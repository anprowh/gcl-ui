import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { projectDir, findContainerRuntime } from "./util.js";

// Debug terminals need a PTY. We support two backends and pick automatically:
//
//   - node-pty (native addon): used when running under Node (source / npm
//     install). Full featured, including live resize.
//   - `script` (util-linux): used in the packaged single-file binary, which
//     runs under the Bun runtime where the node-pty native addon is unreliable.
//     `script` provides a real PTY as an ordinary child process over pipes,
//     which the Bun runtime handles dependably. Linux-only (matches the binary's
//     target); initial size is honored, live resize is a no-op.
//
// Either way the rest of gcl-ui works even if no PTY backend is available.
const require = createRequire(import.meta.url);
const isBun = typeof globalThis.Bun !== "undefined" || !!process.versions?.bun;

let pty = null;
let ptyError = null;
if (!isBun) {
  try {
    pty = require("node-pty");
  } catch (e) {
    ptyError = e;
  }
}

const scriptAvailable = (() => {
  try {
    execFileSync("script", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const debugAvailable = !!pty || scriptAvailable;

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Spawn argv in a PTY, returning a small uniform handle. Prefers node-pty;
// falls back to util-linux `script`.
function startPty(argv, { cwd, env, cols = 120, rows = 30 }) {
  if (pty) {
    const term = pty.spawn(argv[0], argv.slice(1), { name: "xterm-256color", cols, rows, cwd, env });
    return {
      backend: "node-pty",
      pid: term.pid,
      onData: (cb) => term.onData(cb),
      onExit: (cb) => term.onExit(({ exitCode }) => cb(exitCode)),
      write: (d) => term.write(d),
      resize: (c, r) => {
        try {
          term.resize(c, r);
        } catch {}
      },
      kill: (s) => {
        try {
          term.kill(s);
        } catch {}
      },
    };
  }
  // `script -q -e -c CMD /dev/null`: -q quiet, -e propagate child exit code.
  // We set the initial window size with stty inside the PTY before exec'ing.
  const cmd = `stty rows ${rows | 0} cols ${cols | 0} 2>/dev/null; exec ${argv.map(shq).join(" ")}`;
  const child = spawn("script", ["-q", "-e", "-c", cmd, "/dev/null"], {
    cwd,
    env: { ...env, TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const dataCbs = [];
  const exitCbs = [];
  const emit = (s) => {
    for (const cb of dataCbs) cb(s);
  };
  child.stdout.on("data", (d) => emit(d.toString("utf8")));
  child.stderr.on("data", (d) => emit(d.toString("utf8")));
  child.on("error", (e) => emit(`\r\n\x1b[31mgcl-ui: ${e.message}\x1b[0m\r\n`));
  child.on("close", (code) => {
    for (const cb of exitCbs) cb(code == null ? 0 : code);
  });
  return {
    backend: "script",
    pid: child.pid,
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    write: (d) => {
      try {
        child.stdin.write(d);
      } catch {}
    },
    resize: () => {}, // the script-owned PTY master isn't reachable for live resize
    kill: (s) => {
      try {
        child.kill(s || "SIGTERM");
      } catch {}
    },
  };
}

// Debug mode: we re-create the job's shell session ourselves (shell-executor
// semantics) so we can pause between script steps. At a breakpoint the very
// same shell that is executing the job turns interactive — a `read` + `eval`
// loop inside the job shell — so every variable and function of the job is
// inspectable and mutable. Step/breakpoint events ride on a private OSC escape
// sequence (number 7770) that terminals ignore but the server parses.
//
// Two execution targets:
//   - host:      a bash shell on the machine running gcl-ui (rich readline).
//   - container: the job's `image:` run via docker/podman. The project dir is
//                bind-mounted at its real path, so the generated driver script
//                (which lives under <cwd>/.gcl-ui/tmp) is already visible inside
//                the container — no extra tooling needs to exist in the image
//                beyond /bin/sh. The driver is intentionally POSIX-sh clean so
//                it runs on minimal images (busybox/alpine/distroless-with-sh).

const OSC_RE = /\x1b\]7770;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

// Build the driver. It is written to parse cleanly under POSIX sh *and* bash,
// and opportunistically uses bash readline (history, line editing) at runtime
// when it happens to be running under bash — so a single script serves the host
// (always bash) and containers (bash when present, otherwise /bin/sh). Note the
// user's own job script is embedded verbatim, so it still requires whatever
// shell it was written for; that's why we prefer bash to run this driver.
export function buildDriver({ cwd, variables, steps, breakpoints }) {
  const bp = new Set(breakpoints);
  const L = [];
  L.push("#!/usr/bin/env bash");
  L.push("# generated by gcl-ui debug mode");
  L.push("__gcl_osc() { printf '\\033]7770;%s\\007' \"$1\"; }");

  // The breakpoint loop: bash branch gets readline (-e) + history; the sh
  // branch uses a plain prompt + read. dash parses both branches fine (the
  // bash-only options are runtime args, not syntax) and only ever runs the
  // sh branch.
  L.push(`__gcl_break() {
  __gcl_osc "break=$1"
  printf '\\n\\033[1;35m● paused at %s\\033[0m\\n' "$1"
  printf '\\033[2m  this shell IS the job shell — inspect/change variables freely\\033[0m\\n'
  printf '\\033[2m  :c continue · :q abort job · anything else runs in job context\\033[0m\\n'
  while true; do
    if [ -n "$BASH_VERSION" ]; then
      IFS= read -e -r -p "$(printf '\\001\\033[1;35m\\002debug ▸ \\001\\033[0m\\002')" __gcl_cmd || { echo; break; }
      history -s -- "$__gcl_cmd" 2>/dev/null
    else
      printf '\\033[1;35mdebug ▸ \\033[0m'
      IFS= read -r __gcl_cmd || { echo; break; }
    fi
    case "$__gcl_cmd" in
      :c|:cont|:continue) break ;;
      :q|:quit|:abort) __gcl_osc "abort=$1"; exit 130 ;;
      "") ;;
      *) eval "$__gcl_cmd" ;;
    esac
  done
  __gcl_osc "resume=$1"
}`);
  L.push("");
  for (const [k, v] of Object.entries(variables)) {
    L.push(`export ${k}=${shq(v)}`);
  }
  L.push(`cd ${shq(cwd)} 2>/dev/null || true`);
  // pipefail where supported (bash/ksh), silently skipped on dash/busybox
  L.push("if ( set -o pipefail ) 2>/dev/null; then set -o pipefail; fi");
  L.push("");

  // each step becomes a function so multi-line steps stay intact while still
  // running in the top-level shell (variables persist across steps)
  steps.forEach((step, i) => {
    L.push(`__gcl_step_${i}() {`);
    L.push(step.text);
    L.push("}");
  });
  L.push("");

  steps.forEach((step, i) => {
    const id = step.id;
    L.push(`__gcl_osc "step=${id}"`);
    if (bp.has(id)) L.push(`__gcl_break ${shq(id)}`);
    for (const line of step.text.split("\n")) {
      L.push(`printf '\\033[32m$ %s\\033[0m\\n' ${shq(line)}`);
    }
    L.push(`__gcl_step_${i}`);
    L.push(`__rc=$?`);
    L.push(`if [ "$__rc" -ne 0 ]; then`);
    L.push(`  __gcl_osc "steprc=${id},$__rc"`);
    L.push(
      `  printf '\\n\\033[1;31m✗ step failed (exit %s)\\033[0m \\033[2m— job shell kept alive for inspection; :c runs the next step anyway, :q aborts\\033[0m\\n' "$__rc"`
    );
    L.push(`  __gcl_break ${shq(id + " (failed)")}`);
    L.push(`fi`);
    L.push("");
  });
  L.push('__gcl_osc "done=0"');
  L.push(`printf '\\n\\033[1;32m✓ job script finished\\033[0m\\n'`);
  L.push("exit 0");
  return L.join("\n") + "\n";
}

export class DebugManager {
  constructor(cwd, broadcast) {
    this.cwd = cwd;
    this.broadcast = broadcast;
    this.sessions = new Map();
  }

  list() {
    return [...this.sessions.values()].map((s) => this.summary(s));
  }

  summary(s) {
    return {
      id: s.id,
      job: s.job,
      status: s.status,
      currentStep: s.currentStep,
      pausedAt: s.pausedAt,
      breakpoints: s.breakpoints,
      createdAt: s.createdAt,
      exitCode: s.exitCode,
      mode: s.mode,
      image: s.image || null,
      runtime: s.runtime || null,
    };
  }

  capabilities() {
    return { containerRuntime: findContainerRuntime(), ptyAvailable: debugAvailable };
  }

  // job: pipeline job object; breakpoints: array of step ids ("script:1")
  // container: run inside job.image via docker/podman when available
  start({ job, breakpoints = [], variables = {}, cols = 120, rows = 30, container = false }) {
    if (!debugAvailable) {
      throw new Error(
        "debug terminals need a PTY backend: either the native node-pty module" +
          (ptyError ? ` (${ptyError.message})` : "") +
          " or the util-linux `script` command, neither of which is available here."
      );
    }
    const steps = [];
    for (const [section, list] of [
      ["before_script", job.beforeScript || []],
      ["script", job.script || []],
    ]) {
      list.forEach((text, i) => steps.push({ id: `${section}:${i}`, text }));
    }
    if (!steps.length) throw new Error(`job ${job.name} has no script to debug`);

    const runtime = findContainerRuntime();
    const useContainer = container && job.image && runtime;
    if (container && job.image && !runtime) {
      throw new Error("no container runtime found (install docker or podman, or set GCL_UI_CONTAINER_EXECUTABLE)");
    }
    if (container && !job.image) {
      throw new Error(`job ${job.name} has no image — nothing to run a container from`);
    }

    // precedence (weakest → strongest): CI defaults, yaml variables
    // (global+job, merged by the client), user stores / session overrides
    const vars = {
      CI: "true",
      GITLAB_CI: "false",
      GCL_UI_DEBUG: "1",
      CI_PROJECT_DIR: this.cwd,
      CI_JOB_NAME: job.name,
      CI_JOB_STAGE: job.stage,
      ...(job.variables || {}),
      ...variables,
    };

    const id = crypto.randomBytes(5).toString("hex");
    const dir = path.join(projectDir(this.cwd), "tmp");
    fs.mkdirSync(dir, { recursive: true });
    const scriptFile = path.join(dir, `debug-${id}.sh`);
    fs.writeFileSync(scriptFile, buildDriver({ cwd: this.cwd, variables: vars, steps, breakpoints }), {
      mode: 0o755,
    });

    let argv;
    let containerName = null;
    if (useContainer) {
      containerName = `gclui-debug-${id}`;
      // Run the driver under bash when the image has it (most CI scripts are
      // bash), otherwise fall back to /bin/sh with a visible warning. The
      // bootstrap is plain POSIX sh so it runs on minimal images; $0 is the
      // driver path. The project is bind-mounted at its real path so the
      // driver (under <cwd>/.gcl-ui/tmp) and all sources are already visible.
      const bootstrap =
        'if command -v bash >/dev/null 2>&1; then exec bash "$0"; ' +
        'else printf \'\\033[2m[gcl-ui] bash not found in image — running under /bin/sh; bash-only script syntax may fail\\033[0m\\n\' >&2; exec /bin/sh "$0"; fi';
      argv = [
        runtime,
        "run",
        "--rm",
        "-i",
        "-t",
        "--name",
        containerName,
        "-v",
        `${this.cwd}:${this.cwd}`,
        "-w",
        this.cwd,
        "-e",
        "TERM=xterm-256color",
        "--entrypoint",
        "/bin/sh",
        job.image,
        "-c",
        bootstrap,
        scriptFile,
      ];
    } else {
      argv = ["bash", scriptFile];
    }

    const term = startPty(argv, { cwd: this.cwd, env: { ...process.env, TERM: "xterm-256color" }, cols, rows });

    const session = {
      id,
      job: job.name,
      steps,
      breakpoints,
      status: "running",
      currentStep: null,
      pausedAt: null,
      createdAt: Date.now(),
      exitCode: null,
      term,
      scriptFile,
      mode: useContainer ? "container" : "host",
      image: useContainer ? job.image : null,
      runtime: useContainer ? runtime : null,
      containerName,
      oscTail: "",
      scrollback: [],
      scrollbackSize: 0,
      totalBytes: 0,
    };
    this.sessions.set(id, session);

    term.onData((data) => {
      const offset = session.totalBytes;
      session.totalBytes += data.length;
      session.scrollback.push(data);
      session.scrollbackSize += data.length;
      while (session.scrollbackSize > 2_000_000 && session.scrollback.length > 1) {
        session.scrollbackSize -= session.scrollback.shift().length;
      }
      this.parseOsc(session, data);
      this.broadcast({ type: "debug.data", sessionId: id, data, offset });
    });
    term.onExit((exitCode) => {
      session.status = exitCode === 0 ? "finished" : exitCode === 130 ? "aborted" : "failed";
      session.exitCode = exitCode;
      session.pausedAt = null;
      this.broadcast({ type: "debug.update", session: this.summary(session) });
      fs.rm(scriptFile, { force: true }, () => {});
      this.killContainer(session);
    });

    if (useContainer) {
      // a UI-only banner: pushed straight into the client stream + scrollback,
      // NOT written to the pty (that would echo back as literal control chars)
      this.pushLocal(session, `\x1b[2m[gcl-ui] starting ${runtime} container from ${job.image} …\x1b[0m\r\n`);
    }

    this.broadcast({ type: "debug.update", session: this.summary(session) });
    return this.summary(session);
  }

  // inject server-originated text into a session's output stream
  pushLocal(session, data) {
    const offset = session.totalBytes;
    session.totalBytes += data.length;
    session.scrollback.push(data);
    session.scrollbackSize += data.length;
    this.broadcast({ type: "debug.data", sessionId: session.id, data, offset });
  }

  killContainer(session) {
    if (!session.containerName || !session.runtime) return;
    // best-effort: --rm usually handles it, but make sure on abort/kill
    execFile(session.runtime, ["rm", "-f", session.containerName], () => {});
  }

  parseOsc(session, data) {
    const text = session.oscTail + data;
    session.oscTail = text.slice(-128);
    OSC_RE.lastIndex = 0;
    let m;
    let changed = false;
    while ((m = OSC_RE.exec(text))) {
      const [key, value] = m[1].split("=");
      if (key === "step") {
        session.currentStep = value;
        session.pausedAt = null;
        changed = true;
      } else if (key === "break") {
        session.pausedAt = value;
        session.status = "paused";
        changed = true;
      } else if (key === "resume") {
        session.pausedAt = null;
        session.status = "running";
        changed = true;
      } else if (key === "done") {
        session.currentStep = null;
        changed = true;
      }
    }
    // avoid re-parsing the same escapes when they sit inside the kept tail
    session.oscTail = session.oscTail.replace(OSC_RE, "");
    if (changed) this.broadcast({ type: "debug.update", session: this.summary(session) });
  }

  input(id, data) {
    this.sessions.get(id)?.term.write(data);
  }

  resize(id, cols, rows) {
    try {
      this.sessions.get(id)?.term.resize(cols, rows);
    } catch {}
  }

  continue(id) {
    const s = this.sessions.get(id);
    if (s && s.status === "paused") s.term.write(":c\r");
  }

  abort(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.status === "paused") s.term.write(":q\r");
    else {
      try {
        s.term.kill("SIGKILL");
      } catch {}
      this.killContainer(s);
    }
  }

  // returns the buffered output plus the absolute byte offset of its end,
  // so clients can drop live chunks that are already included
  scrollback(id) {
    const s = this.sessions.get(id);
    if (!s) return { data: "", end: 0 };
    return { data: s.scrollback.join(""), end: s.totalBytes };
  }

  dispose(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.term.kill("SIGKILL");
    } catch {}
    this.killContainer(s);
    this.sessions.delete(id);
  }
}
