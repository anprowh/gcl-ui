// Unified diff / git patch parser → [{ oldPath, newPath, hunks: [{header, lines: [{type, oldNo, newNo, text}]}] }]

export function looksLikeDiff(text) {
  if (!text) return false;
  const head = text.slice(0, 4000);
  return /^diff --git /m.test(head) || (/^--- /m.test(head) && /^\+\+\+ /m.test(head) && /^@@ /m.test(head));
}

export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  const pushFile = (oldPath, newPath) => {
    file = { oldPath, newPath, hunks: [], meta: [] };
    files.push(file);
    hunk = null;
  };

  for (const line of text.split("\n")) {
    const git = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (git) {
      pushFile(git[1], git[2]);
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).replace(/^a\//, "");
      if (!file || file.hunks.length) pushFile(p === "/dev/null" ? null : p, null);
      else file.oldPath = p === "/dev/null" ? null : p;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "");
      if (file) file.newPath = p === "/dev/null" ? null : p;
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h && file) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: line, context: h[3].trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      if (line.startsWith("+")) hunk.lines.push({ type: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
      else if (line.startsWith("-")) hunk.lines.push({ type: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
      else if (line.startsWith("\\")) hunk.lines.push({ type: "meta", oldNo: null, newNo: null, text: line });
      else hunk.lines.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    } else if (file) {
      if (line.trim()) file.meta.push(line);
    }
  }
  return files;
}

export function diffStats(files) {
  let add = 0, del = 0;
  for (const f of files) for (const h of f.hunks) for (const l of h.lines) {
    if (l.type === "add") add++;
    else if (l.type === "del") del++;
  }
  return { add, del, files: files.length };
}
