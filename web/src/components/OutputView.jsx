import React, { useEffect, useMemo, useRef, useState } from "react";
import { useStore, setState, cancelRun, copyText, refreshRunLines } from "../store.js";
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
  const split = useStore((s) => s.ui.outputSplit);
  const [jobFilter, setJobFilter] = useState(null);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const bodyRef = useRef(null);

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
        <div className="seg-toggle" title="Combined log vs one live pane per job">
          <button className={"seg" + (!split ? " active" : "")} onClick={() => setState((s) => ({ ui: { ...s.ui, outputSplit: false } }))}>
            ≣ combined
          </button>
          <button className={"seg" + (split ? " active" : "")} onClick={() => setState((s) => ({ ui: { ...s.ui, outputSplit: true } }))}>
            ▦ per-job
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
        {!split && (
          <button className={"btn" + (autoScroll ? " active" : "")} title="Follow output" onClick={() => setAutoScroll(!autoScroll)}>
            ⇣ follow
          </button>
        )}
      </div>

      {split ? (
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
