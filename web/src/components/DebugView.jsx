import React, { useEffect, useMemo, useRef, useState } from "react";
import { EditorView, lineNumbers, gutter, GutterMarker, Decoration } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSet } from "@codemirror/state";
import { yaml } from "@codemirror/lang-yaml";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { useStore, effectiveSettings, updateSettings, startDebug, debugApi, setState, getState } from "../store.js";
import Terminal from "./Terminal.jsx";

// ---- CodeMirror breakpoint + current-line machinery -------------------------
class BpMarker extends GutterMarker {
  constructor(kind) {
    super();
    this.kind = kind; // "set" | "possible"
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-bp " + this.kind;
    el.textContent = this.kind === "set" ? "●" : "○";
    return el;
  }
}
const setBpEffect = StateEffect.define();
const setCurrentEffect = StateEffect.define();

const bpField = StateField.define({
  create: () => ({ set: new Set(), possible: new Map() }), // possible: line -> stepId
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBpEffect)) value = e.value;
    return value;
  },
});

const currentField = StateField.define({
  create: () => null, // {line, paused}
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setCurrentEffect)) value = e.value;
    return value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (cur) => {
      if (!cur) return Decoration.none;
      return Decoration.set([
        Decoration.line({ class: cur.paused ? "cm-exec-paused" : "cm-exec-line" }).range(cur.pos),
      ]);
    }),
});

export default function DebugView() {
  const pipeline = useStore((s) => s.pipeline);
  const settings = useStore((s) => s.settings);
  const sessions = useStore((s) => s.debugSessions);
  const activeDebugId = useStore((s) => s.activeDebugId);
  const debugJobHint = useStore((s) => s.ui.debugJob);
  const containerRuntime = useStore((s) => s.debugCaps.containerRuntime);
  const s = effectiveSettings({ settings });

  const debuggable = (pipeline?.jobs || []).filter((j) => j.script?.length || j.beforeScript?.length);
  const [jobName, setJobName] = useState(null);
  const [focusToken, setFocusToken] = useState(0);
  const [useContainer, setUseContainer] = useState(null); // null = auto
  const effectiveJob = debugJobHint || jobName || debuggable[0]?.name || null;
  const job = debuggable.find((j) => j.name === effectiveJob);
  // default: run in container when the job has an image and a runtime exists
  const canContainer = !!(job?.image && containerRuntime);
  const containerOn = useContainer === null ? canContainer : useContainer && canContainer;

  const editorHost = useRef(null);
  const viewRef = useRef(null);

  const session = sessions.find((d) => d.id === activeDebugId);
  const sessionForJob = session && session.job === effectiveJob ? session : null;
  const liveSession = sessionForJob && ["running", "paused"].includes(sessionForJob.status) ? sessionForJob : null;

  const breakpoints = s.breakpoints?.[effectiveJob] || [];

  // line -> stepId map for this job from the expanded yaml
  const stepLines = useMemo(() => {
    const m = new Map(); // line -> stepId  (only first line of each step)
    const ranges = new Map(); // stepId -> {line, endLine}
    const entry = pipeline?.scriptMap?.[effectiveJob];
    if (entry) {
      for (const section of ["before_script", "script"]) {
        for (const step of entry[section] || []) {
          const id = `${section}:${step.index}`;
          m.set(step.line, id);
          ranges.set(id, step);
        }
      }
    }
    return { byLine: m, byStep: ranges };
  }, [pipeline, effectiveJob]);

  const toggleBreakpoint = (stepId) => {
    const cur = new Set(s.breakpoints?.[effectiveJob] || []);
    if (cur.has(stepId)) cur.delete(stepId);
    else cur.add(stepId);
    updateSettings({ breakpoints: { ...s.breakpoints, [effectiveJob]: [...cur] } });
  };
  const toggleRef = useRef(toggleBreakpoint);
  toggleRef.current = toggleBreakpoint;
  const stepLinesRef = useRef(stepLines);
  stepLinesRef.current = stepLines;

  // build the editor once per yaml text
  useEffect(() => {
    if (!editorHost.current || !pipeline?.expandedYaml) return;
    const bpGutter = gutter({
      class: "cm-bp-gutter",
      markers: (view) => {
        const { set, possible } = view.state.field(bpField);
        const builder = [];
        for (const [line, stepId] of possible) {
          if (line > view.state.doc.lines) continue;
          const pos = view.state.doc.line(line).from;
          builder.push((set.has(stepId) ? new BpMarker("set") : new BpMarker("possible")).range(pos));
        }
        return RangeSet.of(
          builder.sort((a, b) => a.from - b.from),
          true
        );
      },
      domEventHandlers: {
        mousedown: (view, block) => {
          const line = view.state.doc.lineAt(block.from).number;
          const stepId = stepLinesRef.current.byLine.get(line);
          if (stepId) toggleRef.current(stepId);
          return true;
        },
      },
    });

    const view = new EditorView({
      state: EditorState.create({
        doc: pipeline.expandedYaml,
        extensions: [
          lineNumbers(),
          bpGutter,
          bpField,
          currentField,
          yaml(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          EditorView.theme({}, { dark: true }),
        ],
      }),
      parent: editorHost.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [pipeline?.expandedYaml]);

  // sync breakpoint markers + scroll to job
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: setBpEffect.of({ set: new Set(breakpoints), possible: stepLines.byLine }),
    });
    const first = [...stepLines.byLine.keys()].sort((a, b) => a - b)[0];
    if (first && first <= view.state.doc.lines) {
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(first).from, { y: "center" }) });
    }
  }, [stepLines, breakpoints.join("|"), pipeline?.expandedYaml]);

  // sync current execution line
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cur = null;
    if (liveSession?.currentStep || liveSession?.pausedAt) {
      const stepId = (liveSession.pausedAt || liveSession.currentStep || "").replace(/ \(failed\)$/, "");
      const step = stepLines.byStep.get(stepId);
      if (step && step.line <= view.state.doc.lines) {
        cur = { pos: view.state.doc.line(step.line).from, paused: !!liveSession.pausedAt };
      }
    }
    view.dispatch({
      effects: [
        setCurrentEffect.of(cur),
        ...(cur ? [EditorView.scrollIntoView(cur.pos, { y: "center" })] : []),
      ],
    });
  }, [liveSession?.currentStep, liveSession?.pausedAt, liveSession?.status, stepLines]);

  if (!pipeline?.expandedYaml) {
    return <div className="panel-empty">Debug mode needs a parseable pipeline — fix parse errors first.</div>;
  }

  const start = async () => {
    await startDebug(job, breakpoints, { container: containerOn });
    setFocusToken((t) => t + 1);
  };

  return (
    <div className="debug-view">
      <div className="debug-toolbar">
        <select
          className="run-select"
          value={effectiveJob || ""}
          onChange={(e) => {
            setJobName(e.target.value);
            setState({ ui: { ...getState().ui, debugJob: null } });
          }}
        >
          {debuggable.map((j) => (
            <option key={j.name} value={j.name}>
              {j.name}
              {(s.breakpoints?.[j.name] || []).length ? ` ● ${(s.breakpoints?.[j.name] || []).length}` : ""}
            </option>
          ))}
        </select>
        <span className="muted small">
          {breakpoints.length ? `${breakpoints.length} breakpoint${breakpoints.length > 1 ? "s" : ""}` : "click ○ in the gutter to set breakpoints"}
        </span>
        {canContainer && (
          <label className="container-toggle" title={`Run the job in its image (${job.image}) via ${containerRuntime}. The project is bind-mounted and the debug driver is POSIX-sh so it works on minimal images.`}>
            <input type="checkbox" checked={containerOn} disabled={!!liveSession} onChange={(e) => setUseContainer(e.target.checked)} />
            <span>🐳 in container</span>
          </label>
        )}
        {containerOn && <span className="job-tag" title={job.image}>{containerRuntime} · {job.image}</span>}
        {job?.image && !containerRuntime && (
          <span className="job-tag warn" title="No docker/podman found — the script runs on the host shell instead">⚠ no runtime · host shell</span>
        )}
        {job?.image && containerRuntime && !containerOn && (
          <span className="job-tag warn" title="Toggle ‘in container’ to run inside the image">⚠ host shell</span>
        )}
        <div className="topbar-spacer" />
        {liveSession ? (
          <>
            <span className={"run-status st-" + (liveSession.status === "paused" ? "paused" : "running")}>
              {liveSession.status === "paused" ? `paused at ${liveSession.pausedAt}` : `running ${liveSession.currentStep || ""}`}
            </span>
            {liveSession.status === "paused" && (
              <button className="btn primary" onClick={() => debugApi.continue(liveSession.id)} title="resume (:c in the terminal)">
                ▶ continue
              </button>
            )}
            <button className="btn danger" onClick={() => debugApi.abort(liveSession.id)} title="abort the job (:q in the terminal)">
              ⊘ abort
            </button>
          </>
        ) : (
          <>
            {sessionForJob && <span className={"run-status st-" + (sessionForJob.status === "finished" ? "success" : "failed")}>{sessionForJob.status}</span>}
            <button className="btn primary" onClick={start} disabled={!job}>
              ◉ start debug session
            </button>
          </>
        )}
      </div>
      <div className="debug-body">
        <div className="debug-editor" ref={editorHost} />
        <div className="debug-terminal">
          {sessionForJob ? (
            <Terminal sessionId={sessionForJob.id} focusToken={focusToken} />
          ) : (
            <div className="panel-empty small">
              <p><b>How it works</b></p>
              <p>① click ○ next to a script step to set a breakpoint</p>
              <p>② start the session — the job runs right here{canContainer ? ", inside its container image" : ""}</p>
              <p>③ at a breakpoint this terminal <i>is</i> the job's shell: check variables (<code>echo $VAR</code>), change them, then <code>:c</code> to continue or <code>:q</code> to abort</p>
              <p>④ failing steps also pause automatically, so you can post-mortem</p>
              {canContainer && <p className="muted">🐳 container mode bind-mounts your project and uses only <code>/bin/sh</code>, so it works even on minimal images.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
