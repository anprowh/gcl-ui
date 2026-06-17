import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import { buildArgs, gclCapture, makeForcedIncludesFile } from "./gcl.js";

// Build the full pipeline model the UI renders from:
//   - gcl --list-json   → authoritative job list with resolved `when` (rules evaluated)
//   - gcl --preview     → expanded YAML (includes/extends/!reference resolved)
//   - the raw ci file   → inputs spec, variable metadata (description/options), include rules
export async function getPipeline(cwd, opts = {}) {
  const { variables = {}, inputs = {}, forceIncludes = false } = opts;
  let file = opts.file || null;

  const result = {
    cwd,
    file: file || ".gitlab-ci.yml",
    forcedIncludesActive: false,
    error: null,
    warnings: [],
    stages: [],
    jobs: [],
    includes: [],
    inputSpecs: [],
    variableSpecs: [],
    rawTriggers: {},
    expandedYaml: "",
    scriptMap: {},
  };

  // --- raw file analysis (works even when gcl can't parse, e.g. missing inputs)
  let rawText = "";
  try {
    rawText = fs.readFileSync(path.join(cwd, file || ".gitlab-ci.yml"), "utf8");
    analyzeRawFile(rawText, result);
  } catch (e) {
    result.error = `Cannot read ${file || ".gitlab-ci.yml"}: ${e.message}`;
    return result;
  }

  if (forceIncludes) {
    try {
      const patched = await makeForcedIncludesFile(cwd, file, YAML);
      if (patched) {
        file = patched;
        result.forcedIncludesActive = true;
      }
    } catch (e) {
      result.warnings.push(`force includes failed: ${e.message}`);
    }
  }
  result.effectiveFile = file || ".gitlab-ci.yml";

  const common = buildArgs({ variables, inputs, file });

  const [list, preview] = await Promise.all([
    gclCapture(cwd, ["--list-json", ...common]),
    gclCapture(cwd, ["--preview", ...common]),
  ]);

  if (list.code !== 0) {
    result.error = extractError(list.stderr || list.stdout);
    return result;
  }

  let listed = [];
  try {
    listed = parseListJson(list.stdout);
  } catch (e) {
    result.error = `Failed to parse gcl --list-json output: ${e.message}`;
    return result;
  }

  result.expandedYaml = preview.code === 0 ? preview.stdout.replace(/^---\n/, "") : "";

  let expanded = {};
  if (result.expandedYaml) {
    try {
      const lc = new YAML.LineCounter();
      const doc = YAML.parseDocument(result.expandedYaml, { lineCounter: lc });
      expanded = doc.toJS() || {};
      result.scriptMap = buildScriptMap(doc, lc);
    } catch (e) {
      result.warnings.push(`preview parse: ${e.message}`);
    }
  }

  const stages = Array.isArray(expanded.stages) ? expanded.stages : [".pre", "build", "test", "deploy", ".post"];
  result.globalVariables = expanded.variables && typeof expanded.variables === "object" ? expanded.variables : {};

  result.jobs = listed.map((j) => {
    const exp = expanded[j.name] || {};
    return {
      name: j.name,
      description: j.description || exp.description || "",
      stage: j.stage || exp.stage || "test",
      when: j.when,
      allowFailure: j.allow_failure ?? false,
      needs: (j.needs || []).map((n) => (typeof n === "string" ? { job: n } : n)),
      rules: j.rules || exp.rules || null,
      image: typeof exp.image === "string" ? exp.image : exp.image?.name || null,
      script: toLines(exp.script),
      beforeScript: toLines(exp.before_script),
      afterScript: toLines(exp.after_script),
      variables: exp.variables || {},
      artifacts: exp.artifacts || null,
      trigger: normalizeTrigger(exp.trigger) || result.rawTriggers[j.name] || null,
      environment: typeof exp.environment === "string" ? exp.environment : exp.environment?.name || null,
    };
  });

  const seen = new Set(result.jobs.map((j) => j.stage));
  result.stages = stages.filter((s) => seen.has(s));
  // keep any stage gcl knows about that's missing from `stages`
  for (const s of seen) if (!result.stages.includes(s)) result.stages.push(s);

  return result;
}

// gcl prints warnings to stdout before the --list-json array, and those
// warnings can themselves contain "[" (e.g. "Avoid overriding predefined
// variables ... [CI_REGISTRY] ..." when you override CI_REGISTRY). Slicing
// from the first "[" then breaks JSON.parse, so instead scan every "[" and
// return the first one that parses as a balanced JSON array.
function parseListJson(stdout) {
  for (let i = stdout.indexOf("["); i !== -1; i = stdout.indexOf("[", i + 1)) {
    const slice = balancedSlice(stdout, i);
    if (!slice) continue;
    try {
      const v = JSON.parse(slice);
      if (Array.isArray(v)) return v;
    } catch {
      /* this "[" wasn't the JSON array — keep scanning */
    }
  }
  throw new Error("no JSON array found in output");
}

// Return the substring from `start` (a "[" or "{") to its matching close
// bracket, honoring strings and escapes, or null if it never balances.
function balancedSlice(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "[" || c === "{") {
      depth++;
    } else if (c === "]" || c === "}") {
      if (--depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function toLines(script) {
  if (!script) return [];
  if (typeof script === "string") return [script];
  return script.map((s) => String(s));
}

function normalizeTrigger(trigger) {
  if (!trigger) return null;
  if (typeof trigger === "string") return { project: trigger };
  const out = { ...trigger };
  if (out.include && !Array.isArray(out.include)) out.include = [out.include];
  if (Array.isArray(out.include)) {
    out.include = out.include.map((i) => (typeof i === "string" ? { local: i } : i));
  }
  return out;
}

function extractError(text) {
  const lines = (text || "").split("\n").filter(Boolean);
  // gcl prints noisy git fallback warnings; keep the meaningful tail
  const interesting = lines.filter(
    (l) => !/falling back|fallback git|symbolic[- ]ref|get-url origin|No such remote|unknown revision/.test(l)
  );
  return (interesting.length ? interesting : lines).slice(0, 25).join("\n") || "gitlab-ci-local failed";
}

// GitLab CI top-level keys that are not jobs (so we don't mistake them for
// jobs when scanning the raw file for per-job triggers).
const RESERVED_TOP_KEYS = new Set([
  "stages", "variables", "include", "default", "workflow", "spec",
  "image", "services", "cache", "before_script", "after_script", "pages",
]);

// Parse the raw ci file for things the expanded view loses:
// spec.inputs (GitLab inputs header), variable metadata, include entries.
function analyzeRawFile(text, result) {
  let docs;
  try {
    docs = YAML.parseAllDocuments(text, { merge: true });
  } catch {
    return;
  }
  for (const doc of docs) {
    let body;
    try {
      body = doc.toJS({ maxAliasCount: 10_000 });
    } catch {
      continue;
    }
    if (!body || typeof body !== "object") continue;

    // Per-job trigger, straight from the raw file. The `trigger` shown in the
    // model is normally taken from `gcl --preview`, but if the preview fails
    // or its YAML won't parse, every job loses its trigger and the UI then
    // tries to run a trigger job by name (which gcl rejects). This is the
    // fallback so trigger jobs stay recognizable regardless of the preview.
    for (const [name, val] of Object.entries(body)) {
      if (RESERVED_TOP_KEYS.has(name)) continue;
      if (val && typeof val === "object" && val.trigger) {
        result.rawTriggers[name] = normalizeTrigger(val.trigger);
      }
    }

    if (body.spec?.inputs && typeof body.spec.inputs === "object") {
      for (const [name, raw] of Object.entries(body.spec.inputs)) {
        const spec = raw || {};
        result.inputSpecs.push({
          name,
          description: spec.description || "",
          type: spec.type || "string",
          default: spec.default !== undefined ? spec.default : null,
          required: spec.default === undefined,
          options: Array.isArray(spec.options) ? spec.options : null,
          source: "spec",
        });
      }
      continue; // spec header document holds nothing else
    }

    if (body.variables && typeof body.variables === "object") {
      for (const [name, raw] of Object.entries(body.variables)) {
        if (raw && typeof raw === "object") {
          result.variableSpecs.push({
            name,
            value: raw.value !== undefined ? String(raw.value) : "",
            description: raw.description || "",
            options: Array.isArray(raw.options) ? raw.options.map(String) : null,
          });
        } else {
          result.variableSpecs.push({ name, value: String(raw ?? ""), description: "", options: null });
        }
      }
    }

    let includes = body.include;
    if (includes) {
      if (!Array.isArray(includes)) includes = [includes];
      result.includes = includes.map((inc) => {
        if (typeof inc === "string") return { ref: inc, kind: "local", rules: null, inputs: null };
        const kind = inc.local ? "local" : inc.remote ? "remote" : inc.template ? "template" : inc.component ? "component" : inc.project ? "project" : "unknown";
        return {
          ref: inc.local || inc.remote || inc.template || inc.component || inc.project || JSON.stringify(inc),
          kind,
          file: inc.file || null,
          rules: inc.rules || null,
          inputs: inc.inputs || null,
        };
      });
    }
  }
}

// Map every script line of every job in the expanded YAML to its position,
// so the debug editor can offer breakpoints on script steps.
function buildScriptMap(doc, lc) {
  const map = {};
  const contents = doc.contents;
  if (!YAML.isMap(contents)) return map;
  for (const pair of contents.items) {
    const jobName = String(pair.key?.value ?? "");
    const val = pair.value;
    if (!YAML.isMap(val) || !val.has("script")) continue;
    const entry = {};
    for (const section of ["before_script", "script", "after_script"]) {
      const node = val.get(section, true);
      if (!node) continue;
      const items = YAML.isSeq(node) ? node.items : [node];
      entry[section] = items.map((item, idx) => {
        const startLine = lc.linePos(item.range?.[0] ?? 0).line;
        const endLine = lc.linePos(Math.max((item.range?.[1] ?? 1) - 1, 0)).line;
        return {
          index: idx,
          line: startLine,
          endLine,
          text: String(item.value ?? ""),
        };
      });
    }
    if (Object.keys(entry).length) map[jobName] = entry;
  }
  return map;
}
