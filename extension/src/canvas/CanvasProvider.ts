import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { FileManager } from "../services/fileManager";
import { shimForBrowser as shimBrowserHtml } from "../services/libShimmer";
import { CanvasElement, CanvasState, CanvasRegistryEntry, RefreshBinding } from "../types";

interface CanvasPanel {
  panel: vscode.WebviewPanel;
  canvasId: string;
  projectSlug: string | null;
  /** Resolves when the webview's React app sends `canvas.ready`. */
  ready: Promise<void>;
  /** Call to resolve the ready promise (set during wirePanel). */
  resolveReady: () => void;
}

/** Event emitted when the canvas requests a list refresh (via frame or sidebar). */
export interface RefreshListRequest {
  nodeId: string;
  listSlug?: string;
  title?: string;
  canvasKey: string;
}

export class CanvasProvider {
  /** Open panels keyed by canvas ID. */
  private panels = new Map<string, CanvasPanel>();
  private fileManager: FileManager;

  /** The canvas ID of the currently focused panel. */
  private activeCanvasId: string | null = null;

  /** Listeners for refresh-table requests (wired up in extension.ts) */
  private refreshListeners: ((req: RefreshListRequest) => void)[] = [];

  /** Pending state request resolvers keyed by requestId. */
  private stateRequests = new Map<string, (state: CanvasState) => void>();

  /** Tracks whether the serializer has restored at least one panel (used by auto-open fallback). */
  private serializerRestoredAny = false;

  /** Canvas lifecycle listeners (used by RefreshBindingManager). */
  private canvasOpenListeners: ((canvasId: string) => void)[] = [];
  private canvasCloseListeners: ((canvasId: string) => void)[] = [];
  private elementRemoveListeners: ((canvasId: string, elementId: string) => void)[] = [];
  private elementUnbindListeners: ((canvasId: string, elementId: string) => void)[] = [];
  private frameQueryListeners: ((canvasId: string, elementId: string, requestId: string, sql: string) => void)[] = [];
  private shareElementListeners: ((canvasId: string, elementId: string) => void)[] = [];
  private openInBrowserListeners: ((elementId: string, html: string, title: string) => void)[] = [];
  private toggleBindingListeners: ((canvasId: string, elementId: string) => void)[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    fileManager: FileManager
  ) {
    this.fileManager = fileManager;
  }

  // ── Serializer (auto-restore on restart) ──

  /**
   * Register a webview panel serializer so VS Code can restore canvas
   * panels after a window reload / restart.
   */
  public registerSerializer(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer("jetro.canvas", {
        deserializeWebviewPanel: async (
          panel: vscode.WebviewPanel,
          state: { canvasId?: string } | undefined
        ) => {
          console.log(`[JET-serializer] deserialize called, state=`, JSON.stringify(state));
          const canvasId = state?.canvasId;
          if (!canvasId) {
            console.log(`[JET-serializer] no canvasId in state, disposing`);
            panel.dispose();
            return;
          }
          this.serializerRestoredAny = true;
          try {
            await this.restorePanel(panel, canvasId);
            console.log(`[JET-serializer] restorePanel completed for ${canvasId}`);
          } catch (err) {
            console.error(`[JET-serializer] restorePanel FAILED for ${canvasId}:`, err);
          }
        },
      })
    );
  }

  /** Whether the serializer restored any panels (used by auto-open fallback). */
  public didSerializerRestore(): boolean {
    return this.serializerRestoredAny;
  }

  /** Number of currently open panels. */
  public getPanelCount(): number {
    return this.panels.size;
  }

  /** Register a callback for canvas.refreshList events. */
  public onRefreshList(listener: (req: RefreshListRequest) => void): void {
    this.refreshListeners.push(listener);
  }

  /** Register a callback for when any canvas panel is opened/wired. */
  public onCanvasOpen(listener: (canvasId: string) => void): void {
    this.canvasOpenListeners.push(listener);
  }

  /** Register a callback for when a canvas panel is closed/disposed. */
  public onCanvasClose(listener: (canvasId: string) => void): void {
    this.canvasCloseListeners.push(listener);
  }

  /** Register a callback for when an element is removed from canvas. */
  public onElementRemove(listener: (canvasId: string, elementId: string) => void): void {
    this.elementRemoveListeners.push(listener);
  }

  /** Register a callback for when an element's binding should be cleaned up. */
  public onElementUnbind(listener: (canvasId: string, elementId: string) => void): void {
    this.elementUnbindListeners.push(listener);
  }

  /** Register a callback for frame query events (frames querying DuckDB). */
  public onFrameQuery(listener: (canvasId: string, elementId: string, requestId: string, sql: string) => void): void {
    this.frameQueryListeners.push(listener);
  }

  /** Register a callback for share element requests (user clicks Share on a frame). */
  public onShareElement(listener: (canvasId: string, elementId: string) => void): void {
    this.shareElementListeners.push(listener);
  }

  /** Register a callback for "Open in Browser" requests from canvas nodes. */
  public onOpenInBrowser(listener: (elementId: string, html: string, title: string) => void): void {
    this.openInBrowserListeners.push(listener);
  }

  /** Register a callback for toggle binding (pause/resume) requests. */
  public onToggleBinding(listener: (canvasId: string, elementId: string) => void): void {
    this.toggleBindingListeners.push(listener);
  }

  /** Register a callback for when a frame source file changes on disk. */
  private fileChangedListeners: ((filePath: string, html: string) => void)[] = [];
  public onFileChanged(listener: (filePath: string, html: string) => void): void {
    this.fileChangedListeners.push(listener);
  }

  /**
   * Watch frame HTML files for changes. When a file is modified on disk
   * (by the agent, user, or a script), broadcasts `canvas.fileChanged`
   * to all open canvases so elements with a matching `_sourceFile` auto-refresh.
   * Returns disposables that should be pushed to `context.subscriptions`.
   */
  public setupFrameFileWatcher(): vscode.Disposable[] {
    const root = this.fileManager.getRoot();
    const disposables: vscode.Disposable[] = [];

    // Watch .jetro/frames/ (auto-persisted frames)
    const framesPattern = new vscode.RelativePattern(root, ".jetro/frames/**/*.html");
    const framesWatcher = vscode.workspace.createFileSystemWatcher(framesPattern);

    // Watch projects/*/frames/ (project-scoped frames, if any)
    const projectFramesPattern = new vscode.RelativePattern(root, "projects/*/frames/**/*.html");
    const projectFramesWatcher = vscode.workspace.createFileSystemWatcher(projectFramesPattern);

    const handleChange = async (uri: vscode.Uri) => {
      if (this.panels.size === 0) return;
      const rootPath = root.fsPath;
      const relativePath = uri.fsPath.startsWith(rootPath)
        ? uri.fsPath.slice(rootPath.length + 1)
        : uri.fsPath;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const html = new TextDecoder().decode(bytes);
        console.log(`[JET-canvas] Frame file changed: ${relativePath} (${html.length} chars)`);
        this.postToAllCanvases({
          type: "canvas.fileChanged",
          data: { filePath: relativePath, html },
        });
        for (const l of this.fileChangedListeners) l(relativePath, html);
      } catch (err) {
        console.log(`[JET-canvas] Error reading changed frame file: ${err}`);
      }
    };

    framesWatcher.onDidChange(handleChange);
    framesWatcher.onDidCreate(handleChange);
    projectFramesWatcher.onDidChange(handleChange);
    projectFramesWatcher.onDidCreate(handleChange);

    disposables.push(framesWatcher, projectFramesWatcher);
    return disposables;
  }

  /** Post a message to a specific canvas webview. */
  public postToCanvas(canvasId: string, msg: { type: string; data?: unknown }): void {
    const entry = this.panels.get(canvasId);
    if (entry?.panel.webview) {
      entry.panel.webview.postMessage(msg);
    }
  }

  /** Post a message to ALL open canvas webviews. */
  public postToAllCanvases(msg: { type: string; data?: unknown }): void {
    for (const entry of this.panels.values()) {
      try {
        entry.panel.webview.postMessage(msg);
      } catch { /* panel may be disposed */ }
    }
  }

  // ── C2 Mode ──

  /** Enable C2 mode on a project canvas. */
  public async enableC2(canvasId: string): Promise<void> {
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((e: { id: string; projectSlug: string | null }) => e.id === canvasId);
    if (!entry?.projectSlug) {
      throw new Error("C2 mode is only available on project canvases");
    }
    const state = await this.fileManager.readCanvasById(canvasId, entry.projectSlug);
    if (!state) return;
    state.c2 = {
      enabled: true,
      layout: state.c2?.layout ?? "freeform",
      theme: state.c2?.theme ?? "dark",
      framePorts: state.c2?.framePorts ?? {},
      wires: state.c2?.wires ?? [],
    };
    await this.fileManager.writeCanvasById(canvasId, state, entry.projectSlug);
    this.postToCanvas(canvasId, { type: "canvas.c2Changed", data: { enabled: true, c2: state.c2 } });
  }

  /** Disable C2 mode (preserves wires/ports for re-enable). */
  public async disableC2(canvasId: string): Promise<void> {
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((e: { id: string; projectSlug: string | null }) => e.id === canvasId);
    const projectSlug = entry?.projectSlug ?? null;
    const state = await this.fileManager.readCanvasById(canvasId, projectSlug);
    if (!state?.c2) return;
    state.c2.enabled = false;
    await this.fileManager.writeCanvasById(canvasId, state, projectSlug);
    this.postToCanvas(canvasId, { type: "canvas.c2Changed", data: { enabled: false } });
  }

  /** Check if a canvas is a project canvas (has projectSlug). */
  public async isProjectCanvas(canvasId: string): Promise<boolean> {
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((e: { id: string; projectSlug: string | null }) => e.id === canvasId);
    return !!entry?.projectSlug;
  }

  /** Send a frame query result back to the webview for routing into the iframe. */
  public async sendFrameQueryResult(
    canvasId: string,
    elementId: string,
    requestId: string,
    rows: Record<string, unknown>[] | null,
    error?: string
  ): Promise<void> {
    const entry = this.panels.get(canvasId);
    if (entry?.panel.webview) {
      entry.panel.webview.postMessage({
        type: "canvas.frameQueryResult",
        data: { elementId, requestId, rows, error },
      });
    }
  }

  // ── Open / Create / Delete ──

  /**
   * Open (or reveal) a canvas by its registry ID.
   * If `meta` is provided, uses it for title/project; otherwise looks up registry.
   */
  public async open(
    canvasId: string,
    meta?: { name?: string; projectSlug?: string | null }
  ): Promise<void> {
    const existing = this.panels.get(canvasId);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    // Look up registry for name/project if not provided
    let name = meta?.name;
    let projectSlug = meta?.projectSlug ?? null;

    if (!name) {
      const registry = await this.fileManager.readCanvasRegistry();
      const entry = registry.find((e) => e.id === canvasId);
      if (entry) {
        name = entry.name;
        projectSlug = entry.projectSlug;
      }
    }

    const title = name || this.prettifySlug(canvasId);

    const panel = vscode.window.createWebviewPanel(
      "jetro.canvas",
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "webview"),
          vscode.Uri.joinPath(this.extensionUri, "assets"),
          vscode.Uri.joinPath(this.extensionUri, "assets", "libs"),
          ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) || []),
        ],
      }
    );

    await this.wirePanel(panel, canvasId, projectSlug, name || title);
  }

  /**
   * Create a new canvas with the given name.
   * Adds to registry, creates empty state, opens the panel.
   */
  public async create(
    name: string,
    projectSlug?: string | null
  ): Promise<string> {
    const id = this.slugify(name) + "_" + Date.now().toString(36);
    const entry: CanvasRegistryEntry = {
      id,
      name,
      projectSlug: projectSlug ?? null,
      createdAt: new Date().toISOString(),
    };

    // Add to registry
    const registry = await this.fileManager.readCanvasRegistry();
    registry.push(entry);
    await this.fileManager.writeCanvasRegistry(registry);

    // Create empty state
    const emptyState: CanvasState = {
      name,
      elements: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    await this.fileManager.writeCanvasById(id, emptyState, entry.projectSlug);

    // Open
    await this.open(id, { name, projectSlug: entry.projectSlug });
    return id;
  }

  /**
   * Restore a canvas from version history.
   * If timestamp is given, restores that specific version.
   * Otherwise, restores the most recent version with elements.
   */
  public async restore(canvasId: string, timestamp?: number): Promise<boolean> {
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((e) => e.id === canvasId);
    const projectSlug = entry?.projectSlug ?? null;

    let restored: CanvasState | null = null;

    if (timestamp) {
      restored = await this.fileManager.restoreCanvasVersion(canvasId, projectSlug, timestamp);
    } else {
      // Find most recent version with elements
      const versions = await this.fileManager.listCanvasVersions(canvasId, projectSlug);
      for (const v of versions) {
        const data = await this.fileManager.readCanvasVersion(canvasId, projectSlug, v.timestamp);
        if (data && data.elements && data.elements.length > 0) {
          restored = await this.fileManager.restoreCanvasVersion(canvasId, projectSlug, v.timestamp);
          break;
        }
      }
    }

    if (!restored) return false;

    // If panel is open, push restored state into it
    const panelEntry = this.panels.get(canvasId);
    if (panelEntry) {
      panelEntry.panel.webview.postMessage({
        type: "canvas.setState",
        data: restored,
      });
    }
    return true;
  }

  /** Delete a canvas: close panel, remove registry entry, delete state file. */
  public async delete(canvasId: string): Promise<void> {
    // Close if open
    const existing = this.panels.get(canvasId);
    if (existing) {
      existing.panel.dispose(); // triggers onDidDispose → panels.delete
    }

    // Remove from registry
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((e) => e.id === canvasId);
    const updated = registry.filter((e) => e.id !== canvasId);
    await this.fileManager.writeCanvasRegistry(updated);

    // Delete state file
    if (entry) {
      await this.fileManager.deleteCanvasById(canvasId, entry.projectSlug);
    }
  }

  /** List all canvas registry entries. */
  public async list(): Promise<CanvasRegistryEntry[]> {
    return this.fileManager.readCanvasRegistry();
  }

  /** Get the canvas ID of the currently active (focused) panel. */
  public getActiveCanvasId(): string | null {
    return this.activeCanvasId;
  }

  /** Set active canvas ID (e.g. when companion app switches canvas) */
  public setActiveCanvasId(canvasId: string): void {
    this.activeCanvasId = canvasId;
  }

  /**
   * Get the live canvas state. If the panel is open, queries the webview directly
   * (bypasses disk). Falls back to disk if panel is not open or webview doesn't respond.
   */
  public async getState(canvasId?: string): Promise<CanvasState | null> {
    const id = canvasId || this.activeCanvasId;
    if (!id) return null;

    const entry = this.panels.get(id);
    if (!entry) {
      // Panel not open — fall back to disk
      const registry = await this.fileManager.readCanvasRegistry();
      const regEntry = registry.find((e) => e.id === id);
      return this.fileManager.readCanvasById(id, regEntry?.projectSlug ?? null);
    }

    // Send request to webview, await immediate response
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<CanvasState>((resolve) => {
      // Timeout fallback — if webview doesn't respond within 2s, read from disk
      const timer = setTimeout(async () => {
        this.stateRequests.delete(requestId);
        const registry = await this.fileManager.readCanvasRegistry();
        const regEntry = registry.find((e) => e.id === id);
        const diskState = await this.fileManager.readCanvasById(
          id,
          regEntry?.projectSlug ?? null
        );
        resolve(
          diskState || {
            name: "Research Board",
            elements: [],
            edges: [],
            viewport: { x: 0, y: 0, zoom: 1 },
          }
        );
      }, 2000);

      this.stateRequests.set(requestId, (state) => {
        clearTimeout(timer);
        this.stateRequests.delete(requestId);
        resolve(state);
      });

      entry.panel.webview.postMessage({
        type: "canvas.requestState",
        data: { requestId },
      });
    });
  }

  /** Check if a canvas is open by ID. */
  public isOpenById(canvasId: string): boolean {
    return this.panels.has(canvasId);
  }

  /**
   * Find the first canvas ID for a given project slug (backward compat).
   * If none exists, creates one and returns its ID.
   */
  public async resolveProjectCanvas(projectSlug: string): Promise<string> {
    const registry = await this.fileManager.readCanvasRegistry();
    const match = registry.find((e) => e.projectSlug === projectSlug);
    if (match) return match.id;

    // Auto-create one
    return this.create(
      this.prettifySlug(projectSlug) + " Canvas",
      projectSlug
    );
  }

  /**
   * Find the first universal canvas ID (backward compat).
   * If none exists, creates one called "Research Board".
   */
  public async resolveUniversalCanvas(): Promise<string> {
    const registry = await this.fileManager.readCanvasRegistry();
    const match = registry.find((e) => e.projectSlug === null);
    if (match) return match.id;

    // Auto-create one
    return this.create("Research Board", null);
  }

  // ── Element operations (now ID-based) ──

  /**
   * Resolve target canvas. If canvasId given, use it.
   * Otherwise use activeCanvasId, or fall back to first universal canvas.
   */
  private async resolveTarget(canvasId?: string): Promise<string> {
    if (canvasId) return canvasId;
    if (this.activeCanvasId && this.panels.has(this.activeCanvasId)) {
      return this.activeCanvasId;
    }
    return this.resolveUniversalCanvas();
  }

  public async addElement(
    element: CanvasElement,
    canvasId?: string
  ): Promise<void> {
    const id = await this.resolveTarget(canvasId);
    const entry = this.panels.get(id);
    if (entry) {
      await entry.ready;
      entry.panel.webview.postMessage({
        type: "canvas.addElement",
        data: element,
      });

      // Force iframe repaint after a short delay.
      // VS Code's Chromium compositor sometimes doesn't paint iframe content
      // on first addElement. Adding a _repaintKey forces React to remount
      // the HtmlFrame component (new key = new iframe = fresh paint).
      if (element.type === "frame") {
        setTimeout(() => {
          try {
            entry.panel.webview.postMessage({
              type: "canvas.updateElement",
              data: { id: element.id, data: { ...element.data, _repaintKey: Date.now() } },
            });
          } catch { /* ignore */ }
        }, 800);
      }
    }
    await this.requestSave(id);
  }

  public async updateElement(
    elementId: string,
    data: Record<string, unknown>,
    canvasId?: string
  ): Promise<void> {
    const id = await this.resolveTarget(canvasId);
    const entry = this.panels.get(id);
    if (entry) {
      await entry.ready;
      // Add _repaintKey to force iframe remount on frame updates
      const sendData = (data.html || data.content) ? { ...data, _repaintKey: Date.now() } : data;
      entry.panel.webview.postMessage({
        type: "canvas.updateElement",
        data: { id: elementId, data: sendData },
      });
    }
    await this.requestSave(id);
  }

  /**
   * Push refresh data to an element. For frame elements, the webview will
   * postMessage the payload into the iframe so the HTML's JS can update
   * the DOM in place (no iframe reload). For other element types, falls
   * back to a normal shallow-merge into node data.
   */
  public async refreshElement(
    elementId: string,
    payload: Record<string, unknown>,
    canvasId?: string
  ): Promise<void> {
    const id = await this.resolveTarget(canvasId);
    const entry = this.panels.get(id);
    if (entry) {
      console.log(
        `[JET-canvas] refreshElement → panel "${id}" visible=${entry.panel.visible} active=${entry.panel.active}, element=${elementId}, keys=${Object.keys(payload).join(",")}`
      );
      entry.panel.webview.postMessage({
        type: "canvas.refreshElement",
        data: { id: elementId, payload },
      });
    } else {
      console.log(
        `[JET-canvas] refreshElement → NO panel for canvasId=${id} (panels: ${[...this.panels.keys()].join(",")})`
      );
    }
    // NOTE: no requestSave here — refresh data is ephemeral (live prices).
    // Saving every 5s would trigger the file watcher and steal focus.
  }

  public async removeElement(
    elementId: string,
    canvasId?: string
  ): Promise<void> {
    const id = await this.resolveTarget(canvasId);
    const entry = this.panels.get(id);
    entry?.panel.webview.postMessage({
      type: "canvas.removeElement",
      data: { id: elementId },
    });
    await this.requestSave(id);
  }

  public async moveElement(
    elementId: string,
    position: { x: number; y: number },
    canvasId?: string
  ): Promise<void> {
    const id = await this.resolveTarget(canvasId);
    const entry = this.panels.get(id);
    entry?.panel.webview.postMessage({
      type: "canvas.moveElement",
      data: { id: elementId, position },
    });
    await this.requestSave(id);
  }

  public async resizeElement(
    elementId: string,
    size: { width?: number; height?: number },
    canvasId?: string
  ): Promise<void> {
    const id = await this.resolveTarget(canvasId);
    const entry = this.panels.get(id);
    entry?.panel.webview.postMessage({
      type: "canvas.resizeElement",
      data: { id: elementId, size },
    });
    await this.requestSave(id);
  }

  public async arrangeElements(
    operations: Array<{
      elementId: string;
      position?: { x: number; y: number };
      size?: { width?: number; height?: number };
    }>,
    canvasId?: string
  ): Promise<void> {
    const id = await this.resolveTarget(canvasId);
    const entry = this.panels.get(id);
    entry?.panel.webview.postMessage({
      type: "canvas.arrangeElements",
      data: { operations },
    });
    await this.requestSave(id);
  }

  // ── Refresh binding operations ──

  public async addBinding(
    canvasId: string,
    binding: RefreshBinding
  ): Promise<void> {
    const id = await this.resolveTarget(canvasId);
    const entry = this.panels.get(id);
    entry?.panel.webview.postMessage({
      type: "canvas.addBinding",
      data: binding,
    });
    await this.requestSave(id);
  }

  public async removeBinding(
    canvasId: string,
    elementId: string
  ): Promise<void> {
    const id = await this.resolveTarget(canvasId);
    const entry = this.panels.get(id);
    entry?.panel.webview.postMessage({
      type: "canvas.removeBinding",
      data: { elementId },
    });
    await this.requestSave(id);
  }

  public async updateBindingState(
    canvasId: string,
    elementId: string,
    patch: { lastRun?: string; lastError?: string | null; enabled?: boolean; consecutiveSuccesses?: number; patternSubmitted?: boolean }
  ): Promise<void> {
    const id = await this.resolveTarget(canvasId);
    const entry = this.panels.get(id);
    entry?.panel.webview.postMessage({
      type: "canvas.updateBinding",
      data: { elementId, patch },
    });
    // No requestSave — binding metadata (lastRun, lastError) updates every refresh
    // cycle and saving would trigger file watcher + steal focus.
  }

  /** @deprecated — no-op, kept for backward compat. */
  public setActiveProject(_slug: string): void {}

  /** @deprecated Use isOpenById(). */
  public isOpen(projectSlug?: string): boolean {
    // Backward compat: check if any canvas for this project is open
    for (const [, entry] of this.panels) {
      if (!projectSlug && entry.projectSlug === null) return true;
      if (projectSlug && entry.projectSlug === projectSlug) return true;
    }
    return false;
  }

  // ── Context file (active canvas awareness for MCP tools) ──

  private writeContext(canvasId: string | null, projectSlug: string | null): void {
    try {
      const wsRoot = this.fileManager.getRoot().fsPath;
      const dir = path.join(wsRoot, ".jetro");
      if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
      const contextPath = path.join(dir, "context.json");
      fsSync.writeFileSync(contextPath, JSON.stringify({ activeCanvasId: canvasId, activeProjectSlug: projectSlug }, null, 2));
    } catch { /* best-effort */ }
  }

  // ── Internal ──

  /**
   * Wire up a panel (used by both open() and restorePanel()).
   * Sets HTML, registers handlers, loads state from disk, sends canvas.init.
   */
  private async wirePanel(
    panel: vscode.WebviewPanel,
    canvasId: string,
    projectSlug: string | null,
    name: string
  ): Promise<void> {
    console.log(`[JET-wire] wirePanel START for ${canvasId}, visible=${panel.visible}, active=${panel.active}`);
    const webviewUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "webview", "canvas.js")
    );
    const cssUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "webview", "canvas.css")
    );

    panel.webview.html = this.getHtml(panel.webview, webviewUri, cssUri, canvasId);

    let resolveReady: () => void;
    const readyInner = new Promise<void>((r) => { resolveReady = r; });
    // Safety timeout: don't block forever if webview never sends canvas.ready
    const ready = Promise.race([readyInner, new Promise<void>((r) => setTimeout(r, 5000))]);
    const entry: CanvasPanel = { panel, canvasId, projectSlug, ready, resolveReady: resolveReady! };
    this.panels.set(canvasId, entry);

    // Track active panel
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.activeCanvasId = canvasId;
        this.writeContext(canvasId, projectSlug);
      }
    });

    panel.onDidDispose(() => {
      // Notify lifecycle listeners before cleanup (stops refresh timers)
      for (const l of this.canvasCloseListeners) l(canvasId);
      this.panels.delete(canvasId);
      if (this.activeCanvasId === canvasId) {
        this.activeCanvasId = null;
        this.writeContext(null, null);
      }
    });

    // Helper: send init + state to the webview.
    // Called every time canvas.ready is received — VS Code may recreate
    // webview content (e.g. when a restored background tab becomes visible),
    // so we must always respond to canvas.ready, not just the first time.
    let canvasState: import("../types").CanvasState | null = null;

    const sendInitAndState = () => {
      console.log(`[JET-wire] sendInitAndState for ${canvasId}, hasState=${!!canvasState}, elements=${canvasState?.elements?.length}`);
      panel.webview.postMessage({
        type: "canvas.init",
        data: { canvasId, name, isProjectCanvas: !!projectSlug },
      });
      if (canvasState) {
        panel.webview.postMessage({
          type: "canvas.setState",
          data: canvasState,
        });
      }
    };

    // Register the message handler BEFORE disk read so we never miss canvas.ready.
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "canvas.ready") {
        console.log(`[JET-wire] canvas.ready received for ${canvasId}`);
        // Re-read from disk for freshness (another tab may have saved changes)
        canvasState = await this.fileManager.readCanvasById(canvasId, projectSlug);
        console.log(`[JET-wire] state read for ${canvasId}, elements=${canvasState?.elements?.length}`);
        sendInitAndState();
        entry.resolveReady();
      }
      await this.handleMessage(canvasId, projectSlug, msg);
    });

    // Pre-load state from disk (runs in parallel with webview mounting).
    canvasState = await this.fileManager.readCanvasById(canvasId, projectSlug);
    console.log(`[JET-wire] initial disk read for ${canvasId}, elements=${canvasState?.elements?.length}`);

    // Set as active if it's visible
    if (panel.active) {
      this.activeCanvasId = canvasId;
      this.writeContext(canvasId, projectSlug);
    }

    // Notify lifecycle listeners AFTER state is loaded — RefreshBindingManager
    // reads bindings via getState() which may hit the webview or fall back to disk.
    // Either way, the state must be loaded first.
    for (const l of this.canvasOpenListeners) l(canvasId);
  }

  /**
   * Restore a panel from the serializer (VS Code restart).
   * The panel is already created by VS Code — we just need to re-wire it.
   */
  private async restorePanel(
    panel: vscode.WebviewPanel,
    canvasId: string
  ): Promise<void> {
    console.log(`[JET-restore] restorePanel called for ${canvasId}, already in map: ${this.panels.has(canvasId)}`);
    // Dedup: if a panel for this canvas is already wired, dispose the duplicate
    if (this.panels.has(canvasId)) {
      console.log(`[JET-restore] DEDUP: disposing duplicate panel for ${canvasId}`);
      panel.dispose();
      return;
    }

    // Look up registry
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((e) => e.id === canvasId);
    console.log(`[JET-restore] registry lookup for ${canvasId}: found=${!!entry}, name=${entry?.name}`);

    const name = entry?.name || this.prettifySlug(canvasId);
    const projectSlug = entry?.projectSlug ?? null;

    panel.title = name;
    await this.wirePanel(panel, canvasId, projectSlug, name);
  }

  private async requestSave(canvasId: string): Promise<void> {
    const entry = this.panels.get(canvasId);
    if (!entry) return;
    entry.panel.webview.postMessage({ type: "canvas.getState" });
  }

  private async handleMessage(
    canvasId: string,
    projectSlug: string | null,
    msg: { type: string; data?: unknown }
  ): Promise<void> {
    switch (msg.type) {
      case "canvas.stateUpdate": {
        const canvasState = msg.data as CanvasState;
        await this.fileManager.writeCanvasById(
          canvasId,
          canvasState,
          projectSlug
        );
        break;
      }
      case "canvas.selectElement": {
        // Could emit an event for the chat panel to pick up
        break;
      }
      case "canvas.openInBrowser": {
        const { nodeId, html, title } = msg.data as {
          nodeId: string;
          html: string;
          title: string;
        };
        // Emit event so extension.ts can route through live server
        if (this.openInBrowserListeners.length > 0) {
          for (const listener of this.openInBrowserListeners) {
            listener(nodeId, html, title);
          }
        } else {
          // Fallback to static temp file
          await this.openHtmlInBrowser(html, title);
        }
        break;
      }
      case "canvas.openInCompanion": {
        vscode.commands.executeCommand("jetro.openCompanionCanvas", canvasId);
        break;
      }
      case "canvas.openInEditor": {
        const { filePath } = msg.data as { filePath: string };
        if (filePath) {
          const fileUri = filePath.startsWith("/")
            ? vscode.Uri.file(filePath)
            : vscode.Uri.joinPath(this.fileManager.getRoot(), filePath);
          vscode.window.showTextDocument(fileUri, { preview: false });
        }
        break;
      }
      case "canvas.stateResponse": {
        const { requestId, state } = msg.data as {
          requestId: string;
          state: CanvasState;
        };
        const resolver = this.stateRequests.get(requestId);
        if (resolver) resolver(state);
        // Also persist to disk so MCP server and restarts stay fresh
        this.fileManager
          .writeCanvasById(canvasId, state, projectSlug)
          .catch(() => {});
        break;
      }
      case "canvas.refreshTable":
      case "canvas.refreshList": {
        const req = msg.data as {
          nodeId: string;
          listSlug?: string;
          title?: string;
        };
        for (const listener of this.refreshListeners) {
          listener({ ...req, canvasKey: canvasId });
        }
        break;
      }
      case "canvas.removeElement": {
        const { id: removedId } = msg.data as { id: string };
        // Notify listeners (sidebar refresh, binding cleanup)
        for (const l of this.elementRemoveListeners) l(canvasId, removedId);
        break;
      }
      case "canvas.unbindElement": {
        const { elementId } = msg.data as { elementId: string };
        for (const l of this.elementUnbindListeners) l(canvasId, elementId);
        break;
      }
      case "canvas.reloadWebview": {
        // Reload the webview panel — forces full re-render including all iframes.
        // Same effect as switching away from the canvas tab and back.
        const reloadEntry = this.panels.get(canvasId);
        if (reloadEntry) {
          const reloadState = await this.getState(canvasId);
          if (reloadState) {
            const webviewUri = reloadEntry.panel.webview.asWebviewUri(
              vscode.Uri.joinPath(this.extensionUri, "webview", "canvas.js")
            );
            const cssUri = reloadEntry.panel.webview.asWebviewUri(
              vscode.Uri.joinPath(this.extensionUri, "webview", "canvas.css")
            );
            // Clear HTML to force full teardown
            reloadEntry.panel.webview.html = "";
            setTimeout(() => {
              reloadEntry.panel.webview.html = this.getHtml(reloadEntry.panel.webview, webviewUri, cssUri, canvasId);
              // Re-send state after reload
              setTimeout(() => {
                reloadEntry.panel.webview.postMessage({
                  type: "canvas.setState",
                  data: { state: reloadState, canvasId, canvasName: reloadState.name },
                });
              }, 500);
            }, 100);
          }
        }
        break;
      }
      case "canvas.shareElement": {
        const { elementId: seId } = msg.data as { elementId: string };
        for (const l of this.shareElementListeners) l(canvasId, seId);
        break;
      }
      case "canvas.toggleBinding": {
        const { elementId: tbId } = msg.data as { elementId: string };
        for (const l of this.toggleBindingListeners) l(canvasId, tbId);
        break;
      }
      case "canvas.frameQuery": {
        const { elementId: fqId, requestId: fqReqId, sql: fqSql } = msg.data as {
          elementId: string;
          requestId: string;
          sql: string;
        };
        for (const listener of this.frameQueryListeners) {
          listener(canvasId, fqId, fqReqId, fqSql);
        }
        break;
      }
      case "canvas.toggleC2": {
        const registry = await this.fileManager.readCanvasRegistry();
        const regEntry = registry.find((e: { id: string }) => e.id === canvasId);
        if (!regEntry?.projectSlug) break; // silently ignore on universal canvases
        const cs = await this.fileManager.readCanvasById(canvasId, regEntry.projectSlug);
        if (cs?.c2?.enabled) {
          await this.disableC2(canvasId);
        } else {
          await this.enableC2(canvasId);
        }
        break;
      }
      case "canvas.addWire": {
        const wire = msg.data as {
          id: string;
          sourceId: string;
          targetId: string;
          channel: string;
          bidirectional?: boolean;
        };
        await this.addWire(canvasId, wire);
        break;
      }
      case "canvas.removeWire": {
        const { wireId: rwId } = msg.data as { wireId: string };
        await this.removeWire(canvasId, rwId);
        break;
      }
      case "canvas.frameSend": {
        // C2 inter-frame message routing
        const { sourceElementId, channel, payload } = msg.data as {
          sourceElementId: string;
          channel: string;
          payload: unknown;
        };
        await this.routeFrameMessage(canvasId, sourceElementId, channel, payload);
        break;
      }
      case "canvas.frameDeclarePorts": {
        // Frame declares its input/output ports
        const { elementId: dpId, manifest } = msg.data as {
          elementId: string;
          manifest: { outputs?: { channel: string; label?: string }[]; inputs?: { channel: string; label?: string }[] };
        };
        await this.updateFramePorts(canvasId, dpId, manifest);
        break;
      }
    }
  }

  /**
   * Route an inter-frame message from sourceElementId through wires to connected targets.
   * Looks up the wire topology in canvas C2 state, finds all wires from source on the
   * given channel, and delivers the message to each target frame's iframe.
   */
  private async routeFrameMessage(
    canvasId: string,
    sourceElementId: string,
    channel: string,
    payload: unknown
  ): Promise<void> {
    const panel = this.panels.get(canvasId);
    if (!panel) return;

    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((e: { id: string }) => e.id === canvasId);
    if (!entry?.projectSlug) return;

    const state = await this.fileManager.readCanvasById(canvasId, entry.projectSlug);
    if (!state?.c2?.enabled || !state.c2.wires) return;

    // Find target elements connected via wire on this channel
    const targets = new Set<string>();
    for (const wire of state.c2.wires) {
      if (wire.channel !== channel) continue;
      if (wire.sourceId === sourceElementId) {
        targets.add(wire.targetId);
      }
      // Bidirectional wires also route in reverse
      if (wire.bidirectional && wire.targetId === sourceElementId) {
        targets.add(wire.sourceId);
      }
    }

    // Deliver message to each target frame
    for (const targetId of targets) {
      this.postToCanvas(canvasId, {
        type: "canvas.deliverMessage",
        data: { targetElementId: targetId, channel, payload },
      });
    }

    // Update lastActivity on wires for visual feedback
    const now = Date.now();
    let dirty = false;
    for (const wire of state.c2.wires) {
      if (wire.channel === channel && (wire.sourceId === sourceElementId || (wire.bidirectional && wire.targetId === sourceElementId))) {
        // Update the edge data for visual activity pulse
        this.postToCanvas(canvasId, {
          type: "canvas.updateEdgeData",
          data: { edgeId: `wire_${wire.id}`, updates: { lastActivity: now } },
        });
        dirty = true;
      }
    }
  }

  /**
   * Update a frame's port manifest in the canvas C2 state.
   */
  private async updateFramePorts(
    canvasId: string,
    elementId: string,
    manifest: { outputs?: { channel: string; label?: string }[]; inputs?: { channel: string; label?: string }[] }
  ): Promise<void> {
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((e: { id: string }) => e.id === canvasId);
    if (!entry?.projectSlug) return;

    const state = await this.fileManager.readCanvasById(canvasId, entry.projectSlug);
    if (!state?.c2) return;

    if (!state.c2.framePorts) state.c2.framePorts = {};
    state.c2.framePorts[elementId] = manifest;
    await this.fileManager.writeCanvasById(canvasId, state, entry.projectSlug);
  }

  /**
   * Add a wire to the canvas C2 state and persist to disk.
   */
  async addWire(
    canvasId: string,
    wire: { id: string; sourceId: string; targetId: string; channel: string; bidirectional?: boolean }
  ): Promise<void> {
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((e: { id: string }) => e.id === canvasId);
    if (!entry?.projectSlug) return;

    const state = await this.fileManager.readCanvasById(canvasId, entry.projectSlug);
    if (!state?.c2) return;

    if (!state.c2.wires) state.c2.wires = [];
    // Avoid duplicates
    if (state.c2.wires.some((w) => w.id === wire.id)) return;
    state.c2.wires.push(wire);

    // Also add to the edges array for persistence
    if (!state.edges) state.edges = [];
    if (!state.edges.some((e) => e.id === wire.id)) {
      state.edges.push({
        id: wire.id,
        source: wire.sourceId,
        target: wire.targetId,
        type: "wire",
        data: { channel: wire.channel, bidirectional: wire.bidirectional, label: wire.channel },
      });
    }

    await this.fileManager.writeCanvasById(canvasId, state, entry.projectSlug);

    // Broadcast updated C2 state
    this.postToCanvas(canvasId, {
      type: "canvas.c2Changed",
      data: { enabled: true, c2: state.c2 },
    });
  }

  /**
   * Remove a wire from the canvas C2 state and persist to disk.
   */
  async removeWire(canvasId: string, wireId: string): Promise<void> {
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((e: { id: string }) => e.id === canvasId);
    if (!entry?.projectSlug) return;

    const state = await this.fileManager.readCanvasById(canvasId, entry.projectSlug);
    if (!state?.c2?.wires) return;

    state.c2.wires = state.c2.wires.filter((w) => w.id !== wireId);
    if (state.edges) {
      state.edges = state.edges.filter((e) => e.id !== wireId);
    }

    await this.fileManager.writeCanvasById(canvasId, state, entry.projectSlug);

    this.postToCanvas(canvasId, {
      type: "canvas.c2Changed",
      data: { enabled: state.c2.enabled, c2: state.c2 },
    });
  }

  /**
   * Write HTML to a temp file and open in the default browser.
   * CDN library references are rewritten to local ./libs/ paths for performance.
   */
  private async openHtmlInBrowser(
    html: string,
    title: string
  ): Promise<void> {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40);
    const tmpDir = path.join(os.tmpdir(), "jetro-preview");
    const libsDir = path.join(tmpDir, "libs");
    await fs.mkdir(libsDir, { recursive: true });

    // Shim CDN URLs → local ./libs/ paths
    const { html: shimmedHtml, requiredLibs } = shimBrowserHtml(html);

    // Copy required lib files from extension assets
    const extensionLibsDir = path.join(
      this.extensionUri.fsPath,
      "assets",
      "libs"
    );
    for (const lib of requiredLibs) {
      const src = path.join(extensionLibsDir, lib);
      const dest = path.join(libsDir, lib);
      try {
        await fs.copyFile(src, dest);
      } catch {
        // Lib file missing from extension — CDN URL will remain as fallback
      }
    }

    const filePath = path.join(tmpDir, `${slug}_${Date.now()}.html`);
    await fs.writeFile(filePath, shimmedHtml, "utf-8");
    const uri = vscode.Uri.file(filePath);
    await vscode.env.openExternal(uri);
  }

  private prettifySlug(slug: string): string {
    return slug
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  }

  private getHtml(
    webview: vscode.Webview,
    scriptUri: vscode.Uri,
    cssUri: vscode.Uri,
    canvasId?: string
  ): string {
    // If canvasId is provided, set vscode.setState immediately (before React loads)
    // so the serializer always has the canvasId for panel restoration.
    const earlyState = canvasId
      ? `var _vsc=acquireVsCodeApi();_vsc.setState({canvasId:"${canvasId}"});window.__vscode=_vsc;`
      : "";

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https:; script-src 'unsafe-inline' ${webview.cspSource} https:; img-src ${webview.cspSource} data: https: http://127.0.0.1:*; font-src ${webview.cspSource} https:; connect-src https: http://127.0.0.1:*; media-src ${webview.cspSource} http://127.0.0.1:* blob: data:; frame-src blob: data: 'self' http://127.0.0.1:* https:;">
  <link rel="stylesheet" href="${cssUri}">
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #181818; }
    #canvas-root { width: 100%; height: 100%; }
    #canvas-error { position: fixed; bottom: 10px; left: 10px; right: 10px; padding: 8px 12px; background: #3a1a1a; color: #f85149; font-size: 12px; font-family: monospace; border-radius: 4px; display: none; z-index: 9999; white-space: pre-wrap; max-height: 120px; overflow: auto; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="canvas-root"></div>
  <div id="canvas-error"></div>
  <script>
    ${earlyState}
    window.onerror = function(msg, src, line, col, err) {
      var el = document.getElementById('canvas-error');
      if (el) { el.style.display = 'block'; el.textContent = 'Canvas Error: ' + msg + ' (line ' + line + ')'; }
    };
  </script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
