/**
 * AgentRefreshRunner — Headless CLI agent for prompt-based refresh bindings.
 *
 * Spawns a CLI agent in stream-json mode with permission-prompt-tool stdio.
 * Auto-approves all tool use (trusted automated context).
 * Processes one prompt at a time (queue managed by RefreshBindingManager).
 *
 * Currently supports Claude Code CLI (`claude`). To use a different CLI agent,
 * modify findAgentCli() and the spawn arguments.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";

export interface AgentEvent {
  type: "text" | "tool_use" | "tool_result" | "error" | "turn_start" | "turn_end";
  elementId?: string;
  elementTitle?: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  error?: string;
}

type EventCallback = (event: AgentEvent) => void;
type TurnCompleteCallback = () => void;

export class AgentRefreshRunner {
  private process: ChildProcess | null = null;
  private processAlive = false;
  private turnActive = false;
  private sessionId: string | null = null;
  private streamBuffer = "";
  private currentElementId: string | null = null;
  private currentElementTitle: string | null = null;

  private eventListeners: EventCallback[] = [];
  private turnCompleteListeners: TurnCompleteCallback[] = [];

  constructor(
    private workspacePath: string,
    private outputChannel: vscode.OutputChannel,
    private getJwt: () => Promise<string | null>,
  ) {}

  /** Whether the runner is currently processing a prompt turn */
  isBusy(): boolean {
    return this.turnActive;
  }

  /** Subscribe to all agent events (text, tool_use, errors) */
  onEvent(cb: EventCallback): vscode.Disposable {
    this.eventListeners.push(cb);
    return { dispose: () => { this.eventListeners = this.eventListeners.filter(l => l !== cb); } };
  }

  /** Subscribe to turn completion */
  onTurnComplete(cb: TurnCompleteCallback): vscode.Disposable {
    this.turnCompleteListeners.push(cb);
    return { dispose: () => { this.turnCompleteListeners = this.turnCompleteListeners.filter(l => l !== cb); } };
  }

  private emit(event: AgentEvent): void {
    event.elementId = this.currentElementId ?? undefined;
    event.elementTitle = this.currentElementTitle ?? undefined;
    for (const cb of this.eventListeners) {
      try { cb(event); } catch { /* ignore listener errors */ }
    }
  }

  private emitTurnComplete(): void {
    this.turnActive = false;
    for (const cb of this.turnCompleteListeners) {
      try { cb(); } catch { /* ignore */ }
    }
  }

  /**
   * Send a refresh prompt to the headless agent.
   * Wraps the prompt with element context so the agent uses jet_render id= for in-place update.
   */
  async sendRefreshPrompt(
    prompt: string,
    elementId: string,
    elementTitle?: string,
  ): Promise<void> {
    if (this.turnActive) {
      throw new Error("Agent turn already active");
    }

    this.currentElementId = elementId;
    this.currentElementTitle = elementTitle || elementId;

    const wrappedPrompt = [
      `[AUTOMATED REFRESH — element "${elementTitle || elementId}" (id: ${elementId})]`,
      `[WORKSPACE: ${this.workspacePath}]`,
      ``,
      prompt,
      ``,
      `IMPORTANT: You are running an automated refresh for canvas element "${elementTitle || elementId}".`,
      `Use jet_render with id="${elementId}" to UPDATE this existing element in-place. Do NOT omit the id param or you will create a duplicate.`,
      `Your working directory is "${this.workspacePath}". All relative paths (e.g. .jetro/frames/*, .jetro/scripts/*) are relative to this workspace root.`,
      `Keep your response focused and concise. Do NOT ask the user questions — this is an automated task.`,
    ].join("\n");

    this.emit({ type: "turn_start", text: prompt });

    if (!this.processAlive) {
      await this.spawnProcess();
    }

    this.turnActive = true;
    this.streamBuffer = "";

    const sdkMessage = JSON.stringify({
      type: "user",
      message: { role: "user", content: wrappedPrompt },
    });

    try {
      this.process!.stdin!.write(sdkMessage + "\n");
      this.outputChannel.appendLine(`[agent-refresh] Sent prompt for ${elementTitle || elementId}`);
    } catch (err) {
      this.outputChannel.appendLine(`[agent-refresh] Write failed: ${err}`);
      this.turnActive = false;
      this.processAlive = false;
      this.emit({ type: "error", error: `Write failed: ${err}` });
      this.emitTurnComplete();
    }
  }

  private async spawnProcess(): Promise<void> {
    // Find CLI agent
    const claudePath = this.findAgentCli();
    if (!claudePath) {
      this.outputChannel.appendLine("[agent-refresh] CLI agent not found — prompt bindings disabled");
      throw new Error("CLI agent not found. Install Claude Code CLI or configure an alternative.");
    }

    // Ensure MCP config exists
    const mcpConfigPath = path.join(this.workspacePath, ".jetro", "mcp-config.json");
    const hasMcpConfig = fs.existsSync(mcpConfigPath);

    const jwt = await this.getJwt();

    const args: string[] = [
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--permission-prompt-tool", "stdio",
    ];

    if (hasMcpConfig) {
      args.push("--mcp-config", mcpConfigPath);
    }

    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      JET_WORKSPACE: this.workspacePath,
      JET_API_URL: vscode.workspace.getConfiguration("jetro").get<string>("apiUrl") || "http://localhost:8787",
    };
    // Remove CLAUDECODE to prevent "nested session" error — the headless agent
    // is an independent process, not a nested session.
    delete env.CLAUDECODE;
    if (jwt) env.JET_JWT = jwt;

    this.outputChannel.appendLine(`[agent-refresh] Spawning: ${claudePath} ${args.join(" ")}`);

    this.process = spawn(claudePath, args, {
      cwd: this.workspacePath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.processAlive = true;

    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString());
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      // stderr is debug info from CLI agent
      const text = chunk.toString().trim();
      if (text) {
        this.outputChannel.appendLine(`[agent-refresh][stderr] ${text}`);
      }
    });

    this.process.on("exit", (code) => {
      this.outputChannel.appendLine(`[agent-refresh] Process exited: ${code}`);
      this.processAlive = false;
      if (this.turnActive) {
        this.emit({ type: "error", error: `Process exited unexpectedly (code: ${code})` });
        this.emitTurnComplete();
      }
    });

    this.process.on("error", (err) => {
      this.outputChannel.appendLine(`[agent-refresh] Process error: ${err.message}`);
      this.processAlive = false;
      if (this.turnActive) {
        this.emit({ type: "error", error: err.message });
        this.emitTurnComplete();
      }
    });
  }

  private handleStdout(chunk: string): void {
    this.streamBuffer += chunk;

    // Process complete JSON lines
    const lines = this.streamBuffer.split("\n");
    this.streamBuffer = lines.pop() || ""; // Keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this.handleStreamMessage(msg);
      } catch {
        // Not JSON — ignore
      }
    }
  }

  private handleStreamMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    switch (type) {
      case "system": {
        // Session init — capture session ID
        if (msg.session_id) {
          this.sessionId = msg.session_id as string;
          this.outputChannel.appendLine(`[agent-refresh] Session: ${this.sessionId}`);
        }
        break;
      }

      case "assistant": {
        // Start of assistant turn
        break;
      }

      case "content_block_start": {
        const block = msg.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          this.emit({
            type: "tool_use",
            toolName: block.name as string,
            toolInput: block.input,
          });
        }
        break;
      }

      case "content_block_delta": {
        const delta = msg.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta") {
          this.emit({ type: "text", text: delta.text as string });
        }
        break;
      }

      case "content_block_stop": {
        break;
      }

      case "result": {
        // Tool execution result
        const result = msg.result as string | undefined;
        if (result) {
          this.emit({ type: "tool_result", toolResult: result });
        }

        // Check if this is the final result (turn complete)
        if (msg.is_error === false || msg.subtype === "success") {
          // Turn is done
        }
        break;
      }

      // Permission control request — auto-approve everything in refresh mode
      case "control_request": {
        const request = msg as Record<string, unknown>;
        const requestId = request.request_id as string;
        const toolInput = request.input as Record<string, unknown> | undefined;

        // Auto-approve: echo back input with behavior: "allow"
        const response = JSON.stringify({
          type: "control_response",
          response: {
            request_id: requestId,
            subtype: "success",
            response: {
              behavior: "allow",
              updatedInput: toolInput || {},
            },
          },
        });

        try {
          this.process?.stdin?.write(response + "\n");
          this.outputChannel.appendLine(`[agent-refresh] Auto-approved tool (${requestId})`);
        } catch (err) {
          this.outputChannel.appendLine(`[agent-refresh] Auto-approve write failed: ${err}`);
        }
        break;
      }

      // The streamlined_text events from --verbose mode
      case "streamlined_text": {
        const text = msg.text as string || msg.data as string || "";
        if (text) {
          this.emit({ type: "text", text });
        }
        break;
      }

      // End of turn
      case "message_stop":
      case "done": {
        this.outputChannel.appendLine(`[agent-refresh] Turn complete for ${this.currentElementTitle}`);
        this.emit({ type: "turn_end" });
        this.emitTurnComplete();
        break;
      }
    }
  }

  /**
   * Locate a CLI agent binary. Currently checks for `claude` (Claude Code CLI).
   * Override this method to support other CLI agents.
   */
  private findAgentCli(): string | null {
    const candidates = [
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
      path.join(process.env.HOME || "", ".npm-global/bin/claude"),
      "claude", // Rely on PATH
    ];

    for (const candidate of candidates) {
      try {
        if (candidate === "claude") {
          const { execSync } = require("node:child_process");
          const resolved = execSync("which claude", { encoding: "utf-8", timeout: 3000 }).trim();
          if (resolved) return resolved;
        } else if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch { /* not found */ }
    }
    return null;
  }

  /** Kill the headless agent process */
  dispose(): void {
    if (this.process) {
      try { this.process.kill("SIGTERM"); } catch { /* ignore */ }
      this.process = null;
      this.processAlive = false;
    }
    this.eventListeners = [];
    this.turnCompleteListeners = [];
  }
}
