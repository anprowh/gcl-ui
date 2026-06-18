import React, { useState, useRef, useEffect } from "react";
import {
  useStore,
  effectiveSettings,
  updateSettings,
  loadPipeline,
  startRun,
  setDockTab,
} from "../store.js";

function useClickOutside(onClose) {
  const ref = useRef(null);
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);
  return ref;
}

const TOGGLES = [
  ["needs", "--needs", "When running a specific job, also run everything it needs"],
  ["onlyNeeds", "--only-needs", "Run only the needed jobs, not the selected job itself"],
  ["forceRules", "Force rules", "Run jobs even when their rules don't match (jobs are passed to gcl by name, which bypasses rules)"],
  ["forceIncludes", "Force includes", "Strip rules from `include:` entries so every include is loaded"],
  ["evaluateRuleChanges", "Evaluate rules:changes", "When off, every rules:changes clause counts as matching (--evaluate-rule-changes=false)"],
  ["shellIsolation", "--shell-isolation", "Isolate artifacts for shell-executor jobs"],
  ["forceShellExecutor", "--force-shell-executor", "Run every job on your shell instead of docker (trusted pipelines only)"],
  ["mountCache", "--mount-cache", "Docker mount based caching"],
  ["privileged", "--privileged", "Run docker executor in privileged mode"],
  ["cleanup", "--cleanup", "Remove docker resources after each job"],
];

export default function TopBar() {
  const project = useStore((s) => s.project);
  const pipeline = useStore((s) => s.pipeline);
  const loading = useStore((s) => s.pipelineLoading);
  const settingsRaw = useStore((s) => s.settings);
  const wsStatus = useStore((s) => s.wsStatus);
  const s = effectiveSettings({ settings: settingsRaw });
  const [showOptions, setShowOptions] = useState(false);
  const [showIncludes, setShowIncludes] = useState(false);
  const optionsRef = useClickOutside(() => setShowOptions(false));
  const includesRef = useClickOutside(() => setShowIncludes(false));

  const includes = pipeline?.includes || [];
  const gatedIncludes = includes.filter((i) => i.rules);
  const activeFlags = TOGGLES.filter(([k]) => (k === "evaluateRuleChanges" ? !s[k] : s[k])).length + (s.extraFlags ? 1 : 0);

  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand-mark">⛭</span> gcl-ui
      </div>
      {project && (
        <div className="project-info" title={project.cwd}>
          <span className="project-name">{project.name}</span>
          {project.branch && <span className="project-branch">⎇ {project.branch}</span>}
          {project.gclVersion && <span className="project-gcl">{project.gclVersion}</span>}
        </div>
      )}
      <div
        className={"ws-dot ws-" + wsStatus}
        title={wsStatus === "connected" ? "connected" : wsStatus === "reconnecting" ? "reconnecting…" : "connecting…"}
      />

      <div className="topbar-spacer" />

      {includes.length > 0 && (
        <div className="popover-anchor" ref={includesRef}>
          <button
            className={"chip-btn" + (s.forceIncludes ? " warn" : "")}
            onClick={() => setShowIncludes(!showIncludes)}
            title="Includes"
          >
            ⊞ {includes.length} include{includes.length > 1 ? "s" : ""}
            {s.forceIncludes && " · forced"}
          </button>
          {showIncludes && (
            <div className="popover includes-popover">
              <div className="popover-title">Includes</div>
              {includes.map((inc, i) => (
                <div key={i} className="include-row">
                  <div className="include-ref">
                    <span className={"include-kind k-" + inc.kind}>{inc.kind}</span> {inc.ref}
                    {inc.file && <span className="include-file"> → {Array.isArray(inc.file) ? inc.file.join(", ") : inc.file}</span>}
                  </div>
                  {inc.rules && (
                    <div className="include-rules">
                      {inc.rules.map((r, j) => (
                        <code key={j} className="rule-line">
                          {r.if ? `if: ${r.if}` : ""} {r.when ? `when: ${r.when}` : ""}
                          {r.exists ? ` exists: ${JSON.stringify(r.exists)}` : ""}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <label className={"opt-toggle" + (gatedIncludes.length === 0 ? " disabled" : "")} title="Strips rules from include: entries (a patched copy of the CI file is used)">
                <input
                  type="checkbox"
                  checked={s.forceIncludes}
                  onChange={(e) => {
                    updateSettings({ forceIncludes: e.target.checked });
                    setTimeout(loadPipeline, 50);
                  }}
                />
                <span>Force includes (ignore include rules)</span>
              </label>
              {gatedIncludes.length === 0 && <div className="popover-hint">No include here is gated by rules.</div>}
              {pipeline?.forcedIncludesActive && <div className="popover-hint warn">Running against a patched CI file with include rules stripped.</div>}
            </div>
          )}
        </div>
      )}

      <button className="btn" onClick={() => loadPipeline()} disabled={loading} title="Re-parse the pipeline">
        {loading ? "⟳ parsing…" : "⟳ refresh"}
      </button>

      <div className="popover-anchor" ref={optionsRef}>
        <button className={"btn" + (activeFlags ? " has-badge" : "")} onClick={() => setShowOptions(!showOptions)}>
          ⚙ options{activeFlags ? <span className="badge">{activeFlags}</span> : null}
        </button>
        {showOptions && (
          <div className="popover options-popover">
            <div className="popover-title">Run options</div>
            {TOGGLES.map(([key, label, hint]) => (
              <label className="opt-toggle" key={key} title={hint}>
                <input
                  type="checkbox"
                  checked={!!s[key]}
                  onChange={(e) => {
                    updateSettings({ [key]: e.target.checked });
                    if (key === "forceIncludes" || key === "evaluateRuleChanges") setTimeout(loadPipeline, 50);
                  }}
                />
                <span>{label}</span>
                <em className="opt-hint">{hint}</em>
              </label>
            ))}
            <div className="popover-title sub">Extra flags</div>
            <input
              className="extra-flags"
              placeholder="e.g. --timestamps --concurrency 2"
              value={s.extraFlags}
              onChange={(e) => updateSettings({ extraFlags: e.target.value })}
              spellCheck={false}
            />
            <div className="popover-hint">Appended verbatim to every gitlab-ci-local invocation.</div>
          </div>
        )}
      </div>

      <button className="btn" onClick={() => setDockTab("variables")} title="Variables & inputs">
        ⚿ variables
      </button>

      <button
        className="btn primary"
        disabled={!pipeline || !!pipeline.error}
        onClick={() => startRun({ label: s.forceRules ? "pipeline (forced rules)" : "pipeline" })}
        title={s.forceRules ? "Runs ALL jobs by naming them explicitly (rules bypassed)" : "Run the full pipeline"}
      >
        ▶ Run pipeline
      </button>
    </div>
  );
}
