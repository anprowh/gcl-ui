import React, { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { onDebugData, wsSend, debugApi } from "../store.js";

export default function Terminal({ sessionId, focusToken }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);

  useEffect(() => {
    if (!hostRef.current || !sessionId) return;
    const term = new XTerm({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: "#0d1017",
        foreground: "#c9d1d9",
        cursor: "#c678dd",
        selectionBackground: "#3e445199",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fit.fit();

    // Avoid double-writes: live chunks already contained in the scrollback
    // snapshot (identified by byte offset) are dropped.
    let scrollEnd = null; // null = snapshot not loaded yet
    const pending = [];
    const writeLive = (data, offset) => {
      if (offset + data.length <= scrollEnd) return;
      term.write(data);
    };
    debugApi
      .scrollback(sessionId)
      .then(({ data, end }) => {
        if (data) term.write(data);
        scrollEnd = end ?? 0;
      })
      .catch(() => {
        scrollEnd = 0;
      })
      .finally(() => {
        for (const p of pending) writeLive(p.data, p.offset);
        pending.length = 0;
      });

    const offData = onDebugData((sid, data, offset) => {
      if (sid !== sessionId) return;
      if (scrollEnd === null) pending.push({ data, offset });
      else writeLive(data, offset);
    });
    const onInput = term.onData((data) => wsSend({ type: "debug.input", sessionId, data }));

    const sendSize = () => {
      try {
        fit.fit();
        wsSend({ type: "debug.resize", sessionId, cols: term.cols, rows: term.rows });
      } catch {}
    };
    sendSize();
    const ro = new ResizeObserver(sendSize);
    ro.observe(hostRef.current);

    return () => {
      offData();
      onInput.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    termRef.current?.focus();
  }, [focusToken, sessionId]);

  return <div className="terminal-host" ref={hostRef} />;
}
