/**
 * CompanionServer — HTTP + WebSocket server for the Jetro companion web app.
 *
 * Serves the companion React app (companion-dist/) and provides:
 *   - REST API: workspace data (projects, canvases, lists, etc.)
 *   - WebSocket: live canvas sync (bidirectional)
 *   - File serving: workspace files (images, PDFs, frames)
 *   - DuckDB query proxy
 *
 * Preferred port: 17710 (falls back to next available)
 */

import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import WebSocket, { WebSocketServer } from "ws";
import type { FileManager } from "./fileManager";
import type { DuckDBService } from "./duckdb";
import type { PtyManager } from "./ptyManager";
import type { JETList } from "../types";

interface WSClient {
  id: string;
  ws: WebSocket;
  send: (data: string) => void;
  close: () => void;
  alive: boolean;
}

export class CompanionServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private wssTerminal: WebSocketServer | null = null;
  private clients: WSClient[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private clientIdCounter = 0;
  private preferredPort: number;

  /** Directory containing the built companion React app */
  private staticDir: string;
  private shareManager?: import("./shareManager").ShareManager;
  private deployManager?: import("./deployManager").DeployManager;

  /** Callback when companion changes active canvas (so extension can update CanvasProvider) */
  onCompanionCanvasChanged?: (canvasId: string) => void;

  /** Canvas IDs recently written by companion (REST save / WS stateUpdate). Prevents file watcher from auto-opening them. */
  private recentCompanionWrites = new Set<string>();

  constructor(
    private port: number,
    private workspacePath: string,
    private extensionPath: string,
    private fileManager: FileManager,
    private duckdb: DuckDBService | null,
    private outputChannel: vscode.OutputChannel,
    private ptyManager?: PtyManager,
  ) {
    this.preferredPort = port;
    // companion-dist/ is at the extension root (sibling to out/)
    this.staticDir = path.join(extensionPath, "companion-dist");
  }

  // ══════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════

  setShareManager(manager: import("./shareManager").ShareManager): void {
    this.shareManager = manager;
  }

  setDeployManager(manager: import("./deployManager").DeployManager): void {
    this.deployManager = manager;
  }

  async start(): Promise<number> {
    if (this.server?.listening) return this.port;

    return new Promise<number>((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.timeout = 0;
      this.server.keepAliveTimeout = 0;

      // WebSocket servers (noServer mode — we route upgrades manually)
      this.wss = new WebSocketServer({ noServer: true });
      this.wssTerminal = new WebSocketServer({ noServer: true });

      // Route upgrade requests to the appropriate WebSocket server
      this.server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
        this.outputChannel.appendLine(`[companion] WS upgrade request: ${url.pathname}`);

        if (url.pathname === "/ws") {
          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.wss!.emit("connection", ws, req);
          });
        } else if (url.pathname === "/ws/terminal") {
          this.wssTerminal!.handleUpgrade(req, socket, head, (ws) => {
            this.wssTerminal!.emit("connection", ws, req);
          });
        } else {
          socket.destroy();
        }
      });

      // Main WS connections (canvas sync)
      this.wss.on("connection", (ws) => {
        this.handleMainWSConnection(ws);
      });

      // Terminal WS connections (PTY I/O)
      this.wssTerminal.on("connection", (ws) => {
        this.handleTerminalWSConnection(ws);
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && this.port < this.preferredPort + 10) {
          // Port in use — try next one
          this.port++;
          this.outputChannel.appendLine(`[companion] Port ${this.port - 1} in use, trying ${this.port}...`);
          this.server!.listen(this.port, "127.0.0.1");
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        this.outputChannel.appendLine(`[companion] Server listening on http://127.0.0.1:${this.port}`);
        this.heartbeatTimer = setInterval(() => this.heartbeat(), 30000);
        resolve(this.port);
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          this.outputChannel.appendLine(`[companion] Port ${this.port} already in use`);
        }
        reject(err);
      });
    });
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients) {
      try { client.close(); } catch { /* ignore */ }
    }
    this.clients = [];
    if (this.wss) { this.wss.close(); this.wss = null; }
    if (this.wssTerminal) { this.wssTerminal.close(); this.wssTerminal = null; }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.outputChannel.appendLine("[companion] Server stopped");
  }

  dispose(): void {
    this.stop();
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Returns the actual port the server is listening on. */
  getPort(): number {
    return this.port;
  }

  /** Returns true if this canvas was recently written by the companion (not by agent/render queue). */
  isRecentCompanionWrite(canvasId: string): boolean {
    return this.recentCompanionWrites.has(canvasId);
  }

  /** Mark a canvas as companion-written (auto-clears after 3s). */
  private markCompanionWrite(canvasId: string): void {
    this.recentCompanionWrites.add(canvasId);
    setTimeout(() => this.recentCompanionWrites.delete(canvasId), 3000);
  }

  // ══════════════════════════════════════════
  // WebSocket — broadcast to all companion clients
  // ══════════════════════════════════════════

  /** Send a message to all connected companion clients */
  broadcast(msg: Record<string, unknown>): void {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      try { client.send(payload); } catch { /* dead client — will be cleaned */ }
    }
  }

  /** Send a message to a specific client */
  sendTo(clientId: string, msg: Record<string, unknown>): void {
    const client = this.clients.find((c) => c.id === clientId);
    if (client) {
      try { client.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  get clientCount(): number {
    return this.clients.length;
  }

  // ══════════════════════════════════════════
  // HTTP Request Router
  // ══════════════════════════════════════════

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.upgrade) return; // handled by ws library

    const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
    const pathname = url.pathname;

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ── API routes ──
      if (pathname.startsWith("/api/")) {
        await this.handleApiRoute(req, res, pathname, url);
        return;
      }

      // ── Static files (companion app) ──
      this.serveStatic(pathname, req, res);
    } catch (err) {
      this.outputChannel.appendLine(`[companion] Request error: ${err}`);
      this.json(res, 500, { error: "Internal server error" });
    }
  }

  // ══════════════════════════════════════════
  // API Routes
  // ══════════════════════════════════════════

  private async handleApiRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    url: URL,
  ): Promise<void> {
    const method = req.method || "GET";
    const segments = pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
    const route = segments[0] || "";

    // ── GET routes ──
    if (method === "GET") {
      switch (route) {
        case "workspace":
          return this.json(res, 200, {
            path: this.workspacePath,
            name: path.basename(this.workspacePath),
          });

        case "projects":
          return this.apiGetProjects(res);

        case "project":
          return this.apiGetProject(res, segments[1]);

        case "canvases":
          return this.apiGetCanvases(res);

        case "canvas":
          // GET /api/canvas/:id/versions
          if (segments[2] === "versions") {
            return this.apiGetCanvasVersions(res, segments[1]);
          }
          return this.apiGetCanvas(res, segments[1]);

        case "lists":
          return this.apiGetLists(res);

        case "datasets":
          return this.apiGetDatasets(res);

        case "recipes":
          return this.apiGetRecipes(res);

        case "templates":
          return this.apiGetTemplates(res);

        case "shares":
          return this.apiGetShares(res);

        case "connectors":
          return this.apiGetConnectors(res);

        case "bindings":
          return this.apiGetBindings(res);

        case "daemon":
          return this.apiGetDaemonStatus(res);

        case "search":
          return this.apiSearch(res, url.searchParams.get("q") || "");

        case "files":
          return this.serveWorkspaceFile(segments.slice(1).join("/"), req, res);

        case "vendor":
          return this.serveVendorFile(segments.slice(1).join("/"), req, res);

        default:
          return this.json(res, 404, { error: `Unknown route: ${route}` });
      }
    }

    // ── POST routes ──
    if (method === "POST") {
      const body = await this.readBody(req);

      switch (route) {
        case "project":
          // POST /api/project/:slug/link/:resourceType/:resourceSlug
          if (segments[2] === "link") {
            return this.apiLinkResource(res, segments[1], segments[3], segments[4]);
          }
          return this.apiCreateProject(res, body);

        case "canvas":
          // POST /api/canvas/:id/element/:eid/toggle-visibility
          if (segments[2] === "element" && segments[4] === "toggle-visibility") {
            return this.apiToggleElementVisibility(res, segments[1], segments[3]);
          }
          // POST /api/canvas/:id/restore
          if (segments[2] === "restore") {
            return this.apiRestoreCanvasVersion(res, segments[1], body);
          }
          return this.apiCreateCanvas(res, body);

        case "deploy":
          // POST /api/deploy/:action { slug }
          if (segments[1] && body) {
            return this.apiDeployAction(res, segments[1], body as Record<string, unknown>);
          }
          break;

        case "bindings":
          // POST /api/bindings/toggle — toggle individual binding
          if (segments[1] === "toggle") {
            return this.apiToggleBinding(res, body as Record<string, unknown>);
          }
          // POST /api/bindings/trigger — trigger individual binding
          if (segments[1] === "trigger") {
            return this.apiTriggerBinding(res, body as Record<string, unknown>);
          }
          // POST /api/bindings/global-pause — toggle global pause
          if (segments[1] === "global-pause") {
            return this.apiToggleGlobalPause(res);
          }
          break;

        case "list":
          return this.apiCreateList(res, body);

        case "query":
          return this.apiQuery(res, body);

        case "upload":
          return this.apiUpload(req, res);

        case "daemon":
          if (segments[1] === "toggle-pause") {
            return this.apiToggleDaemonPause(res);
          }
          return this.json(res, 404, { error: "Unknown daemon route" });

        default:
          return this.json(res, 404, { error: `Unknown route: ${route}` });
      }
    }

    // ── PUT routes ──
    if (method === "PUT") {
      const body = await this.readBody(req);

      switch (route) {
        case "project":
          if (segments[2] === "status") {
            return this.apiUpdateProjectStatus(res, segments[1], body);
          }
          if (segments[2] === "mode") {
            return this.apiUpdateProjectMode(res, segments[1], body);
          }
          return this.apiRenameProject(res, segments[1], body);

        case "canvas":
          if (segments[2] === "rename") {
            return this.apiRenameCanvas(res, segments[1], body);
          }
          return this.apiSaveCanvas(res, segments[1], body);

        case "list":
          return this.apiUpdateList(res, segments[1], body);

        default:
          return this.json(res, 404, { error: `Unknown route: ${route}` });
      }
    }

    // ── DELETE routes ──
    if (method === "DELETE") {
      switch (route) {
        case "project":
          // DELETE /api/project/:slug/file/:dir/:filename
          if (segments[2] === "file") {
            return this.apiDeleteProjectFile(res, segments[1], segments[3], segments[4]);
          }
          // DELETE /api/project/:slug/link/:resourceType/:resourceSlug
          if (segments[2] === "link") {
            return this.apiUnlinkResource(res, segments[1], segments[3], segments[4]);
          }
          return this.apiDeleteProject(res, segments[1]);

        case "canvas":
          if (segments[2] === "element") {
            return this.apiDeleteCanvasElement(res, segments[1], segments[3]);
          }
          return this.apiDeleteCanvas(res, segments[1]);

        case "list":
          return this.apiDeleteList(res, segments[1]);

        case "recipe":
          return this.apiDeleteRecipe(res, segments[1]);

        case "dataset":
          return this.apiDeleteDataset(res, segments[1]);

        case "template":
          return this.apiDeleteTemplate(res, segments[1]);

        default:
          return this.json(res, 404, { error: `Unknown route: ${route}` });
      }
    }

    this.json(res, 405, { error: "Method not allowed" });
  }

  // ── API Handlers ──

  private async apiGetProjects(res: http.ServerResponse): Promise<void> {
    const slugs = await this.fileManager.listProjects();
    const projects = [];
    const canvasRegistry = await this.fileManager.readCanvasRegistry();
    for (const slug of slugs) {
      const project = await this.fileManager.readProject(slug);
      if (project) {
        // Enrich canvas entries with element details
        const rawEntries = canvasRegistry.filter((c) => c.projectSlug === slug);
        const canvasEntries = [];
        for (const entry of rawEntries) {
          const state = await this.fileManager.readCanvasById(entry.id, entry.projectSlug);
          const elements = (state?.elements || []).map((el) => ({
            id: el.id,
            type: el.type,
            name: (el.data.title as string) || (el.data.name as string) || el.type,
            live: !!(state?.refreshBindings?.find((b: { elementId: string; enabled: boolean }) => b.elementId === el.id)?.enabled),
            visible: el.data._hidden !== true,
          }));
          const c2Enabled = !!state?.c2?.enabled;
          const wireCount = c2Enabled ? (state?.c2?.wires ?? []).length : 0;
          canvasEntries.push({ ...entry, elements, c2Enabled, wireCount });
        }
        const files = await this.listProjectFiles(slug);
        projects.push({ ...project, canvasEntries, files });
      }
    }
    this.json(res, 200, projects);
  }

  private async apiGetProject(res: http.ServerResponse, slug: string | undefined): Promise<void> {
    if (!slug) return this.json(res, 400, { error: "Missing project slug" });
    const project = await this.fileManager.readProject(slug);
    if (!project) return this.json(res, 404, { error: "Project not found" });
    this.json(res, 200, project);
  }

  private async apiGetCanvases(res: http.ServerResponse): Promise<void> {
    const registry = await this.fileManager.readCanvasRegistry();
    // Enrich with element summaries
    const entries = [];
    for (const entry of registry) {
      const state = await this.fileManager.readCanvasById(entry.id, entry.projectSlug);
      const elements = (state?.elements || []).map((el) => ({
        id: el.id,
        type: el.type,
        name: (el.data.title as string) || (el.data.name as string) || el.type,
        live: !!(state?.refreshBindings?.find((b) => b.elementId === el.id)?.enabled),
        visible: el.data._hidden !== true,
      }));
      const sources = (state?.elements || [])
        .filter((el) => el.type === "frame" && (el.data.file || el.data.filePath))
        .map((el) => ({
          name: path.basename((el.data.file || el.data.filePath) as string),
          type: "frame",
        }));
      entries.push({ ...entry, elements, sources });
    }
    this.json(res, 200, entries);
  }

  private async apiGetCanvas(res: http.ServerResponse, id: string | undefined): Promise<void> {
    if (!id) return this.json(res, 400, { error: "Missing canvas id" });
    // Look up projectSlug from registry
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((c) => c.id === id);
    const state = await this.fileManager.readCanvasById(id, entry?.projectSlug ?? null);
    if (!state) return this.json(res, 404, { error: "Canvas not found" });
    this.json(res, 200, state);
  }

  private async apiGetCanvasVersions(res: http.ServerResponse, id: string | undefined): Promise<void> {
    if (!id) return this.json(res, 400, { error: "Missing canvas id" });
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((c) => c.id === id);
    const versions = await this.fileManager.listCanvasVersions(id, entry?.projectSlug ?? null);
    // Read element/edge counts for each version (up to 30)
    const result = [];
    for (const v of versions.slice(0, 30)) {
      const state = await this.fileManager.readCanvasVersion(id, entry?.projectSlug ?? null, v.timestamp);
      result.push({
        timestamp: v.timestamp,
        date: new Date(v.timestamp).toISOString(),
        elementCount: state?.elements?.length ?? 0,
        edgeCount: state?.edges?.length ?? 0,
      });
    }
    this.json(res, 200, { canvasId: id, versions: result });
  }

  private async apiRestoreCanvasVersion(res: http.ServerResponse, id: string | undefined, body: unknown): Promise<void> {
    if (!id) return this.json(res, 400, { error: "Missing canvas id" });
    const { timestamp } = (body || {}) as { timestamp?: number };
    if (!timestamp) return this.json(res, 400, { error: "Missing timestamp" });
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((c) => c.id === id);
    const restored = await this.fileManager.restoreCanvasVersion(id, entry?.projectSlug ?? null, timestamp);
    if (!restored) return this.json(res, 404, { error: "Version not found" });
    // Broadcast restored state to connected companion WS clients
    this.broadcast({ type: "canvas.setState", canvasId: id, data: restored as unknown as Record<string, unknown> });
    this.json(res, 200, { success: true, elementCount: restored.elements?.length ?? 0 });
  }

  private async apiSaveCanvas(res: http.ServerResponse, id: string | undefined, body: unknown): Promise<void> {
    if (!id) return this.json(res, 400, { error: "Missing canvas id" });
    const data = body as Record<string, unknown>;

    // Read existing state, merge with updates
    const registry = await this.fileManager.readCanvasRegistry();
    const entry = registry.find((c) => c.id === id);
    const existing = await this.fileManager.readCanvasById(id, entry?.projectSlug ?? null);
    if (!existing) return this.json(res, 404, { error: "Canvas not found" });

    const merged = { ...existing, ...data };
    this.markCompanionWrite(id);
    await this.fileManager.writeCanvasById(id, merged as never, entry?.projectSlug ?? null);
    this.json(res, 200, { ok: true });
  }

  private async apiGetLists(res: http.ServerResponse): Promise<void> {
    const slugs = await this.fileManager.listLists();
    const lists = [];
    for (const slug of slugs) {
      const list = await this.fileManager.readList(slug);
      if (list) lists.push(await this.enrichListVisibility(list));
    }
    this.json(res, 200, lists);
  }

  private async apiGetDatasets(res: http.ServerResponse): Promise<void> {
    const slugs = await this.fileManager.listDatasets();
    const datasets = [];
    for (const slug of slugs) {
      const ds = await this.fileManager.readDataset(slug);
      if (ds) datasets.push(ds);
    }
    this.json(res, 200, datasets);
  }

  private async apiGetRecipes(res: http.ServerResponse): Promise<void> {
    const slugs = await this.fileManager.listRecipes();
    const recipes = [];
    for (const slug of slugs) {
      const recipe = await this.fileManager.readRecipe(slug);
      if (recipe) recipes.push(recipe);
    }
    this.json(res, 200, recipes);
  }

  private async apiGetTemplates(res: http.ServerResponse): Promise<void> {
    const templates: Array<{ name: string; description: string; source: string }> = [];

    // Bundled starter templates
    const bundledDir = path.join(this.extensionPath, "agent", "templates");
    try {
      const files = fs.readdirSync(bundledDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const tpl = JSON.parse(fs.readFileSync(path.join(bundledDir, file), "utf-8"));
          if (tpl.name) {
            templates.push({ name: tpl.name, description: tpl.description || "", source: "starter" });
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* no bundled dir */ }

    // Local user templates
    try {
      const slugs = await this.fileManager.listTemplates();
      for (const slug of slugs) {
        const displayName = slug.replace(/_/g, " ");
        if (!templates.some((t) => t.name.toLowerCase() === displayName.toLowerCase())) {
          templates.push({ name: displayName, description: "", source: "local" });
        }
      }
    } catch { /* no local templates */ }

    this.json(res, 200, templates);
  }

  private async apiGetShares(res: http.ServerResponse): Promise<void> {
    if (!this.shareManager) {
      this.json(res, 200, []);
      return;
    }
    try {
      const shares = await this.shareManager.listShares();
      this.json(res, 200, shares);
    } catch {
      this.json(res, 200, []);
    }
  }

  // ── Deploy actions ──

  private async apiDeployAction(res: http.ServerResponse, action: string, body: Record<string, unknown>): Promise<void> {
    if (!this.deployManager) { this.json(res, 500, { error: "DeployManager not available" }); return; }
    const slug = body.slug as string;
    if (!slug) { this.json(res, 400, { error: "Missing slug" }); return; }
    try {
      switch (action) {
        case "stop":
          await this.deployManager.stop(slug);
          this.json(res, 200, { ok: true, status: "stopped" });
          break;
        case "start": {
          const deployDir = path.join(this.workspacePath, "projects", slug, "deploy");
          const result = await this.deployManager.start(slug, deployDir);
          this.json(res, 200, { ok: true, status: "live", port: result.port });
          break;
        }
        case "redeploy": {
          const rResult = await this.deployManager.redeploy(slug);
          this.json(res, 200, { ok: true, status: "live", port: rResult.port });
          break;
        }
        case "remove":
          await this.deployManager.remove(slug);
          this.json(res, 200, { ok: true, status: "removed" });
          break;
        default:
          this.json(res, 400, { error: `Unknown action: ${action}` });
      }
    } catch (err) {
      this.json(res, 500, { error: String(err) });
    }
  }

  // ── Bindings ──

  private async apiGetBindings(res: http.ServerResponse): Promise<void> {
    try {
      const registry = await this.fileManager.readCanvasRegistry();
      const bindings: { canvasId: string; canvasName: string; elementName: string; binding: Record<string, unknown> }[] = [];
      for (const entry of registry) {
        const state = await this.fileManager.readCanvasById(entry.id, entry.projectSlug);
        for (const b of state?.refreshBindings || []) {
          const elem = (state?.elements || []).find((e) => e.id === b.elementId);
          const elemName = (elem?.data as Record<string, unknown>)?.title as string || b.elementId;
          bindings.push({ canvasId: entry.id, canvasName: entry.name || entry.id, elementName: elemName, binding: b as unknown as Record<string, unknown> });
        }
      }
      let paused = false;
      try {
        paused = JSON.parse(fs.readFileSync(path.join(this.workspacePath, ".jetro", "daemon-config.json"), "utf-8")).paused === true;
      } catch { /* not paused */ }
      this.json(res, 200, { bindings, paused });
    } catch {
      this.json(res, 200, { bindings: [], paused: false });
    }
  }

  private async apiToggleBinding(res: http.ServerResponse, body: Record<string, unknown>): Promise<void> {
    const canvasId = body.canvasId as string;
    const elementId = body.elementId as string;
    if (!canvasId || !elementId) { this.json(res, 400, { error: "Missing canvasId/elementId" }); return; }
    try {
      const state = await this.fileManager.readCanvasById(canvasId, null);
      if (state?.refreshBindings) {
        const b = state.refreshBindings.find((rb) => rb.elementId === elementId);
        if (b) {
          b.enabled = !b.enabled;
          await this.fileManager.writeCanvasById(canvasId, state, null);
        }
      }
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: String(err) });
    }
  }

  private async apiTriggerBinding(res: http.ServerResponse, body: Record<string, unknown>): Promise<void> {
    const canvasId = body.canvasId as string;
    const elementId = body.elementId as string;
    if (!canvasId || !elementId) { this.json(res, 400, { error: "Missing canvasId/elementId" }); return; }
    // Trigger is handled by extension command — send via WS broadcast
    this.broadcast({ type: "binding.trigger", canvasId, elementId });
    this.json(res, 200, { ok: true });
  }

  private async apiToggleGlobalPause(res: http.ServerResponse): Promise<void> {
    try {
      const dcPath = path.join(this.workspacePath, ".jetro", "daemon-config.json");
      let paused = false;
      try { paused = JSON.parse(fs.readFileSync(dcPath, "utf-8")).paused === true; } catch { /* */ }
      fs.writeFileSync(dcPath, JSON.stringify({ paused: !paused }, null, 2));
      this.json(res, 200, { paused: !paused });
    } catch (err) {
      this.json(res, 500, { error: String(err) });
    }
  }

  // ── Daemon status ──

  private async apiGetDaemonStatus(res: http.ServerResponse): Promise<void> {
    let paused = false;
    try {
      const config = JSON.parse(
        fs.readFileSync(path.join(this.workspacePath, ".jetro", "daemon-config.json"), "utf-8")
      );
      paused = config.paused === true;
    } catch { /* default */ }

    let activeBindingCount = 0;
    try {
      const registry = await this.fileManager.readCanvasRegistry();
      for (const entry of registry) {
        const state = await this.fileManager.readCanvasById(entry.id, entry.projectSlug ?? null);
        if (state?.refreshBindings) {
          activeBindingCount += (state.refreshBindings as Array<{ enabled: boolean }>).filter(
            (b) => b.enabled
          ).length;
        }
      }
    } catch { /* best effort */ }

    this.json(res, 200, { paused, activeBindingCount });
  }

  private async apiToggleDaemonPause(res: http.ServerResponse): Promise<void> {
    const configPath = path.join(this.workspacePath, ".jetro", "daemon-config.json");
    let config: { paused: boolean } = { paused: false };
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch { /* default */ }
    config.paused = !config.paused;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    this.broadcast({ type: "daemon.status", paused: config.paused, activeBindingCount: 0 });
    this.json(res, 200, { paused: config.paused });
  }

  // ── Element visibility toggle ──

  private async apiToggleElementVisibility(
    res: http.ServerResponse,
    canvasId: string,
    elementId: string
  ): Promise<void> {
    try {
      const registry = await this.fileManager.readCanvasRegistry();
      const entry = registry.find((c: { id: string }) => c.id === canvasId);
      const state = await this.fileManager.readCanvasById(canvasId, entry?.projectSlug ?? null);
      if (!state) return this.json(res, 404, { error: "Canvas not found" });

      const elements = (state as { elements: Array<{ id: string; data: Record<string, unknown> }> }).elements;
      const el = elements?.find((e) => e.id === elementId);
      if (!el) return this.json(res, 404, { error: "Element not found" });

      const hidden = !(el.data._hidden === true);
      el.data._hidden = hidden;
      await this.fileManager.writeCanvasById(canvasId, state as never, entry?.projectSlug ?? null);

      // Broadcast canvas update to companion clients
      this.broadcast({
        type: "canvas.updateElement",
        canvasId,
        elementId,
        data: { _hidden: hidden },
      });
      // Re-broadcast sidebar data so element visibility state updates
      await this.broadcastSidebarCanvases();
      await this.broadcastSidebarProjects();
      await this.broadcastSidebarLists();

      this.json(res, 200, { hidden });
    } catch (err) {
      this.json(res, 500, { error: `Toggle visibility failed: ${err}` });
    }
  }

  private async apiSearch(res: http.ServerResponse, q: string): Promise<void> {
    if (!q || q.length < 1) return this.json(res, 200, []);

    const results: Record<string, unknown>[] = [];
    const qLower = q.toLowerCase();

    // Search stocks
    const stocks = await this.fileManager.listStocks();
    for (const ticker of stocks) {
      if (ticker.toLowerCase().includes(qLower)) {
        const profile = await this.fileManager.readStockData<Record<string, unknown>>(ticker, "profile");
        results.push({
          symbol: ticker,
          name: (profile?.companyName as string) || ticker,
          exchangeShortName: (profile?.exchangeShortName as string) || "NSE",
        });
      }
      if (results.length >= 20) break;
    }

    // Search projects
    const projectSlugs = await this.fileManager.listProjects();
    for (const slug of projectSlugs) {
      if (slug.includes(qLower)) {
        const project = await this.fileManager.readProject(slug);
        if (project) {
          results.push({ type: "project", slug, name: project.name });
        }
      }
    }

    this.json(res, 200, results);
  }

  private async apiQuery(res: http.ServerResponse, body: unknown): Promise<void> {
    if (!this.duckdb) {
      return this.json(res, 503, { error: "DuckDB not available" });
    }
    const { sql } = body as { sql?: string };
    if (!sql) return this.json(res, 400, { error: "Missing sql parameter" });

    try {
      const rows = await this.duckdb.executeQuery(sql);
      this.json(res, 200, { rows });
    } catch (err) {
      this.json(res, 400, { error: `Query failed: ${err}` });
    }
  }

  private async apiCreateProject(res: http.ServerResponse, body: unknown): Promise<void> {
    const { name } = body as { name?: string };
    if (!name) return this.json(res, 400, { error: "Missing project name" });

    try {
      const now = new Date().toISOString();
      const slug = this.slugify(name);
      await this.fileManager.writeProject(name, {
        name,
        slug,
        status: "active",
        securities: [],
        sources: [],
        createdAt: now,
        updatedAt: now,
      });
      this.json(res, 201, { ok: true, slug });
    } catch (err) {
      this.json(res, 500, { error: `Failed to create project: ${err}` });
    }
  }

  // ── Project CRUD ──

  private async apiRenameProject(res: http.ServerResponse, slug: string | undefined, body: unknown): Promise<void> {
    if (!slug) return this.json(res, 400, { error: "Missing project slug" });
    const { name } = body as { name?: string };
    if (!name) return this.json(res, 400, { error: "Missing new name" });

    try {
      const project = await this.fileManager.readProject(slug);
      if (!project) return this.json(res, 404, { error: "Project not found" });
      const updated = { ...project, name, updatedAt: new Date().toISOString() };
      await this.fileManager.writeProject(slug, updated);
      await this.broadcastSidebarProjects();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to rename project: ${err}` });
    }
  }

  private async apiUpdateProjectStatus(res: http.ServerResponse, slug: string | undefined, body: unknown): Promise<void> {
    if (!slug) return this.json(res, 400, { error: "Missing project slug" });
    const { status } = body as { status?: "active" | "draft" | "done" };
    if (!status) return this.json(res, 400, { error: "Missing status" });

    try {
      const project = await this.fileManager.readProject(slug);
      if (!project) return this.json(res, 404, { error: "Project not found" });
      const updated = { ...project, status, updatedAt: new Date().toISOString() };
      await this.fileManager.writeProject(slug, updated);
      await this.broadcastSidebarProjects();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to update project status: ${err}` });
    }
  }

  private async apiDeleteProject(res: http.ServerResponse, slug: string | undefined): Promise<void> {
    if (!slug) return this.json(res, 400, { error: "Missing project slug" });

    try {
      await this.fileManager.deleteProject(slug);
      await this.broadcastSidebarProjects();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to delete project: ${err}` });
    }
  }

  // ── Canvas CRUD ──

  private async apiCreateCanvas(res: http.ServerResponse, body: unknown): Promise<void> {
    const { name, projectSlug } = body as { name?: string; projectSlug?: string };
    if (!name) return this.json(res, 400, { error: "Missing canvas name" });

    try {
      const crypto = require("node:crypto");
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      // Write empty canvas state
      await this.fileManager.writeCanvasById(id, {
        name,
        elements: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      } as never, projectSlug ?? null);

      // Update registry
      const registry = await this.fileManager.readCanvasRegistry();
      registry.push({ id, name, projectSlug: projectSlug ?? null, createdAt: now });
      await this.fileManager.writeCanvasRegistry(registry);

      await this.broadcastSidebarCanvases();
      if (projectSlug) await this.broadcastSidebarProjects();
      this.json(res, 201, { ok: true, id });
    } catch (err) {
      this.json(res, 500, { error: `Failed to create canvas: ${err}` });
    }
  }

  private async apiRenameCanvas(res: http.ServerResponse, id: string | undefined, body: unknown): Promise<void> {
    if (!id) return this.json(res, 400, { error: "Missing canvas id" });
    const { name } = body as { name?: string };
    if (!name) return this.json(res, 400, { error: "Missing new name" });

    try {
      const registry = await this.fileManager.readCanvasRegistry();
      const entry = registry.find((c) => c.id === id);
      if (!entry) return this.json(res, 404, { error: "Canvas not found in registry" });
      entry.name = name;
      await this.fileManager.writeCanvasRegistry(registry);

      await this.broadcastSidebarCanvases();
      if (entry.projectSlug) await this.broadcastSidebarProjects();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to rename canvas: ${err}` });
    }
  }

  private async apiDeleteCanvas(res: http.ServerResponse, id: string | undefined): Promise<void> {
    if (!id) return this.json(res, 400, { error: "Missing canvas id" });

    try {
      // Look up projectSlug before deleting
      const registryForDelete = await this.fileManager.readCanvasRegistry();
      const entryForDelete = registryForDelete.find((c) => c.id === id);
      await this.fileManager.deleteCanvasById(id, entryForDelete?.projectSlug ?? null);

      // Remove from registry
      const registry = await this.fileManager.readCanvasRegistry();
      const filtered = registry.filter((c) => c.id !== id);
      await this.fileManager.writeCanvasRegistry(filtered);

      await this.broadcastSidebarCanvases();
      if (entryForDelete?.projectSlug) await this.broadcastSidebarProjects();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to delete canvas: ${err}` });
    }
  }

  private async apiDeleteCanvasElement(res: http.ServerResponse, canvasId: string | undefined, elementId: string | undefined): Promise<void> {
    if (!canvasId || !elementId) return this.json(res, 400, { error: "Missing canvasId or elementId" });

    try {
      const registry = await this.fileManager.readCanvasRegistry();
      const entry = registry.find((c) => c.id === canvasId);
      const state = await this.fileManager.readCanvasById(canvasId, entry?.projectSlug ?? null);
      if (!state) return this.json(res, 404, { error: "Canvas not found" });

      state.elements = (state.elements || []).filter((el: { id: string }) => el.id !== elementId);
      await this.fileManager.writeCanvasById(canvasId, state as never, entry?.projectSlug ?? null);

      // Broadcast updated canvas state to companion clients
      this.broadcast({ type: "canvas.setState", canvasId, state });
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to delete element: ${err}` });
    }
  }

  // ── List CRUD ──

  private async apiCreateList(res: http.ServerResponse, body: unknown): Promise<void> {
    const { name, tickers } = body as { name?: string; tickers?: string[] };
    if (!name) return this.json(res, 400, { error: "Missing list name" });

    try {
      const listSlug = this.slugify(name);
      await this.fileManager.writeList(name, {
        name,
        tickers: tickers || [],
        refreshable: false,
        createdAt: new Date().toISOString(),
      });
      await this.broadcastSidebarLists();
      this.json(res, 201, { ok: true, slug: listSlug });
    } catch (err) {
      this.json(res, 500, { error: `Failed to create list: ${err}` });
    }
  }

  private async apiUpdateList(res: http.ServerResponse, slug: string | undefined, body: unknown): Promise<void> {
    if (!slug) return this.json(res, 400, { error: "Missing list slug" });

    try {
      const existing = await this.fileManager.readList(slug);
      if (!existing) return this.json(res, 404, { error: "List not found" });
      const data = body as Record<string, unknown>;
      const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
      await this.fileManager.writeList(slug, merged);
      await this.broadcastSidebarLists();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to update list: ${err}` });
    }
  }

  private async apiDeleteList(res: http.ServerResponse, slug: string | undefined): Promise<void> {
    if (!slug) return this.json(res, 400, { error: "Missing list slug" });

    try {
      await this.fileManager.deleteList(slug);
      await this.broadcastSidebarLists();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to delete list: ${err}` });
    }
  }

  // ── Project mode toggle ──

  private async apiUpdateProjectMode(res: http.ServerResponse, slug: string | undefined, body: unknown): Promise<void> {
    if (!slug) return this.json(res, 400, { error: "Missing project slug" });
    const { mode } = body as { mode?: "portfolio" };

    try {
      const project = await this.fileManager.readProject(slug);
      if (!project) return this.json(res, 404, { error: "Project not found" });

      if (mode === "portfolio") {
        project.mode = "portfolio";
      } else {
        project.mode = undefined;
        await this.fileManager.deletePortfolioData(slug);
      }
      project.updatedAt = new Date().toISOString();
      await this.fileManager.writeProject(project.name, project);
      await this.broadcastSidebarProjects();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to update project mode: ${err}` });
    }
  }

  // ── Recipe / Dataset delete ──

  private async apiDeleteRecipe(res: http.ServerResponse, slug: string | undefined): Promise<void> {
    if (!slug) return this.json(res, 400, { error: "Missing recipe slug" });

    try {
      await this.fileManager.deleteRecipe(slug);
      await this.broadcastSidebarRecipes();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to delete recipe: ${err}` });
    }
  }

  private async apiDeleteDataset(res: http.ServerResponse, slug: string | undefined): Promise<void> {
    if (!slug) return this.json(res, 400, { error: "Missing dataset slug" });

    try {
      await this.fileManager.deleteDataset(slug);
      await this.broadcastSidebarDatasets();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to delete dataset: ${err}` });
    }
  }

  private async apiDeleteTemplate(res: http.ServerResponse, slug: string | undefined): Promise<void> {
    if (!slug) return this.json(res, 400, { error: "Missing template slug" });

    try {
      await this.fileManager.deleteTemplate(slug);
      await this.broadcastSidebarTemplates();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to delete template: ${err}` });
    }
  }

  private async apiDeleteProjectFile(
    res: http.ServerResponse,
    projectSlug: string | undefined,
    dir: string | undefined,
    filename: string | undefined,
  ): Promise<void> {
    if (!projectSlug || !dir || !filename) return this.json(res, 400, { error: "Missing parameters" });
    try {
      const filePath = dir === "root"
        ? path.join(this.workspacePath, "projects", projectSlug, filename)
        : path.join(this.workspacePath, "projects", projectSlug, dir, filename);
      fs.unlinkSync(filePath);
      await this.broadcastSidebarProjects();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to delete file: ${err}` });
    }
  }

  private async apiUnlinkResource(
    res: http.ServerResponse,
    projectSlug: string | undefined,
    resourceType: string | undefined,
    resourceSlug: string | undefined,
  ): Promise<void> {
    if (!projectSlug || !resourceType || !resourceSlug) {
      return this.json(res, 400, { error: "Missing parameters" });
    }
    try {
      const project = await this.fileManager.readProject(projectSlug);
      if (!project) return this.json(res, 404, { error: "Project not found" });

      const fieldMap: Record<string, string> = {
        connector: "linkedConnectors",
        recipe: "linkedRecipes",
        template: "linkedTemplates",
      };
      const field = fieldMap[resourceType];
      if (!field) return this.json(res, 400, { error: `Unknown resource type: ${resourceType}` });

      const proj = project as unknown as Record<string, unknown>;
      const arr = proj[field];
      if (Array.isArray(arr)) {
        proj[field] = arr.filter((s: string) => s !== resourceSlug);
      }
      await this.fileManager.writeProject(projectSlug, project);
      await this.broadcastSidebarProjects();
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to unlink resource: ${err}` });
    }
  }

  private async apiGetConnectors(res: http.ServerResponse): Promise<void> {
    try {
      const slugs = await this.fileManager.listConnectors();
      const connectors = [];
      for (const slug of slugs) {
        const c = await this.fileManager.readConnector(slug);
        if (c) connectors.push({ slug: c.slug, name: c.name, type: c.type, auth: c.auth ? { method: c.auth.method } : undefined });
      }
      this.json(res, 200, connectors);
    } catch (err) {
      this.json(res, 500, { error: `Failed to list connectors: ${err}` });
    }
  }

  private async apiLinkResource(
    res: http.ServerResponse,
    projectSlug: string | undefined,
    resourceType: string | undefined,
    resourceSlug: string | undefined,
  ): Promise<void> {
    if (!projectSlug || !resourceType || !resourceSlug) {
      return this.json(res, 400, { error: "Missing parameters" });
    }
    try {
      const project = await this.fileManager.readProject(projectSlug);
      if (!project) return this.json(res, 404, { error: "Project not found" });

      const fieldMap: Record<string, "linkedConnectors" | "linkedConnections" | "linkedTemplates" | "linkedRecipes"> = {
        connector: "linkedConnectors",
        connection: "linkedConnections",
        template: "linkedTemplates",
        recipe: "linkedRecipes",
      };
      const field = fieldMap[resourceType];
      if (!field) return this.json(res, 400, { error: `Unknown resource type: ${resourceType}` });

      const proj = project as unknown as Record<string, unknown>;
      const arr = (proj[field] || []) as string[];
      if (!arr.includes(resourceSlug)) {
        arr.push(resourceSlug);
        proj[field] = arr;
        (project as { updatedAt: string }).updatedAt = new Date().toISOString();
        await this.fileManager.writeProject(projectSlug, project);
        await this.broadcastSidebarProjects();
      }
      this.json(res, 200, { ok: true });
    } catch (err) {
      this.json(res, 500, { error: `Failed to link resource: ${err}` });
    }
  }

  // ── Broadcast helpers ──

  private async broadcastSidebarProjects(): Promise<void> {
    try {
      const slugs = await this.fileManager.listProjects();
      const projects = [];
      const canvasRegistry = await this.fileManager.readCanvasRegistry();
      for (const slug of slugs) {
        const project = await this.fileManager.readProject(slug);
        if (project) {
          // Enrich canvas entries with element details
          const rawEntries = canvasRegistry.filter((c) => c.projectSlug === slug);
          const canvasEntries = [];
          for (const entry of rawEntries) {
            const state = await this.fileManager.readCanvasById(entry.id, entry.projectSlug);
            const elements = (state?.elements || []).map((el) => ({
              id: el.id,
              type: el.type,
              name: (el.data.title as string) || (el.data.name as string) || el.type,
              live: !!(state?.refreshBindings?.find((b: { elementId: string; enabled: boolean }) => b.elementId === el.id)?.enabled),
              visible: el.data._hidden !== true,
            }));
            const c2Enabled = !!state?.c2?.enabled;
            const wireCount = c2Enabled ? (state?.c2?.wires ?? []).length : 0;
            canvasEntries.push({ ...entry, elements, c2Enabled, wireCount });
          }
          const files = await this.listProjectFiles(slug);

          // Enrich portfolio-mode projects with summary
          let portfolioSummary: Record<string, unknown> | undefined;
          if (project.mode === "portfolio") {
            const pf = await this.fileManager.readPortfolio(slug);
            if (pf) {
              const navPerUnit = pf.navPerUnit ?? 100;
              portfolioSummary = {
                holdings: pf.holdings.length,
                navPerUnit,
                returnPct: ((navPerUnit - 100) / 100) * 100,
                cash: pf.cash,
                initialCapital: pf.initialCapital,
                benchmark: pf.benchmark,
              };
            }
          }

          projects.push({ ...project, canvasEntries, files, portfolioSummary });
        }
      }
      this.broadcast({ type: "sidebar.projectsChanged", projects });
    } catch (err) {
      this.outputChannel.appendLine(`[companion] Broadcast projects error: ${err}`);
    }
  }

  private async broadcastSidebarCanvases(): Promise<void> {
    try {
      const registry = await this.fileManager.readCanvasRegistry();
      const entries = [];
      for (const entry of registry) {
        const state = await this.fileManager.readCanvasById(entry.id, entry.projectSlug);
        const elements = (state?.elements || []).map((el) => ({
          id: el.id,
          type: el.type,
          name: (el.data.title as string) || (el.data.name as string) || el.type,
          live: !!(state?.refreshBindings?.find((b: { elementId: string; enabled: boolean }) => b.elementId === el.id)?.enabled),
          visible: el.data._hidden !== true,
        }));
        const c2Enabled = !!state?.c2?.enabled;
        const wireCount = c2Enabled ? (state?.c2?.wires ?? []).length : 0;
        entries.push({ ...entry, elements, c2Enabled, wireCount });
      }
      this.broadcast({ type: "sidebar.canvasesChanged", canvases: entries });
    } catch (err) {
      this.outputChannel.appendLine(`[companion] Broadcast canvases error: ${err}`);
    }
  }

  private async broadcastSidebarLists(): Promise<void> {
    try {
      const slugs = await this.fileManager.listLists();
      const lists = [];
      for (const slug of slugs) {
        const list = await this.fileManager.readList(slug);
        if (list) lists.push(await this.enrichListVisibility(list));
      }
      this.broadcast({ type: "sidebar.listsChanged", lists });
    } catch (err) {
      this.outputChannel.appendLine(`[companion] Broadcast lists error: ${err}`);
    }
  }

  /** Enrich a list with its linked canvas element's visibility state. */
  private async enrichListVisibility(list: JETList): Promise<JETList & { _elementHidden?: boolean }> {
    const canvasId = list.canvasId;
    const canvasElementId = list.canvasElementId;
    if (!canvasId || !canvasElementId) return list;

    try {
      const registry = await this.fileManager.readCanvasRegistry();
      const entry = (registry as Array<{ id: string; projectSlug?: string }>).find(
        (c) => c.id === canvasId
      );
      const state = await this.fileManager.readCanvasById(canvasId, entry?.projectSlug ?? null);
      if (state) {
        const el = (state as { elements: Array<{ id: string; data: Record<string, unknown> }> }).elements?.find(
          (e) => e.id === canvasElementId
        );
        return { ...list, _elementHidden: el?.data?._hidden === true };
      }
    } catch { /* non-critical */ }
    return list;
  }

  private async broadcastSidebarRecipes(): Promise<void> {
    try {
      const slugs = await this.fileManager.listRecipes();
      const recipes = [];
      for (const slug of slugs) {
        const recipe = await this.fileManager.readRecipe(slug);
        if (recipe) recipes.push(recipe);
      }
      this.broadcast({ type: "sidebar.recipesChanged", recipes });
    } catch (err) {
      this.outputChannel.appendLine(`[companion] Broadcast recipes error: ${err}`);
    }
  }

  private async broadcastSidebarDatasets(): Promise<void> {
    try {
      const slugs = await this.fileManager.listDatasets();
      const datasets = [];
      for (const slug of slugs) {
        const ds = await this.fileManager.readDataset(slug);
        if (ds) datasets.push(ds);
      }
      this.broadcast({ type: "sidebar.datasetsChanged", datasets });
    } catch (err) {
      this.outputChannel.appendLine(`[companion] Broadcast datasets error: ${err}`);
    }
  }

  private async broadcastSidebarTemplates(): Promise<void> {
    try {
      const templates: Array<{ name: string; description: string; source: string }> = [];

      // Bundled starter templates
      const bundledDir = path.join(this.extensionPath, "agent", "templates");
      try {
        const files = fs.readdirSync(bundledDir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          try {
            const tpl = JSON.parse(fs.readFileSync(path.join(bundledDir, file), "utf-8"));
            if (tpl.name) {
              templates.push({ name: tpl.name, description: tpl.description || "", source: "starter" });
            }
          } catch { /* skip malformed */ }
        }
      } catch { /* no bundled dir */ }

      // Local user templates
      try {
        const slugs = await this.fileManager.listTemplates();
        for (const slug of slugs) {
          const displayName = slug.replace(/_/g, " ");
          if (!templates.some((t) => t.name.toLowerCase() === displayName.toLowerCase())) {
            templates.push({ name: displayName, description: "", source: "local" });
          }
        }
      } catch { /* no local templates */ }

      this.broadcast({ type: "sidebar.templatesChanged", templates });
    } catch (err) {
      this.outputChannel.appendLine(`[companion] Broadcast templates error: ${err}`);
    }
  }

  private async apiUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Simple file upload — save to .jetro/uploads/
    const contentType = req.headers["content-type"] || "";

    if (!contentType.includes("multipart/form-data")) {
      return this.json(res, 400, { error: "Expected multipart/form-data" });
    }

    // Parse boundary
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return this.json(res, 400, { error: "Missing boundary" });

    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = Buffer.concat(chunks);
        const boundary = boundaryMatch[1];
        const { fileName, fileData } = this.parseMultipart(body, boundary);

        if (!fileName || !fileData) {
          return this.json(res, 400, { error: "No file found in upload" });
        }

        // Save to .jetro/uploads/
        const uploadsDir = path.join(this.workspacePath, ".jetro", "uploads");
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
        const dest = path.join(uploadsDir, safeName);
        fs.writeFileSync(dest, fileData);

        this.json(res, 200, { path: `.jetro/uploads/${safeName}` });
      } catch (err) {
        this.json(res, 500, { error: `Upload failed: ${err}` });
      }
    });
  }

  // ══════════════════════════════════════════
  // Static File Serving (companion app)
  // ══════════════════════════════════════════

  private serveStatic(pathname: string, _req: http.IncomingMessage, res: http.ServerResponse): void {
    let filePath = path.join(this.staticDir, pathname === "/" ? "index.html" : pathname);

    // Security: prevent path traversal
    const relative = path.relative(this.staticDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    // If file doesn't exist, serve index.html (SPA fallback)
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(this.staticDir, "index.html");
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Companion app not built. Run 'npm run build' in companion/");
      return;
    }

    const mime = this.getMimeType(filePath);
    const stat = fs.statSync(filePath);

    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "Cache-Control": pathname.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  }

  // ══════════════════════════════════════════
  // Workspace File Serving
  // ══════════════════════════════════════════

  private serveWorkspaceFile(relativePath: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const decoded = decodeURIComponent(relativePath);
    const resolved = path.resolve(this.workspacePath, decoded);
    const rel = path.relative(this.workspacePath, resolved);

    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: path traversal");
      return;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(resolved);
      if (stats.isDirectory()) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: directory listing");
        return;
      }
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const mime = this.getMimeType(resolved);
    const total = stats.size;
    const rangeHeader = req.headers.range;

    try {
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (!match) {
          res.writeHead(416, { "Content-Range": `bytes */${total}` });
          res.end();
          return;
        }
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : total - 1;
        if (start >= total || end >= total || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${total}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(resolved, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": total,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(resolved).pipe(res);
      }
    } catch (err) {
      this.outputChannel.appendLine(`[companion] File error: ${err}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }

  /** GET /api/vendor/* — serve bundled 3D libraries (CesiumJS, Three.js). */
  private serveVendorFile(relativePath: string, _req: http.IncomingMessage, res: http.ServerResponse): void {
    const decoded = decodeURIComponent(relativePath);
    const vendorRoot = path.join(this.extensionPath, "webview", "vendor");
    const resolved = path.resolve(vendorRoot, decoded);
    const rel = path.relative(vendorRoot, resolved);

    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    try {
      const stats = fs.statSync(resolved);
      if (stats.isDirectory()) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      const mime = this.getMimeType(resolved);
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": stats.size,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      fs.createReadStream(resolved).pipe(res);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  }

  // ══════════════════════════════════════════
  // WebSocket handlers (using `ws` library)
  // ══════════════════════════════════════════

  private handleMainWSConnection(ws: WebSocket): void {
    const clientId = `ws-${++this.clientIdCounter}`;
    const client: WSClient = {
      id: clientId,
      ws,
      alive: true,
      send: (data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      },
      close: () => {
        try { ws.close(); } catch { /* already closed */ }
      },
    };

    this.clients.push(client);
    this.outputChannel.appendLine(`[companion] WS client connected: ${clientId} (total: ${this.clients.length})`);

    // Send connection status
    client.send(JSON.stringify({ type: "connection.status", connected: true }));

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleWSMessage(clientId, msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("pong", () => {
      client.alive = true;
    });

    ws.on("close", () => {
      this.removeClient(clientId);
    });

    ws.on("error", (err) => {
      this.outputChannel.appendLine(`[companion] WS ${clientId}: error: ${err.message}`);
      this.removeClient(clientId);
    });
  }

  private handleWSMessage(clientId: string, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "canvas.stateUpdate":
        if (msg.canvasId && msg.state) {
          this.fileManager.readCanvasRegistry().then(async (registry) => {
            const entry = registry.find((c) => c.id === msg.canvasId);
            const existing = await this.fileManager.readCanvasById(
              msg.canvasId as string,
              entry?.projectSlug ?? null,
            );
            if (existing) {
              const merged = { ...existing, ...(msg.state as Record<string, unknown>) };
              this.markCompanionWrite(msg.canvasId as string);
              await this.fileManager.writeCanvasById(
                msg.canvasId as string,
                merged as never,
                entry?.projectSlug ?? null,
              );
            }
          }).catch((err) => {
            this.outputChannel.appendLine(`[companion] Canvas save error: ${err}`);
          });
        }
        break;

      case "canvas.openCanvas":
        if (msg.canvasId) {
          this.sendCanvasState(clientId, msg.canvasId as string);
        }
        break;

      case "canvas.toggleBinding":
        if (msg.canvasId && msg.elementId) {
          this.fileManager.readCanvasRegistry().then(async (registry) => {
            const entry = registry.find((c) => c.id === msg.canvasId);
            const state = await this.fileManager.readCanvasById(
              msg.canvasId as string,
              entry?.projectSlug ?? null,
            );
            if (state && state.refreshBindings) {
              const binding = state.refreshBindings.find(
                (b: { elementId: string }) => b.elementId === msg.elementId,
              );
              if (binding) {
                binding.enabled = !binding.enabled;
                this.markCompanionWrite(msg.canvasId as string);
                await this.fileManager.writeCanvasById(
                  msg.canvasId as string,
                  state as never,
                  entry?.projectSlug ?? null,
                );
                this.sendCanvasState(clientId, msg.canvasId as string);
              }
            }
          }).catch((err) => {
            this.outputChannel.appendLine(`[companion] Toggle binding error: ${err}`);
          });
        }
        break;

      case "canvas.setActive":
        if (msg.canvasId) {
          this.onCompanionCanvasChanged?.(msg.canvasId as string);
        }
        break;

      case "canvas.toggleC2":
        if (msg.canvasId) {
          this.fileManager.readCanvasRegistry().then(async (registry) => {
            const entry = registry.find((c) => c.id === msg.canvasId);
            if (!entry?.projectSlug) return; // C2 only on project canvases
            const state = await this.fileManager.readCanvasById(
              msg.canvasId as string,
              entry.projectSlug,
            );
            if (!state) return;
            if (state.c2?.enabled) {
              // Disable — preserve wires/ports for re-enable
              state.c2.enabled = false;
            } else {
              // Enable — initialise C2 state
              state.c2 = {
                enabled: true,
                layout: state.c2?.layout ?? "freeform",
                theme: state.c2?.theme ?? "dark",
                framePorts: state.c2?.framePorts ?? {},
                wires: state.c2?.wires ?? [],
              };
            }
            this.markCompanionWrite(msg.canvasId as string);
            await this.fileManager.writeCanvasById(
              msg.canvasId as string,
              state as never,
              entry.projectSlug,
            );
            this.broadcast({
              type: "canvas.c2Changed",
              canvasId: msg.canvasId,
              enabled: !!state.c2.enabled,
              c2: state.c2,
            });
          }).catch((err) => {
            this.outputChannel.appendLine(`[companion] Toggle C2 error: ${err}`);
          });
        }
        break;

      case "canvas.addWire":
        if (msg.canvasId && msg.wire) {
          this.fileManager.readCanvasRegistry().then(async (registry) => {
            const entry = registry.find((c) => c.id === msg.canvasId);
            if (!entry?.projectSlug) return;
            const state = await this.fileManager.readCanvasById(
              msg.canvasId as string,
              entry.projectSlug,
            );
            if (!state?.c2) return;
            const wire = msg.wire as { id: string; sourceId: string; targetId: string; channel: string; bidirectional?: boolean };
            if (!state.c2.wires) state.c2.wires = [];
            state.c2.wires.push(wire);
            if (!state.edges) state.edges = [];
            state.edges.push({
              id: wire.id,
              source: wire.sourceId,
              target: wire.targetId,
              type: "wire",
              data: { channel: wire.channel, bidirectional: !!wire.bidirectional, label: wire.channel },
            });
            this.markCompanionWrite(msg.canvasId as string);
            await this.fileManager.writeCanvasById(msg.canvasId as string, state as never, entry.projectSlug);
            this.broadcast({ type: "canvas.c2Changed", canvasId: msg.canvasId, enabled: true, c2: state.c2 });
          }).catch((err) => {
            this.outputChannel.appendLine(`[companion] Add wire error: ${err}`);
          });
        }
        break;

      case "canvas.removeWire":
        if (msg.canvasId && msg.wireId) {
          this.fileManager.readCanvasRegistry().then(async (registry) => {
            const entry = registry.find((c) => c.id === msg.canvasId);
            if (!entry?.projectSlug) return;
            const state = await this.fileManager.readCanvasById(msg.canvasId as string, entry.projectSlug);
            if (!state?.c2) return;
            const wireId = msg.wireId as string;
            if (state.c2.wires) {
              state.c2.wires = state.c2.wires.filter((w: { id: string }) => w.id !== wireId);
            }
            if (state.edges) {
              state.edges = state.edges.filter((e: { id: string }) => e.id !== wireId);
            }
            this.markCompanionWrite(msg.canvasId as string);
            await this.fileManager.writeCanvasById(msg.canvasId as string, state as never, entry.projectSlug);
            this.broadcast({ type: "canvas.c2Changed", canvasId: msg.canvasId, enabled: !!state.c2.enabled, c2: state.c2 });
          }).catch((err) => {
            this.outputChannel.appendLine(`[companion] Remove wire error: ${err}`);
          });
        }
        break;

      case "canvas.selectElement":
        break;

      default:
        break;
    }
  }

  private async sendCanvasState(clientId: string, canvasId: string): Promise<void> {
    try {
      const registry = await this.fileManager.readCanvasRegistry();
      const entry = registry.find((c) => c.id === canvasId);
      const state = await this.fileManager.readCanvasById(canvasId, entry?.projectSlug ?? null);
      if (state) {
        this.sendTo(clientId, { type: "canvas.setState", canvasId, state });
      }
    } catch (err) {
      this.outputChannel.appendLine(`[companion] Failed to send canvas state: ${err}`);
    }
  }

  // ── Terminal WebSocket ──

  private handleTerminalWSConnection(ws: WebSocket): void {
    if (!this.ptyManager) {
      this.outputChannel.appendLine("[companion] Terminal WS rejected: no PtyManager");
      ws.close();
      return;
    }

    const session = this.ptyManager.getOrCreateSession();
    if (!session) {
      this.outputChannel.appendLine("[companion] Terminal WS rejected: pty-server failed to start");
      ws.close();
      return;
    }

    this.ptyManager.attachClient(ws);
    this.outputChannel.appendLine("[companion] Terminal WS client connected");

    ws.on("message", (data) => {
      const text = data.toString();

      // Check if it's a resize message
      if (text.startsWith("{")) {
        try {
          const msg = JSON.parse(text);
          if (msg.type === "resize" && msg.cols && msg.rows) {
            this.ptyManager!.resize(msg.cols, msg.rows);
            return;
          }
        } catch {
          // Not JSON — treat as terminal input
        }
      }

      // Regular terminal input
      this.ptyManager!.write(text);
    });

    ws.on("close", () => {
      this.outputChannel.appendLine("[companion] Terminal WS: closed");
      this.ptyManager!.detachClient(ws);
    });

    ws.on("error", (err) => {
      this.outputChannel.appendLine(`[companion] Terminal WS: error: ${err.message}`);
      this.ptyManager!.detachClient(ws);
    });
  }

  private heartbeat(): void {
    for (const client of [...this.clients]) {
      if (!client.alive) {
        this.removeClient(client.id);
        continue;
      }
      client.alive = false;
      try { client.ws.ping(); } catch { this.removeClient(client.id); }
    }
  }

  private removeClient(clientId: string): void {
    const idx = this.clients.findIndex((c) => c.id === clientId);
    if (idx >= 0) {
      const client = this.clients[idx];
      this.clients.splice(idx, 1);
      try { client.ws.terminate(); } catch { /* ignore */ }
      this.outputChannel.appendLine(`[companion] WS client disconnected: ${clientId} (total: ${this.clients.length})`);
    }
  }

  // ══════════════════════════════════════════
  // Utility
  // ══════════════════════════════════════════

  private json(res: http.ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  private async readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve({});
        }
      });
    });
  }

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const types: Record<string, string> = {
      ".json": "application/json", ".csv": "text/csv",
      ".txt": "text/plain", ".md": "text/markdown", ".xml": "application/xml",
      ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
      ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm",
      ".pdf": "application/pdf",
      ".wasm": "application/wasm",
      ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
      ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
    };
    return types[ext] || "application/octet-stream";
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  private parseMultipart(body: Buffer, boundary: string): { fileName: string | null; fileData: Buffer | null } {
    const boundaryBuf = Buffer.from(`--${boundary}`);
    const parts = [];
    let start = body.indexOf(boundaryBuf);

    while (start !== -1) {
      const nextStart = body.indexOf(boundaryBuf, start + boundaryBuf.length);
      if (nextStart === -1) break;
      parts.push(body.slice(start + boundaryBuf.length, nextStart));
      start = nextStart;
    }

    for (const part of parts) {
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) continue;

      const headers = part.slice(0, headerEnd).toString("utf8");
      const fileNameMatch = headers.match(/filename="([^"]+)"/);
      if (fileNameMatch) {
        // Skip the \r\n\r\n and trailing \r\n
        let data = part.slice(headerEnd + 4);
        if (data[data.length - 2] === 0x0D && data[data.length - 1] === 0x0A) {
          data = data.slice(0, data.length - 2);
        }
        return { fileName: fileNameMatch[1], fileData: data };
      }
    }

    return { fileName: null, fileData: null };
  }

  private async listProjectFiles(slug: string): Promise<{ name: string; type: string; size?: number; dir: string }[]> {
    const projectDir = path.join(this.workspacePath, "projects", slug);
    const files: { name: string; type: string; size?: number; dir: string }[] = [];
    const subdirs = ["sources", "notes", "output", ""];

    for (const dir of subdirs) {
      try {
        const dirPath = dir ? path.join(projectDir, dir) : projectDir;
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name !== "project.json") {
            const ext = path.extname(entry.name).toLowerCase();
            const stat = fs.statSync(path.join(dirPath, entry.name));
            files.push({ name: entry.name, type: ext.replace(".", ""), size: stat.size, dir: dir || "root" });
          }
        }
      } catch { /* directory may not exist */ }
    }

    return files;
  }
}
