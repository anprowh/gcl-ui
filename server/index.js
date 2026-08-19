import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WebSocketServer } from "ws";
import { getPipeline } from "./pipeline.js";
import { RunManager } from "./runs.js";
import { DebugManager } from "./debug.js";
import {
  getVariables,
  setVariables,
  effectiveVariableEntries,
  splitVariableEntries,
  materializeFileVariables,
  getSettings,
  setSettings,
} from "./variables.js";
import { makeVariablesFile } from "./gcl.js";
import { findGclBin, isProbablyText, walkDir, GLOBAL_DIR, projectDir } from "./util.js";
import { assets as embeddedAssets } from "./embedded-assets.js";

export function createServer(cwd, { staticDir = null, viteDev = false } = {}) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  };

  const runs = new RunManager(cwd, broadcast);
  const debug = new DebugManager(cwd, broadcast);

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", runs: runs.list(), debugSessions: debug.list() }));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === "debug.input") debug.input(msg.sessionId, msg.data);
      else if (msg.type === "debug.resize") debug.resize(msg.sessionId, msg.cols, msg.rows);
    });
  });

  const ok = (res, data) => res.json(data ?? { ok: true });
  const fail = (res, e, code = 500) => res.status(code).json({ error: e?.message || String(e) });

  // ---- project info ----------------------------------------------------
  app.get("/api/project", (req, res) => {
    let branch = null;
    let gclVersion = null;
    try {
      branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim();
    } catch {}
    try {
      gclVersion = execFileSync(findGclBin(), ["--version"], { cwd, encoding: "utf8" }).trim().split("\n").pop();
    } catch {}
    ok(res, {
      cwd,
      name: path.basename(cwd),
      branch,
      gclVersion,
      ciFile: fs.existsSync(path.join(cwd, ".gitlab-ci.yml")),
      globalDir: GLOBAL_DIR,
      projectDir: projectDir(cwd),
    });
  });

  // ---- pipeline model ---------------------------------------------------
  app.post("/api/pipeline", async (req, res) => {
    try {
      const { variables = {}, inputs = {}, forceIncludes = false, file = null } = req.body || {};
      const { plain, files } = splitVariableEntries(effectiveVariableEntries(cwd, variables));
      const variablesFile = makeVariablesFile(cwd, files);
      const model = await getPipeline(cwd, { variables: plain, variablesFile, inputs, forceIncludes, file });
      ok(res, model);
    } catch (e) {
      fail(res, e);
    }
  });

  // ---- variables & settings ----------------------------------------------
  app.get("/api/variables", (req, res) => ok(res, getVariables(cwd)));
  app.put("/api/variables", (req, res) => {
    try {
      const { scope, variables } = req.body || {};
      ok(res, setVariables(cwd, scope, variables));
    } catch (e) {
      fail(res, e, 400);
    }
  });
  app.get("/api/settings", (req, res) => ok(res, getSettings(cwd)));
  app.put("/api/settings", (req, res) => ok(res, setSettings(cwd, req.body)));

  // ---- runs ---------------------------------------------------------------
  app.get("/api/runs", (req, res) => ok(res, runs.list()));
  app.get("/api/runs/:id", (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return fail(res, "run not found", 404);
    const after = Number(req.query.after ?? -1);
    ok(res, { ...runs.summary(run), lines: run.lines.filter((l) => l.seq > after) });
  });
  app.post("/api/run", async (req, res) => {
    try {
      const body = req.body || {};
      const session = body.variables || {};
      const { plain, files } = splitVariableEntries(effectiveVariableEntries(cwd, session));
      const opts = {
        ...body,
        variables: plain,
        variablesFile: makeVariablesFile(cwd, files),
      };
      const summary = await runs.start(opts, body.knownJobs || []);
      ok(res, summary);
    } catch (e) {
      fail(res, e);
    }
  });
  app.post("/api/runs/:id/cancel", (req, res) => ok(res, { cancelled: runs.cancel(req.params.id) }));

  // Raw per-job log, read straight from gcl's own output file. A run may use a
  // custom --state-dir (child pipelines run separately do), so the output dir
  // is resolved per-run rather than from the fixed project .gitlab-ci-local.
  app.get("/api/runs/:id/joblog", (req, res) => {
    try {
      const run = runs.get(req.params.id);
      if (!run) return fail(res, "run not found", 404);
      const job = String(req.query.job || "");
      if (!job || /[\\/]|\.\./.test(job)) return fail(res, "bad job name", 400);
      const stateDir = run.opts?.stateDir || ".gitlab-ci-local";
      const outDir = path.resolve(cwd, stateDir, "output");
      // gcl names log files after a "safe" form of the job name: every run of
      // characters outside [A-Za-z0-9_-] is base64-encoded (padding stripped),
      // e.g. "build [x86_64]" -> "buildIFsx86_64XQ.log". Match that, but fall
      // back to the raw name for older/other layouts.
      const safe = job.replace(/[^\w-]+/g, (u) => Buffer.from(u, "utf8").toString("base64").replace(/=+$/, ""));
      let full = path.resolve(outDir, safe + ".log");
      if (!fs.existsSync(full)) full = path.resolve(outDir, job + ".log");
      if (full !== outDir && !full.startsWith(outDir + path.sep)) return fail(res, "path escapes root", 400);
      if (!fs.existsSync(full)) return ok(res, { job, content: "", size: 0, missing: true });
      const st = fs.statSync(full);
      const MAX = 4 * 1024 * 1024;
      const fd = fs.openSync(full, "r");
      const buf = Buffer.alloc(Math.min(st.size, MAX));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      ok(res, { job, path: full, size: st.size, truncated: st.size > MAX, content: buf.toString("utf8") });
    } catch (e) {
      fail(res, e, 400);
    }
  });

  // ---- artifacts / logs / files -------------------------------------------
  const ROOTS = () => ({
    artifacts: path.join(cwd, ".gitlab-ci-local", "artifacts"),
    output: path.join(cwd, ".gitlab-ci-local", "output"),
    cwd,
  });

  app.get("/api/artifacts", (req, res) => {
    const root = ROOTS().artifacts;
    const jobs = {};
    if (fs.existsSync(root)) {
      for (const job of fs.readdirSync(root)) {
        const dir = path.join(root, job);
        try {
          if (fs.statSync(dir).isDirectory()) jobs[job] = walkDir(dir);
        } catch {}
      }
    }
    ok(res, { root, jobs });
  });

  app.get("/api/logs", (req, res) => {
    const root = ROOTS().output;
    const logs = [];
    if (fs.existsSync(root)) {
      for (const f of fs.readdirSync(root)) {
        if (!f.endsWith(".log")) continue;
        try {
          const st = fs.statSync(path.join(root, f));
          logs.push({ job: f.replace(/\.log$/, ""), path: path.join(root, f), size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    }
    ok(res, { root, logs });
  });

  function resolveSafe(base, rel) {
    const root = ROOTS()[base];
    if (!root) throw new Error("bad base");
    const full = path.resolve(root, rel || "");
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error("path escapes root");
    return full;
  }

  app.get("/api/file", (req, res) => {
    try {
      const full = resolveSafe(req.query.base || "artifacts", req.query.path || "");
      const st = fs.statSync(full);
      if (!st.isFile()) return fail(res, "not a file", 400);
      const MAX = 4 * 1024 * 1024;
      const fd = fs.openSync(full, "r");
      const buf = Buffer.alloc(Math.min(st.size, MAX));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const text = isProbablyText(buf);
      ok(res, {
        path: full,
        size: st.size,
        truncated: st.size > MAX,
        binary: !text,
        content: text ? buf.toString("utf8") : null,
      });
    } catch (e) {
      fail(res, e, 400);
    }
  });

  app.get("/api/file/raw", (req, res) => {
    try {
      const full = resolveSafe(req.query.base || "artifacts", req.query.path || "");
      res.sendFile(full);
    } catch (e) {
      fail(res, e, 400);
    }
  });

  // Serve artifacts and job logs as plain static trees so that HTML artifacts
  // render with a real document context: relative URLs (./style.css, scripts,
  // images) resolve correctly and their JavaScript runs as if opened directly.
  // Used as the src of a sandboxed <iframe> in the artifacts viewer.
  const staticOpts = { index: false, dotfiles: "allow", redirect: false };
  app.use("/artifact", express.static(ROOTS().artifacts, staticOpts));
  app.use("/joblog", express.static(ROOTS().output, staticOpts));

  // ---- debug ---------------------------------------------------------------
  app.get("/api/debug", (req, res) => ok(res, { sessions: debug.list(), ...debug.capabilities() }));
  app.post("/api/debug/start", (req, res) => {
    try {
      const { job, breakpoints = [], variables = {}, cols, rows, container = false } = req.body || {};
      if (!job?.name) return fail(res, "job object required", 400);
      const effVars = materializeFileVariables(cwd, effectiveVariableEntries(cwd, variables));
      ok(res, debug.start({ job, breakpoints, variables: effVars, cols, rows, container }));
    } catch (e) {
      fail(res, e, 400);
    }
  });
  app.get("/api/debug/:id/scrollback", (req, res) => ok(res, debug.scrollback(req.params.id)));
  app.post("/api/debug/:id/continue", (req, res) => ok(res, debug.continue(req.params.id)));
  app.post("/api/debug/:id/abort", (req, res) => ok(res, debug.abort(req.params.id)));
  app.delete("/api/debug/:id", (req, res) => ok(res, debug.dispose(req.params.id)));

  // ---- static frontend -------------------------------------------------------
  const embeddedKeys = Object.keys(embeddedAssets);
  if (embeddedKeys.length) {
    // serve the UI from the in-memory bundle (single-file executable mode)
    const decoded = {};
    const sendAsset = (res, key) => {
      const a = embeddedAssets[key];
      if (!decoded[key]) decoded[key] = Buffer.from(a.b64, "base64");
      res.type(a.type).send(decoded[key]);
    };
    app.get(/^\/(?!api|ws|artifact|joblog).*/, (req, res) => {
      const p = req.path === "/" ? "/index.html" : req.path;
      if (embeddedAssets[p]) return sendAsset(res, p);
      sendAsset(res, "/index.html"); // SPA fallback
    });
  } else if (staticDir) {
    app.use(express.static(staticDir));
    app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(staticDir, "index.html")));
  } else if (viteDev) {
    // dev mode: vite middleware is attached by bin/gcl-ui.js after creation
  }

  return { app, server, wss, runs, debug };
}
