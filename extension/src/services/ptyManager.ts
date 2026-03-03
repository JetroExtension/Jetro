/**
 * PtyManager — manages a single PTY session per workspace.
 *
 * The PTY runs in a separate Node.js child process (pty-server.js) to avoid
 * native module issues inside Electron. Communication is via Node IPC.
 *
 * Survives companion disconnects. Replays scrollback on reconnect.
 */

import { fork, type ChildProcess } from "child_process";
import * as path from "path";
import type * as vscode from "vscode";
import type WebSocket from "ws";
import type { PtyParentMessage, PtyChildMessage } from "./pty-ipc";

const MAX_SCROLLBACK = 10_000; // bytes

export interface PtySession {
  child: ChildProcess;
  ptyPid: number | null;
  scrollback: Buffer;
  alive: boolean;
}

export class PtyManager {
  private session: PtySession | null = null;
  private clients: Set<WebSocket> = new Set();

  constructor(
    private workspacePath: string,
    private extensionPath: string,
    private outputChannel: vscode.OutputChannel,
  ) {}

  /** Get or create the singleton PTY session (forks pty-server.js) */
  getOrCreateSession(): PtySession | null {
    if (this.session) return this.session;

    const serverScript = path.join(this.extensionPath, "out", "services", "pty-server.js");

    try {
      const child = fork(serverScript, [], {
        env: {
          ...process.env,
          JET_EXTENSION_PATH: this.extensionPath,
          JET_WORKSPACE_PATH: this.workspacePath,
        },
        silent: true,
      });

      const session: PtySession = {
        child,
        ptyPid: null,
        scrollback: Buffer.alloc(0),
        alive: false,
      };

      this.session = session;

      // IPC messages from child
      child.on("message", (msg: PtyChildMessage) => {
        if (this.session?.child !== child) return;

        switch (msg.type) {
          case "ready":
            session.ptyPid = msg.pid;
            session.alive = true;
            this.outputChannel.appendLine(`[pty] Child ready (pty pid ${msg.pid})`);
            break;

          case "output": {
            const buf = Buffer.from(msg.data, "utf8");

            // Append to scrollback (circular, capped)
            session.scrollback = Buffer.concat([session.scrollback, buf]);
            if (session.scrollback.length > MAX_SCROLLBACK) {
              session.scrollback = session.scrollback.slice(
                session.scrollback.length - MAX_SCROLLBACK,
              );
            }

            // Forward to all attached WS clients
            const text = msg.data;
            for (const ws of this.clients) {
              try {
                if (ws.readyState === 1 /* OPEN */) {
                  ws.send(text);
                }
              } catch {
                // Dead client — will be cleaned up
              }
            }
            break;
          }

          case "exit": {
            session.alive = false;
            this.outputChannel.appendLine(`[pty] Shell exited with code ${msg.code}`);

            const exitText = `\r\n[Process exited with code ${msg.code}]\r\n`;
            for (const ws of this.clients) {
              try {
                if (ws.readyState === 1) {
                  ws.send(exitText);
                }
              } catch { /* ignore */ }
            }

            this.session = null;
            break;
          }

          case "error":
            this.outputChannel.appendLine(`[pty] Child error: ${msg.message}`);
            break;
        }
      });

      child.on("exit", (code) => {
        if (this.session?.child === child) {
          this.outputChannel.appendLine(`[pty] Child process exited (code ${code})`);
          this.session = null;
        }
      });

      child.on("error", (err) => {
        this.outputChannel.appendLine(`[pty] Child process error: ${err.message}`);
        if (this.session?.child === child) {
          this.session = null;
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        this.outputChannel.appendLine(`[pty:stderr] ${chunk.toString("utf8").trim()}`);
      });

      this.outputChannel.appendLine(`[pty] Forked pty-server (child pid ${child.pid})`);
      return this.session;
    } catch (err) {
      this.outputChannel.appendLine(`[pty] Failed to fork pty-server: ${err}`);
      return null;
    }
  }

  /** Attach a WebSocket client — replays scrollback then subscribes to future output */
  attachClient(ws: WebSocket): void {
    this.clients.add(ws);

    // Replay scrollback
    const session = this.session;
    if (session && session.scrollback.length > 0 && ws.readyState === 1) {
      ws.send(session.scrollback.toString("utf8"));
    }

    this.outputChannel.appendLine(`[pty] Client attached (total: ${this.clients.size})`);
  }

  /** Detach a WebSocket client */
  detachClient(ws: WebSocket): void {
    this.clients.delete(ws);
    this.outputChannel.appendLine(`[pty] Client detached (total: ${this.clients.size})`);
  }

  /** Write input to the PTY (keystrokes from the browser) */
  write(data: string): void {
    if (this.session?.alive) {
      try {
        this.session.child.send({ type: "input", data } satisfies PtyParentMessage);
      } catch { /* IPC channel may be closed */ }
    }
  }

  /** Resize the PTY */
  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0 && this.session?.alive) {
      try {
        this.session.child.send({ type: "resize", cols, rows } satisfies PtyParentMessage);
      } catch { /* IPC channel may be closed */ }
    }
  }

  /** Kill the PTY and clean up */
  dispose(): void {
    if (this.session) {
      const child = this.session.child;
      try {
        child.send({ type: "kill" } satisfies PtyParentMessage);
      } catch { /* IPC channel may be closed */ }

      const killTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 2000);
      killTimer.unref();

      this.session = null;
    }
    this.clients.clear();
    this.outputChannel.appendLine("[pty] Disposed");
  }
}
