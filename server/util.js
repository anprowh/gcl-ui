import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

export const GLOBAL_DIR = path.join(os.homedir(), ".settings", "gcl-ui");
export const PROJECT_DIR_NAME = ".gcl-ui";

export function projectDir(cwd) {
  return path.join(cwd, PROJECT_DIR_NAME);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function stripAnsi(s) {
  return s.replace(ANSI_RE, "");
}

// Split a flags string the way a shell would (handles quotes).
export function shellSplit(input) {
  const args = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < (input || "").length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) args.push(cur);
      cur = "";
      has = false;
    } else if (c === "\\" && i + 1 < input.length) {
      cur += input[++i];
    } else {
      cur += c;
    }
  }
  if (has || cur) args.push(cur);
  return args;
}

// Locate the gitlab-ci-local executable: prefer the user's own install on
// PATH, fall back to the copy bundled with gcl-ui.
let cachedGclBin = null;
export function findGclBin() {
  if (cachedGclBin) return cachedGclBin;
  if (process.env.GCL_UI_GCL_BIN) return (cachedGclBin = process.env.GCL_UI_GCL_BIN);
  try {
    const which = execFileSync(process.platform === "win32" ? "where" : "which", ["gitlab-ci-local"], {
      encoding: "utf8",
    })
      .split("\n")[0]
      .trim();
    if (which) return (cachedGclBin = which);
  } catch {
    /* not on PATH */
  }
  // bundled fallback
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.join(here, "..", "node_modules", ".bin", "gitlab-ci-local"),
    path.join(here, "..", "..", ".bin", "gitlab-ci-local"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return (cachedGclBin = c);
  }
  throw new Error(
    "gitlab-ci-local executable not found. Install it (npm i -g gitlab-ci-local) or set GCL_UI_GCL_BIN."
  );
}

export function isProbablyText(buf) {
  const n = Math.min(buf.length, 4096);
  if (n === 0) return true;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b < 7 || (b > 14 && b < 27) || (b > 27 && b < 32)) suspicious++;
  }
  return suspicious / n < 0.05;
}

export function walkDir(root, { maxEntries = 5000 } = {}) {
  const out = [];
  let count = 0;
  function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (count++ > maxEntries) return;
      const r = rel ? rel + "/" + e.name : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push({ type: "dir", path: r });
        walk(full, r);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        out.push({ type: "file", path: r, size });
      }
    }
  }
  walk(root, "");
  return out;
}
