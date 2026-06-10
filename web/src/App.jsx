import React, { useEffect, useRef, useState } from "react";
import { useStore, setDockTab, setState } from "./store.js";
import TopBar from "./components/TopBar.jsx";
import PipelineGraph from "./components/PipelineGraph.jsx";
import JobPanel from "./components/JobPanel.jsx";
import OutputView from "./components/OutputView.jsx";
import ArtifactsView from "./components/ArtifactsView.jsx";
import VariablesView from "./components/VariablesView.jsx";
import DebugView from "./components/DebugView.jsx";

const TABS = [
  { id: "output", label: "Output", icon: "≣" },
  { id: "job", label: "Job", icon: "□" },
  { id: "artifacts", label: "Artifacts", icon: "▤" },
  { id: "variables", label: "Variables", icon: "{}" },
  { id: "debug", label: "Debug", icon: "◉" },
];

export default function App() {
  const ui = useStore((s) => s.ui);
  const pipeline = useStore((s) => s.pipeline);
  const selectedJob = ui.selectedJob;
  const [dockHeight, setDockHeight] = useState(() => Number(localStorage.getItem("gclui.dockHeight")) || 380);
  const dragRef = useRef(null);

  useEffect(() => {
    localStorage.setItem("gclui.dockHeight", String(dockHeight));
  }, [dockHeight]);

  const startDrag = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = dockHeight;
    const move = (ev) => setDockHeight(Math.min(window.innerHeight - 160, Math.max(120, startH + (startY - ev.clientY))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const toast = ui.toast;

  return (
    <div className="app">
      <TopBar />
      {pipeline?.error && (
        <div className="pipeline-error">
          <div className="pipeline-error-title">gitlab-ci-local could not parse the pipeline</div>
          <pre>{pipeline.error}</pre>
          {pipeline.inputSpecs?.some((i) => i.required) && (
            <div className="pipeline-error-hint">
              This pipeline declares required <b>inputs</b> — set them in the{" "}
              <a onClick={() => setDockTab("variables")}>Variables</a> tab, then refresh.
            </div>
          )}
        </div>
      )}
      <div className="graph-area">
        <PipelineGraph />
      </div>
      {ui.dockOpen && (
        <>
          <div className="dock-resize" ref={dragRef} onMouseDown={startDrag} />
          <div className="dock" style={{ height: dockHeight }}>
            <div className="dock-tabs">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className={"dock-tab" + (ui.dockTab === t.id ? " active" : "")}
                  onClick={() => setDockTab(t.id)}
                >
                  <span className="dock-tab-icon">{t.icon}</span>
                  {t.label}
                  {t.id === "job" && selectedJob ? <span className="dock-tab-extra">{selectedJob}</span> : null}
                </button>
              ))}
              <div className="dock-tabs-spacer" />
              <button className="dock-collapse" title="Collapse panel" onClick={() => setState({ ui: { ...ui, dockOpen: false } })}>
                ▾
              </button>
            </div>
            <div className="dock-body">
              {ui.dockTab === "output" && <OutputView />}
              {ui.dockTab === "job" && <JobPanel />}
              {ui.dockTab === "artifacts" && <ArtifactsView />}
              {ui.dockTab === "variables" && <VariablesView />}
              {ui.dockTab === "debug" && <DebugView />}
            </div>
          </div>
        </>
      )}
      {!ui.dockOpen && (
        <button className="dock-reopen" onClick={() => setState({ ui: { ...ui, dockOpen: true } })}>
          ▴ panel
        </button>
      )}
      {toast && <div className={`toast toast-${toast.kind}`}>{toast.message}</div>}
    </div>
  );
}
