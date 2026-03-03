/**
 * esbuild config for the extension backend.
 *
 * Bundles all TypeScript source + pure-JS dependencies (ws, uuid, xlsx, etc.)
 * into a single out/extension.js file. Native modules and the vscode API
 * are kept external.
 *
 * Also bundles pty-server.ts as a separate entry point — it runs as a
 * forked child process and must exist at out/services/pty-server.js.
 *
 * Usage:
 *   node esbuild.extension.mjs           # production build
 *   node esbuild.extension.mjs --watch   # dev mode (sourcemaps, no minify)
 */
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";

const isWatch = process.argv.includes("--watch");

// Clean out/ directory before building (removes old tsc output)
if (!isWatch) {
  fs.rmSync("out", { recursive: true, force: true });
  fs.mkdirSync("out/services", { recursive: true });
}

const external = [
  "vscode",
  // Native modules — must remain in node_modules (not bundleable)
  "@duckdb/node-api",
  "@duckdb/node-bindings",
  "node-pty",
];

const shared = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  external,
  minify: !isWatch,
  sourcemap: isWatch,
  logLevel: "info",
};

// ── Main extension entry point ──
const extensionConfig = {
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
};

// ── PTY server (forked child process, separate bundle) ──
// PtyManager forks this at: path.join(extensionPath, "out", "services", "pty-server.js")
const ptyServerConfig = {
  ...shared,
  entryPoints: ["src/services/pty-server.ts"],
  outfile: "out/services/pty-server.js",
};

if (isWatch) {
  const ctx1 = await esbuild.context(extensionConfig);
  const ctx2 = await esbuild.context(ptyServerConfig);
  await ctx1.watch();
  await ctx2.watch();
  console.log("Watching extension...");
} else {
  await esbuild.build(extensionConfig);
  await esbuild.build(ptyServerConfig);
  console.log("Extension built.");
}
