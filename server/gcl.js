import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findGclBin, shellSplit, projectDir } from "./util.js";

// Build the argv for a gitlab-ci-local invocation from structured options.
export function buildArgs(opts = {}) {
  const args = [];
  if (Array.isArray(opts.jobs)) args.push(...opts.jobs);
  if (opts.needs) args.push("--needs");
  if (opts.onlyNeeds) args.push("--only-needs");
  if (opts.stage) args.push("--stage", opts.stage);
  for (const m of opts.manual || []) args.push("--manual", m);
  for (const [k, v] of Object.entries(opts.variables || {})) args.push("--variable", `${k}=${v}`);
  for (const [k, v] of Object.entries(opts.inputs || {})) {
    if (v !== "" && v !== null && v !== undefined) args.push("--input", `${k}=${v}`);
  }
  if (opts.file) args.push("--file", opts.file);
  if (opts.stateDir) args.push("--state-dir", opts.stateDir);
  if (opts.noArtifactsToSource === false) args.push("--artifacts-to-source");
  if (opts.shellIsolation) args.push("--shell-isolation");
  if (opts.forceShellExecutor) args.push("--force-shell-executor");
  if (opts.mountCache) args.push("--mount-cache");
  if (opts.privileged) args.push("--privileged");
  if (opts.cleanup) args.push("--cleanup");
  if (opts.evaluateRuleChanges === false) args.push("--evaluate-rule-changes", "false");
  if (opts.fetchIncludes) args.push("--fetch-includes");
  if (opts.extraFlags) args.push(...shellSplit(opts.extraFlags));
  return args;
}

// Run gcl and capture stdout/stderr fully (for --list-json / --preview).
export function gclCapture(cwd, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const bin = findGclBin();
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      timeout,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Spawn gcl for a streaming run. Returns the child process. Runs in its own
// process group so cancellation can kill the whole tree.
export function gclSpawn(cwd, args) {
  const bin = findGclBin();
  return spawn(bin, args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: "1" },
    detached: true,
  });
}

// If "force includes" is on we rewrite the root CI file with include rules
// stripped, so every include is pulled in regardless of its rules, and run
// gcl against the patched copy. Returns the --file value to use (relative
// to cwd) or null when no patching is needed.
export async function makeForcedIncludesFile(cwd, file, YAML) {
  const src = path.join(cwd, file || ".gitlab-ci.yml");
  const text = fs.readFileSync(src, "utf8");
  const docs = YAML.parseAllDocuments(text);
  let changed = false;
  for (const doc of docs) {
    const inc = doc.get?.("include");
    if (!inc || !YAML.isSeq(inc)) continue;
    for (const item of inc.items) {
      if (YAML.isMap(item) && item.has("rules")) {
        item.delete("rules");
        changed = true;
      }
    }
  }
  if (!changed) return null;
  const outDir = path.join(projectDir(cwd), "tmp");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "forced-includes.gitlab-ci.yml");
  fs.writeFileSync(out, docs.map((d) => d.toString()).join("---\n"));
  return path.relative(cwd, out);
}
