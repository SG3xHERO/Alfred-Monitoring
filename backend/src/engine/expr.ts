// Hand-written lexer + Pratt parser + evaluator for the rule condition DSL.
// No eval(), no dynamic code — expressions compile to a small AST that is
// walked against a metrics context.
//
// Grammar:
//   expr    := or
//   or      := and ("or" and)*
//   and     := unary ("and" unary)*
//   unary   := "not" unary | cmp
//   cmp     := add (("=="|"!="|"<="|">="|"<"|">") add)?
//   add     := primary
//   primary := number | string | "true" | "false" | path | path "(" args ")" | "(" expr ")"
//   path    := ident ("." ident)*

export type Value = number | string | boolean | null;

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "path"; name: string }
  | { kind: "call"; name: string; args: Expr[] }
  | { kind: "cmp"; op: string; left: Expr; right: Expr }
  | { kind: "logic"; op: "and" | "or"; left: Expr; right: Expr }
  | { kind: "not"; operand: Expr };

export class ExprError extends Error {
  constructor(message: string, public pos: number) {
    super(message);
  }
}

interface Token {
  kind: "num" | "str" | "ident" | "op" | "lparen" | "rparen" | "comma" | "eof";
  text: string;
  pos: number;
}

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") { tokens.push({ kind: "lparen", text: ch, pos: i++ }); continue; }
    if (ch === ")") { tokens.push({ kind: "rparen", text: ch, pos: i++ }); continue; }
    if (ch === ",") { tokens.push({ kind: "comma", text: ch, pos: i++ }); continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== quote) {
        s += src[j++];
      }
      if (j >= src.length) throw new ExprError("unterminated string", i);
      tokens.push({ kind: "str", text: s, pos: i });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">="].includes(two)) {
      tokens.push({ kind: "op", text: two, pos: i });
      i += 2;
      continue;
    }
    if (ch === "<" || ch === ">") {
      tokens.push({ kind: "op", text: ch, pos: i++ });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      tokens.push({ kind: "num", text: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      tokens.push({ kind: "ident", text: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    throw new ExprError(`unexpected character '${ch}'`, i);
  }
  tokens.push({ kind: "eof", text: "", pos: src.length });
  return tokens;
}

export function parseExpr(src: string): Expr {
  const tokens = lex(src);
  let idx = 0;
  const peek = () => tokens[idx];
  const next = () => tokens[idx++];
  const expect = (kind: Token["kind"], what: string): Token => {
    const t = next();
    if (t.kind !== kind) throw new ExprError(`expected ${what}, got '${t.text || "end"}'`, t.pos);
    return t;
  };

  function parseOr(): Expr {
    let left = parseAnd();
    while (peek().kind === "ident" && peek().text === "or") {
      next();
      left = { kind: "logic", op: "or", left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd(): Expr {
    let left = parseUnary();
    while (peek().kind === "ident" && peek().text === "and") {
      next();
      left = { kind: "logic", op: "and", left, right: parseUnary() };
    }
    return left;
  }
  function parseUnary(): Expr {
    if (peek().kind === "ident" && peek().text === "not") {
      next();
      return { kind: "not", operand: parseUnary() };
    }
    return parseCmp();
  }
  function parseCmp(): Expr {
    const left = parsePrimary();
    if (peek().kind === "op") {
      const op = next().text;
      return { kind: "cmp", op, left, right: parsePrimary() };
    }
    return left;
  }
  function parsePrimary(): Expr {
    const t = next();
    if (t.kind === "num") return { kind: "num", value: parseFloat(t.text) };
    if (t.kind === "str") return { kind: "str", value: t.text };
    if (t.kind === "lparen") {
      const inner = parseOr();
      expect("rparen", "')'");
      return inner;
    }
    if (t.kind === "ident") {
      if (t.text === "true") return { kind: "bool", value: true };
      if (t.text === "false") return { kind: "bool", value: false };
      if (t.text === "and" || t.text === "or" || t.text === "not") {
        throw new ExprError(`'${t.text}' is a keyword, expected a value`, t.pos);
      }
      if (peek().kind === "lparen") {
        next();
        const args: Expr[] = [];
        if (peek().kind !== "rparen") {
          for (;;) {
            args.push(parseOr());
            if (peek().kind === "comma") { next(); continue; }
            break;
          }
        }
        expect("rparen", "')'");
        return { kind: "call", name: t.text, args };
      }
      return { kind: "path", name: t.text };
    }
    throw new ExprError(`unexpected '${t.text || "end of expression"}'`, t.pos);
  }

  const expr = parseOr();
  const last = peek();
  if (last.kind !== "eof") {
    throw new ExprError(`unexpected trailing '${last.text}'`, last.pos);
  }
  return expr;
}

export interface EvalContext {
  getPath(name: string): Value | undefined;
  callFn(name: string, args: Value[]): Value;
}

export function truthy(v: Value): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v.length > 0;
}

export function evaluate(expr: Expr, ctx: EvalContext): Value {
  switch (expr.kind) {
    case "num": return expr.value;
    case "str": return expr.value;
    case "bool": return expr.value;
    case "path": {
      const v = ctx.getPath(expr.name);
      return v === undefined ? null : v;
    }
    case "call": {
      const args = expr.args.map((a) => evaluate(a, ctx));
      return ctx.callFn(expr.name, args);
    }
    case "not":
      return !truthy(evaluate(expr.operand, ctx));
    case "logic": {
      const l = truthy(evaluate(expr.left, ctx));
      if (expr.op === "and") return l ? truthy(evaluate(expr.right, ctx)) : false;
      return l ? true : truthy(evaluate(expr.right, ctx));
    }
    case "cmp": {
      const l = evaluate(expr.left, ctx);
      const r = evaluate(expr.right, ctx);
      switch (expr.op) {
        case "==": return looseEq(l, r);
        case "!=": return !looseEq(l, r);
        case "<": return num(l) < num(r);
        case "<=": return num(l) <= num(r);
        case ">": return num(l) > num(r);
        case ">=": return num(l) >= num(r);
      }
      return false;
    }
  }
}

function looseEq(l: Value, r: Value): boolean {
  if (l === null || r === null) return l === r;
  if (typeof l === "string" && typeof r === "string") {
    return l.toLowerCase() === r.toLowerCase();
  }
  return l === r;
}

function num(v: Value): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (!isNaN(n)) return n;
  }
  return NaN; // NaN comparisons are always false — null metrics never trigger
}

/** Walk the AST collecting identifier usage for save-time validation. */
export function collectRefs(expr: Expr, paths: Set<string>, calls: Set<string>): void {
  switch (expr.kind) {
    case "path": paths.add(expr.name); break;
    case "call":
      calls.add(expr.name);
      expr.args.forEach((a) => collectRefs(a, paths, calls));
      break;
    case "not": collectRefs(expr.operand, paths, calls); break;
    case "logic":
    case "cmp":
      collectRefs(expr.left, paths, calls);
      collectRefs(expr.right, paths, calls);
      break;
  }
}
