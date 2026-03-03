/**
 * RefreshMonitorPanel — webview panel showing agent refresh activity.
 *
 * Displays a scrollable log of agent text, tool calls, errors, and a
 * status line with queue depth. Provides Pause All / Resume All controls.
 */

import * as vscode from "vscode";
import type { AgentRefreshRunner, AgentEvent } from "../services/agentRefreshRunner";
import type { RefreshBindingManager } from "../services/refreshBindingManager";

export class RefreshMonitorPanel {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private agentRunner: AgentRefreshRunner,
    private bindingManager: RefreshBindingManager,
    private outputChannel: vscode.OutputChannel,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "jetro.refreshMonitor",
      "Refresh Monitor",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.html = this.getHtml();

    // Forward agent events to webview
    const eventSub = this.agentRunner.onEvent((event: AgentEvent) => {
      this.postMessage({ type: "agentEvent", event });
    });
    this.disposables.push(eventSub);

    const turnSub = this.agentRunner.onTurnComplete(() => {
      this.postMessage({
        type: "status",
        status: "idle",
        queueLength: this.bindingManager.getPromptQueueLength(),
      });
    });
    this.disposables.push(turnSub);

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      async (msg: { type: string; canvasId?: string }) => {
        switch (msg.type) {
          case "pauseAll":
            if (msg.canvasId) {
              await this.bindingManager.pauseAll(msg.canvasId);
              this.postMessage({ type: "status", status: "paused" });
            }
            break;
          case "resumeAll":
            if (msg.canvasId) {
              await this.bindingManager.resumeAll(msg.canvasId);
              this.postMessage({ type: "status", status: "idle" });
            }
            break;
          case "getStatus":
            this.postMessage({
              type: "status",
              status: this.agentRunner.isBusy() ? "running" : "idle",
              queueLength: this.bindingManager.getPromptQueueLength(),
            });
            break;
        }
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => {
      this.panel = null;
      for (const d of this.disposables) d.dispose();
      this.disposables = [];
    });
  }

  private postMessage(msg: unknown): void {
    this.panel?.webview.postMessage(msg);
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Refresh Monitor</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: #1e1e1e;
      color: #ccc;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid #2b2b2b;
      background: #181818;
      flex-shrink: 0;
    }

    .header h2 {
      font-size: 13px;
      font-weight: 600;
      color: #DEBFCA;
    }

    .status-line {
      font-size: 11px;
      color: #888;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #555;
    }
    .status-dot.running {
      background: #4caf50;
      animation: pulse 1.5s ease-in-out infinite;
    }
    .status-dot.error { background: #f44336; }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .controls {
      display: flex;
      gap: 6px;
    }

    .controls button {
      font-size: 11px;
      padding: 3px 8px;
      border: 1px solid #444;
      border-radius: 3px;
      background: #2b2b2b;
      color: #ccc;
      cursor: pointer;
    }
    .controls button:hover { background: #363636; }

    .log-container {
      flex: 1;
      overflow-y: auto;
      padding: 8px 14px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 11px;
      line-height: 1.6;
    }

    .log-entry {
      padding: 2px 0;
      border-bottom: 1px solid #1a1a1a;
    }
    .log-entry.text { color: #d4d4d4; }
    .log-entry.tool {
      color: #569cd6;
      padding-left: 8px;
      border-left: 2px solid #569cd6;
    }
    .log-entry.tool-result {
      color: #6a9955;
      padding-left: 8px;
      border-left: 2px solid #6a9955;
    }
    .log-entry.error {
      color: #f44336;
      padding-left: 8px;
      border-left: 2px solid #f44336;
    }
    .log-entry.turn-marker {
      color: #DEBFCA;
      font-weight: 600;
      margin-top: 8px;
      padding-top: 4px;
      border-top: 1px dashed #333;
    }

    .timestamp {
      color: #555;
      margin-right: 6px;
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: #555;
      font-size: 12px;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="header">
    <h2>Refresh Monitor</h2>
    <div class="status-line">
      <div class="status-dot" id="statusDot"></div>
      <span id="statusText">Idle</span>
    </div>
  </div>

  <div class="log-container" id="log">
    <div class="empty-state" id="emptyState">
      No refresh activity yet. Prompt-bound elements will show agent activity here.
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const logEl = document.getElementById('log');
    const emptyState = document.getElementById('emptyState');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');

    function ts() {
      const d = new Date();
      return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function addEntry(cls, content) {
      if (emptyState) emptyState.remove();
      const div = document.createElement('div');
      div.className = 'log-entry ' + cls;
      div.innerHTML = '<span class="timestamp">' + ts() + '</span>' + escapeHtml(content);
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function escapeHtml(s) {
      const div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }

    function setStatus(status, queueLength) {
      statusDot.className = 'status-dot' + (status === 'running' ? ' running' : '');
      let label = status === 'running' ? 'Running' : 'Idle';
      if (queueLength > 0) label += ' · Queued: ' + queueLength;
      statusText.textContent = label;
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'agentEvent') {
        const ev = msg.event;
        switch (ev.type) {
          case 'turn_start':
            addEntry('turn-marker', '▶ Refresh: ' + (ev.elementTitle || ev.elementId || 'unknown'));
            setStatus('running');
            break;
          case 'text':
            if (ev.text && ev.text.trim()) addEntry('text', ev.text);
            break;
          case 'tool_use':
            addEntry('tool', '⚙ ' + (ev.toolName || 'tool'));
            break;
          case 'tool_result':
            if (ev.toolResult) {
              const preview = ev.toolResult.length > 200 ? ev.toolResult.slice(0, 200) + '…' : ev.toolResult;
              addEntry('tool-result', '↳ ' + preview);
            }
            break;
          case 'error':
            addEntry('error', '✗ ' + (ev.error || 'Unknown error'));
            break;
          case 'turn_end':
            addEntry('turn-marker', '✓ Turn complete');
            setStatus('idle');
            break;
        }
      } else if (msg.type === 'status') {
        setStatus(msg.status, msg.queueLength);
      }
    });

    // Request initial status
    vscode.postMessage({ type: 'getStatus' });
  </script>
</body>
</html>`;
  }
}
