import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { ShareUploader } from "./shareUploader";

interface RefreshBinding {
  elementId: string;
  scriptPath: string;
  intervalMs: number;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  lastError?: string;
  sourceDomain?: string;
  timeoutMs?: number;
}

interface CanvasState {
  elements: Array<{
    id: string;
    type: string;
    data: Record<string, unknown>;
    label?: string;
  }>;
  refreshBindings?: RefreshBinding[];
}

interface RegistryEntry {
  id: string;
  name: string;
  projectSlug?: string;
}

// Security: minimum interval to prevent resource exhaustion
const MIN_INTERVAL_MS = 10_000; // 10 seconds

/**
 * Core refresh loop — mirrors RefreshBindingManager but runs standalone
 * without VS Code APIs. Reads canvas files from disk, executes Python
 * scripts, writes results back to canvas JSON.
 */
export class BindingRunner {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private watcher: fs.FSWatcher | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private workspace: string,
    private uploader: ShareUploader,
    private jwt: string,
    private apiUrl: string
  ) {}

  async scanAndStart(): Promise<void> {
    const registry = this.readRegistry();
    console.log(`[daemon] Found ${registry.length} canvases in registry`);

    for (const entry of registry) {
      const state = this.readCanvasState(entry);
      if (!state) continue;

      const bindings = (state.refreshBindings || []).filter((b) => b.enabled);
      for (const binding of bindings) {
        // Skip hidden elements — their bindings stay dormant
        const elem = state.elements.find((e) => e.id === binding.elementId);
        if (elem?.data?._hidden === true) continue;
        this.startBinding(entry.id, entry, binding);
      }
    }

    console.log(`[daemon] Started ${this.timers.size} binding timers`);
  }

  watchForChanges(): void {
    const canvasesDir = path.join(this.workspace, ".jetro", "canvases");
    if (!fs.existsSync(canvasesDir)) return;

    this.watcher = fs.watch(canvasesDir, { recursive: true }, (_event, filename) => {
      if (!filename?.endsWith(".json")) return;
      // Debounce rescans — cancel any pending rescan before scheduling a new one
      if (this.rescanTimer) clearTimeout(this.rescanTimer);
      this.rescanTimer = setTimeout(() => this.rescan(), 500);
    });

    console.log(`[daemon] Watching for canvas changes`);
  }

  private rescan(): void {
    const registry = this.readRegistry();
    const activeKeys = new Set<string>();

    for (const entry of registry) {
      const state = this.readCanvasState(entry);
      if (!state) continue;

      const bindings = (state.refreshBindings || []).filter((b) => b.enabled);
      for (const binding of bindings) {
        // Skip hidden elements — their bindings stay dormant
        const elem = state.elements.find((e) => e.id === binding.elementId);
        if (elem?.data?._hidden === true) continue;

        const key = `${entry.id}:${binding.elementId}`;
        activeKeys.add(key);
        if (!this.timers.has(key)) {
          this.startBinding(entry.id, entry, binding);
        }
      }
    }

    // Stop timers for bindings that no longer exist
    for (const [key, timer] of this.timers) {
      if (!activeKeys.has(key)) {
        clearInterval(timer);
        this.timers.delete(key);
        console.log(`[daemon] Stopped binding timer: ${key}`);
      }
    }
  }

  private startBinding(canvasId: string, entry: RegistryEntry, binding: RefreshBinding): void {
    const key = `${canvasId}:${binding.elementId}`;
    if (this.timers.has(key)) return;

    // Enforce minimum interval
    const interval = Math.max(binding.intervalMs, MIN_INTERVAL_MS);

    console.log(
      `[daemon] Starting binding: ${binding.elementId} (${interval}ms)`
    );

    // Run once immediately, then on interval
    setTimeout(() => this.executeBinding(canvasId, entry, binding), 2000);
    const timer = setInterval(
      () => this.executeBinding(canvasId, entry, binding),
      interval
    );
    this.timers.set(key, timer);
  }

  private async executeBinding(
    canvasId: string,
    entry: RegistryEntry,
    binding: RefreshBinding
  ): Promise<void> {
    // Global pause — skip all execution
    if (this.isGloballyPaused()) return;

    // Visibility gate — skip hidden elements
    const preState = this.readCanvasState(entry);
    if (preState) {
      const elem = preState.elements.find((e) => e.id === binding.elementId);
      if (elem?.data?._hidden === true) return;
    }

    const scriptFullPath = path.resolve(this.workspace, binding.scriptPath);

    // Security: ensure script is contained within workspace
    if (!scriptFullPath.startsWith(this.workspace + path.sep)) {
      console.error(`[daemon] Path traversal blocked: ${binding.scriptPath}`);
      return;
    }
    if (!fs.existsSync(scriptFullPath)) {
      console.error(`[daemon] Script not found: ${binding.scriptPath}`);
      return;
    }

    try {
      const jetLibPath = path.resolve(this.workspace, ".jetro", "lib");
      const existingPythonPath = process.env.PYTHONPATH || "";
      const scriptEnv: Record<string, string> = {
        JET_API_URL: this.apiUrl,
        JET_JWT: this.jwt,
        JET_WORKSPACE: this.workspace,
        JET_ELEMENT_ID: binding.elementId,
        JET_CANVAS_ID: canvasId,
        PYTHONPATH: existingPythonPath
          ? `${jetLibPath}:${existingPythonPath}`
          : jetLibPath,
        // Pass through essential env vars only (not ...process.env which leaks everything)
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "",
        LANG: process.env.LANG || "en_US.UTF-8",
      };

      // Inject domain-scoped credentials from daemon credentials file
      if (binding.sourceDomain) {
        const credsFile = path.join(this.workspace, ".jetro", "daemon", "credentials.json");
        if (fs.existsSync(credsFile)) {
          try {
            const allCreds = JSON.parse(fs.readFileSync(credsFile, "utf-8"));
            const scoped: Record<string, unknown> = {};
            for (const [domain, cred] of Object.entries(allCreds)) {
              if (domain === binding.sourceDomain || binding.sourceDomain!.endsWith(domain)) {
                scoped[domain] = cred;
              }
            }
            if (Object.keys(scoped).length > 0) {
              scriptEnv.JET_CREDENTIALS = JSON.stringify(scoped);
            }
          } catch { /* credentials file unreadable */ }
        }
      }

      // Prefer managed venv Python
      const venvPython = path.resolve(
        this.workspace,
        ".jetro",
        "venv",
        "bin",
        "python3"
      );
      const pythonBin = fs.existsSync(venvPython) ? venvPython : "python3";

      // Security: use execFile instead of exec to avoid shell interpretation
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          pythonBin,
          [scriptFullPath],
          {
            cwd: this.workspace,
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

      const parsed = JSON.parse(stdout.trim());
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Script output must be a JSON object");
      }

      // Write results back to canvas JSON on disk (atomic write)
      const state = this.readCanvasState(entry);
      if (state) {
        const elem = state.elements.find((e) => e.id === binding.elementId);
        if (elem) {
          // Shallow-merge into element data
          elem.data = {
            ...elem.data,
            ...parsed,
            lastRefreshed: new Date().toISOString(),
          };
          this.writeCanvasState(entry, state);
        }
      }

      console.log(`[daemon] OK ${binding.elementId}`);

      // Re-upload to shared viewers if element is shared
      this.uploader.reUpload(canvasId, binding.elementId).catch((err) => {
        console.error(`[daemon] Share re-upload error: ${err}`);
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[daemon] FAIL ${binding.elementId}: ${errorMsg}`);
    }
  }

  shutdown(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  getActiveCount(): number {
    return this.timers.size;
  }

  // ── Helpers ──

  /** Check if all bindings are globally paused via daemon-config.json. */
  private isGloballyPaused(): boolean {
    try {
      const config = JSON.parse(
        fs.readFileSync(
          path.join(this.workspace, ".jetro", "daemon-config.json"),
          "utf-8"
        )
      );
      return config.paused === true;
    } catch {
      return false;
    }
  }

  /** Sanitize a path segment to prevent directory traversal. */
  private sanitizeSegment(seg: string): string {
    return seg.replace(/[^a-zA-Z0-9_\-]/g, "_");
  }

  private readRegistry(): RegistryEntry[] {
    const registryPath = path.join(
      this.workspace,
      ".jetro",
      "canvas-registry.json"
    );
    if (!fs.existsSync(registryPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    } catch {
      return [];
    }
  }

  private readCanvasState(entry: RegistryEntry): CanvasState | null {
    const safeId = this.sanitizeSegment(entry.id);
    const canvasPath = entry.projectSlug
      ? path.join(
          this.workspace,
          "projects",
          this.sanitizeSegment(entry.projectSlug),
          "canvases",
          `${safeId}.json`
        )
      : path.join(
          this.workspace,
          ".jetro",
          "canvases",
          `${safeId}.json`
        );

    // Verify resolved path is within workspace
    const resolved = path.resolve(canvasPath);
    if (!resolved.startsWith(this.workspace + path.sep)) {
      console.error(`[daemon] Path traversal blocked in readCanvasState`);
      return null;
    }

    if (!fs.existsSync(canvasPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(canvasPath, "utf-8"));
    } catch {
      return null;
    }
  }

  private writeCanvasState(entry: RegistryEntry, state: CanvasState): void {
    const safeId = this.sanitizeSegment(entry.id);
    const canvasPath = entry.projectSlug
      ? path.join(
          this.workspace,
          "projects",
          this.sanitizeSegment(entry.projectSlug),
          "canvases",
          `${safeId}.json`
        )
      : path.join(
          this.workspace,
          ".jetro",
          "canvases",
          `${safeId}.json`
        );

    // Verify resolved path is within workspace
    const resolved = path.resolve(canvasPath);
    if (!resolved.startsWith(this.workspace + path.sep)) {
      console.error(`[daemon] Path traversal blocked in writeCanvasState`);
      return;
    }

    // Atomic write: write to temp file then rename
    const tmpPath = canvasPath + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    fs.renameSync(tmpPath, canvasPath);
  }
}
