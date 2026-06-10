import React, { useEffect, useMemo, useRef, useState } from "react";
import { useStore, setState, cancelRun, copyText, refreshRunLines } from "../store.js";
import { ansiToSpans, stripAnsi } from "../lib/ansi.js";
import { STATUS_ICONS } from "./PipelineGraph.jsx";

const MAX_RENDER = 4000;

function Line({ line }) {
  const spans = useMemo(() => ansiToSpans(line.raw), [line.raw]);
  return (
    <div className={"out-line kind-" + line.kind}>
      {spans.map((s, i) => (
        <span key={i} style={s.style || undefined}>
          {s.text}
        </span>
      ))}
      {spans.length === 0 && " "}
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

  const filtered = useMemo(() => {
    let ls = lines;
    if (jobFilter) ls = ls.filter((l) => l.job === jobFilter || (l.child && l.child === jobFilter));
    if (search) {
      const q = search.toLowerCase();
      ls = ls.filter((l) => stripAnsi(l.raw).toLowerCase().includes(q));
    }
    return ls;
  }, [lines, jobFilter, search]);

  useEffect(() => {
    if (autoScroll && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [filtered.length, autoScroll, run?.id]);

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

  return (
    <div className="output-view">
      <div className="output-toolbar">
        <select
          className="run-select"
          value={run.id}
          onChange={(e) => setState({ activeRunId: e.target.value })}
        >
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {STATUS_ICONS[r.status === "cancelling" ? "running" : r.status] || "·"} {r.label} ·{" "}
              {new Date(r.createdAt).toLocaleTimeString()}
              {r.triggerJob ? ` (child of ${r.triggerJob})` : ""}
            </option>
          ))}
        </select>
        <span className={"run-status st-" + run.status}>{run.status}</span>
        {run.status === "running" && (
          <button className="btn danger" onClick={() => cancelRun(run.id)}>
            ⊘ cancel
          </button>
        )}
        <button className="btn" title="Copy the full gitlab-ci-local command of this run" onClick={() => copyText(run.argv, "Command")}>
          ⧉ cmd
        </button>
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
        <input
          className="output-search"
          placeholder="filter output…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
        <button
          className={"btn" + (autoScroll ? " active" : "")}
          title="Follow output"
          onClick={() => setAutoScroll(!autoScroll)}
        >
          ⇣ follow
        </button>
      </div>
      <div className="output-body" ref={bodyRef} onScroll={onScroll}>
        {run.droppedLines > 0 && <div className="out-line kind-meta">… {run.droppedLines * 1000}+ earlier lines dropped …</div>}
        {filtered.length > MAX_RENDER && (
          <div className="out-line kind-meta">… showing last {MAX_RENDER} of {filtered.length} lines (use the filter to narrow down) …</div>
        )}
        {visible.map((l) => (
          <Line key={l.seq} line={l} />
        ))}
        {visible.length === 0 && <div className="out-line kind-meta">{run.status === "running" ? "waiting for output…" : "no output"}</div>}
      </div>
    </div>
  );
}
