"""A tiny Power Query M evaluator for the subset the templates' pure helper functions use.

It exists so tests can run M text shipped in the .pbit files (for example ValueLensDescribeAgent)
against the Python rules they port, without Power BI Desktop. Supported: let/in, if/then/else,
and/or/not, = <> < <= > >= & + -, function literals (type annotations are ignored), each/_,
lists (with "a".."z" ranges), records, {n} item access, calls, and the Text.*/List.* library
functions in BUILTINS. Evaluation is strict about logical conditions and lazy for let bindings,
as in M. Anything else raises MError, so unsupported M fails loudly instead of being guessed.
"""
import re

__all__ = ["MError", "evaluate"]


class MError(Exception):
    pass


_TOKEN = re.compile(r"""
    (?P<ws>\s+|//[^\n]*|/\*.*?\*/)
  | (?P<text>"(?:[^"]|"")*")
  | (?P<number>\d+(?:\.\d+)?)
  | (?P<op>=>|\.\.|<>|<=|>=|[=<>&+\-*/(){}\[\],?@])
  | (?P<ident>[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)
""", re.S | re.X)

_ESCAPES = {"tab": "\t", "cr": "\r", "lf": "\n", "#": "#"}
_KEYWORDS = {"let", "in", "if", "then", "else", "and", "or", "not", "each", "as", "nullable",
             "true", "false", "null", "otherwise", "try", "meta", "type", "is", "error", "section"}


def _unescape(raw):
    body = raw[1:-1].replace('""', '"')

    def esc(match):
        name = match.group(1).lower()
        if name in _ESCAPES:
            return _ESCAPES[name]
        if re.fullmatch(r"[0-9a-f]{4}", name):
            return chr(int(name, 16))
        raise MError(f"unsupported escape #({match.group(1)})")
    return re.sub(r"#\(([^)]*)\)", esc, body)


def _tokens(src):
    pos, out = 0, []
    while pos < len(src):
        match = _TOKEN.match(src, pos)
        if not match:
            raise MError(f"cannot tokenise at {src[pos:pos + 30]!r}")
        pos = match.end()
        kind = match.lastgroup
        if kind == "ws":
            continue
        value = match.group(kind)
        if kind == "text":
            out.append(("text", _unescape(value)))
        elif kind == "number":
            out.append(("number", float(value) if "." in value else int(value)))
        elif kind == "ident" and value in _KEYWORDS:
            out.append(("kw", value))
        else:
            out.append((kind, value))
    out.append(("eof", None))
    return out


class _Parser:
    def __init__(self, src):
        self.toks = _tokens(src)
        self.i = 0

    def peek(self, offset=0):
        return self.toks[self.i + offset]

    def take(self, kind=None, value=None):
        tok = self.toks[self.i]
        if (kind and tok[0] != kind) or (value is not None and tok[1] != value):
            raise MError(f"expected {value or kind}, got {tok}")
        self.i += 1
        return tok

    def at(self, kind, value=None):
        tok = self.toks[self.i]
        return tok[0] == kind and (value is None or tok[1] == value)

    def parse(self):
        node = self.expr()
        self.take("eof")
        return node

    def expr(self):
        if self.at("kw", "let"):
            self.take()
            binds = []
            while True:
                name = self.take("ident")[1]
                self.take("op", "=")
                binds.append((name, self.expr()))
                if self.at("op", ","):
                    self.take()
                    continue
                break
            self.take("kw", "in")
            return ("let", binds, self.expr())
        if self.at("kw", "if"):
            self.take()
            cond = self.expr()
            self.take("kw", "then")
            yes = self.expr()
            self.take("kw", "else")
            return ("if", cond, yes, self.expr())
        if self.at("kw", "each"):
            self.take()
            return ("func", ["_"], self.expr())
        if self.at("kw", "try"):
            raise MError("try/otherwise is not supported")
        func = self.try_function()
        if func:
            return func
        return self.logical_or()

    def skip_type(self):
        if self.at("kw", "nullable"):
            self.take()
        self.take("ident") if self.at("ident") else self.take("kw")

    def try_function(self):
        if not self.at("op", "("):
            return None
        start, params = self.i, []
        try:
            self.take()
            while not self.at("op", ")"):
                params.append(self.take("ident")[1])
                if self.at("kw", "as"):
                    self.take()
                    self.skip_type()
                if self.at("op", ","):
                    self.take()
            self.take("op", ")")
            if self.at("kw", "as"):
                self.take()
                self.skip_type()
            self.take("op", "=>")
        except MError:
            self.i = start
            return None
        return ("func", params, self.expr())

    def binary(self, ops, lower):
        node = lower()
        while self.peek()[1] in ops and self.peek()[0] in ("op", "kw"):
            op = self.take()[1]
            node = ("bin", op, node, lower())
        return node

    def logical_or(self):
        return self.binary({"or"}, self.logical_and)

    def logical_and(self):
        return self.binary({"and"}, self.equality)

    def equality(self):
        return self.binary({"=", "<>"}, self.relational)

    def relational(self):
        return self.binary({"<", "<=", ">", ">="}, self.additive)

    def additive(self):
        return self.binary({"+", "-", "&"}, self.unary)

    def unary(self):
        if self.at("kw", "not"):
            self.take()
            return ("not", self.unary())
        if self.at("op", "-"):
            self.take()
            return ("neg", self.unary())
        return self.postfix()

    def postfix(self):
        node = self.primary()
        while True:
            if self.at("op", "("):
                self.take()
                args = []
                while not self.at("op", ")"):
                    args.append(self.expr())
                    if self.at("op", ","):
                        self.take()
                self.take()
                node = ("call", node, args)
            elif self.at("op", "{"):
                self.take()
                index = self.expr()
                self.take("op", "}")
                node = ("item", node, index)
            else:
                return node

    def primary(self):
        kind, value = self.peek()
        if kind in ("text", "number"):
            self.take()
            return ("lit", value)
        if kind == "kw" and value in ("true", "false", "null"):
            self.take()
            return ("lit", {"true": True, "false": False, "null": None}[value])
        if kind == "ident":
            self.take()
            return ("name", value)
        if kind == "op" and value == "(":
            self.take()
            node = self.expr()
            self.take("op", ")")
            return node
        if kind == "op" and value == "{":
            self.take()
            items = []
            while not self.at("op", "}"):
                first = self.expr()
                if self.at("op", ".."):
                    self.take()
                    items.append(("range", first, self.expr()))
                else:
                    items.append(first)
                if self.at("op", ","):
                    self.take()
            self.take()
            return ("list", items)
        if kind == "op" and value == "[":
            self.take()
            fields = []
            while not self.at("op", "]"):
                name = self.take("ident")[1]
                self.take("op", "=")
                fields.append((name, self.expr()))
                if self.at("op", ","):
                    self.take()
            self.take()
            return ("record", fields)
        raise MError(f"unsupported syntax at {self.peek()}")


class _Lazy:
    def __init__(self, node, env):
        self.node, self.env, self.done, self.value = node, env, False, None

    def get(self):
        if not self.done:
            self.value, self.done = _eval(self.node, self.env), True
        return self.value


def _logical(value):
    if not isinstance(value, bool):
        raise MError(f"expected a logical, got {value!r}")
    return value


def _text(value, what="text"):
    if not isinstance(value, str):
        raise MError(f"expected {what}, got {value!r}")
    return value


def _nullable_text(fn):
    return lambda value, *rest: None if value is None else fn(_text(value), *rest)


def _middle(text, start, count=None):
    if start > len(text):
        raise MError("Text.Middle offset past the end")
    return text[start:] if count is None else text[start:start + count]


def _text_from(value):
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    raise MError(f"Text.From({value!r}) is not supported")


def _call(fn, *args):
    return fn(*args)


BUILTINS = {
    "Text.From": _text_from,
    "Text.Trim": _nullable_text(lambda t: t.strip()),
    "Text.Lower": _nullable_text(str.lower),
    "Text.Upper": _nullable_text(str.upper),
    "Text.Length": _nullable_text(len),
    "Text.Middle": _nullable_text(_middle),
    "Text.PositionOf": lambda t, s: _text(t).find(_text(s)),
    "Text.StartsWith": lambda t, s: None if t is None else _text(t).startswith(_text(s)),
    "Text.Contains": lambda t, s: None if t is None else _text(s) in _text(t),
    "Text.Select": _nullable_text(lambda t, keep: "".join(c for c in t if c in set(keep))),
    "Text.Remove": _nullable_text(lambda t, drop: "".join(c for c in t if c not in set(drop))),
    "List.First": lambda items, default=None: items[0] if items else default,
    "List.Select": lambda items, fn: [x for x in items if _logical(_call(fn, x))],
    "List.Transform": lambda items, fn: [_call(fn, x) for x in items],
    "List.RemoveNulls": lambda items: [x for x in items if x is not None],
    "List.Contains": lambda items, value: value in items,
}


def _equal(a, b):
    if type(a) is bool or type(b) is bool:
        return type(a) is type(b) and a == b
    return a == b


def _eval(node, env):
    kind = node[0]
    if kind == "lit":
        return node[1]
    if kind == "name":
        name = node[1]
        if name in env:
            value = env[name]
            return value.get() if isinstance(value, _Lazy) else value
        if name in BUILTINS:
            return BUILTINS[name]
        raise MError(f"unknown name {name}")
    if kind == "let":
        scope = dict(env)
        for name, value in node[1]:
            scope[name] = _Lazy(value, scope)
        return _eval(node[2], scope)
    if kind == "if":
        return _eval(node[2] if _logical(_eval(node[1], env)) else node[3], env)
    if kind == "func":
        params, body = node[1], node[2]

        def fn(*args):
            if len(args) != len(params):
                raise MError(f"expected {len(params)} arguments, got {len(args)}")
            return _eval(body, {**env, **dict(zip(params, args))})
        return fn
    if kind == "call":
        fn = _eval(node[1], env)
        if not callable(fn):
            raise MError(f"{fn!r} is not a function")
        return fn(*[_eval(a, env) for a in node[2]])
    if kind == "item":
        items, index = _eval(node[1], env), _eval(node[2], env)
        if not isinstance(items, list) or not isinstance(index, int) or not 0 <= index < len(items):
            raise MError(f"bad item access {index!r}")
        return items[index]
    if kind == "list":
        out = []
        for item in node[1]:
            if item[0] == "range":
                lo, hi = _eval(item[1], env), _eval(item[2], env)
                out.extend(chr(c) for c in range(ord(_text(lo)), ord(_text(hi)) + 1))
            else:
                out.append(_eval(item, env))
        return out
    if kind == "record":
        return {name: _eval(value, env) for name, value in node[1]}
    if kind == "not":
        return not _logical(_eval(node[1], env))
    if kind == "neg":
        return -_eval(node[1], env)
    if kind == "bin":
        op, left = node[1], _eval(node[2], env)
        if op == "and":
            return _logical(left) and _logical(_eval(node[3], env))
        if op == "or":
            return _logical(left) or _logical(_eval(node[3], env))
        right = _eval(node[3], env)
        if op == "=":
            return _equal(left, right)
        if op == "<>":
            return not _equal(left, right)
        if left is None or right is None:
            return None
        if op == "&":
            if isinstance(left, str) and isinstance(right, str):
                return left + right
            if isinstance(left, list) and isinstance(right, list):
                return left + right
            raise MError(f"cannot combine {left!r} & {right!r}")
        return {"<": lambda: left < right, "<=": lambda: left <= right, ">": lambda: left > right,
                ">=": lambda: left >= right, "+": lambda: left + right, "-": lambda: left - right}[op]()
    raise MError(f"unsupported node {kind}")


def evaluate(source, env=None):
    """Evaluate one M expression (for example a function literal) and return a Python value."""
    return _eval(_Parser(source).parse(), dict(env or {}))
