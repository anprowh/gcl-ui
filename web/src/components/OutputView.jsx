import React, { useEffect, useMemo, useRef, useState } from "react";
import { useStore, setState, cancelRun, copyText, refreshRunLines, getRunJobLog } from "../store.js";
import { ansiToSpans, stripAnsi } from "../lib/ansi.js";
import { STATUS_ICONS } from "./PipelineGraph.jsx";

const MAX_RENDER = 4000;
const MAX_PANE = 1500;

function Line({ line }) {
  const spans = useMemo(() => ansiToSpans(line.raw), [line.raw]);
  return (
    <div className={"out-line kind-" + line.kind}>
      {spans.map((s, i) => (
        <span key={i} style={s.style || undefined}>
          {s.text}
        </span>
      ))}
      {spans.length === 0 && " "}
    </div>
  );
}

// One scrollable, independently-following pane for a single job's live output.
function JobPane({ title, status, duration, lines, running }) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    if (autoScroll && !collapsed && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines.length, autoScroll, collapsed]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== autoScroll) setAutoScroll(atBottom);
  };

  const visible = lines.slice(-MAX_PANE);
  return (
    <div className={"job-pane st-" + (status || "pending") + (collapsed ? " collapsed" : "")}>
      <div className="job-pane-head" onClick={() => setCollapsed(!collapsed)}>
        <span className="job-pane-caret">{collapsed ? "▸" : "▾"}</span>
        <span className={"job-pane-status st-" + (status || "pending")}>{STATUS_ICONS[status] || "○"}</span>
        <span className="job-pane-name" title={title}>
          {title}
        </span>
        {duration && <span className="job-tag time">{duration}</span>}
        {running && !duration && <span className="job-tag running-tag">running…</span>}
        <span className="job-pane-count">{lines.length} ln</span>
      </div>
      {!collapsed && (
        <div className="job-pane-body" ref={bodyRef} onScroll={onScroll}>
          {lines.length > MAX_PANE && (
            <div className="out-line kind-meta">… last {MAX_PANE} of {lines.length} lines …</div>
          )}
          {visible.map((l) => (
            <Line key={l.seq} line={l} />
          ))}
          {visible.length === 0 && (
            <div className="out-line kind-meta">{running ? "waiting for output…" : "no output"}</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function OutputView() {
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  const runLines = useStore((s) => s.runLines);
  const [jobFilter, setJobFilter] = useState(null);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [rawLogs, setRawLogs] = useState({}); // job -> raw .log file contents (raw mode)
  const [rawLoading, setRawLoading] = useState(false);
  const bodyRef = useRef(null);

  const mode = useStore((s) => s.ui.outputMode);
  const rawOutputOnly = useStore((s) => s.ui.rawOutputOnly);
  const split = mode === "split";
  const raw = mode === "raw";

  const run = runs.find((r) => r.id === activeRunId) || runs[0];
  const lines = (run && runLines[run.id]) || [];

  // lazily fetch lines for runs that started before this page connected
  useEffect(() => {
    if (run && runLines[run.id] === undefined) {
      setState({ runLines: { ...runLines, [run.id]: [] } });
      refreshRunLines(run.id);
    }
  }, [run?.id]);

  const matchesSearch = (l) => !search || stripAnsi(l.raw).toLowerCase().includes(search.toLowerCase());

  // combined-mode filtered lines
  const filtered = useMemo(() => {
    let ls = lines;
    if (jobFilter) ls = ls.filter((l) => l.job === jobFilter || (l.child && l.child === jobFilter));
    if (search) ls = ls.filter(matchesSearch);
    return ls;
  }, [lines, jobFilter, search]);

  // raw mode reads gcl's own per-job log files straight from
  // .gitlab-ci-local/output/<job>.log — the real captured stdout/stderr, not
  // our prefix-parsed reconstruction of the streamed pipeline log.
  const logTargets = useMemo(() => {
    if (!run) return [];
    const names = [];
    if (jobFilter) {
      // a chip filter is either a top-level job or a child-pipeline group
      if (run.childJobs?.[jobFilter]) names.push(...Object.keys(run.childJobs[jobFilter]));
      else names.push(jobFilter);
    } else {
      names.push(...Object.keys(run.jobs || {}));
      for (const t of Object.keys(run.childJobs || {})) names.push(...Object.keys(run.childJobs[t] || {}));
    }
    return [...new Set(names)];
  }, [run, jobFilter]);

  // a cheap signature of job states so we refetch logs as jobs finish
  const logKey = useMemo(() => {
    if (!run) return "";
    const parts = [run.status];
    for (const [n, s] of Object.entries(run.jobs || {})) parts.push(`${n}:${s.status}`);
    for (const t of Object.keys(run.childJobs || {}))
      for (const [n, s] of Object.entries(run.childJobs[t] || {})) parts.push(`${t}/${n}:${s.status}`);
    return parts.join("|");
  }, [run]);

  useEffect(() => {
    if (!raw || !run || logTargets.length === 0) {
      setRawLogs({});
      return;
    }
    let cancelled = false;
    const load = async () => {
      setRawLoading(true);
      const entries = await Promise.all(
        logTargets.map(async (name) => {
          try {
            const d = await getRunJobLog(run.id, name);
            return [name, d.missing ? null : d.content ?? ""];
          } catch {
            return [name, null]; // log not written yet (job hasn't run)
          }
        })
      );
      if (!cancelled) {
        setRawLogs(Object.fromEntries(entries));
        setRawLoading(false);
      }
    };
    load();
    // while the run is live the on-disk logs keep growing — poll for updates
    const running = run.status === "running" || run.status === "cancelling";
    const timer = running ? setInterval(load, 2000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [raw, run?.id, jobFilter, logKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // raw-mode text: concatenated raw job logs, ANSI stripped, ready to copy.
  const rawText = useMemo(() => {
    if (!raw) return "";
    const multi = logTargets.length > 1;
    const term = search.toLowerCase();
    const out = [];
    for (const name of logTargets) {
      const content = rawLogs[name];
      if (content == null) continue;
      let lines = stripAnsi(content).split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      if (rawOutputOnly) lines = lines.filter((l) => !/^\s*\$ /.test(l)); // drop command echoes
      if (search) lines = lines.filter((l) => l.toLowerCase().includes(term));
      if (lines.length === 0) continue;
      if (multi) out.push(`===== ${name} =====`);
      out.push(...lines);
    }
    return out.join("\n");
  }, [raw, rawLogs, rawOutputOnly, search, logTargets]);

  // split-mode buckets: one per top-level job, one per child-pipeline group
  const panes = useMemo(() => {
    if (!split || !run) return [];
    const map = {};
    for (const l of lines) {
      if (!matchesSearch(l)) continue;
      const key = l.child ? "child:" + l.child : l.job ? l.job : "(pipeline)";
      (map[key] ||= []).push(l);
    }
    const out = [];
    for (const name of Object.keys(run.jobs || {})) {
      out.push({
        key: name,
        title: name,
        status: run.jobs[name]?.status,
        duration: run.jobs[name]?.duration,
        lines: map[name] || [],
      });
    }
    for (const t of Object.keys(run.childJobs || {})) {
      const states = Object.values(run.childJobs[t] || {});
      const status = states.some((s) => s.status === "failed")
        ? "failed"
        : states.every((s) => s.status === "success") && states.length
          ? "success"
          : "running";
      out.push({ key: "child:" + t, title: `↳ ${t} · child pipeline`, status, lines: map["child:" + t] || [] });
    }
    if (map["(pipeline)"]?.length) out.push({ key: "(pipeline)", title: "(pipeline)", status: run.status, lines: map["(pipeline)"] });
    return out;
  }, [split, lines, run, search]);

  useEffect(() => {
    if (!split && autoScroll && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [filtered.length, autoScroll, run?.id, split]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== autoScroll) setAutoScroll(atBottom);
  };

  if (!run) {
    return <div className="panel-empty">No runs yet — hit “▶ Run pipeline” or play a job in the graph.</div>;
  }

  const jobNames = Object.keys(run.jobs || {});
  const childNames = Object.keys(run.childJobs || {});
  const visible = filtered.slice(-MAX_RENDER);
  const running = run.status === "running" || run.status === "cancelling";

  return (
    <div className="output-view">
      <div className="output-toolbar">
        <select className="run-select" value={run.id} onChange={(e) => setState({ activeRunId: e.target.value })}>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {STATUS_ICONS[r.status === "cancelling" ? "running" : r.status] || "·"} {r.label} ·{" "}
              {new Date(r.createdAt).toLocaleTimeString()}
              {r.triggerJob ? ` (child of ${r.triggerJob})` : ""}
            </option>
          ))}
        </select>
        <span className={"run-status st-" + run.status}>{run.status}</span>
        {running && (
          <button className="btn danger" onClick={() => cancelRun(run.id)}>
            ⊘ cancel
          </button>
        )}
        <button className="btn" title="Copy the full gitlab-ci-local command of this run" onClick={() => copyText(run.argv, "Command")}>
          ⧉ cmd
        </button>
        <div className="seg-toggle" title="Combined log · one live pane per job · raw prefix-free text">
          <button className={"seg" + (mode === "combined" ? " active" : "")} onClick={() => setState((s) => ({ ui: { ...s.ui, outputMode: "combined" } }))}>
            ≣ combined
          </button>
          <button className={"seg" + (mode === "split" ? " active" : "")} onClick={() => setState((s) => ({ ui: { ...s.ui, outputMode: "split" } }))}>
            ▦ per-job
          </button>
          <button className={"seg" + (mode === "raw" ? " active" : "")} onClick={() => setState((s) => ({ ui: { ...s.ui, outputMode: "raw" } }))} title="Raw per-job logs read straight from .gitlab-ci-local/output/<job>.log — easy to copy">
            ⌁ raw
          </button>
        </div>
        {!split && (
          <div className="chip-row scroll">
            {jobNames.map((j) => (
              <button
                key={j}
                className={"chip-btn st-" + (run.jobs[j]?.status || "pending") + (jobFilter === j ? " active" : "")}
                onClick={() => setJobFilter(jobFilter === j ? null : j)}
              >
                {STATUS_ICONS[run.jobs[j]?.status] || "○"} {j}
              </button>
            ))}
            {childNames.map((t) => (
              <button
                key={"c-" + t}
                className={"chip-btn child" + (jobFilter === t ? " active" : "")}
                title={`child pipeline of ${t}`}
                onClick={() => setJobFilter(jobFilter === t ? null : t)}
              >
                ⧉ {t}
              </button>
            ))}
          </div>
        )}
        {split && <div className="topbar-spacer" />}
        <input
          className="output-search"
          placeholder="filter output…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
        {raw && (
          <>
            <label className="raw-only-toggle" title="Show only program output (drop the $ command echoes)">
              <input
                type="checkbox"
                checked={rawOutputOnly}
                onChange={(e) => setState((s) => ({ ui: { ...s.ui, rawOutputOnly: e.target.checked } }))}
              />
              <span>output only</span>
            </label>
            <button
              className="btn primary"
              title={jobFilter ? `Copy raw output of ${jobFilter}` : "Copy all raw output (tip: click a job chip to isolate one)"}
              onClick={() => copyText(rawText, "Raw output")}
            >
              ⧉ copy{jobFilter ? ` ${jobFilter}` : " all"}
            </button>
          </>
        )}
        {mode === "combined" && (
          <button className={"btn" + (autoScroll ? " active" : "")} title="Follow output" onClick={() => setAutoScroll(!autoScroll)}>
            ⇣ follow
          </button>
        )}
      </div>

      {raw ? (
        <textarea
          className="output-raw"
          readOnly
          spellCheck={false}
          wrap="off"
          value={rawText || (rawLoading ? "loading job logs…" : running ? "waiting for output…" : "no output")}
          onFocus={(e) => e.target.select()}
        />
      ) : split ? (
        <div className="output-split">
          {panes.length === 0 && <div className="panel-empty">no jobs in this run yet…</div>}
          {panes.map((p) => (
            <JobPane key={p.key} title={p.title} status={p.status} duration={p.duration} lines={p.lines} running={running && p.status !== "success" && p.status !== "failed"} />
          ))}
        </div>
      ) : (
        <div className="output-body" ref={bodyRef} onScroll={onScroll}>
          {run.droppedLines > 0 && <div className="out-line kind-meta">… {run.droppedLines * 1000}+ earlier lines dropped …</div>}
          {filtered.length > MAX_RENDER && (
            <div className="out-line kind-meta">… showing last {MAX_RENDER} of {filtered.length} lines (use the filter to narrow down) …</div>
          )}
          {visible.map((l) => (
            <Line key={l.seq} line={l} />
          ))}
          {visible.length === 0 && <div className="out-line kind-meta">{running ? "waiting for output…" : "no output"}</div>}
        </div>
      )}
    </div>
  );
}
