import React, { useState } from "react";
import {
  useStore,
  saveVariables,
  effectiveSettings,
  updateSettings,
  loadPipeline,
  toast,
} from "../store.js";

function VarTable({ scope, list, fileHint }) {
  const [rows, setRows] = useState(null); // null = pristine (mirror store)
  const data = rows ?? list;

  const edit = (i, patch) => {
    const next = data.map((r, j) => (j === i ? { ...r, ...patch } : r));
    setRows(next);
  };
  const add = () => setRows([...data, { key: "", value: "", enabled: true }]);
  const remove = (i) => setRows(data.filter((_, j) => j !== i));
  const save = async () => {
    const cleaned = data.filter((r) => r.key.trim());
    await saveVariables(scope, cleaned);
    setRows(null);
  };
  const dirty = rows !== null;

  return (
    <div className="vars-block">
      <div className="vars-head">
        <h3>{scope === "project" ? "Project variables" : "Global variables"}</h3>
        <span className="muted small" title={fileHint}>
          {fileHint}
        </span>
        <div className="topbar-spacer" />
        <button className="btn small" onClick={add}>
          + add
        </button>
        {dirty && (
          <>
            <button className="btn small primary" onClick={save}>
              save
            </button>
            <button className="btn small" onClick={() => setRows(null)}>
              discard
            </button>
          </>
        )}
      </div>
      {data.length === 0 && <div className="muted small">none yet</div>}
      {data.length > 0 && (
        <table className="vars-table">
          <thead>
            <tr>
              <th style={{ width: 28 }} title="enabled"></th>
              <th>key</th>
              <th>value</th>
              <th style={{ width: 28 }}></th>
            </tr>
          </thead>
          <tbody>
            {data.map((r, i) => (
              <tr key={i} className={r.enabled ? "" : "var-disabled"}>
                <td>
                  <input type="checkbox" checked={r.enabled} onChange={(e) => edit(i, { enabled: e.target.checked })} />
                </td>
                <td>
                  <input className="var-input key" value={r.key} placeholder="KEY" spellCheck={false} onChange={(e) => edit(i, { key: e.target.value })} />
                </td>
                <td>
                  <input className="var-input" value={r.value} placeholder="value" spellCheck={false} onChange={(e) => edit(i, { value: e.target.value })} />
                </td>
                <td>
                  <button className="icon-btn" title="remove" onClick={() => remove(i)}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function VariablesView() {
  const variables = useStore((s) => s.variables);
  const pipeline = useStore((s) => s.pipeline);
  const project = useStore((s) => s.project);
  const settings = useStore((s) => s.settings);
  const s = effectiveSettings({ settings });
  const [newInput, setNewInput] = useState("");

  const setSessionVar = (key, value, def) => {
    const next = { ...s.sessionVars };
    if (value === def || value === "") delete next[key];
    else next[key] = value;
    updateSettings({ sessionVars: next });
  };
  const setInput = (key, value, def) => {
    const next = { ...s.inputs };
    if (value === String(def ?? "") || value === "") delete next[key];
    else next[key] = value;
    updateSettings({ inputs: next });
  };

  const inputSpecs = pipeline?.inputSpecs || [];
  const variableSpecs = pipeline?.variableSpecs || [];
  const extraSessionVars = Object.keys(s.sessionVars).filter((k) => !variableSpecs.some((v) => v.name === k));

  return (
    <div className="variables-view">
      <div className="vars-col">
        <div className="vars-block">
          <div className="vars-head">
            <h3>Pipeline form</h3>
            <span className="muted small">like GitLab's “Run pipeline” page — values apply to the next runs & rule evaluation</span>
            <div className="topbar-spacer" />
            <button className="btn small primary" onClick={() => loadPipeline().then(() => toast("pipeline re-evaluated", "ok"))}>
              ⟳ re-evaluate rules
            </button>
          </div>

          {inputSpecs.length > 0 && (
            <>
              <div className="form-sub">inputs (spec:inputs)</div>
              {inputSpecs.map((spec) => {
                const cur = s.inputs[spec.name] ?? (spec.default !== null ? String(spec.default) : "");
                const overridden = s.inputs[spec.name] !== undefined;
                return (
                  <div className="form-row" key={spec.name}>
                    <label className={"form-label" + (spec.required && !cur ? " required" : "")}>
                      {spec.name}
                      {spec.required && <span className="req">*</span>}
                      {spec.type !== "string" && <span className="muted"> ({spec.type})</span>}
                    </label>
                    {spec.options ? (
                      <select className="form-field" value={cur} onChange={(e) => setInput(spec.name, e.target.value, spec.default)}>
                        {spec.required && cur === "" && <option value="">— choose —</option>}
                        {spec.options.map((o) => (
                          <option key={o} value={String(o)}>
                            {String(o)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="form-field"
                        value={cur}
                        placeholder={spec.default !== null ? String(spec.default) : "(required)"}
                        spellCheck={false}
                        onChange={(e) => setInput(spec.name, e.target.value, spec.default)}
                      />
                    )}
                    {overridden && (
                      <button className="icon-btn" title="reset to default" onClick={() => setInput(spec.name, "", spec.default)}>
                        ↺
                      </button>
                    )}
                    {spec.description && <div className="form-desc">{spec.description}</div>}
                  </div>
                );
              })}
            </>
          )}

          {variableSpecs.length > 0 && <div className="form-sub">pipeline variables</div>}
          {variableSpecs.map((spec) => {
            const cur = s.sessionVars[spec.name] ?? spec.value;
            const overridden = s.sessionVars[spec.name] !== undefined;
            return (
              <div className="form-row" key={spec.name}>
                <label className="form-label">{spec.name}</label>
                {spec.options ? (
                  <select className={"form-field" + (overridden ? " overridden" : "")} value={cur} onChange={(e) => setSessionVar(spec.name, e.target.value, spec.value)}>
                    {spec.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={"form-field" + (overridden ? " overridden" : "")}
                    value={cur}
                    spellCheck={false}
                    onChange={(e) => setSessionVar(spec.name, e.target.value, spec.value)}
                  />
                )}
                {overridden && (
                  <button className="icon-btn" title={`reset to default (${spec.value})`} onClick={() => setSessionVar(spec.name, "", spec.value)}>
                    ↺
                  </button>
                )}
                {spec.description && <div className="form-desc">{spec.description}</div>}
              </div>
            );
          })}

          {extraSessionVars.map((k) => (
            <div className="form-row" key={k}>
              <label className="form-label">{k}</label>
              <input className="form-field overridden" value={s.sessionVars[k]} spellCheck={false} onChange={(e) => setSessionVar(k, e.target.value, undefined)} />
              <button className="icon-btn" title="remove" onClick={() => setSessionVar(k, "", undefined)}>
                ✕
              </button>
            </div>
          ))}

          <div className="form-row add-row">
            <input
              className="form-field"
              placeholder="add one-off variable: KEY=value  ⏎"
              value={newInput}
              spellCheck={false}
              onChange={(e) => setNewInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newInput.includes("=")) {
                  const idx = newInput.indexOf("=");
                  setSessionVar(newInput.slice(0, idx).trim(), newInput.slice(idx + 1), undefined);
                  setNewInput("");
                }
              }}
            />
          </div>
        </div>
      </div>
      <div className="vars-col">
        <VarTable scope="project" list={variables.project} fileHint={project ? `${project.projectDir}/variables.json` : ".gcl-ui/variables.json"} />
        <VarTable scope="global" list={variables.global} fileHint={project ? `${project.globalDir}/variables.json` : "~/.settings/gcl-ui/variables.json"} />
        <div className="muted small precedence-note">
          Precedence: pipeline form &gt; project &gt; global. Everything is passed to gitlab-ci-local as <code>--variable KEY=value</code>.
        </div>
      </div>
    </div>
  );
}
