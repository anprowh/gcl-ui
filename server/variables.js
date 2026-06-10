import path from "node:path";
import { GLOBAL_DIR, projectDir, readJson, writeJson } from "./util.js";

// Variable stores.
//  - project scope lives in   <project>/.gcl-ui/variables.json
//  - global  scope lives in   ~/.settings/gcl-ui/variables.json
// Each store is a list of { key, value, enabled } entries so users can keep
// a variable around but toggle it off for a run.

function projectFile(cwd) {
  return path.join(projectDir(cwd), "variables.json");
}
const globalFile = path.join(GLOBAL_DIR, "variables.json");

function normalize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((v) => v && typeof v.key === "string" && v.key.trim())
    .map((v) => ({ key: v.key.trim(), value: String(v.value ?? ""), enabled: v.enabled !== false }));
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

// Merge stores + per-run session overrides into a flat KEY=VALUE map.
// Precedence: session > project > global.
export function effectiveVariables(cwd, session = {}) {
  const { project, global: glob } = getVariables(cwd);
  const out = {};
  for (const v of glob) if (v.enabled) out[v.key] = v.value;
  for (const v of project) if (v.enabled) out[v.key] = v.value;
  for (const [k, v] of Object.entries(session)) {
    if (v === null || v === undefined) continue;
    out[k] = String(v);
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
