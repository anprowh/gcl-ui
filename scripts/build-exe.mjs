// Build single-file gcl-ui executables with `bun build --compile`.
//
//   node scripts/build-exe.mjs            # host platform
//   node scripts/build-exe.mjs all        # linux/mac/win, x64+arm64
//   node scripts/build-exe.mjs bun-linux-x64 bun-darwin-arm64
//
// Produces self-contained binaries in dist-bin/. The UI is embedded in-memory,
// so the binary needs no files on disk. It still calls out to `gitlab-ci-local`
// (must be on PATH or set via GCL_UI_GCL_BIN) and, for container debug, to
// docker/podman. node-pty (debug terminals) is bundled when the toolchain can;
// otherwise the binary runs fine with debug disabled.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist-bin");

const ALL = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64", "bun-windows-x64"];

function hostTarget() {
  const a = os.arch() === "arm64" ? "arm64" : "x64";
  const p = os.platform() === "darwin" ? "darwin" : os.platform() === "win32" ? "windows" : "linux";
  return `bun-${p}-${a}`;
}

let targets = process.argv.slice(2);
if (targets.length === 0) targets = [hostTarget()];
else if (targets.length === 1 && targets[0] === "all") targets = ALL;

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) {
    if (r.error) throw r.error;
    throw new Error(`${cmd} exited with ${r.status}`);
  }
}

function bunBin() {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return "bun";
  } catch {
    throw new Error("bun is required to build executables. Install it from https://bun.sh");
  }
}

const bun = bunBin();
fs.mkdirSync(outDir, { recursive: true });

try {
  // 1) build the frontend and embed it into the server bundle
  run("npm", ["run", "build"]);
  run("node", ["scripts/embed-assets.mjs"]);

  // 2) compile one binary per target
  for (const target of targets) {
    const isWin = target.includes("windows");
    const name = "gcl-ui-" + target.replace(/^bun-/, "") + (isWin ? ".exe" : "");
    const outfile = path.join(outDir, name);
    run(bun, [
      "build",
      "bin/gcl-ui.js",
      "--compile",
      `--target=${target}`,
      // vite is only used in the dev workflow; never bundle it into the binary
      "--external",
      "vite",
      "--outfile",
      outfile,
    ]);
    console.log(`✓ ${path.relative(root, outfile)}`);
  }
} finally {
  // 3) restore the empty embedded-assets stub so the working tree stays clean
  run("node", ["scripts/embed-assets.mjs", "--clear"]);
}

console.log("\nDone. Binaries in dist-bin/:");
for (const f of fs.readdirSync(outDir)) console.log("  " + f);
console.log("\nThe binary needs `gitlab-ci-local` on PATH (or GCL_UI_GCL_BIN).");
