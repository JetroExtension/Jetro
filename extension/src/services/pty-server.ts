/**
 * pty-server — standalone Node.js child process that owns node-pty.
 *
 * Runs OUTSIDE the VS Code extension host (forked via child_process.fork()).
 * Communicates with the parent PtyManager via IPC (process.send / process.on).
 *
 * Environment variables (set by parent):
 *   JET_EXTENSION_PATH — extension root (for resolving node-pty native module)
 *   JET_WORKSPACE_PATH — workspace directory (shell cwd)
 */

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import type { PtyParentMessage, PtyChildMessage } from "./pty-ipc";

// ── Helpers ──

function send(msg: PtyChildMessage): void {
  process.send!(msg);
}

function fixSpawnHelperPermissions(extensionPath: string): void {
  const candidates = [
    path.join(extensionPath, "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"),
    path.join(extensionPath, "node_modules/node-pty/prebuilds/darwin-x64/spawn-helper"),
  ];
  for (const p of candidates) {
    try { fs.chmodSync(p, 0o755); } catch { /* not this platform or doesn't exist */ }
  }
}

// ── Main ──

function main(): void {
  const extensionPath = process.env.JET_EXTENSION_PATH;
  const workspacePath = process.env.JET_WORKSPACE_PATH || process.cwd();

  if (!extensionPath) {
    send({ type: "error", message: "JET_EXTENSION_PATH not set" });
    process.exit(1);
  }

  // Fix spawn-helper permissions before loading node-pty
  fixSpawnHelperPermissions(extensionPath);

  // Load node-pty (native module — this is why we run out-of-process)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pty = require("node-pty") as typeof import("node-pty");

  const shell = process.env.SHELL || (os.platform() === "win32" ? "cmd.exe" : "/bin/zsh");

  const ptyEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };

  const proc = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: workspacePath,
    env: ptyEnv,
  });

  send({ type: "ready", pid: proc.pid });

  // PTY output → parent
  proc.onData((data: string) => {
    send({ type: "output", data });
  });

  // PTY exit → parent, then self-exit
  proc.onExit(({ exitCode }) => {
    send({ type: "exit", code: exitCode });
    process.exit(0);
  });

  // Parent messages → PTY
  process.on("message", (msg: PtyParentMessage) => {
    switch (msg.type) {
      case "input":
        proc.write(msg.data);
        break;
      case "resize":
        if (msg.cols > 0 && msg.rows > 0) {
          try { proc.resize(msg.cols, msg.rows); } catch { /* dead pty */ }
        }
        break;
      case "kill":
        try { proc.kill(); } catch { /* already dead */ }
        process.exit(0);
        break;
    }
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    try { proc.kill(); } catch { /* already dead */ }
    process.exit(0);
  });

  // If parent disconnects (IPC channel closes), clean up
  process.on("disconnect", () => {
    try { proc.kill(); } catch { /* already dead */ }
    process.exit(0);
  });
}

try {
  main();
} catch (err) {
  try {
    send({ type: "error", message: String(err) });
  } catch { /* IPC may be dead */ }
  process.exit(1);
}
