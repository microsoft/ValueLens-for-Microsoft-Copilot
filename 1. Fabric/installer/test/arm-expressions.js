// @ts-check
// A small offline evaluator for ARM template language expressions ("[split(...)[2]]").
// It covers the functions the Analytics Hub template uses outside runtime values, so tests
// can catch expressions that ARM rejects at validation time (e.g. an out-of-bounds index),
// which no amount of parameter-shape checking would find. Unknown functions throw.
import { createHash } from 'node:crypto';

const hash = (/** @type {unknown[]} */ args) => createHash('sha256').update(args.map(String).join('|')).digest('hex');
/** Functions whose value only exists while the deployment runs; expressions using them are skipped. */
export const RUNTIME_FUNCTIONS = /\b(reference|list\w*|environment|deployment|managementGroup|tenant|pickZones|newGuid|utcNow)\s*\(/i;

/** @param {string} src */
function tokenize(src) {
  /** @type {{ t: string, v?: any }[]} */
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new Error(`Unterminated string in ${src}`);
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ t: 'str', v: s });
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && (c === '-' || /\d/.test(c))) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][\w]*/.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    if ('()[],.'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`Unexpected '${c}' in ${src}`);
  }
  return out;
}

/** Parse into an AST: { k: 'lit', v } | { k: 'call', name, args } | { k: 'index', obj, key } */
function parse(/** @type {string} */ src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = (/** @type {string} */ t) => {
    if (toks[p]?.t !== t) throw new Error(`Expected '${t}' at token ${p} in ${src}`);
    return toks[p++];
  };
  /** @returns {any} */
  const expr = () => {
    const tok = toks[p++];
    /** @type {any} */
    let node;
    if (!tok) throw new Error(`Unexpected end of ${src}`);
    if (tok.t === 'str' || tok.t === 'num') node = { k: 'lit', v: tok.v };
    else if (tok.t === 'id') {
      take('(');
      const args = [];
      if (peek()?.t !== ')') {
        args.push(expr());
        while (peek()?.t === ',') { p++; args.push(expr()); }
      }
      take(')');
      node = { k: 'call', name: tok.v.toLowerCase(), args };
    } else throw new Error(`Unexpected token '${tok.t}' in ${src}`);
    for (;;) {
      if (peek()?.t === '[') { p++; const key = expr(); take(']'); node = { k: 'index', obj: node, key }; }
      else if (peek()?.t === '.') { p++; node = { k: 'index', obj: node, key: { k: 'lit', v: String(take('id').v) } }; }
      else return node;
    }
  };
  const ast = expr();
  if (p !== toks.length) throw new Error(`Trailing tokens in ${src}`);
  return ast;
}

/** True for strings ARM treats as expressions ("[...]", but not the "[[" literal escape). */
export const isExpression = (/** @type {unknown} */ v) => typeof v === 'string' && v.startsWith('[') && !v.startsWith('[[') && v.endsWith(']');

/**
 * @param {any} template compiled ARM template
 * @param {Record<string, { value: any }>} parameters deployment parameters (as the installer sends them)
 * @param {{ subscriptionId?: string, resourceGroup?: string, location?: string }} [scope]
 */
export function armEvaluator(template, parameters, scope = {}) {
  const sub = scope.subscriptionId ?? '00000000-0000-0000-0000-000000000001';
  const rgName = scope.resourceGroup ?? 'rg-test';
  const rg = { id: `/subscriptions/${sub}/resourceGroups/${rgName}`, name: rgName, location: scope.location ?? 'uksouth', type: 'Microsoft.Resources/resourceGroups' };
  /** @type {Record<string, any>} */
  const params = {};
  /** @type {Record<string, any>} defaults are expressions too, evaluated on first use */
  const defaults = {};
  for (const [name, def] of Object.entries(template.parameters ?? {})) {
    if (parameters[name]) params[name] = parameters[name].value;
    else if ('defaultValue' in def) defaults[name] = def.defaultValue;
    else throw new Error(`Parameter ${name} has no value and no default`);
  }
  for (const name of Object.keys(parameters)) if (!(name in (template.parameters ?? {}))) throw new Error(`Parameter ${name} is not declared by the template`);
  /** @type {Record<string, any>} */
  const vars = {};
  const evaluating = new Set();

  const resolveId = (/** @type {string} */ prefix, /** @type {any[]} */ args) => {
    const [type, ...names] = args.map(String);
    const [ns, ...types] = type.split('/');
    if (types.length !== names.length) throw new Error(`${type} needs ${types.length} name segment(s), got ${names.length}`);
    return `${prefix}/providers/${ns}/${types.map((t, i) => `${t}/${names[i]}`).join('/')}`;
  };
  const toInt = (/** @type {any} */ v) => {
    if (!Number.isInteger(v)) throw new Error(`Expected an integer, got ${JSON.stringify(v)}`);
    return v;
  };

  /** @type {Record<string, (args: any[]) => any>} */
  const fns = {
    parameters: ([n]) => {
      if (n in params) return params[n];
      if (!(n in defaults)) throw new Error(`The template parameter '${n}' is not found`);
      return (params[n] = evalValue(defaults[n]));
    },
    variables: ([n]) => {
      if (n in vars) return vars[n];
      if (!(n in (template.variables ?? {}))) throw new Error(`The template variable '${n}' is not found`);
      if (evaluating.has(n)) throw new Error(`Variable '${n}' refers to itself`);
      evaluating.add(n);
      vars[n] = evalValue(template.variables[n]);
      evaluating.delete(n);
      return vars[n];
    },
    resourcegroup: () => rg,
    subscription: () => ({ id: `/subscriptions/${sub}`, subscriptionId: sub, tenantId: '00000000-0000-0000-0000-0000000000aa' }),
    concat: (a) => (a.every(Array.isArray) ? a.flat() : a.map(String).join('')),
    format: ([f, ...a]) => String(f).replace(/\{(\d+)(:[^}]*)?\}/g, (_, i) => {
      if (Number(i) >= a.length) throw new Error(`format('${f}') has no argument {${i}}`);
      return String(a[Number(i)]);
    }),
    split: ([s, d]) => {
      if (typeof s !== 'string') throw new Error('split() expects a string');
      return s.split(String(d));
    },
    replace: ([s, a, b]) => String(s).split(String(a)).join(String(b)),
    tolower: ([s]) => String(s).toLowerCase(),
    toupper: ([s]) => String(s).toUpperCase(),
    trim: ([s]) => String(s).trim(),
    take: ([v, n]) => v.slice(0, Math.max(0, toInt(n))),
    skip: ([v, n]) => v.slice(Math.max(0, toInt(n))),
    substring: ([s, start, len]) => {
      const str = String(s);
      const st = toInt(start);
      const l = len === undefined ? str.length - st : toInt(len);
      if (st < 0 || st > str.length || l < 0 || st + l > str.length) throw new Error(`substring('${str}', ${st}, ${l}) is out of range`);
      return str.substr(st, l);
    },
    length: ([v]) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).length : v.length),
    first: ([v]) => (typeof v === 'string' ? v.slice(0, 1) : v[0]),
    last: ([v]) => (typeof v === 'string' ? v.slice(-1) : v[v.length - 1]),
    empty: ([v]) => v === null || v === undefined || v === '' || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.keys(v).length === 0),
    contains: ([c, x]) => (typeof c === 'string' ? c.toLowerCase().includes(String(x).toLowerCase()) : Array.isArray(c) ? c.includes(x) : Object.keys(c).some((k) => k.toLowerCase() === String(x).toLowerCase())),
    equals: ([a, b]) => JSON.stringify(a) === JSON.stringify(b),
    not: ([a]) => !a,
    and: (a) => a.every(Boolean),
    or: (a) => a.some(Boolean),
    true: () => true,
    false: () => false,
    null: () => null,
    string: ([v]) => (typeof v === 'string' ? v : JSON.stringify(v)),
    int: ([v]) => parseInt(String(v), 10),
    bool: ([v]) => (typeof v === 'string' ? v.toLowerCase() === 'true' : !!v),
    json: ([v]) => JSON.parse(String(v)),
    coalesce: (a) => a.find((v) => v !== null && v !== undefined) ?? null,
    createobject: (a) => Object.fromEntries(Array.from({ length: a.length / 2 }, (_, i) => [a[2 * i], a[2 * i + 1]])),
    createarray: (a) => a,
    union: (a) => (a.every(Array.isArray) ? [...new Set(a.flat())] : Object.assign({}, ...a)),
    uniquestring: (a) => BigInt(`0x${hash(a).slice(0, 16)}`).toString(32).padStart(13, 'a').slice(0, 13),
    guid: (a) => hash(a).slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
    resourceid: (a) => {
      const segs = a.map(String);
      const typeAt = segs.findIndex((s) => s.includes('/'));
      if (typeAt < 0) throw new Error('resourceId() needs a resource type');
      const pre = segs.slice(0, typeAt);
      const s = pre.length === 2 ? pre[0] : sub;
      const g = pre.length ? pre[pre.length - 1] : rgName;
      return resolveId(`/subscriptions/${s}/resourceGroups/${g}`, segs.slice(typeAt));
    },
    subscriptionresourceid: (a) => resolveId(`/subscriptions/${a.length && !String(a[0]).includes('/') ? a.shift() : sub}`, a),
    extensionresourceid: ([scopeId, ...a]) => {
      if (typeof scopeId !== 'string' || !scopeId.startsWith('/')) throw new Error(`extensionResourceId() scope must be a resource id, got ${JSON.stringify(scopeId)}`);
      return resolveId(scopeId, a);
    },
  };

  /** @param {any} node @returns {any} */
  function run(node) {
    if (node.k === 'lit') return node.v;
    if (node.k === 'index') {
      const obj = run(node.obj);
      const key = run(node.key);
      if (Array.isArray(obj) || typeof obj === 'string') {
        if (!Number.isInteger(key)) throw new Error(`Array index must be an integer, got ${JSON.stringify(key)}`);
        if (key < 0 || key >= obj.length) throw new Error(`The language expression property array index '${key}' is out of bounds.`);
        return obj[key];
      }
      if (obj && typeof obj === 'object') {
        const match = Object.keys(obj).find((k) => k.toLowerCase() === String(key).toLowerCase());
        if (match === undefined) throw new Error(`The language expression property '${key}' doesn't exist, available properties are '${Object.keys(obj).join(', ')}'.`);
        return obj[match];
      }
      throw new Error(`Cannot index ${JSON.stringify(obj)} with ${JSON.stringify(key)}`);
    }
    if (node.name === 'if') {
      if (node.args.length !== 3) throw new Error('if() takes three arguments');
      return run(node.args[0]) ? run(node.args[1]) : run(node.args[2]);
    }
    const fn = fns[node.name];
    if (!fn) throw new Error(`Unsupported template function '${node.name}' (teach test/arm-expressions.js about it)`);
    return fn(node.args.map(run));
  }

  /** Evaluate a template value: expression strings are evaluated, objects and arrays recursively. @param {any} v @returns {any} */
  function evalValue(v) {
    if (isExpression(v)) return run(parse(v.slice(1, -1)));
    if (typeof v === 'string' && v.startsWith('[[')) return v.slice(1);
    if (Array.isArray(v)) return v.map(evalValue);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, evalValue(x)]));
    return v;
  }

  return { evalValue, variable: (/** @type {string} */ n) => fns.variables([n]) };
}

/**
 * Evaluate every expression ARM resolves while validating a deployment: all variables, and each
 * top-level resource's name, condition, scope fields and dependsOn (regardless of its condition),
 * plus nested-deployment parameter values that don't depend on runtime state.
 * @returns {{ resources: { name: string, deployed: boolean, dependsOn: string[], subscriptionId?: string, resourceGroup?: string }[], errors: string[] }}
 */
export function validateArmTemplate(/** @type {any} */ template, /** @type {Record<string, { value: any }>} */ parameters, /** @type {any} */ scope) {
  const errors = [];
  const ev = armEvaluator(template, parameters, scope);
  const attempt = (/** @type {string} */ where, /** @type {() => any} */ f) => {
    try {
      return f();
    } catch (e) {
      errors.push(`${where}: ${/** @type {Error} */ (e).message}`);
      return undefined;
    }
  };
  for (const name of Object.keys(template.parameters ?? {})) attempt(`parameter '${name}'`, () => ev.evalValue(`[parameters('${name}')]`));
  for (const name of Object.keys(template.variables ?? {})) attempt(`variable '${name}'`, () => ev.variable(name));
  const resources = (Array.isArray(template.resources) ? template.resources : Object.values(template.resources ?? {})).map((/** @type {any} */ r, /** @type {number} */ i) => {
    const label = `resource ${i} (${r.name})`;
    const name = attempt(`${label} name`, () => ev.evalValue(r.name));
    const deployed = 'condition' in r ? attempt(`${label} condition`, () => ev.evalValue(r.condition)) : true;
    const out = { name, deployed: !!deployed, dependsOn: /** @type {string[]} */ ([]), subscriptionId: undefined, resourceGroup: undefined };
    for (const key of /** @type {const} */ (['subscriptionId', 'resourceGroup', 'scope'])) {
      if (key in r) /** @type {any} */ (out)[key] = attempt(`${label} ${key}`, () => ev.evalValue(r[key]));
    }
    for (const dep of r.dependsOn ?? []) out.dependsOn.push(attempt(`${label} dependsOn ${dep}`, () => ev.evalValue(dep)));
    for (const [p, def] of Object.entries(r.properties?.parameters ?? {})) {
      const raw = JSON.stringify(def);
      if (!RUNTIME_FUNCTIONS.test(raw)) attempt(`${label} parameter '${p}'`, () => ev.evalValue(def));
    }
    return out;
  });
  return { resources, errors };
}
