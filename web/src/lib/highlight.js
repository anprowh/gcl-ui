// Minimal tokenizers for artifact text previews. Returns [{text, cls}] per line.

function tokensFromRegex(line, patterns) {
  const tokens = [];
  let pos = 0;
  while (pos < line.length) {
    let best = null;
    for (const [re, cls] of patterns) {
      re.lastIndex = pos;
      const m = re.exec(line);
      if (m && m.index === pos && m[0] && (!best || m[0].length > best.text.length)) {
        best = { text: m[0], cls };
      }
    }
    if (best) {
      tokens.push(best);
      pos += best.text.length;
    } else {
      const last = tokens[tokens.length - 1];
      if (last && !last.cls) last.text += line[pos];
      else tokens.push({ text: line[pos], cls: null });
      pos++;
    }
  }
  return tokens;
}

const YAML_PATTERNS = [
  [/#.*/y, "hl-comment"],
  [/^(\s*)[\w."'$\[\]\/-]+(?=\s*:(\s|$))/y, "hl-key"],
  [/"(?:[^"\\]|\\.)*"|'[^']*'/y, "hl-str"],
  [/\$\{?\w+\}?/y, "hl-var"],
  [/\b(true|false|null|~)\b/y, "hl-const"],
  [/-?\d+(\.\d+)?\b/y, "hl-num"],
  [/^\s*-(?=\s|$)/y, "hl-punct"],
];

const JSON_PATTERNS = [
  [/"(?:[^"\\]|\\.)*"(?=\s*:)/y, "hl-key"],
  [/"(?:[^"\\]|\\.)*"/y, "hl-str"],
  [/\b(true|false|null)\b/y, "hl-const"],
  [/-?\d+(\.\d+)?([eE][+-]?\d+)?\b/y, "hl-num"],
];

const SHELL_PATTERNS = [
  [/#.*/y, "hl-comment"],
  [/"(?:[^"\\]|\\.)*"|'[^']*'/y, "hl-str"],
  [/\$\{?[\w@#?]+\}?/y, "hl-var"],
  [/\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|export|local|return|exit|echo|set|cd)\b/y, "hl-kw"],
];

const LOG_PATTERNS = [
  [/\b(ERROR|FATAL|FAIL(ED|URE)?)\b/y, "hl-err"],
  [/\b(WARN(ING)?)\b/y, "hl-warn"],
  [/\b(INFO|NOTICE|PASS(ED)?|SUCCESS|OK)\b/y, "hl-ok"],
  [/\b(DEBUG|TRACE)\b/y, "hl-comment"],
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/y, "hl-num"],
  [/\bhttps?:\/\/\S+/y, "hl-str"],
];

export function languageFor(filename) {
  const ext = (filename || "").split(".").pop()?.toLowerCase();
  if (["yml", "yaml"].includes(ext)) return "yaml";
  if (ext === "json") return "json";
  if (["sh", "bash", "zsh"].includes(ext)) return "shell";
  if (["log", "txt", "out"].includes(ext)) return "log";
  if (["patch", "diff"].includes(ext)) return "diff";
  return "plain";
}

export function highlightLine(line, lang) {
  switch (lang) {
    case "yaml": return tokensFromRegex(line, YAML_PATTERNS);
    case "json": return tokensFromRegex(line, JSON_PATTERNS);
    case "shell": return tokensFromRegex(line, SHELL_PATTERNS);
    case "log": return tokensFromRegex(line, LOG_PATTERNS);
    default: return [{ text: line, cls: null }];
  }
}
