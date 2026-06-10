import React, { useMemo, useState } from "react";
import { parseDiff, diffStats } from "../lib/diff.js";

function FileDiff({ file }) {
  const [open, setOpen] = useState(true);
  const name = file.newPath || file.oldPath || "(unknown file)";
  const renamed = file.oldPath && file.newPath && file.oldPath !== file.newPath;
  let adds = 0, dels = 0;
  for (const h of file.hunks) for (const l of h.lines) {
    if (l.type === "add") adds++;
    if (l.type === "del") dels++;
  }
  return (
    <div className="diff-file">
      <div className="diff-file-head" onClick={() => setOpen(!open)}>
        <span className="diff-caret">{open ? "▾" : "▸"}</span>
        <span className="diff-file-name">
          {renamed ? `${file.oldPath} → ${file.newPath}` : name}
          {!file.oldPath && <span className="diff-new-file"> (new)</span>}
          {!file.newPath && <span className="diff-del-file"> (deleted)</span>}
        </span>
        <span className="diff-file-stats">
          <span className="diff-adds">+{adds}</span> <span className="diff-dels">−{dels}</span>
        </span>
      </div>
      {open &&
        file.hunks.map((h, i) => (
          <div key={i} className="diff-hunk">
            <div className="diff-hunk-head">{h.header}</div>
            <table className="diff-table">
              <tbody>
                {h.lines.map((l, j) => (
                  <tr key={j} className={"dl-" + l.type}>
                    <td className="diff-no">{l.oldNo ?? ""}</td>
                    <td className="diff-no">{l.newNo ?? ""}</td>
                    <td className="diff-sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</td>
                    <td className="diff-text">{l.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

export default function DiffViewer({ text }) {
  const files = useMemo(() => parseDiff(text), [text]);
  const stats = useMemo(() => diffStats(files), [files]);
  if (!files.length) return <pre className="file-preview-plain">{text}</pre>;
  return (
    <div className="diff-viewer">
      <div className="diff-summary">
        {stats.files} file{stats.files > 1 ? "s" : ""} changed,{" "}
        <span className="diff-adds">+{stats.add}</span> <span className="diff-dels">−{stats.del}</span>
      </div>
      {files.map((f, i) => (
        <FileDiff key={i} file={f} />
      ))}
    </div>
  );
}
