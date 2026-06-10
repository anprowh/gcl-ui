import React, { useEffect, useMemo, useState } from "react";
import { useStore, getFile, copyText, loadArtifacts } from "../store.js";
import { looksLikeDiff } from "../lib/diff.js";
import { languageFor, highlightLine } from "../lib/highlight.js";
import { ansiToSpans } from "../lib/ansi.js";
import DiffViewer from "./DiffViewer.jsx";

function buildTree(entries) {
  const root = { dirs: {}, files: [] };
  for (const e of entries) {
    const parts = e.path.split("/");
    if (e.type === "dir") {
      let node = root;
      for (const p of parts) node = node.dirs[p] ||= { dirs: {}, files: [] };
    } else {
      let node = root;
      for (const p of parts.slice(0, -1)) node = node.dirs[p] ||= { dirs: {}, files: [] };
      node.files.push({ name: parts[parts.length - 1], ...e });
    }
  }
  return root;
}

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function Tree({ node, prefix, depth, onOpen, openPath }) {
  return (
    <>
      {Object.entries(node.dirs).map(([name, child]) => (
        <DirRow key={name} name={name} node={child} prefix={prefix ? prefix + "/" + name : name} depth={depth} onOpen={onOpen} openPath={openPath} />
      ))}
      {node.files.map((f) => (
        <div
          key={f.path}
          className={"tree-row file" + (openPath === f.path ? " active" : "")}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => onOpen(f)}
        >
          <span className="tree-icon">▢</span>
          <span className="tree-name">{f.name}</span>
          <span className="tree-size">{fmtSize(f.size)}</span>
        </div>
      ))}
    </>
  );
}

function DirRow({ name, node, prefix, depth, onOpen, openPath }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div className="tree-row dir" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => setOpen(!open)}>
        <span className="tree-icon">{open ? "▾" : "▸"}</span>
        <span className="tree-name">{name}/</span>
      </div>
      {open && <Tree node={node} prefix={prefix} depth={depth + 1} onOpen={onOpen} openPath={openPath} />}
    </>
  );
}

const IMG_EXT = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"];

function Preview({ file, jobName, root }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const isLog = file?.base === "output";
  const relPath = file ? (isLog ? file.path : jobName + "/" + file.path) : null;

  useEffect(() => {
    setData(null);
    setErr(null);
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (IMG_EXT.includes(ext)) {
      setData({ image: `/api/file/raw?base=${file.base || "artifacts"}&path=${encodeURIComponent(relPath)}` });
      return;
    }
    getFile(file.base || "artifacts", relPath)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [file?.path, jobName]);

  if (!file) return <div className="panel-empty">Pick a file on the left — text, diffs and images preview right here.</div>;
  if (err) return <div className="panel-empty">⚠ {err}</div>;
  if (!data) return <div className="panel-empty">loading…</div>;

  const absPath = data.path || `${root}/${relPath}`;

  let body;
  if (data.image) {
    body = <div className="img-preview"><img src={data.image} alt={file.name} /></div>;
  } else if (data.binary) {
    body = (
      <div className="panel-empty">
        Binary file ({fmtSize(data.size)}) —{" "}
        <a href={`/api/file/raw?base=${file.base || "artifacts"}&path=${encodeURIComponent(relPath)}`} download={file.name}>
          download
        </a>
      </div>
    );
  } else if (languageFor(file.name) === "diff" || looksLikeDiff(data.content)) {
    body = <DiffViewer text={data.content} />;
  } else {
    const lang = languageFor(file.name);
    const hasAnsi = data.content.includes("\x1b[");
    const lines = data.content.split("\n");
    const shown = lines.slice(0, 5000);
    body = (
      <pre className="file-preview">
        {shown.map((l, i) => (
          <div key={i} className="fp-line">
            <span className="fp-no">{i + 1}</span>
            <span className="fp-text">
              {hasAnsi
                ? ansiToSpans(l).map((s, j) => (
                    <span key={j} style={s.style || undefined}>
                      {s.text}
                    </span>
                  ))
                : highlightLine(l, lang).map((t, j) => (
                    <span key={j} className={t.cls || undefined}>
                      {t.text}
                    </span>
                  ))}
            </span>
          </div>
        ))}
        {lines.length > 5000 && <div className="fp-line muted">… truncated ({lines.length} lines total)</div>}
      </pre>
    );
  }

  return (
    <div className="preview-pane">
      <div className="preview-head">
        <span className="preview-name" title={absPath}>
          {file.name}
        </span>
        {data.size !== undefined && <span className="muted">{fmtSize(data.size)}</span>}
        {data.truncated && <span className="job-tag warn">truncated preview</span>}
        <div className="topbar-spacer" />
        <button className="btn" title={absPath} onClick={() => copyText(absPath, "Path")}>
          ⧉ copy path
        </button>
      </div>
      {body}
    </div>
  );
}

export default function ArtifactsView() {
  const artifacts = useStore((s) => s.artifacts);
  const logs = useStore((s) => s.logs);
  const [open, setOpen] = useState(null); // {file, jobName}

  const jobs = Object.keys(artifacts.jobs);
  const trees = useMemo(
    () => Object.fromEntries(jobs.map((j) => [j, buildTree(artifacts.jobs[j])])),
    [artifacts]
  );

  return (
    <div className="artifacts-view">
      <div className="artifacts-tree">
        <div className="tree-toolbar">
          <span className="job-section-title">Artifacts</span>
          <button className="btn small" onClick={() => loadArtifacts()} title="Rescan .gitlab-ci-local/artifacts">
            ⟳
          </button>
        </div>
        {jobs.length === 0 && <div className="panel-empty small">No artifacts yet — run a job that declares some.</div>}
        {jobs.map((j) => (
          <div key={j} className="tree-job">
            <div className="tree-job-head">
              <span className="tree-job-name">{j}</span>
              <button
                className="icon-btn"
                title="Copy artifacts folder path"
                onClick={(e) => {
                  e.stopPropagation();
                  copyText(`${artifacts.root}/${j}`, "Path");
                }}
              >
                ⧉
              </button>
            </div>
            <Tree
              node={trees[j]}
              prefix=""
              depth={1}
              openPath={open?.jobName === j ? open.file.path : null}
              onOpen={(f) => setOpen({ file: f, jobName: j })}
            />
          </div>
        ))}
        {logs.logs.length > 0 && (
          <>
            <div className="tree-toolbar logs">
              <span className="job-section-title">Job logs</span>
            </div>
            {logs.logs.map((l) => (
              <div
                key={l.job}
                className={"tree-row file" + (open?.file?.base === "output" && open.file.path === l.job + ".log" ? " active" : "")}
                style={{ paddingLeft: 10 }}
                onClick={() => setOpen({ file: { name: l.job + ".log", path: l.job + ".log", base: "output", size: l.size }, jobName: null })}
              >
                <span className="tree-icon">≣</span>
                <span className="tree-name">{l.job}.log</span>
                <span className="tree-size">{fmtSize(l.size)}</span>
                <button
                  className="icon-btn"
                  title="Copy log path"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyText(l.path, "Log path");
                  }}
                >
                  ⧉
                </button>
              </div>
            ))}
          </>
        )}
      </div>
      <Preview file={open?.file} jobName={open?.jobName} root={artifacts.root} />
    </div>
  );
}
