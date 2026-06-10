import crypto from "node:crypto";
import { buildArgs, gclSpawn, makeForcedIncludesFile } from "./gcl.js";
import { stripAnsi } from "./util.js";
import * as YAML from "yaml";

const MAX_LINES = 50_000;

// Classify one (ANSI-stripped) gcl output line.
//   knownJobs: job names sorted by length desc, so the longest prefix wins
export function classifyLine(text, knownJobs) {
  let child = null;
  let rest = text;

  const childMatch = /^\s*\[([^\]]+)\] -> (.*)$/.exec(text);
  if (childMatch) {
    child = childMatch[1];
    rest = childMatch[2];
  }

  const passFail = /^\s*(PASS|FAIL|WARN)\s+(.*)$/.exec(rest);
  if (passFail && (passFail[1] === "PASS" || passFail[1] === "FAIL")) {
    let target = passFail[2].trim();
    const childRef = /^\[([^\]]+)\] -> (.*)$/.exec(target);
    if (childRef) {
      child = childRef[1];
      target = childRef[2].trim();
    }
    return { kind: passFail[1] === "PASS" ? "pass" : "fail", job: target, child };
  }

  let job = null;
  let payload = rest;
  if (child) {
    // child job names are unknown ahead of time: first whitespace-padded token
    const m = /^(\S+)\s+(.*)$/.exec(rest);
    if (m) {
      job = m[1];
      payload = m[2];
    }
  } else {
    for (const name of knownJobs) {
      if (rest.startsWith(name) && (rest.length === name.length || /\s/.test(rest[name.length]))) {
        job = name;
        payload = rest.slice(name.length).replace(/^\s+/, "");
        break;
      }
    }
  }

  if (job !== null) {
    if (payload.startsWith("$ ")) return { kind: "cmd", job, child, payload };
    if (payload.startsWith("> ")) return { kind: "out", job, child, payload };
    if (payload.startsWith("starting ")) return { kind: "starting", job, child, payload };
    if (payload.startsWith("finished in")) return { kind: "finished", job, child, payload };
    if (payload.startsWith("exported artifacts")) return { kind: "artifacts", job, child, payload };
    if (payload.startsWith("copied artifacts") || payload.startsWith("imported cache") || payload.startsWith("exported cache"))
      return { kind: "artifacts", job, child, payload };
    return { kind: "job-meta", job, child, payload };
  }
  if (/^pipeline finished/.test(rest.trim())) return { kind: "pipeline-finished", job: null, child };
  return { kind: "meta", job: null, child };
}

export class RunManager {
  constructor(cwd, broadcast) {
    this.cwd = cwd;
    this.broadcast = broadcast;
    this.runs = new Map();
  }

  list() {
    return [...this.runs.values()].map((r) => this.summary(r)).reverse();
  }

  summary(r) {
    return {
      id: r.id,
      label: r.label,
      argv: r.argvDisplay,
      status: r.status,
      exitCode: r.exitCode,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      jobs: r.jobs,
      childJobs: r.childJobs,
      parentRunId: r.parentRunId,
      triggerJob: r.triggerJob,
      file: r.file,
      droppedLines: r.droppedLines,
    };
  }

  get(id) {
    return this.runs.get(id);
  }

  // opts: { jobs, needs, onlyNeeds, manual, variables, inputs, extraFlags,
  //         forceIncludes, file, parentRunId, triggerJob, label, ...toggles }
  async start(opts, knownJobNames = []) {
    let file = opts.file || null;
    if (opts.forceIncludes && !opts.parentRunId) {
      const patched = await makeForcedIncludesFile(this.cwd, file, YAML).catch(() => null);
      if (patched) file = patched;
    }

    const args = buildArgs({ ...opts, file });
    const id = crypto.randomBytes(5).toString("hex");
    const run = {
      id,
      label:
        opts.label ||
        (opts.jobs?.length ? opts.jobs.join(", ") : opts.stage ? `stage: ${opts.stage}` : "pipeline"),
      argvDisplay: "gitlab-ci-local " + args.join(" "),
      opts,
      file,
      status: "running",
      exitCode: null,
      createdAt: Date.now(),
      finishedAt: null,
      jobs: {},
      childJobs: {},
      lines: [],
      seq: 0,
      droppedLines: 0,
      parentRunId: opts.parentRunId || null,
      triggerJob: opts.triggerJob || null,
      knownJobs: [...knownJobNames].sort((a, b) => b.length - a.length),
      buffer: "",
      pending: [],
      flushTimer: null,
    };
    this.runs.set(id, run);

    for (const j of opts.jobs || []) run.jobs[j] = { status: "pending" };

    let child;
    try {
      child = gclSpawn(this.cwd, args);
    } catch (e) {
      run.status = "error";
      run.finishedAt = Date.now();
      this.pushLine(run, e.message + "\n");
      this.flush(run);
      this.broadcast({ type: "run.done", runId: id, status: run.status, run: this.summary(run) });
      return this.summary(run);
    }
    run.proc = child;

    const onData = (d) => {
      run.buffer += d.toString();
      let idx;
      while ((idx = run.buffer.indexOf("\n")) >= 0) {
        const line = run.buffer.slice(0, idx);
        run.buffer = run.buffer.slice(idx + 1);
        this.pushLine(run, line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => this.pushLine(run, `gcl-ui: ${err.message}`));
    child.on("close", (code) => {
      if (run.buffer) this.pushLine(run, run.buffer);
      run.exitCode = code;
      run.finishedAt = Date.now();
      if (run.status === "cancelling") run.status = "cancelled";
      else run.status = code === 0 ? "success" : "failed";
      // any job still marked running didn't report: align with exit code
      for (const j of Object.values(run.jobs)) {
        if (j.status === "running") j.status = code === 0 ? "success" : "failed";
        if (j.status === "pending" && run.status === "cancelled") j.status = "skipped";
      }
      this.flush(run);
      this.broadcast({ type: "run.done", runId: id, status: run.status, exitCode: code, run: this.summary(run) });
      this.broadcast({ type: "artifacts.changed" });
    });

    this.broadcast({ type: "run.started", run: this.summary(run) });
    return this.summary(run);
  }

  pushLine(run, raw) {
    const text = stripAnsi(raw);
    const info = classifyLine(text, run.knownJobs);
    const entry = { seq: run.seq++, raw, ...info };
    run.lines.push(entry);
    if (run.lines.length > MAX_LINES) {
      run.lines.splice(0, run.lines.length - MAX_LINES);
      run.droppedLines++;
    }
    this.applyStatus(run, info);
    run.pending.push(entry);
    if (!run.flushTimer) run.flushTimer = setTimeout(() => this.flush(run), 30);
  }

  flush(run) {
    if (run.flushTimer) {
      clearTimeout(run.flushTimer);
      run.flushTimer = null;
    }
    if (run.pending.length === 0) return;
    this.broadcast({ type: "run.lines", runId: run.id, lines: run.pending });
    run.pending = [];
  }

  applyStatus(run, info) {
    if (!info.job) return;
    const store = info.child
      ? (run.childJobs[info.child] ||= {})
      : run.jobs;
    const job = (store[info.job] ||= { status: "pending" });
    if (info.kind === "starting") {
      job.status = "running";
      job.startedAt = Date.now();
      this.broadcastJob(run, info);
    } else if (info.kind === "finished") {
      job.duration = info.payload?.replace("finished in", "").trim();
    } else if (info.kind === "pass") {
      job.status = "success";
      this.broadcastJob(run, info);
    } else if (info.kind === "fail") {
      job.status = "failed";
      this.broadcastJob(run, info);
    }
  }

  broadcastJob(run, info) {
    const store = info.child ? run.childJobs[info.child] : run.jobs;
    this.broadcast({
      type: "run.job",
      runId: run.id,
      job: info.job,
      child: info.child || null,
      state: store[info.job],
    });
  }

  cancel(id) {
    const run = this.runs.get(id);
    if (!run || !run.proc || run.finishedAt) return false;
    run.status = "cancelling";
    try {
      process.kill(-run.proc.pid, "SIGINT");
    } catch {
      try {
        run.proc.kill("SIGINT");
      } catch {}
    }
    const proc = run.proc;
    setTimeout(() => {
      if (!run.finishedAt) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {}
      }
    }, 5000).unref();
    return true;
  }
}
