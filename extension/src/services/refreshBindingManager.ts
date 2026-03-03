import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";
import { CanvasProvider } from "../canvas/CanvasProvider";
import { AuthService } from "./authService";
import { RefreshBinding } from "../types";
import type { ShareManager } from "./shareManager";
import type { AgentRefreshRunner } from "./agentRefreshRunner";
import type { FileManager } from "./fileManager";
import { logTrouble } from "./troubleLog";

/**
 * RefreshBindingManager — manages timer-based script execution for canvas
 * element refresh bindings.  When a canvas is opened, it reads the stored
 * bindings from canvas state and starts an `setInterval` per enabled binding.
 * When a canvas is closed (or the extension deactivates) all timers are
 * cleared.
 *
 * Script contract (same as jetro.refreshList):
 *   • `python3 "{scriptFullPath}"`
 *   • Env: JET_JWT, JET_API_URL, JET_WORKSPACE, JET_ELEMENT_ID, JET_CANVAS_ID
 *   • Timeout: 30 s, maxBuffer: 4 MB
 *   • stdout → JSON object, shallow-merged into element.data
 *   • exit 0 = success, non-zero = error stored in binding.lastError
 */
/** Minimum prompt refresh interval (5 minutes) */
const MIN_PROMPT_INTERVAL_MS = 5 * 60 * 1000;

interface PromptQueueEntry {
  canvasId: string;
  binding: RefreshBinding;
}

export class RefreshBindingManager {
  /** Map<canvasId, Map<timerKey, timer>>  — timerKey = elementId or elementId:prompt */
  private timers = new Map<string, Map<string, ReturnType<typeof setInterval>>>();
  private shareManager: ShareManager | null = null;
  private agentRunner: AgentRefreshRunner | null = null;
  private livePusher: ((elementId: string, data: unknown) => void) | null = null;

  /** FIFO queue for prompt bindings (agent processes one at a time) */
  private promptQueue: PromptQueueEntry[] = [];
  private promptDraining = false;

  private workspacePath: string;
  private extensionPath: string;

  constructor(
    private canvasProvider: CanvasProvider,
    private authService: AuthService,
    private outputChannel: vscode.OutputChannel,
    extensionPath?: string,
    private fileManager?: FileManager,
    private secrets?: vscode.SecretStorage,
  ) {
    this.workspacePath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
    this.extensionPath = extensionPath || "";
  }

  setShareManager(manager: ShareManager): void {
    this.shareManager = manager;
  }

  /** Attach a callback to push refresh data to the live preview server. */
  setLivePusher(pusher: (elementId: string, data: unknown) => void): void {
    this.livePusher = pusher;
  }

  /** Attach the headless agent runner for prompt bindings. */
  setAgentRunner(runner: AgentRefreshRunner): void {
    this.agentRunner = runner;
    // When a turn completes, drain next in queue
    runner.onTurnComplete(() => this.drainPromptQueue());
  }

  // ── Lifecycle ──

  /** Check if the standalone daemon is running (via PID file). */
  private isDaemonRunning(): boolean {
    const pidFile = path.join(this.workspacePath, ".jetro", "daemon", "daemon.pid");
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8"));
      process.kill(pid, 0); // Signal 0 = check if alive
      return true;
    } catch {
      return false;
    }
  }

  /** Start timers for all enabled bindings on the given canvas. */
  async onCanvasOpened(canvasId: string): Promise<void> {
    this.outputChannel.appendLine(
      `[bindings] onCanvasOpened called for: ${canvasId}`
    );

    // If daemon is running, it handles all refresh timers — skip local ones
    if (this.isDaemonRunning()) {
      this.outputChannel.appendLine(
        `[bindings] Daemon running — skipping local timers for ${canvasId}`
      );
      return;
    }

    // Read bindings directly from disk to avoid timing issues with webview state.
    // The webview may not have loaded its state yet when this is called.
    const bindings = this.readBindingsFromDisk(canvasId);
    this.outputChannel.appendLine(
      `[bindings] Disk bindings for ${canvasId}: ${bindings.length} total`
    );
    const enabled = bindings.filter((b) => b.enabled);
    if (enabled.length === 0) {
      this.outputChannel.appendLine(
        `[bindings] No enabled bindings found for ${canvasId} — skipping`
      );
      return;
    }

    this.outputChannel.appendLine(
      `[bindings] Canvas ${canvasId} opened — starting ${enabled.length} binding(s)`
    );

    const canvasTimers =
      this.timers.get(canvasId) ?? new Map<string, ReturnType<typeof setInterval>>();
    this.timers.set(canvasId, canvasTimers);

    for (const binding of enabled) {
      this.startTimer(canvasId, binding, canvasTimers);
    }
  }

  /** Clear all timers for a canvas that was closed. */
  onCanvasClosed(canvasId: string): void {
    const canvasTimers = this.timers.get(canvasId);
    if (!canvasTimers) return;
    for (const timer of canvasTimers.values()) {
      clearInterval(timer);
    }
    canvasTimers.clear();
    this.timers.delete(canvasId);
    this.outputChannel.appendLine(
      `[bindings] Canvas ${canvasId} closed — timers cleared`
    );
  }

  /** Clean up everything (extension deactivate). */
  dispose(): void {
    for (const [, canvasTimers] of this.timers) {
      for (const timer of canvasTimers.values()) {
        clearInterval(timer);
      }
    }
    this.timers.clear();
    this.promptQueue = [];
    this.agentRunner = null;
  }

  // ── Public API (for jet_canvas actions) ──

  async addBinding(
    canvasId: string,
    binding: RefreshBinding
  ): Promise<void> {
    // Enforce minimum interval for prompt bindings
    if (binding.bindingType === "prompt" && binding.intervalMs < MIN_PROMPT_INTERVAL_MS) {
      binding.intervalMs = MIN_PROMPT_INTERVAL_MS;
    }

    // Push to webview state (persists via debounced save)
    await this.canvasProvider.addBinding(canvasId, binding);

    // Auto-resume if globally paused — user expects new bindings to fire
    if (this.isGloballyPaused()) {
      try {
        const configPath = path.join(this.workspacePath, ".jetro", "daemon-config.json");
        fs.writeFileSync(configPath, JSON.stringify({ paused: false }, null, 2));
        this.outputChannel.appendLine("[bindings] Auto-resumed: new binding added while paused");
      } catch { /* ignore */ }
    }

    // Start timer — create the canvasTimers map if it doesn't exist yet
    // (happens when binding is added after canvas was opened with zero bindings)
    if (binding.enabled) {
      let canvasTimers = this.timers.get(canvasId);
      if (!canvasTimers) {
        canvasTimers = new Map<string, ReturnType<typeof setInterval>>();
        this.timers.set(canvasId, canvasTimers);
      }
      // Composite key allows script + prompt on same element
      const timerKey = this.timerKey(binding);
      const existing = canvasTimers.get(timerKey);
      if (existing) clearInterval(existing);
      this.startTimer(canvasId, binding, canvasTimers);
    }

    const target = binding.bindingType === "prompt"
      ? `prompt (${(binding.refreshPrompt || "").slice(0, 40)}…)`
      : binding.scriptPath || "unknown";
    this.outputChannel.appendLine(
      `[bindings] Added binding: ${binding.elementId} → ${target} (${binding.intervalMs}ms)`
    );
  }

  /** Composite timer key: allows both script and prompt binding on the same element. */
  private timerKey(binding: RefreshBinding): string {
    return binding.bindingType === "prompt"
      ? `${binding.elementId}:prompt`
      : binding.elementId;
  }

  async removeBinding(
    canvasId: string,
    elementId: string
  ): Promise<void> {
    // Look up the binding's script path before removing
    const bindings = this.readBindingsFromDisk(canvasId);
    const binding = bindings.find((b) => b.elementId === elementId);
    const scriptPath = binding?.scriptPath;

    // Stop timer
    const canvasTimers = this.timers.get(canvasId);
    if (canvasTimers) {
      const timer = canvasTimers.get(elementId);
      if (timer) {
        clearInterval(timer);
        canvasTimers.delete(elementId);
      }
    }

    // Remove from webview state
    await this.canvasProvider.removeBinding(canvasId, elementId);

    // Delete the script file if no other binding references it
    if (scriptPath) {
      const stillReferenced = this.isScriptReferencedElsewhere(
        scriptPath,
        canvasId,
        elementId
      );
      if (!stillReferenced) {
        const fullPath = path.resolve(this.workspacePath, scriptPath);
        try {
          fs.unlinkSync(fullPath);
          this.outputChannel.appendLine(
            `[bindings] Deleted script: ${scriptPath}`
          );
        } catch {
          // Script already gone or inaccessible — that's fine
        }
      } else {
        this.outputChannel.appendLine(
          `[bindings] Script ${scriptPath} still referenced by other bindings — kept`
        );
      }
    }

    this.outputChannel.appendLine(
      `[bindings] Removed binding: ${elementId}`
    );
  }

  /** Check if any other binding (across all canvases) references the same script. */
  private isScriptReferencedElsewhere(
    scriptPath: string,
    excludeCanvasId: string,
    excludeElementId: string
  ): boolean {
    try {
      const registryPath = path.join(
        this.workspacePath,
        ".jetro",
        "canvas-registry.json"
      );
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
      const entries = Array.isArray(registry) ? registry : registry.canvases || [];

      for (const entry of entries) {
        const canvasBindings = this.readBindingsFromDisk(entry.id);
        for (const b of canvasBindings) {
          // Skip the binding we're about to remove
          if (entry.id === excludeCanvasId && b.elementId === excludeElementId) {
            continue;
          }
          if (b.scriptPath === scriptPath) {
            return true;
          }
        }
      }
    } catch {
      // Registry unreadable — be safe and don't delete
      return true;
    }
    return false;
  }

  async getBindings(canvasId: string): Promise<RefreshBinding[]> {
    const state = await this.canvasProvider.getState(canvasId);
    return state?.refreshBindings ?? [];
  }

  async trigger(canvasId: string, elementId: string): Promise<void> {
    const bindings = await this.getBindings(canvasId);
    const binding = bindings.find((b) => b.elementId === elementId);
    if (!binding) {
      this.outputChannel.appendLine(
        `[bindings] trigger: no binding for ${elementId}`
      );
      return;
    }
    await this.executeBinding(canvasId, binding);
  }

  // ── Internal ──

  /** Read refresh bindings directly from the canvas JSON file on disk.
   *  This avoids timing issues where the webview hasn't loaded state yet. */
  private readBindingsFromDisk(canvasId: string): RefreshBinding[] {
    // Try universal canvas path first, then check registry for project canvas
    const paths = [
      path.join(this.workspacePath, ".jetro", "canvases", `${canvasId}.json`),
    ];
    // Also check registry for the correct path
    try {
      const registryPath = path.join(this.workspacePath, ".jetro", "canvas-registry.json");
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
      const entries = Array.isArray(registry) ? registry : (registry.canvases || []);
      const entry = entries.find((e: { id: string }) => e.id === canvasId);
      if (entry?.projectSlug) {
        paths.unshift(
          path.join(this.workspacePath, "projects", entry.projectSlug, "canvases", `${canvasId}.json`)
        );
      }
    } catch { /* no registry — that's fine */ }

    for (const p of paths) {
      try {
        const raw = fs.readFileSync(p, "utf-8");
        const state = JSON.parse(raw);
        return (state.refreshBindings || []) as RefreshBinding[];
      } catch { /* file not found, try next */ }
    }
    return [];
  }

  private startTimer(
    canvasId: string,
    binding: RefreshBinding,
    canvasTimers: Map<string, ReturnType<typeof setInterval>>
  ): void {
    const key = this.timerKey(binding);

    // Immediate first run after a short delay (let canvas settle)
    setTimeout(() => this.dispatchBinding(canvasId, binding), 2000);

    // Recurring timer
    const timer = setInterval(
      () => this.dispatchBinding(canvasId, binding),
      binding.intervalMs
    );
    canvasTimers.set(key, timer);
  }

  /** Route binding to script execution or prompt queue. */
  private dispatchBinding(canvasId: string, binding: RefreshBinding): void {
    // Global pause — skip all execution
    if (this.isGloballyPaused()) return;

    // Visibility gate — skip hidden elements
    const state = this.readCanvasStateFromDisk(canvasId);
    if (state) {
      const elem = state.elements?.find(
        (e: { id: string }) => e.id === binding.elementId
      );
      if ((elem?.data as Record<string, unknown>)?._hidden === true) return;
    }

    if (binding.bindingType === "prompt") {
      this.enqueuePromptRefresh(canvasId, binding);
    } else {
      this.executeBinding(canvasId, binding);
    }
  }

  // ── Prompt binding queue ──

  private enqueuePromptRefresh(canvasId: string, binding: RefreshBinding): void {
    if (!this.agentRunner) {
      this.outputChannel.appendLine(
        `[bindings] No agent runner — skipping prompt binding for ${binding.elementId}`
      );
      return;
    }
    if (!binding.refreshPrompt) {
      this.outputChannel.appendLine(
        `[bindings] No refreshPrompt on binding ${binding.elementId} — skipping`
      );
      return;
    }

    // Don't enqueue if same element is already queued
    const alreadyQueued = this.promptQueue.some(
      (e) => e.canvasId === canvasId && e.binding.elementId === binding.elementId
    );
    if (alreadyQueued) {
      this.outputChannel.appendLine(
        `[bindings] ${binding.elementId} already queued — skipping duplicate`
      );
      return;
    }

    this.promptQueue.push({ canvasId, binding });
    this.outputChannel.appendLine(
      `[bindings] Queued prompt refresh for ${binding.elementTitle || binding.elementId} (queue: ${this.promptQueue.length})`
    );
    this.drainPromptQueue();
  }

  private async drainPromptQueue(): Promise<void> {
    if (this.promptDraining) return;
    if (!this.agentRunner || this.agentRunner.isBusy()) return;
    if (this.promptQueue.length === 0) return;

    this.promptDraining = true;
    try {
      const entry = this.promptQueue.shift()!;
      const { canvasId, binding } = entry;

      // Verify binding still exists and is enabled
      const current = this.readBindingsFromDisk(canvasId);
      const live = current.find(
        (b) => b.elementId === binding.elementId && b.bindingType === "prompt"
      );
      if (!live || !live.enabled) {
        this.outputChannel.appendLine(
          `[bindings] Prompt binding for ${binding.elementId} no longer active — skipping`
        );
        this.promptDraining = false;
        this.drainPromptQueue(); // Try next
        return;
      }

      this.outputChannel.appendLine(
        `[bindings] Dispatching prompt refresh for ${binding.elementTitle || binding.elementId}`
      );

      await this.agentRunner.sendRefreshPrompt(
        binding.refreshPrompt!,
        binding.elementId,
        binding.elementTitle
      );

      // Update lastRun
      await this.canvasProvider.updateBindingState(canvasId, binding.elementId, {
        lastRun: new Date().toISOString(),
        lastError: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`[bindings] Prompt refresh error: ${msg}`);
    } finally {
      this.promptDraining = false;
      // onTurnComplete callback will call drainPromptQueue again
    }
  }

  /** Number of prompt bindings waiting in queue. */
  getPromptQueueLength(): number {
    return this.promptQueue.length;
  }

  // ── Pause / Resume ──

  async pauseBinding(canvasId: string, elementId: string): Promise<void> {
    // Stop timer(s) for this element
    const canvasTimers = this.timers.get(canvasId);
    if (canvasTimers) {
      // Check both script and prompt timer keys
      for (const suffix of ["", ":prompt"]) {
        const key = `${elementId}${suffix}`;
        const timer = canvasTimers.get(key);
        if (timer) {
          clearInterval(timer);
          canvasTimers.delete(key);
        }
      }
    }
    // Persist enabled=false
    await this.canvasProvider.updateBindingState(canvasId, elementId, { enabled: false });
    this.outputChannel.appendLine(`[bindings] Paused binding: ${elementId}`);
  }

  async resumeBinding(canvasId: string, elementId: string): Promise<void> {
    // Mark as enabled
    await this.canvasProvider.updateBindingState(canvasId, elementId, { enabled: true });

    // Re-read and restart
    const bindings = this.readBindingsFromDisk(canvasId);
    const binding = bindings.find((b) => b.elementId === elementId);
    if (binding) {
      binding.enabled = true;
      let canvasTimers = this.timers.get(canvasId);
      if (!canvasTimers) {
        canvasTimers = new Map();
        this.timers.set(canvasId, canvasTimers);
      }
      this.startTimer(canvasId, binding, canvasTimers);
    }
    this.outputChannel.appendLine(`[bindings] Resumed binding: ${elementId}`);
  }

  async pauseAll(canvasId: string): Promise<void> {
    const canvasTimers = this.timers.get(canvasId);
    if (canvasTimers) {
      for (const timer of canvasTimers.values()) clearInterval(timer);
      canvasTimers.clear();
    }
    const bindings = this.readBindingsFromDisk(canvasId);
    for (const b of bindings) {
      if (b.enabled) {
        await this.canvasProvider.updateBindingState(canvasId, b.elementId, { enabled: false });
      }
    }
    this.outputChannel.appendLine(`[bindings] Paused all bindings for canvas ${canvasId}`);
  }

  async resumeAll(canvasId: string): Promise<void> {
    const bindings = this.readBindingsFromDisk(canvasId);
    let canvasTimers = this.timers.get(canvasId);
    if (!canvasTimers) {
      canvasTimers = new Map();
      this.timers.set(canvasId, canvasTimers);
    }
    for (const b of bindings) {
      await this.canvasProvider.updateBindingState(canvasId, b.elementId, { enabled: true });
      b.enabled = true;
      this.startTimer(canvasId, b, canvasTimers);
    }
    this.outputChannel.appendLine(`[bindings] Resumed all bindings for canvas ${canvasId}`);
  }

  private async executeBinding(
    canvasId: string,
    binding: RefreshBinding
  ): Promise<void> {
    // Prompt bindings are handled via dispatchBinding → enqueuePromptRefresh
    if (binding.bindingType === "prompt" || !binding.scriptPath) {
      return;
    }
    const scriptFullPath = path.resolve(this.workspacePath, binding.scriptPath);

    try {
      const jwt = await this.authService.getToken();
      const jetLibPath = path.resolve(this.workspacePath, ".jetro", "lib");
      const existingPythonPath = process.env.PYTHONPATH || "";

      // Prefer managed venv Python if it exists
      const venvPython = path.resolve(this.workspacePath, ".jetro", "venv", "bin", "python3");
      const pythonBin = fs.existsSync(venvPython) ? venvPython : "python3";

      // Ensure Python scripts get valid SSL certs on macOS.
      // Python installed via .pkg doesn't configure the system cert store,
      // so urllib HTTPS calls fail with CERTIFICATE_VERIFY_FAILED.
      // We bundle a CA cert file (from certifi) with the extension.
      let sslCertFile = process.env.SSL_CERT_FILE || "";
      if (!sslCertFile && this.extensionPath) {
        const bundledCert = path.join(this.extensionPath, "resources", "cacert.pem");
        if (fs.existsSync(bundledCert)) {
          sslCertFile = bundledCert;
        }
      }

      const scriptEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        JET_API_URL: vscode.workspace.getConfiguration("jetro").get<string>("apiUrl") || "http://localhost:8787",
        JET_JWT: jwt || "",
        JET_WORKSPACE: this.workspacePath,
        JET_ELEMENT_ID: binding.elementId,
        JET_CANVAS_ID: canvasId,
        PYTHONPATH: existingPythonPath ? `${jetLibPath}:${existingPythonPath}` : jetLibPath,
        ...(sslCertFile ? { SSL_CERT_FILE: sslCertFile } : {}),
      };

      // Inject domain-scoped credentials for web scraping
      if (binding.sourceDomain && this.fileManager && this.secrets) {
        try {
          const credsJson = await this.fileManager.buildCredentialsEnv(this.secrets, binding.sourceDomain);
          if (credsJson !== "{}") {
            scriptEnv.JET_CREDENTIALS = credsJson;
          }
        } catch { /* credentials unavailable */ }
      }

      const stdout = await new Promise<string>((resolve, reject) => {
        exec(
          `"${pythonBin}" "${scriptFullPath}"`,
          {
            cwd: this.workspacePath,
            timeout: Math.min(binding.timeoutMs || 30_000, 60_000),
            maxBuffer: 4 * 1024 * 1024,
            env: scriptEnv,
          },
          (err, out) => {
            if (err) reject(err);
            else resolve(out);
          }
        );
      });

      let parsed = JSON.parse(stdout.trim());
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Script output must be a JSON object");
      }

      this.outputChannel.appendLine(
        `[bindings] Script output for ${binding.elementId}: ${JSON.stringify(parsed).slice(0, 200)}`
      );

      // Push refresh data to the element.
      // For frame elements: the webview postMessages into the iframe so the
      // HTML's JS can update the DOM in place (no iframe reload/replace).
      // For non-frame elements: shallow-merges into React node data.
      await this.canvasProvider.refreshElement(
        binding.elementId,
        { ...parsed, lastRefreshed: new Date().toISOString() },
        canvasId
      );

      // Push to live preview server if running
      try { this.livePusher?.(binding.elementId, parsed); } catch { /* best effort */ }

      // If this element is shared, re-upload the updated HTML (fire-and-forget, respects 5-min debounce)
      this.shareManager?.onElementRefreshed(canvasId, binding.elementId).catch((err) => {
        this.outputChannel.appendLine(`[bindings] Share re-upload error: ${err}`);
      });

      // Update binding metadata — track consecutive successes for pattern graduation
      const prevSuccesses = binding.consecutiveSuccesses ?? 0;
      const newSuccesses = prevSuccesses + 1;
      // Update in-memory binding so next tick reads the correct streak
      binding.consecutiveSuccesses = newSuccesses;
      binding.lastRun = new Date().toISOString();
      binding.lastError = undefined;
      await this.canvasProvider.updateBindingState(canvasId, binding.elementId, {
        lastRun: binding.lastRun,
        lastError: null,
        consecutiveSuccesses: newSuccesses,
      });

      // Pattern graduation: after 10 consecutive successes, signal readiness
      if (newSuccesses === 10 && !binding.patternSubmitted && binding.sourceDomain) {
        this.outputChannel.appendLine(
          `[bindings] ★ Pattern graduation reached for ${binding.sourceDomain} (${binding.elementId})`
        );
        // Mark as submitted to avoid re-triggering
        await this.canvasProvider.updateBindingState(canvasId, binding.elementId, {
          patternSubmitted: true,
        });
      }

      this.outputChannel.appendLine(
        `[bindings] ✓ ${binding.elementId} refreshed via ${binding.scriptPath} (streak: ${newSuccesses})`
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      binding.consecutiveSuccesses = 0;
      binding.lastError = errorMsg;
      await this.canvasProvider.updateBindingState(canvasId, binding.elementId, {
        lastError: errorMsg,
        consecutiveSuccesses: 0,
      });
      this.outputChannel.appendLine(
        `[bindings] ✗ ${binding.elementId}: ${errorMsg}`
      );
      logTrouble(this.workspacePath, {
        type: "script_error",
        canvasId,
        elementId: binding.elementId,
        message: `Refresh script failed: ${binding.scriptPath || "prompt"}`,
        detail: errorMsg.slice(0, 500),
        hint: "Check the Python script for errors. Run it manually to debug.",
      });
    }
  }

  // ── Visibility & Pause helpers ──

  /** Check if all bindings are globally paused via daemon-config.json. */
  private isGloballyPaused(): boolean {
    try {
      const config = JSON.parse(
        fs.readFileSync(
          path.join(this.workspacePath, ".jetro", "daemon-config.json"),
          "utf-8"
        )
      );
      return config.paused === true;
    } catch {
      return false;
    }
  }

  /** Read full canvas state from disk (for visibility checks). */
  private readCanvasStateFromDisk(
    canvasId: string
  ): { elements: Array<{ id: string; data: Record<string, unknown> }> } | null {
    const paths = [
      path.join(this.workspacePath, ".jetro", "canvases", `${canvasId}.json`),
    ];
    try {
      const registryPath = path.join(this.workspacePath, ".jetro", "canvas-registry.json");
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
      const entries = Array.isArray(registry) ? registry : (registry.canvases || []);
      const entry = entries.find((e: { id: string }) => e.id === canvasId);
      if (entry?.projectSlug) {
        paths.unshift(
          path.join(this.workspacePath, "projects", entry.projectSlug, "canvases", `${canvasId}.json`)
        );
      }
    } catch { /* no registry */ }

    for (const p of paths) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf-8"));
      } catch { /* try next */ }
    }
    return null;
  }

  /** Number of active binding timers across all canvases. */
  getActiveTimerCount(): number {
    let count = 0;
    for (const m of this.timers.values()) count += m.size;
    return count;
  }

  /** All canvas IDs that have bindings on disk. */
  getCanvasIdsWithBindings(): string[] {
    const ids: string[] = [];
    // Include canvases with active timers
    for (const canvasId of this.timers.keys()) ids.push(canvasId);
    // Also scan disk for canvases that have bindings (may be paused, no timers)
    try {
      const registryPath = require("path").join(this.workspacePath, ".jetro", "canvas-registry.json");
      const registry = JSON.parse(require("fs").readFileSync(registryPath, "utf-8"));
      for (const entry of registry) {
        const cid = entry.id || entry.canvasId;
        if (cid && !ids.includes(cid)) {
          const bindings = this.readBindingsFromDisk(cid);
          if (bindings.length > 0) ids.push(cid);
        }
      }
    } catch { /* ignore */ }
    return ids;
  }
}
