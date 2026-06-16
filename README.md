# gcl-ui

A friendly web UI wrapper around [gitlab-ci-local](https://github.com/firecow/gitlab-ci-local):
visualize your pipeline, run jobs, inspect outputs/artifacts and **debug job scripts with
breakpoints** — all locally, in the browser.

## Quick start

```bash
# in this repo
npm install
npm run build

# then, from any project that has a .gitlab-ci.yml
node /path/to/gcl-ui/bin/gcl-ui.js          # or `npm i -g .` once and just run: gcl-ui
```

`gcl-ui` starts a local server (127.0.0.1, first free port from 8275) and opens the UI in
your browser. It uses the `gitlab-ci-local` from your `PATH` if present, otherwise the copy
bundled with gcl-ui.

```
Usage: gcl-ui [directory] [options]
  -p, --port <port>   port to listen on
  --host <host>       host to bind (default 127.0.0.1)
  --no-open           don't open the browser
  --dev               vite dev server with HMR (for hacking on gcl-ui)
```

## What it does

### Pipeline graph
Stages as columns, `needs` as edges (GitLab-style). Hover a job to highlight its dependency
chain; click for the full details panel (rules, script, variables, artifacts, needs).
Live status while runs are in progress.

### Running jobs
- **▶ Run pipeline** runs everything; the **play button on a job card** runs just that job
  (with `--needs` by default — configurable).
- **Run a whole stage** with the ▶ button on any stage header (`--stage <name>`).
- **Run several jobs at once**: tick the ☐ on each card (or Ctrl/⌘-click cards) and hit
  **▶ Run N jobs** in the floating selection bar; "select all" is one click away.
- **Jobs whose rules don't match** (`when: never`) are shown dashed with a `rules: never`
  badge. Their play button becomes **⚡ force run** — gitlab-ci-local runs explicitly named
  jobs regardless of rules, and the UI makes that explicit instead of hiding it.
- The job panel shows **every rule with a best-effort verdict** (`✓ matched / ✕ no match /
  ? can't evaluate`) computed against your current variables, next to the authoritative
  `when` resolved by gitlab-ci-local.
- **Force includes**: includes gated by `rules:` are listed in the topbar popover; a toggle
  strips include rules (via a patched copy of the CI file) so every include is loaded.
- **Options popover**: `--needs`, `--only-needs`, force rules, force includes,
  `--evaluate-rule-changes`, `--shell-isolation`, `--force-shell-executor`, `--mount-cache`,
  `--privileged`, `--cleanup` … plus a free-form **extra flags** field appended to every
  invocation.

### Variables & inputs
- **Project variables** live in `<project>/.gcl-ui/variables.json`; **global variables**
  (used in every session) in `~/.settings/gcl-ui/variables.json`. Both editable in the UI,
  with per-variable enable/disable. Passed as `--variable KEY=value`
  (precedence: pipeline form > project > global).
- The **pipeline form** is generated like GitLab's "Run pipeline" page: `spec:inputs`
  (passed as `--input`) and `variables:` declared with `description:`/`options:` become
  proper form fields (dropdowns for options, defaults pre-filled, reset buttons).
  Changing values re-evaluates rules.

### Output, artifacts, diffs
- **Live job output** streams into the Output tab with ANSI colors, command/section
  highlighting, per-job filter chips with live status, text search, follow-mode and run
  history. Toggle **per-job** mode for a grid of independent, live-following panes — one
  per job (and one per child pipeline), each with its own status, duration and scroll.
- **Artifacts browser**: tree of `.gitlab-ci-local/artifacts/<job>/`, with in-browser
  preview — syntax highlighting for yaml/json/shell/logs, image preview, a **git diff
  viewer** for `.patch`/`.diff` artifacts (per-file collapsible hunks, +/− line numbers),
  and **inline HTML rendering**: `.html` artifacts render in a sandboxed iframe served from
  a real static path, so relative assets resolve and their JavaScript runs exactly as if
  opened standalone (with rendered/source toggle and an open-in-new-tab button).
- **⧉ copy path** buttons everywhere: artifact files, artifact folders, job output logs
  (`.gitlab-ci-local/output/<job>.log`), and the equivalent CLI command for any run.

### Debug mode (breakpoints in the expanded YAML)
The Debug tab shows the **expanded** pipeline (`--preview`: includes/extends/!reference
resolved) in an editor. Script steps get a clickable gutter — set breakpoints (●), then
start a session:

- the job's script runs step by step in a real PTY shown in the embedded terminal;
- at a breakpoint **the terminal is the job's own shell** — `echo $VAR`, change variables,
  source files… everything affects the running job;
- `:c` (or the Continue button) resumes, `:q` aborts;
- **failing steps pause automatically** for post-mortem inspection;
- the editor highlights the executing step, and the paused line in purple.

**Where it runs.** By default debug runs with shell-executor semantics on your machine
(CI variables, global + job + your variables exported). For jobs that declare an `image`,
flip **🐳 in container** (on by default when docker/podman is detected): gcl-ui starts the
image, bind-mounts your project at its real path, and runs the breakpoint shell *inside the
container* — so variables, tools and filesystem are the container's. The generated driver
is deliberately POSIX-sh and needs only `/bin/sh` in the image (no bash/extra tooling), so
it works on minimal images. Set `GCL_UI_CONTAINER_EXECUTABLE` to force a specific runtime.

### Triggered (child) pipelines
- Running the full pipeline uses gitlab-ci-local's native downstream support; child job
  status (`[trigger] -> job`) is parsed and shown on the trigger job card (`2/2 child ✓`)
  and as filter chips in the output.
- Trigger jobs (`trigger: include: artifact:`) get a panel section to **run the generated
  child pipeline directly** (`--file <artifact>`, isolated state dir) and to **preview the
  child pipeline graph** parsed from the artifact.

## State on disk

| Path | Purpose |
|---|---|
| `<project>/.gcl-ui/variables.json` | project variables |
| `<project>/.gcl-ui/settings.json` | UI state: toggles, extra flags, form values, breakpoints |
| `<project>/.gcl-ui/tmp/` | patched CI files (force includes), debug drivers |
| `~/.settings/gcl-ui/variables.json` | global variables |

Add `.gcl-ui/` to your project's `.gitignore`.

## Single-file executable

Build a self-contained binary that runs without Node, npm, or `node_modules`:

```bash
npm run build:exe          # binary for the current OS/arch → dist-bin/
npm run build:exe:all      # linux, macOS, Windows (x64 + arm64)
```

This builds the frontend, embeds it in-memory, and compiles everything into one
file with `bun --compile` (install bun from https://bun.sh). The binary serves
the whole UI from memory — no files on disk.

A ready-to-run **`build-executable` CI job** is included in `.gitlab-ci.yml`, so
you can produce the binaries with gcl-ui itself (open gcl-ui in this repo and hit
▶ on `build-executable`); the artifacts land in `dist-bin/`.

Runtime requirements of the binary:
- **`gitlab-ci-local`** must be reachable — on `PATH`, or via `GCL_UI_GCL_BIN`
  (gcl-ui is a wrapper around it).
- a **container runtime** (docker/podman) only if you use container debug.
- **Debug terminals** rely on the native `node-pty` addon, which can't be
  embedded into the single file; the binary detects this and disables debug
  cleanly (everything else works). For debug, run gcl-ui from an `npm install`.

## Development

```bash
npm install
npm run dev          # server + vite middleware with HMR on http://localhost:8275
npm run build        # production bundle to web/dist
```

Architecture: `server/` is an Express + WebSocket app that wraps gitlab-ci-local
(`--list-json` + `--preview` for the model, streamed spawns for runs, node-pty for debug
sessions); `web/` is a React (Vite) SPA. Job/step events during debug ride on a private
OSC escape sequence that terminals ignore but the server parses.
