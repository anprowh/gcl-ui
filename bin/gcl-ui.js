#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "../server/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`gcl-ui — web UI for gitlab-ci-local

Usage: gcl-ui [directory] [options]

Options:
  -p, --port <port>   Port to listen on (default: first free port from 8275)
  --host <host>       Host to bind (default: 127.0.0.1)
  --no-open           Don't open the browser automatically
  --dev               Use the Vite dev server (for hacking on gcl-ui itself)
  -h, --help          Show this help`);
}

const argv = process.argv.slice(2);
let cwd = process.cwd();
let port = null;
let host = "127.0.0.1";
let open = true;
let dev = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") {
    usage();
    process.exit(0);
  } else if (a === "-p" || a === "--port") port = Number(argv[++i]);
  else if (a === "--host") host = argv[++i];
  else if (a === "--no-open") open = false;
  else if (a === "--dev") dev = true;
  else if (!a.startsWith("-")) cwd = path.resolve(a);
  else {
    console.error(`unknown option: ${a}`);
    process.exit(1);
  }
}

if (!fs.existsSync(cwd)) {
  console.error(`directory not found: ${cwd}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(cwd, ".gitlab-ci.yml"))) {
  console.warn(`warning: no .gitlab-ci.yml in ${cwd} (you can still point gcl at another file via extra flags)`);
}

function freePort(start) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(freePort(start + 1)));
    srv.listen(start, host, () => srv.close(() => resolve(start)));
  });
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best effort */
  }
}

const distDir = path.join(here, "..", "web", "dist");
const hasDist = fs.existsSync(path.join(distDir, "index.html"));
// in a packaged single-file binary the UI is embedded in-memory
const { assets: embeddedAssets } = await import("../server/embedded-assets.js");
const embeddedMode = Object.keys(embeddedAssets).length > 0;

const { server } = createServer(cwd, {
  staticDir: !dev && hasDist ? distDir : null,
  viteDev: dev || (!hasDist && !embeddedMode),
});

// only spin up Vite when there is no built/embedded UI (dev workflow)
if (!embeddedMode && (dev || !hasDist)) {
  // fall back to vite middleware mode (requires devDependencies installed)
  try {
    const { createServer: createVite } = await import("vite");
    const vite = await createVite({
      root: path.join(here, "..", "web"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    // mount vite in front of the express handler at the http level:
    // /api, /ws and the static artifact trees go to express, everything else to vite
    const toExpress = (url) =>
      url?.startsWith("/api/") || url === "/ws" || url?.startsWith("/artifact/") || url?.startsWith("/joblog/");
    const listeners = server.listeners("request").slice();
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      if (toExpress(req.url)) {
        for (const l of listeners) l(req, res);
      } else {
        vite.middlewares(req, res, () => {
          for (const l of listeners) l(req, res);
        });
      }
    });
    console.log("vite dev middleware enabled");
  } catch (e) {
    if (!hasDist) {
      console.error("No built frontend found (web/dist) and Vite is unavailable.");
      console.error("Run `npm run build` in the gcl-ui repo first, or `npm install` for dev mode.");
      console.error(String(e?.message || e));
      process.exit(1);
    }
  }
}

port = port || (await freePort(8275));
server.listen(port, host, () => {
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  console.log(`\n  gcl-ui for ${cwd}`);
  console.log(`  ${url}\n`);
  if (open) openBrowser(url);
});
