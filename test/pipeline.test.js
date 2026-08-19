import { test } from "node:test";
import assert from "node:assert/strict";

const { sanitizePreview } = await import("../server/pipeline.js");

test("clean preview: leading --- stripped, yaml kept verbatim", () => {
  const { yaml, warnings } = sanitizePreview("---\nstages:\n  - build\n");
  assert.equal(yaml, "stages:\n  - build\n");
  assert.deepEqual(warnings, []);
});

test("predefined-var WARN block before --- is stripped and surfaced as a warning", () => {
  const stdout = [
    " WARN  Avoid overriding predefined variables [CI_COMMIT_SHA] as it can cause the pipeline to behave unexpectedly.",
    "If you know what you're doing and would like to suppress this warning, use one of the following methods:",
    "\t• via cli options",
    "\t\t• --ignore-predefined-vars CI_COMMIT_SHA",
    "\t• via environment variable",
    "\t\t• GCL_IGNORE_PREDEFINED_VARS=CI_COMMIT_SHA",
    "---",
    "variables:",
    "  CI_COMMIT_SHA: abc",
    "",
  ].join("\n");
  const { yaml, warnings } = sanitizePreview(stdout);
  assert.equal(yaml, "variables:\n  CI_COMMIT_SHA: abc\n");
  assert.deepEqual(warnings, [
    "Avoid overriding predefined variables [CI_COMMIT_SHA] as it can cause the pipeline to behave unexpectedly.",
  ]);
});

test("no --- marker: whole output treated as yaml", () => {
  const { yaml, warnings } = sanitizePreview("stages:\n  - build\n");
  assert.equal(yaml, "stages:\n  - build\n");
  assert.deepEqual(warnings, []);
});
