# SPEC — gcl-ui

## §G goal
Web UI wrap gitlab-ci-local. Visualize pipeline, run jobs, inspect output/artifacts, debug scripts with breakpoints. All local, in browser.

## §C constraints
- Node >=18, ESM only.
- Server: Express + ws + node-pty + yaml. `server/`.
- Frontend: React 18 + Vite SPA. `web/`. No state lib — own store `web/src/store.js`.
- Wraps `gitlab-ci-local` binary: PATH first, else bundled copy, else `GCL_UI_GCL_BIN`.
- Pipeline model from `gcl --list-json` (authoritative `when`) + `gcl --preview` (expanded YAML) + raw CI file parse (inputs spec, var metadata, include rules).
- Single-file exe via `bun --compile` (`npm run build:exe`); UI embedded in-memory; node-pty unavailable in binary → util-linux `script` PTY backend on Linux, no live resize.
- Debug driver script must parse under POSIX sh AND bash; container debug needs only `/bin/sh` in image.
- Container debug: docker/podman autodetect, override `GCL_UI_CONTAINER_EXECUTABLE`; project bind-mounted at real path.
- No test suite exist.

## §I interfaces
- CLI: `gcl-ui [directory] [-p|--port N] [--host H] [--no-open] [--dev]`. Default bind 127.0.0.1, first free port from 8275, open browser.
- HTTP API (`server/index.js`):
  - GET `/api/project` — cwd, name, branch, gclVersion, ciFile, dirs.
  - POST `/api/pipeline` — {variables, inputs, forceIncludes, file} → model.
  - GET/PUT `/api/variables` — scope project|global.
  - GET/PUT `/api/settings` — per-project UI state.
  - GET `/api/runs`, GET `/api/runs/:id?after=seq`, POST `/api/run`, POST `/api/runs/:id/cancel`.
  - GET `/api/runs/:id/joblog?job=` — raw gcl log file, per-run stateDir.
  - GET `/api/artifacts`, GET `/api/logs`, GET `/api/file?base=&path=`, GET `/api/file/raw`.
  - GET `/api/debug`, POST `/api/debug/start`, GET `/api/debug/:id/scrollback`, POST `/api/debug/:id/continue`, POST `/api/debug/:id/abort`, DELETE `/api/debug/:id`.
  - Static: `/artifact/*` → `.gitlab-ci-local/artifacts/`, `/joblog/*` → `.gitlab-ci-local/output/` (iframe HTML render).
- WS `/ws`: server→client `hello`, `run.started`, `run.lines`, `run.job`, `run.done`, `artifacts.changed`, `debug.data`, `debug.update`; client→server `debug.input`, `debug.resize`.
- Env: `GCL_UI_GCL_BIN`, `GCL_UI_CONTAINER_EXECUTABLE`, `GCL_UI_DEBUG` (set inside driver).
- Disk state: `<project>/.gcl-ui/variables.json`, `<project>/.gcl-ui/settings.json`, `<project>/.gcl-ui/tmp/` (patched CI files, drivers), `~/.settings/gcl-ui/variables.json` (global).
- Debug events: private OSC 7770 escape in PTY stream, server parse via `OSC_RE` (`server/debug.js:124`).

## §V invariants
- V1: file-serving endpoints (`/api/file`, `/api/file/raw`, `/api/runs/:id/joblog`) resolve path inside allowed root; escape → 400 "path escapes root". Job name with `/`, `\`, `..` rejected.
- V2: variable precedence session > project > global; `enabled:false` vars excluded (`server/variables.js effectiveVariables`).
- V3: file/log reads capped 4MB; response carry `truncated:true` when over.
- V4: joblog filename encode: each run of chars outside `[A-Za-z0-9_-]` → base64, padding stripped; fallback raw name (`server/index.js:133`).
- V5: gcl child env: all `GCL_UI_*` vars stripped before spawn (`server/gcl.js:13`).
- V6: run line classification: known-job prefix match longest-first; child lines `[trigger] -> job` parsed; run buffer capped 50_000 lines (`server/runs.js`).
- V7: debug driver parse clean under POSIX sh and bash; uses bash readline only when running under bash.
- V8: SPA fallback (embedded + staticDir modes) never shadow `/api`, `/ws`, `/artifact`, `/joblog`.
- V9: WS `hello` on connect carries current runs + debugSessions so late clients recover state.
- V10: default bind 127.0.0.1 — server never exposed off-host unless `--host` given.
- V11: user volumes pass verbatim to executor (`--volume` for gcl runs, `-v` for debug container); empty/whitespace entries dropped; run + debug always mount same list.
- V12: effective volumes = global list ∪ project list (global first, exact-string dedupe); global persist `~/.settings/gcl-ui/settings.json`, project persist `<project>/.gcl-ui/settings.json`.

## §T tasks
id|status|desc|cites
T1|.|test classifyLine: prefix longest-first, PASS/FAIL, child `[t] -> job` forms|V6
T2|.|test effectiveVariables precedence + enabled toggle|V2
T3|.|test path-escape guards + joblog safe-name base64 encode|V1,V4
T4|.|test buildDriver output pass `sh -n` and `bash -n`|V7
T5|.|test getPipeline model on sample .gitlab-ci.yml (stages, inputs, triggers)|I.api
T6|x|gitignore stray built binary `gcl-ui` in repo root|
T7|x|support file-type variables (GitLab `variables: X: {file: true}` semantics; pass to gcl, editable in UI)|V2,I.api
T8|x|full ignore of predefined vars: user-defined predefined vars inject warning text + `---` into `--preview` → Debug tab expanded YAML breaks, debug unusable. Sanitize preview / use GCL_IGNORE_PREDEFINED_VARS|I.api
T9|.|volume support: `volumes` string array (`src:dst[:mode]`) in run opts → repeated `--volume` in buildArgs (`server/gcl.js`)|V11,I.api
T10|.|volumes UI: editable list in TopBar run options, project + global scope tabs (like variables); project → settings.json, global → `~/.settings/gcl-ui/settings.json`|V12,I.api
T11|.|debug container mount same `volumes` list (extra `-v` per entry, `server/debug.js` ~:307) — parity with run env|V11

## §B bugs
id|date|cause|fix
