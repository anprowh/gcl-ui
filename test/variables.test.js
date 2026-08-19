import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point HOME at a scratch dir BEFORE importing server modules, so the global
// variable store (resolved from os.homedir() at import time) never touches
// the real user files.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gcl-ui-test-home-"));

const {
  getVariables,
  setVariables,
  effectiveVariables,
  effectiveVariableEntries,
  splitVariableEntries,
  materializeFileVariables,
} = await import("../server/variables.js");
const { buildArgs, makeVariablesFile } = await import("../server/gcl.js");

function tmpProject() {
  setVariables(process.cwd(), "global", []); // global store is per-HOME; keep tests independent
  return fs.mkdtempSync(path.join(os.tmpdir(), "gcl-ui-test-proj-"));
}

test("file flag round-trips through the store and defaults to false", () => {
  const cwd = tmpProject();
  setVariables(cwd, "project", [
    { key: "CERT", value: "-----BEGIN-----\nabc\n", file: true },
    { key: "PLAIN", value: "1" },
  ]);
  const { project } = getVariables(cwd);
  assert.deepEqual(project, [
    { key: "CERT", value: "-----BEGIN-----\nabc\n", enabled: true, file: true },
    { key: "PLAIN", value: "1", enabled: true, file: false },
  ]);
});

test("precedence session > project > global; disabled excluded; file flag follows the winning entry", () => {
  const cwd = tmpProject();
  setVariables(cwd, "global", [
    { key: "A", value: "global", file: true },
    { key: "B", value: "global-b" },
    { key: "OFF", value: "x", enabled: false },
  ]);
  setVariables(cwd, "project", [{ key: "A", value: "project", file: false }]);

  const entries = effectiveVariableEntries(cwd, { B: "session-b" });
  assert.deepEqual(entries, {
    A: { value: "project", file: false }, // project shadows global, including its file flag
    B: { value: "session-b", file: false },
  });
  assert.deepEqual(effectiveVariables(cwd, { B: "session-b" }), { A: "project", B: "session-b" });
});

test("session override of a file variable keeps file semantics", () => {
  const cwd = tmpProject();
  setVariables(cwd, "project", [{ key: "KUBECONFIG", value: "orig", file: true }]);
  const entries = effectiveVariableEntries(cwd, { KUBECONFIG: "override-content" });
  assert.deepEqual(entries, { KUBECONFIG: { value: "override-content", file: true } });
});

test("splitVariableEntries separates plain from file variables", () => {
  const { plain, files } = splitVariableEntries({
    A: { value: "1", file: false },
    C: { value: "content", file: true },
  });
  assert.deepEqual(plain, { A: "1" });
  assert.deepEqual(files, { C: "content" });
});

test("makeVariablesFile writes gcl file-type yaml and merges the project variables file", async () => {
  const YAML = (await import("yaml")).default;
  const cwd = tmpProject();
  fs.writeFileSync(path.join(cwd, ".gitlab-ci-local-variables.yml"), "EXISTING: keep\nCERT: shadowed\n");

  assert.equal(makeVariablesFile(cwd, {}), null);

  const rel = makeVariablesFile(cwd, { CERT: "line1\nline2\n" });
  assert.ok(rel && !path.isAbsolute(rel));
  const doc = YAML.parse(fs.readFileSync(path.join(cwd, rel), "utf8"));
  assert.equal(doc.EXISTING, "keep");
  assert.deepEqual(doc.CERT, { type: "file", values: { "*": "line1\nline2\n" } });
});

test("buildArgs passes --variables-file alongside --variable", () => {
  const args = buildArgs({ variables: { A: "1" }, variablesFile: ".gcl-ui/tmp/file-variables.gitlab-ci-local.yml" });
  assert.deepEqual(args, ["--variable", "A=1", "--variables-file", ".gcl-ui/tmp/file-variables.gitlab-ci-local.yml"]);
});

test("materializeFileVariables writes content under .gcl-ui/tmp and resolves to the path", () => {
  const cwd = tmpProject();
  const out = materializeFileVariables(cwd, {
    PLAIN: { value: "v", file: false },
    CERT: { value: "secret\n", file: true },
  });
  assert.equal(out.PLAIN, "v");
  assert.ok(out.CERT.startsWith(path.join(cwd, ".gcl-ui", "tmp", "file-variables")));
  assert.equal(fs.readFileSync(out.CERT, "utf8"), "secret\n");
});
