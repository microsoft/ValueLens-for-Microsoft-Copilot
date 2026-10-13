/**
 * The app's slicer-style DAX filters (1. Fabric/Fabric App/src/lib/dax-filters.ts), for the
 * queries /api/ask runs. Kept to what Ask needs; test/dax.test.js holds it to
 * the app's behaviour.
 */

const KEYWORD_PATTERNS = [
  ['DEFINE', /^DEFINE\b/i],
  ['EVALUATE', /^EVALUATE\b/i],
  ['ORDER BY', /^ORDER\s+BY\b/i],
  ['START AT', /^START\s+AT\b/i]
];

const isWordChar = (char) => char !== undefined && /[A-Za-z0-9_]/.test(char);

/** Statement keywords at the top level: outside strings, quoted and bracketed names, comments and parentheses. */
function findTopLevelKeywords(query) {
  const hits = [];
  let depth = 0;
  let i = 0;
  const skipDelimited = (close) => {
    i++;
    while (i < query.length) {
      if (query[i] === close) {
        if (query[i + 1] === close) { i += 2; continue; }
        i++;
        return;
      }
      i++;
    }
  };
  while (i < query.length) {
    const char = query[i];
    const next = query[i + 1];
    if (char === '"') skipDelimited('"');
    else if (char === "'") skipDelimited("'");
    else if (char === '[') skipDelimited(']');
    else if ((char === '/' && next === '/') || (char === '-' && next === '-')) { while (i < query.length && query[i] !== '\n') i++; }
    else if (char === '/' && next === '*') { const close = query.indexOf('*/', i + 2); i = close === -1 ? query.length : close + 2; }
    else if (char === '(') { depth++; i++; }
    else if (char === ')') { depth--; i++; }
    else if (depth === 0 && !isWordChar(query[i - 1]) && /[A-Za-z]/.test(char)) {
      const rest = query.slice(i);
      const match = KEYWORD_PATTERNS.find(([, pattern]) => pattern.test(rest));
      if (match) {
        const length = rest.match(match[1])[0].length;
        hits.push({ keyword: match[0], start: i, end: i + length });
        i += length;
      } else {
        while (isWordChar(query[i])) i++;
      }
    } else i++;
  }
  return hits;
}

/** Wraps every `EVALUATE` body in `CALCULATETABLE(..., filters)`, as a report slicer would. */
export function applyDaxFilters(query, filters) {
  if (filters.length === 0) return query;
  const hits = findTopLevelKeywords(query);
  let result = query;
  for (let index = hits.length - 1; index >= 0; index--) {
    const hit = hits[index];
    if (hit.keyword !== 'EVALUATE') continue;
    const bodyEnd = hits[index + 1]?.start ?? query.length;
    const body = query.slice(hit.end, bodyEnd).trim();
    if (!body) continue;
    const wrapped = `\nCALCULATETABLE(\n${body}\n,\n    ${filters.join(',\n    ')}\n)\n`;
    result = result.slice(0, hit.end) + wrapped + result.slice(bodyEnd);
  }
  return result;
}

export const daxString = (value) => `"${String(value).replace(/"/g, '""')}"`;

export function treatAs(column, values) {
  const literals = values.map((value) => (typeof value === 'number' ? String(value) : daxString(value)));
  return `TREATAS({${literals.join(', ')}}, ${column})`;
}

const daxDate = (iso) => { const [year, month, day] = iso.split('-').map(Number); return `DATE(${year}, ${month}, ${day})`; };

export const dateBetween = (column, from, to) => `FILTER(ALL(${column}), ${column} >= ${daxDate(from)} && ${column} <= ${daxDate(to)})`;

/** The columns the filter bar's filters act on, as 1. Fabric/Fabric App/src/lib/filters.ts sets them. */
export const DATE_COLUMN = "'Calendar'[Date]";
export const ORG_COLUMN = "'Chat + Agent Org Data'[Organization]";
