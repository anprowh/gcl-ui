import fs from "node:fs";
import path from "node:path";
import { GLOBAL_DIR, projectDir, readJson, writeJson } from "./util.js";

// Variable stores.
//  - project scope lives in   <project>/.gcl-ui/variables.json
//  - global  scope lives in   ~/.settings/gcl-ui/variables.json
// Each store is a list of { key, value, enabled, file } entries so users can
// keep a variable around but toggle it off for a run. `file: true` gives the
// entry GitLab file-variable semantics: the value is written to a temp file
// and the job sees the variable holding that file's path.

function projectFile(cwd) {
  return path.join(projectDir(cwd), "variables.json");
}
const globalFile = path.join(GLOBAL_DIR, "variables.json");

function normalize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((v) => v && typeof v.key === "string" && v.key.trim())
    .map((v) => ({ key: v.key.trim(), value: String(v.value ?? ""), enabled: v.enabled !== false, file: v.file === true }));
}

export function getVariables(cwd) {
  return {
    project: normalize(readJson(projectFile(cwd), [])),
    global: normalize(readJson(globalFile, [])),
  };
}

export function setVariables(cwd, scope, list) {
  const data = normalize(list);
  if (scope === "project") writeJson(projectFile(cwd), data);
  else if (scope === "global") writeJson(globalFile, data);
  else throw new Error(`unknown variable scope: ${scope}`);
  return data;
}

// Merge stores + per-run session overrides into KEY -> { value, file }.
// Precedence: session > project > global. A session override replaces the
// value but keeps the file flag of the store entry it shadows, so overriding
// a file variable's content still yields a file variable.
export function effectiveVariableEntries(cwd, session = {}) {
  const { project, global: glob } = getVariables(cwd);
  const out = {};
  for (const v of glob) if (v.enabled) out[v.key] = { value: v.value, file: v.file };
  for (const v of project) if (v.enabled) out[v.key] = { value: v.value, file: v.file };
  for (const [k, v] of Object.entries(session)) {
    if (v === null || v === undefined) continue;
    out[k] = { value: String(v), file: out[k]?.file === true };
  }
  return out;
}

// Flat KEY=VALUE view of the above (file vars carry their raw content).
export function effectiveVariables(cwd, session = {}) {
  const out = {};
  for (const [k, v] of Object.entries(effectiveVariableEntries(cwd, session))) out[k] = v.value;
  return out;
}

// Split entries into what goes on the gcl command line (--variable) and what
// must travel via a generated --variables-file (file-type variables).
export function splitVariableEntries(entries) {
  const plain = {};
  const files = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v.file) files[k] = v.value;
    else plain[k] = v.value;
  }
  return { plain, files };
}

// Flatten entries for contexts that export real env vars (debug driver):
// file variables get their content written under .gcl-ui/tmp/ and resolve to
// that file's path — the same thing gcl does for its jobs. The tmp dir lives
// inside the project so container debug sees it through the bind mount.
export function materializeFileVariables(cwd, entries) {
  const out = {};
  let dir = null;
  for (const [k, v] of Object.entries(entries)) {
    if (!v.file) {
      out[k] = v.value;
      continue;
    }
    if (!dir) {
      dir = path.join(projectDir(cwd), "tmp", "file-variables");
      fs.mkdirSync(dir, { recursive: true });
    }
    const safe = k.replace(/[^\w-]/g, "_");
    const file = path.join(dir, safe);
    fs.writeFileSync(file, v.value);
    out[k] = file;
  }
  return out;
}

// Per-project UI settings (toggles, extra flags, breakpoints...) so the UI
// comes back exactly as you left it.
export function getSettings(cwd) {
  return readJson(path.join(projectDir(cwd), "settings.json"), {});
}

export function setSettings(cwd, settings) {
  writeJson(path.join(projectDir(cwd), "settings.json"), settings || {});
  return settings;
}
