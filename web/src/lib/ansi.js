// Tiny ANSI SGR → styled span converter (covers what gcl/chalk emits).

const BASE = {
  30: "#3b4252", 31: "#e06c75", 32: "#98c379", 33: "#e5c07b",
  34: "#61afef", 35: "#c678dd", 36: "#56b6c2", 37: "#abb2bf",
  90: "#5c6370", 91: "#ff7a85", 92: "#a9d68a", 93: "#f0d197",
  94: "#74bdf7", 95: "#d48ce8", 96: "#6fc8d4", 97: "#ffffff",
};
const BASE_BG = {
  40: "#000", 41: "#e06c75", 42: "#98c379", 43: "#e5c07b", 44: "#61afef",
  45: "#c678dd", 46: "#56b6c2", 47: "#abb2bf", 100: "#5c6370", 101: "#ff7a85",
  102: "#a9d68a", 103: "#f0d197", 104: "#74bdf7", 105: "#d48ce8", 106: "#6fc8d4", 107: "#fff",
};

const C256 = (n) => {
  if (n < 16) return Object.values(BASE)[n % 8];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  n -= 16;
  const r = Math.floor(n / 36), g = Math.floor((n % 36) / 6), b = n % 6;
  const s = (x) => (x ? x * 40 + 55 : 0);
  return `rgb(${s(r)},${s(g)},${s(b)})`;
};

// returns [{text, style}] where style is a React style object (or null)
export function ansiToSpans(input) {
  const spans = [];
  let cur = { color: null, bg: null, bold: false, dim: false, italic: false, underline: false };
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const style = {};
    if (cur.color) style.color = cur.color;
    if (cur.bg) style.backgroundColor = cur.bg;
    if (cur.bold) style.fontWeight = "600";
    if (cur.dim) style.opacity = 0.6;
    if (cur.italic) style.fontStyle = "italic";
    if (cur.underline) style.textDecoration = "underline";
    spans.push({ text: buf, style: Object.keys(style).length ? style : null });
    buf = "";
  };

  const re = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-ln-z]/g;
  let last = 0;
  let m;
  while ((m = re.exec(input))) {
    buf += input.slice(last, m.index);
    last = re.lastIndex;
    if (m[1] === undefined) continue; // non-SGR escape: drop
    flush();
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) cur = { color: null, bg: null, bold: false, dim: false, italic: false, underline: false };
      else if (c === 1) cur.bold = true;
      else if (c === 2) cur.dim = true;
      else if (c === 3) cur.italic = true;
      else if (c === 4) cur.underline = true;
      else if (c === 22) { cur.bold = false; cur.dim = false; }
      else if (c === 23) cur.italic = false;
      else if (c === 24) cur.underline = false;
      else if (c === 39) cur.color = null;
      else if (c === 49) cur.bg = null;
      else if (BASE[c]) cur.color = BASE[c];
      else if (BASE_BG[c]) cur.bg = BASE_BG[c];
      else if (c === 38 || c === 48) {
        const target = c === 38 ? "color" : "bg";
        if (codes[i + 1] === 5) { cur[target] = C256(codes[i + 2] ?? 0); i += 2; }
        else if (codes[i + 1] === 2) { cur[target] = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`; i += 4; }
      }
    }
  }
  buf += input.slice(last);
  flush();
  return spans;
}

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}
