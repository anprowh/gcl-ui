import { useSyncExternalStore } from "react";

// ---- tiny external store ----------------------------------------------------
let state = {
  project: null,
  pipeline: null,
  pipelineLoading: false,
  childPipelines: {}, // key: `${triggerJob}` -> pipeline model for artifact file
  variables: { project: [], global: [] },
  settings: null, // loaded from server; null until then
  runs: [],
  runLines: {}, // runId -> [{seq, raw, kind, job, child}]
  activeRunId: null,
  debugSessions: [],
  activeDebugId: null,
  debugCaps: { containerRuntime: null, ptyAvailable: true },
  artifacts: { root: "", jobs: {} },
  logs: { root: "", logs: [] },
  ui: {
    selectedJob: null,
    selection: [], // multi-select of job names for batch runs
    dockTab: "output",
    dockOpen: true,
    outputMode: "combined", // combined | split | raw
    rawOutputOnly: false, // raw mode: show only program stdout (drop $ commands & meta)
    toast: null,
  },
  wsConnected: false,
};

const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const l of listeners) l();
}

export function useStore(selector = (s) => s) {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state)
  );
}

let toastTimer = null;
export function toast(message, kind = "info") {
  setState({ ui: { ...state.ui, toast: { message, kind, at: Date.now() } } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ ui: { ...state.ui, toast: null } }), 2600);
}

export function copyText(text, label = "Copied") {
  navigator.clipboard
    .writeText(text)
    .then(() => toast(`${label}: ${text.length > 60 ? text.slice(0, 57) + "…" : text}`, "ok"))
    .catch(() => toast("Copy failed (clipboard unavailable)", "err"));
}

// ---- REST helpers -----------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const DEFAULT_SETTINGS = {
  needs: true,
  onlyNeeds: false,
  forceRules: false,
  forceIncludes: false,
  evaluateRuleChanges: true,
  shellIsolation: false,
  forceShellExecutor: false,
  cleanup: false,
  privileged: false,
  mountCache: false,
  extraFlags: "",
  sessionVars: {},
  inputs: {},
  breakpoints: {},
};

export function effectiveSettings(s = state) {
  return { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
}

let settingsTimer = null;
export function updateSettings(patch) {
  const next = { ...effectiveSettings(), ...patch };
  setState({ settings: next });
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    api("/api/settings", { method: "PUT", body: next }).catch(() => {});
  }, 400);
}

export async function loadProject() {
  const [project, variables, settings, debug] = await Promise.all([
    api("/api/project"),
    api("/api/variables"),
    api("/api/settings"),
    api("/api/debug").catch(() => ({ containerRuntime: null, ptyAvailable: true })),
  ]);
  setState({
    project,
    variables,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    debugCaps: { containerRuntime: debug.containerRuntime || null, ptyAvailable: debug.ptyAvailable !== false },
  });
}

export async function loadPipeline() {
  const s = effectiveSettings();
  setState({ pipelineLoading: true });
  try {
    const pipeline = await api("/api/pipeline", {
      method: "POST",
      body: {
        variables: s.sessionVars,
        inputs: s.inputs,
        forceIncludes: s.forceIncludes,
      },
    });
    setState({ pipeline, pipelineLoading: false });
  } catch (e) {
    setState({
      pipeline: { ...(state.pipeline || {}), error: e.message },
      pipelineLoading: false,
    });
  }
}

export async function loadChildPipeline(triggerJob, file) {
  try {
    const model = await api("/api/pipeline", {
      method: "POST",
      body: { variables: effectiveSettings().sessionVars, file },
    });
    setState({ childPipelines: { ...state.childPipelines, [triggerJob]: model } });
    return model;
  } catch (e) {
    toast(e.message, "err");
    return null;
  }
}

export async function saveVariables(scope, list) {
  const saved = await api("/api/variables", { method: "PUT", body: { scope, variables: list } });
  setState({ variables: { ...state.variables, [scope]: saved } });
  toast(`${scope} variables saved`, "ok");
}

export async function loadArtifacts() {
  const [artifacts, logs] = await Promise.all([api("/api/artifacts"), api("/api/logs")]);
  setState({ artifacts, logs });
}

// ---- runs --------------------------------------------------------------------
export async function startRun({
  jobs = null,
  stage = null,
  label = null,
  file = null,
  parentRunId = null,
  triggerJob = null,
  overrides = {},
} = {}) {
  const s = effectiveSettings();
  const p = state.pipeline;
  const knownJobs = p?.jobs?.map((j) => j.name) || [];
  let jobList = jobs;
  if (!jobList && !stage && !file && s.forceRules && p?.jobs) {
    // force rules on a full pipeline run: name every job explicitly.
    // Skipped when `file` is set (e.g. a child-pipeline run) — the parent's
    // job names don't exist in that file and gcl would reject them.
    jobList = p.jobs.filter((j) => !j.trigger).map((j) => j.name);
  }
  if (stage) overrides = { ...overrides, stage };
  try {
    const run = await api("/api/run", {
      method: "POST",
      body: {
        jobs: jobList || [],
        needs: jobs ? s.needs : false,
        onlyNeeds: jobs ? s.onlyNeeds : false,
        variables: s.sessionVars,
        inputs: s.inputs,
        extraFlags: s.extraFlags,
        forceIncludes: s.forceIncludes,
        evaluateRuleChanges: s.evaluateRuleChanges,
        shellIsolation: s.shellIsolation,
        forceShellExecutor: s.forceShellExecutor,
        cleanup: s.cleanup,
        privileged: s.privileged,
        mountCache: s.mountCache,
        knownJobs,
        file,
        parentRunId,
        triggerJob,
        label,
        ...overrides,
      },
    });
    setState({
      activeRunId: run.id,
      ui: { ...state.ui, dockTab: "output", dockOpen: true },
    });
    return run;
  } catch (e) {
    toast(e.message, "err");
    return null;
  }
}

export function cancelRun(id) {
  return api(`/api/runs/${id}/cancel`, { method: "POST" }).catch((e) => toast(e.message, "err"));
}

// Trigger jobs can't be run by name: `gcl <trigger-job>` forwards the --job
// filter into the downstream pipeline, which has no job by that name ("…
// could not be found"). Run the generated child config directly instead.
// When the child config comes from an artifact that hasn't been produced yet
// the child file doesn't exist ("<file> could not be found"), so fall back to
// a full pipeline run — gcl produces the artifact and triggers the child
// inline, which (unlike a named trigger-job run) works.
export async function runChildPipeline(job, { parentRunId = null } = {}) {
  const inc = (job.trigger?.include || []).find((i) => i.local || (i.artifact && i.job));
  if (!inc) {
    toast(`${job.name}: no local/artifact child include to run`, "err");
    return null;
  }

  if (inc.artifact) {
    await loadArtifacts().catch(() => {});
    const produced = (state.artifacts?.jobs?.[inc.job] || []).some(
      (a) => a.type === "file" && a.path === inc.artifact
    );
    if (!produced) {
      toast(`${inc.artifact} not produced yet — running the full pipeline to trigger ${job.name}`);
      return startRun({ label: `pipeline → ${job.name}` });
    }
  }

  const file = inc.local ? inc.local : `.gitlab-ci-local/artifacts/${inc.job}/${inc.artifact}`;
  // load the child model so the run knows the child's job names (status + raw
  // log grouping); falls back gracefully if the config isn't available yet.
  let childModel = state.childPipelines[job.name];
  if (!childModel || childModel.error) childModel = await loadChildPipeline(job.name, file);
  return startRun({
    label: `child of ${job.name}`,
    file,
    triggerJob: job.name,
    parentRunId,
    overrides: {
      needs: false,
      onlyNeeds: false,
      // run in the default .gitlab-ci-local state dir (not an isolated one) so
      // the child's logs and artifacts land where the Artifacts/logs tabs and
      // the raw output look — same place inline-triggered child jobs write to.
      ...(childModel && !childModel.error ? { knownJobs: childModel.jobs.map((j) => j.name) } : {}),
    },
  });
}

// ---- debug --------------------------------------------------------------------
export async function startDebug(job, breakpoints, { container = false, ...dims } = {}) {
  try {
    // merge pipeline-level yaml variables under the job's own ones
    const globalVars = state.pipeline?.globalVariables || {};
    const session = await api("/api/debug/start", {
      method: "POST",
      body: {
        job: { ...job, variables: { ...globalVars, ...(job.variables || {}) } },
        breakpoints,
        container,
        variables: effectiveSettings().sessionVars,
        cols: dims?.cols,
        rows: dims?.rows,
      },
    });
    setState({ activeDebugId: session.id });
    return session;
  } catch (e) {
    toast(e.message, "err");
    return null;
  }
}

export const debugApi = {
  continue: (id) => api(`/api/debug/${id}/continue`, { method: "POST" }),
  abort: (id) => api(`/api/debug/${id}/abort`, { method: "POST" }),
  dispose: (id) => api(`/api/debug/${id}`, { method: "DELETE" }),
  scrollback: (id) => api(`/api/debug/${id}/scrollback`),
};

export function getFile(base, path) {
  return api(`/api/file?base=${encodeURIComponent(base)}&path=${encodeURIComponent(path)}`);
}

// Raw per-job log for a run, read from that run's own output dir (which honors
// the run's --state-dir, so child pipelines run separately resolve correctly).
export function getRunJobLog(runId, job) {
  return api(`/api/runs/${encodeURIComponent(runId)}/joblog?job=${encodeURIComponent(job)}`);
}

// ---- websocket ----------------------------------------------------------------
let ws = null;
const debugDataListeners = new Set();
export function onDebugData(cb) {
  debugDataListeners.add(cb);
  return () => debugDataListeners.delete(cb);
}

export function wsSend(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

export function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setState({ wsConnected: true });
  ws.onclose = () => {
    setState({ wsConnected: false });
    setTimeout(connectWs, 1500);
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleWs(msg);
  };
}

function upsertRun(runs, run) {
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) {
    const next = runs.slice();
    next[idx] = run;
    return next;
  }
  return [run, ...runs];
}

function handleWs(msg) {
  switch (msg.type) {
    case "hello":
      setState({
        runs: msg.runs,
        debugSessions: msg.debugSessions,
        activeRunId: state.activeRunId || msg.runs[0]?.id || null,
      });
      // refetch lines for the active run after reconnect
      if (state.activeRunId) refreshRunLines(state.activeRunId);
      break;
    case "run.started":
      setState({ runs: upsertRun(state.runs, msg.run), runLines: { ...state.runLines, [msg.run.id]: [] } });
      break;
    case "run.lines": {
      const cur = state.runLines[msg.runId] || [];
      setState({ runLines: { ...state.runLines, [msg.runId]: cur.concat(msg.lines) } });
      break;
    }
    case "run.job": {
      const runs = state.runs.map((r) => {
        if (r.id !== msg.runId) return r;
        const next = { ...r };
        if (msg.child) next.childJobs = { ...r.childJobs, [msg.child]: { ...(r.childJobs[msg.child] || {}), [msg.job]: msg.state } };
        else next.jobs = { ...r.jobs, [msg.job]: msg.state };
        return next;
      });
      setState({ runs });
      break;
    }
    case "run.done":
      setState({ runs: upsertRun(state.runs, msg.run) });
      loadArtifacts().catch(() => {});
      break;
    case "artifacts.changed":
      loadArtifacts().catch(() => {});
      break;
    case "debug.update": {
      const sessions = state.debugSessions.slice();
      const idx = sessions.findIndex((s) => s.id === msg.session.id);
      if (idx >= 0) sessions[idx] = msg.session;
      else sessions.push(msg.session);
      setState({ debugSessions: sessions, activeDebugId: state.activeDebugId || msg.session.id });
      break;
    }
    case "debug.data":
      for (const cb of debugDataListeners) cb(msg.sessionId, msg.data, msg.offset ?? 0);
      break;
    default:
      break;
  }
}

export async function refreshRunLines(runId) {
  try {
    const have = state.runLines[runId]?.length ? state.runLines[runId][state.runLines[runId].length - 1].seq : -1;
    const data = await api(`/api/runs/${runId}?after=${have}`);
    const cur = state.runLines[runId] || [];
    setState({
      runs: upsertRun(state.runs, { ...data, lines: undefined }),
      runLines: { ...state.runLines, [runId]: cur.concat(data.lines || []) },
    });
  } catch {
    /* run may be gone after server restart */
  }
}

export function selectJob(name) {
  setState({ ui: { ...state.ui, selectedJob: name, dockTab: name ? "job" : state.ui.dockTab, dockOpen: true } });
}

export function setDockTab(tab) {
  setState({ ui: { ...state.ui, dockTab: tab, dockOpen: true } });
}

// ---- multi-select for batch runs ---------------------------------------------
export function toggleSelect(name) {
  const cur = state.ui.selection;
  const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
  setState({ ui: { ...state.ui, selection: next } });
}

export function setSelection(names) {
  setState({ ui: { ...state.ui, selection: names } });
}

export function clearSelection() {
  setState({ ui: { ...state.ui, selection: [] } });
}
