// Best-effort evaluator for GitLab `rules:if` expressions, used only to
// EXPLAIN which rule likely matched. The authoritative result (job.when)
// always comes from gitlab-ci-local itself.

function tokenize(expr) {
  const tokens = [];
  const re = /\s*(\$\w+|\$\{\w+\}|"(?:[^"\\]|\\.)*"|'[^']*'|\/(?:[^\/\\\n]|\\.)*\/[a-z]*|==|!=|=~|!~|&&|\|\||\(|\)|null)\s*/y;
  let pos = 0;
  while (pos < expr.length) {
    re.lastIndex = pos;
    const m = re.exec(expr);
    if (!m) return null; // unsupported syntax
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

// returns true / false / null (unknown)
export function evalRuleIf(expr, vars) {
  const tokens = tokenize(expr);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function value(tok) {
    if (tok === "null") return { kind: "null", v: null };
    if (tok.startsWith("$")) {
      const name = tok.replace(/^\$\{?|\}$/g, "");
      const v = vars[name];
      return { kind: "var", v: v === undefined ? undefined : String(v) };
    }
    if (tok.startsWith('"') || tok.startsWith("'")) return { kind: "str", v: tok.slice(1, -1) };
    if (tok.startsWith("/")) {
      const m = /^\/((?:[^\/\\\n]|\\.)*)\/([a-z]*)$/.exec(tok);
      try {
        return { kind: "re", v: new RegExp(m[1], m[2]) };
      } catch {
        return { kind: "bad" };
      }
    }
    return { kind: "bad" };
  }

  function primary() {
    if (peek() === "(") {
      next();
      const r = orExpr();
      if (next() !== ")") return null;
      return r;
    }
    const tok = next();
    if (tok === undefined) return null;
    const left = value(tok);
    if (left.kind === "bad") return null;
    const op = peek();
    if (op === "==" || op === "!=" || op === "=~" || op === "!~") {
      next();
      const rtok = next();
      if (rtok === undefined) return null;
      const right = value(rtok);
      if (right.kind === "bad") return null;
      if (op === "==" || op === "!=") {
        const l = left.kind === "var" && left.v === undefined ? null : left.v;
        const r = right.kind === "var" && right.v === undefined ? null : right.v;
        const eq = l === r;
        return op === "==" ? eq : !eq;
      }
      // regex matching
      const subject = left.v;
      const rx = right.kind === "re" ? right.v : safeRegex(right.v);
      if (subject === undefined || subject === null || !rx) return null;
      const matched = rx.test(subject);
      return op === "=~" ? matched : !matched;
    }
    // bare $VAR: true when defined and non-empty
    if (left.kind === "var") return left.v !== undefined && left.v !== "";
    if (left.kind === "null") return false;
    return left.v !== "";
  }

  function andExpr() {
    let l = primary();
    while (peek() === "&&") {
      next();
      const r = primary();
      l = l === null || r === null ? (l === false || r === false ? false : null) : l && r;
    }
    return l;
  }

  function orExpr() {
    let l = andExpr();
    while (peek() === "||") {
      next();
      const r = andExpr();
      l = l === null || r === null ? (l === true || r === true ? true : null) : l || r;
    }
    return l;
  }

  try {
    const result = orExpr();
    return i === tokens.length ? result : null;
  } catch {
    return null;
  }
}

function safeRegex(s) {
  try {
    const m = /^\/(.*)\/([a-z]*)$/.exec(s);
    return m ? new RegExp(m[1], m[2]) : new RegExp(s);
  } catch {
    return null;
  }
}

// Annotate a job's rules with best-effort match info.
// Returns [{rule, verdict: 'matched'|'no-match'|'unknown'|'skipped'}]
export function explainRules(rules, vars) {
  if (!Array.isArray(rules)) return [];
  let decided = false;
  return rules.map((rule) => {
    if (decided) return { rule, verdict: "skipped" };
    let v;
    if (rule.if === undefined) v = true; // catch-all rule
    else v = evalRuleIf(rule.if, vars);
    // rules with changes:/exists: clauses we can't fully evaluate
    if ((rule.changes || rule.exists) && v !== false) v = null;
    if (v === true) {
      decided = true;
      return { rule, verdict: "matched" };
    }
    if (v === null) {
      decided = true; // can't be sure about anything after an unknown
      return { rule, verdict: "unknown" };
    }
    return { rule, verdict: "no-match" };
  });
}
