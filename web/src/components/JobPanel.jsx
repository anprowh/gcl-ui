import React, { useMemo, useState } from "react";
import {
  useStore,
  startRun,
  runChildPipeline,
  copyText,
  effectiveSettings,
  selectJob,
  setDockTab,
  setState,
  getState,
  loadChildPipeline,
  mergedRunStatus,
  viewJobOutput,
} from "../store.js";
import { explainRules } from "../lib/rules.js";
import { highlightLine } from "../lib/highlight.js";
import PipelineGraph, { STATUS_ICONS } from "./PipelineGraph.jsx";

function Script({ lines, title }) {
  if (!lines?.length) return null;
  return (
    <div className="job-section">
      <div className="job-section-title">{title}</div>
      <pre className="script-block">
        {lines.map((l, i) => (
          <div key={i} className="script-line">
            <span className="script-prompt">$</span>{" "}
            {l.split("\n").map((sub, k) => (
              <span key={k}>
                {k > 0 && <br />}
                {highlightLine(sub, "shell").map((t, j) => (
                  <span key={j} className={t.cls || undefined}>
                    {t.text}
                  </span>
                ))}
              </span>
            ))}
          </div>
        ))}
      </pre>
    </div>
  );
}

const VERDICT_LABEL = {
  matched: "✓ matched",
  "no-match": "✕ no match",
  unknown: "? can't evaluate",
  skipped: "· not reached",
};

export default function JobPanel() {
  const pipeline = useStore((s) => s.pipeline);
  const selected = useStore((s) => s.ui.selectedJob);
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  const variables = useStore((s) => s.variables);
  const settings = useStore((s) => s.settings);
  const logs = useStore((s) => s.logs);
  const artifacts = useStore((s) => s.artifacts);
  const childPipelines = useStore((s) => s.childPipelines);
  const [childOpen, setChildOpen] = useState(false);

  const job = pipeline?.jobs?.find((j) => j.name === selected);
  const s = effectiveSettings({ settings });
  const activeRun = runs.find((r) => r.id === activeRunId);

  const varsForRules = useMemo(() => {
    const map = {};
    for (const spec of pipeline?.variableSpecs || []) map[spec.name] = spec.value;
    for (const v of variables.global) if (v.enabled) map[v.key] = v.value;
    for (const v of variables.project) if (v.enabled) map[v.key] = v.value;
    Object.assign(map, s.sessionVars);
    Object.assign(map, job?.variables || {});
    map.CI_PIPELINE_SOURCE ??= "push";
    return map;
  }, [pipeline, variables, s.sessionVars, job]);

  if (!job) {
    return (
      <div className="panel-empty">
        Select a job in the graph above to inspect its rules, script, artifacts and actions.
      </div>
    );
  }

  // latest known status across runs, so it persists when the job wasn't rerun
  const merged = mergedRunStatus(runs, activeRun);
  const st = merged.jobs[job.name]?.status;
  // has this job ever produced output we can show?
  const hasRun = runs.some((r) => r.jobs?.[job.name] || Object.values(r.childJobs || {}).some((k) => k[job.name]));
  const never = job.when === "never";
  const ruleInfo = explainRules(job.rules, varsForRules);
  const logEntry = logs.logs.find((l) => l.job === job.name);
  const jobArtifacts = artifacts.jobs[job.name] || [];
  const cliCmd =
    "gitlab-ci-local " +
    [job.name.includes(" ") ? `"${job.name}"` : job.name, s.needs ? "--needs" : "", s.extraFlags].filter(Boolean).join(" ");

  const triggerIncludes = (job.trigger?.include || []).filter((i) => i.artifact || i.local);

  return (
    <div className="job-panel">
      <div className="job-panel-head">
        <div className={"job-status big" + (st ? " st-" + st : never ? " st-never" : "")}>
          {st ? STATUS_ICONS[st] : never ? "⃠" : "○"}
        </div>
        <div className="job-panel-title">
          <h2>{job.name}</h2>
          <div className="job-panel-sub">
            <span className="job-tag">stage: {job.stage}</span>
            <span className={"job-tag when-" + job.when}>when: {job.when}</span>
            {job.image && <span className="job-tag image" title="docker image">🐳 {job.image}</span>}
            {!job.image && <span className="job-tag shell">shell executor</span>}
            {job.allowFailure && <span className="job-tag allow">allow failure</span>}
            {job.environment && <span className="job-tag">env: {job.environment}</span>}
          </div>
          {job.description && <div className="job-desc">{job.description}</div>}
        </div>
        <div className="job-actions">
          {job.trigger ? (
            <button
              className="btn primary"
              title="Run this job's child pipeline directly (gcl can't run a trigger job by name)"
              onClick={() => runChildPipeline(job, { parentRunId: activeRunId })}
            >
              ▶ Run child
            </button>
          ) : (
            <>
              <button
                className={"btn primary" + (never ? " warn" : "")}
                title={never ? "Rules say never — this run forces the job (gcl runs explicitly named jobs regardless of rules)" : "Run this job" + (s.needs ? " and its needs" : "")}
                onClick={() => startRun({ jobs: [job.name], label: job.name + (never ? " (forced)" : "") })}
              >
                {never ? "⚡ Force run" : "▶ Run"}
                {s.needs && (job.needs || []).length ? " +needs" : ""}
              </button>
              <button
                className="btn"
                title="Run only this job, ignoring needs"
                onClick={() => startRun({ jobs: [job.name], label: job.name, overrides: { needs: false, onlyNeeds: false } })}
              >
                ▶ only this
              </button>
            </>
          )}
          {(job.script?.length || job.beforeScript?.length) ? (
            <button
              className="btn debug"
              title="Open in the visual debugger — set breakpoints between script steps"
              onClick={() => {
                setState({ ui: { ...getState().ui, debugJob: job.name } });
                setDockTab("debug");
              }}
            >
              ◉ Debug
            </button>
          ) : null}
          {hasRun && (
            <button
              className="btn"
              title="Show this job's output in the Output tab"
              onClick={() => viewJobOutput(job.name)}
            >
              ≣ View output
            </button>
          )}
          <button className="btn" title="Copy the equivalent CLI command" onClick={() => copyText(cliCmd, "Command")}>
            ⧉ CLI
          </button>
          {logEntry && (
            <button className="btn" title="Copy the path of this job's output log" onClick={() => copyText(logEntry.path, "Log path")}>
              ⧉ log path
            </button>
          )}
        </div>
      </div>

      {job.rules && (
        <div className="job-section">
          <div className="job-section-title">
            Rules <span className="muted">resolved by gitlab-ci-local to “{job.when}”{never ? " — job won't run in a pipeline, but can be forced" : ""}</span>
          </div>
          <table className="rules-table">
            <tbody>
              {ruleInfo.map(({ rule, verdict }, i) => (
                <tr key={i} className={"rule-" + verdict}>
                  <td className="rule-verdict" title="best-effort evaluation with current variables">
                    {VERDICT_LABEL[verdict]}
                  </td>
                  <td className="rule-body">
                    {rule.if && <code>if: {rule.if}</code>}
                    {rule.changes && <code>changes: {JSON.stringify(rule.changes)}</code>}
                    {rule.exists && <code>exists: {JSON.stringify(rule.exists)}</code>}
                    {!rule.if && !rule.changes && !rule.exists && <code className="muted">(always)</code>}
                  </td>
                  <td className="rule-when">→ {rule.when || "on_success"}</td>
                  {rule.allow_failure !== undefined && <td className="rule-extra">allow_failure: {String(rule.allow_failure)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small">
            Verdicts are estimated from your current variables; the resolved “when” above is authoritative. Tweak variables in the
            Variables tab and refresh to re-evaluate.
          </div>
        </div>
      )}

      {(job.needs || []).length > 0 && (
        <div className="job-section">
          <div className="job-section-title">Needs</div>
          <div className="chip-row">
            {job.needs.map((n) => (
              <button key={n.job} className="chip-btn" onClick={() => selectJob(n.job)}>
                {n.job}
                {n.optional ? " (optional)" : ""}
                {n.artifacts === false ? " (no artifacts)" : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {Object.keys(job.variables || {}).length > 0 && (
        <div className="job-section">
          <div className="job-section-title">Job variables</div>
          <table className="kv-table">
            <tbody>
              {Object.entries(job.variables).map(([k, v]) => (
                <tr key={k}>
                  <td className="kv-key">{k}</td>
                  <td className="kv-val">{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {triggerIncludes.length > 0 && (
        <div className="job-section">
          <div className="job-section-title">Triggered child pipeline</div>
          {triggerIncludes.map((inc, i) => {
            const file = inc.local ? inc.local : `.gitlab-ci-local/artifacts/${inc.job}/${inc.artifact}`;
            const childModel = childPipelines[job.name];
            return (
              <div key={i} className="trigger-block">
                <div className="trigger-info">
                  {inc.local ? (
                    <>
                      from local file <code>{inc.local}</code>
                    </>
                  ) : (
                    <>
                      from artifact <code>{inc.artifact}</code> of job{" "}
                      <a className="job-link" onClick={() => selectJob(inc.job)}>
                        {inc.job}
                      </a>
                    </>
                  )}
                </div>
                <div className="chip-row">
                  <button
                    className="btn primary"
                    title="Run the whole pipeline so gcl triggers the child (downstream support)"
                    onClick={() => startRun({ label: `pipeline → ${job.name}` })}
                  >
                    ▶ Run via pipeline
                  </button>
                  <button
                    className="btn"
                    title={
                      inc.local
                        ? `Run the child pipeline directly (gcl --file ${file})`
                        : `Run the generated child pipeline directly (gcl --file ${file}); requires ${inc.job} to have produced the artifact`
                    }
                    onClick={() => runChildPipeline(job, { parentRunId: activeRunId })}
                  >
                    ▶ Run child directly
                  </button>
                  <button
                    className="btn"
                    onClick={async () => {
                      if (!childOpen) await loadChildPipeline(job.name, file);
                      setChildOpen(!childOpen);
                    }}
                  >
                    {childOpen ? "▾ hide child graph" : "▸ show child graph"}
                  </button>
                </div>
                {childOpen && childModel && !childModel.error && (
                  <div className="child-graph">
                    <PipelineGraph model={childModel} run={null} compact onSelect={() => {}} />
                  </div>
                )}
                {childOpen && childModel?.error && (
                  <div className="muted small">
                    {inc.local
                      ? `child pipeline not parseable: ${childModel.error}`
                      : `child pipeline not parseable yet — run “${inc.job}” first to produce ${inc.artifact}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Script lines={job.beforeScript} title="before_script" />
      <Script lines={job.script} title="script" />
      <Script lines={job.afterScript} title="after_script" />

      {job.artifacts && (
        <div className="job-section">
          <div className="job-section-title">Artifacts</div>
          {(job.artifacts.paths || []).map((p) => (
            <code key={p} className="artifact-path-decl">
              {p}
            </code>
          ))}
          {jobArtifacts.length > 0 && (
            <div className="chip-row" style={{ marginTop: 6 }}>
              <button className="btn" onClick={() => setDockTab("artifacts")}>
                ▤ browse {jobArtifacts.filter((a) => a.type === "file").length} produced file(s)
              </button>
              <button
                className="btn"
                title="Copy absolute path of this job's artifacts folder"
                onClick={() => copyText(`${artifacts.root}/${job.name}`, "Artifacts path")}
              >
                ⧉ artifacts path
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
