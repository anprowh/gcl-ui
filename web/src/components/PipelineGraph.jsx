import React, { useMemo, useState } from "react";
import { useStore, selectJob, startRun } from "../store.js";

const COL_W = 264;
const CARD_W = 228;
const CARD_H = 60;
const VGAP = 14;
const HEADER_H = 38;
const PAD = 18;

export const STATUS_ICONS = {
  success: "✓",
  failed: "✕",
  running: "◐",
  pending: "○",
  skipped: "»",
  cancelled: "⊘",
};

export function statusOf(run, jobName) {
  return run?.jobs?.[jobName]?.status || null;
}

export default function PipelineGraph({ model = null, run = undefined, compact = false, onSelect = null }) {
  const globalPipeline = useStore((s) => s.pipeline);
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  const selected = useStore((s) => s.ui.selectedJob);
  const [hover, setHover] = useState(null);

  const pipeline = model || globalPipeline;
  const activeRun = run !== undefined ? run : runs.find((r) => r.id === activeRunId);

  const layout = useMemo(() => {
    if (!pipeline?.jobs?.length) return null;
    const stages = pipeline.stages?.length ? pipeline.stages : [...new Set(pipeline.jobs.map((j) => j.stage))];
    const byStage = new Map(stages.map((s) => [s, []]));
    for (const job of pipeline.jobs) {
      if (!byStage.has(job.stage)) byStage.set(job.stage, []);
      byStage.get(job.stage).push(job);
    }
    const cols = [...byStage.entries()].filter(([, jobs]) => jobs.length);
    const pos = new Map();
    cols.forEach(([, jobs], si) => {
      jobs.forEach((job, ji) => {
        pos.set(job.name, {
          x: PAD + si * COL_W,
          y: PAD + HEADER_H + ji * (CARD_H + VGAP),
          job,
        });
      });
    });
    const width = PAD * 2 + cols.length * COL_W;
    const height = PAD * 2 + HEADER_H + Math.max(...cols.map(([, j]) => j.length), 1) * (CARD_H + VGAP);
    const edges = [];
    for (const job of pipeline.jobs) {
      for (const need of job.needs || []) {
        const from = pos.get(need.job);
        const to = pos.get(job.name);
        if (from && to) edges.push({ from: need.job, to: job.name, optional: need.optional });
      }
    }
    return { cols, pos, edges, width, height };
  }, [pipeline]);

  const related = useMemo(() => {
    if (!hover || !pipeline?.jobs) return null;
    const up = new Map();
    const down = new Map();
    for (const j of pipeline.jobs) {
      up.set(j.name, (j.needs || []).map((n) => n.job));
    }
    for (const j of pipeline.jobs) {
      for (const n of up.get(j.name) || []) {
        if (!down.has(n)) down.set(n, []);
        down.get(n).push(j.name);
      }
    }
    const set = new Set([hover]);
    const walk = (name, dir) => {
      for (const next of dir.get(name) || []) {
        if (!set.has(next)) {
          set.add(next);
          walk(next, dir);
        }
      }
    };
    walk(hover, up);
    walk(hover, down);
    return set;
  }, [hover, pipeline]);

  if (!pipeline) return <div className="graph-empty">loading pipeline…</div>;
  if (!layout) return <div className="graph-empty">{pipeline.error ? "fix the pipeline to see the graph" : "no jobs found"}</div>;

  const handleSelect = onSelect || selectJob;

  return (
    <div className={"graph-scroll" + (compact ? " compact" : "")}>
      <div className="graph-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg className="graph-edges" width={layout.width} height={layout.height}>
          {layout.edges.map((e, i) => {
            const f = layout.pos.get(e.from);
            const t = layout.pos.get(e.to);
            const x1 = f.x + CARD_W;
            const y1 = f.y + CARD_H / 2;
            const x2 = t.x;
            const y2 = t.y + CARD_H / 2;
            const mx = (x1 + x2) / 2;
            const lit = related && (related.has(e.from) && related.has(e.to));
            const dim = related && !lit;
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                className={"edge" + (lit ? " lit" : "") + (dim ? " dim" : "") + (e.optional ? " optional" : "")}
              />
            );
          })}
        </svg>
        {layout.cols.map(([stage], si) => (
          <div key={stage} className="stage-header" style={{ left: PAD + si * COL_W, top: PAD, width: CARD_W }}>
            {stage}
            <span className="stage-count">{layout.cols[si][1].length}</span>
          </div>
        ))}
        {[...layout.pos.values()].map(({ x, y, job }) => {
          const st = statusOf(activeRun, job.name);
          const never = job.when === "never";
          const manual = job.when === "manual";
          const dim = related && !related.has(job.name);
          const childStates = activeRun?.childJobs?.[job.name];
          return (
            <div
              key={job.name}
              className={
                "job-card" +
                (st ? " st-" + st : "") +
                (never ? " never" : "") +
                (dim ? " dim" : "") +
                (selected === job.name ? " selected" : "")
              }
              style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
              onMouseEnter={() => setHover(job.name)}
              onMouseLeave={() => setHover(null)}
              onClick={() => handleSelect(job.name)}
            >
              <div className={"job-status" + (st ? " st-" + st : never ? " st-never" : manual ? " st-manual" : "")}>
                {st ? STATUS_ICONS[st] : never ? "⃠" : manual ? "▶" : "○"}
              </div>
              <div className="job-card-main">
                <div className="job-name" title={job.name}>
                  {job.name}
                </div>
                <div className="job-meta">
                  {job.trigger ? <span className="job-tag trigger">⧉ child pipeline</span> : null}
                  {never && <span className="job-tag never">rules: never</span>}
                  {manual && <span className="job-tag manual">manual</span>}
                  {job.allowFailure && <span className="job-tag allow">allow failure</span>}
                  {activeRun?.jobs?.[job.name]?.duration && (
                    <span className="job-tag time">{activeRun.jobs[job.name].duration}</span>
                  )}
                  {childStates && (
                    <span className="job-tag child-sum">
                      {Object.values(childStates).filter((c) => c.status === "success").length}/
                      {Object.keys(childStates).length} child ✓
                    </span>
                  )}
                </div>
              </div>
              {!compact && (
                <button
                  className={"job-play" + (never ? " force" : "")}
                  title={
                    never
                      ? "Rules are not satisfied — running it from here forces it (gcl runs explicitly named jobs)"
                      : manual
                        ? "Run this manual job"
                        : "Run this job"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    startRun({ jobs: [job.name], label: job.name + (never ? " (forced)" : "") });
                  }}
                >
                  {never ? "⚡" : "▶"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
