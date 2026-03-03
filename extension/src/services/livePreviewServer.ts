/**
 * LivePreviewServer — local HTTP + SSE server for "Open in Browser" live preview.
 *
 * Routes:
 *   GET /frame/:elementId   → serves element HTML with injected SSE client
 *   GET /sse/:elementId     → SSE stream for live data pushes
 *   GET /files/*            → serves workspace files for iframe asset access
 *
 * Lifecycle:
 *   - Started on first "Open in Browser" request
 *   - Auto-shuts down after 5 minutes with zero SSE connections
 *   - Port is OS-assigned (port 0) and written to .jetro/live-server.json
 */

import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";

interface SSEClient {
  res: http.ServerResponse;
  elementId: string;
}

export class LivePreviewServer {
  private server: http.Server | null = null;
  private port = 0;
  private clients: SSEClient[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private elementHtml = new Map<string, string>();

  /** Idle timeout before auto-shutdown (5 minutes) */
  private static IDLE_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(
    private workspacePath: string,
    private outputChannel: vscode.OutputChannel,
    private onServerStart?: (port: number) => void,
    private onServerStop?: () => void,
    private extensionPath?: string,
  ) {}

  /** Whether the server is currently running. */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Get the port the server is listening on (0 if not running). */
  getPort(): number {
    return this.port;
  }

  /** Get the base URL for workspace file serving. Returns empty string if server not running. */
  getFileUrlBase(): string {
    if (!this.isRunning()) return "";
    return `http://127.0.0.1:${this.port}/files`;
  }

  /** Set or update the HTML content for an element (used before opening). */
  setElementHtml(elementId: string, html: string): void {
    this.elementHtml.set(elementId, html);
  }

  /** Start the HTTP server (idempotent). Returns the port. */
  async start(): Promise<number> {
    if (this.isRunning()) return this.port;

    return new Promise<number>((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;

        // Write port to disk so MCP server / other tools can discover it
        this.writePortFile();

        this.outputChannel.appendLine(`[live-server] Listening on http://127.0.0.1:${this.port}`);
        this.onServerStart?.(this.port);
        this.resetIdleTimer();
        resolve(this.port);
      });

      this.server.on("error", (err) => {
        this.outputChannel.appendLine(`[live-server] Server error: ${err.message}`);
        reject(err);
      });
    });
  }

  /** Push updated data to all SSE clients for a given element. */
  pushData(elementId: string, data: unknown): void {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (client.elementId === elementId) {
        try {
          client.res.write(payload);
        } catch {
          // Client disconnected — will be cleaned up
        }
      }
    }
  }

  /** Stop the server and clean up. */
  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const client of this.clients) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.clients = [];

    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
    }

    this.removePortFile();
    this.outputChannel.appendLine("[live-server] Stopped");
    this.onServerStop?.();
  }

  dispose(): void {
    this.stop();
  }

  // ── Request handler ──

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
    const segments = url.pathname.split("/").filter(Boolean);

    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (segments[0] === "api" && segments[1] === "store" && segments[2]) {
      if (req.method === "GET") {
        this.handleStoreGet(segments[2], res);
      } else if (req.method === "POST") {
        this.handleStoreSet(segments[2], req, res);
      } else {
        res.writeHead(405).end();
      }
      return;
    }

    if (segments[0] === "api" && segments[1] === "query" && req.method === "POST") {
      this.handleQuery(req, res);
      return;
    }

    if (segments[0] === "frame" && segments[1]) {
      this.handleFrame(segments[1], res);
    } else if (segments[0] === "sse" && segments[1]) {
      this.handleSSE(segments[1], req, res);
    } else if (segments[0] === "vendor" && segments.length > 1) {
      this.handleVendorFile(segments.slice(1).join("/"), req, res);
    } else if (segments[0] === "files" && segments.length > 1) {
      this.handleWorkspaceFile(segments.slice(1).join("/"), req, res);
    } else {
      // Fallback: try serving as workspace file (handles relative paths from frame HTML)
      const tryPath = segments.join("/");
      if (tryPath) {
        this.handleWorkspaceFile(tryPath, req, res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    }
  }

  /** GET /frame/:elementId — serve HTML with injected SSE client script. */
  private handleFrame(elementId: string, res: http.ServerResponse): void {
    const html = this.elementHtml.get(elementId) || "<p>Element not loaded</p>";

    // Inject SSE client script before </body> (or at end)
    const sseScript = `
<script>
(function() {
  var es = new EventSource('/sse/${elementId}');
  es.onmessage = function(e) {
    try {
      var data = JSON.parse(e.data);
      // Dispatch CustomEvent directly — agent HTML listens for this
      window.dispatchEvent(new CustomEvent('jet:refresh', { detail: data }));
      // Also postMessage for any code using the message-based pattern
      window.postMessage({ type: 'jet:refresh', payload: data }, '*');
    } catch(err) {
      console.error('[jet-live] Parse error:', err);
    }
  };
  es.onerror = function() {
    console.warn('[jet-live] SSE disconnected, will retry...');
  };
})();
</script>`;

    const injected = html.includes("</body>")
      ? html.replace("</body>", sseScript + "\n</body>")
      : html + sseScript;

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(injected);
  }

  /** GET /sse/:elementId — SSE stream. */
  private handleSSE(elementId: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(":ok\n\n");

    const client: SSEClient = { res, elementId };
    this.clients.push(client);
    this.resetIdleTimer();

    this.outputChannel.appendLine(
      `[live-server] SSE client connected for ${elementId} (total: ${this.clients.length})`
    );

    req.on("close", () => {
      this.clients = this.clients.filter((c) => c !== client);
      this.outputChannel.appendLine(
        `[live-server] SSE client disconnected for ${elementId} (total: ${this.clients.length})`
      );
      this.resetIdleTimer();
    });
  }

  /** GET /files/* — serve workspace files for iframe access (supports Range requests for media). */
  private handleWorkspaceFile(relativePath: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const decoded = decodeURIComponent(relativePath);
    const resolved = path.resolve(this.workspacePath, decoded);
    const rel = path.relative(this.workspacePath, resolved);

    // Block path traversal (../) and absolute paths
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
        // Parse Range header (e.g. "bytes=0-1023")
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
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(resolved, { start, end }).pipe(res);
      } else {
        // No Range — stream full file with Accept-Ranges hint
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": total,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(resolved).pipe(res);
      }
    } catch (err) {
      this.outputChannel.appendLine(`[live-server] File read error: ${err}`);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }

  /** GET /vendor/* — serve bundled 3D libraries (CesiumJS, Three.js). */
  private handleVendorFile(relativePath: string, _req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.extensionPath) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Extension path not available");
      return;
    }
    const decoded = decodeURIComponent(relativePath);
    const vendorRoot = path.join(this.extensionPath, "webview", "vendor");
    const resolved = path.resolve(vendorRoot, decoded);
    const rel = path.relative(vendorRoot, resolved);

    // Block path traversal
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

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const types: Record<string, string> = {
      ".json": "application/json", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
      ".txt": "text/plain", ".md": "text/markdown", ".xml": "application/xml",
      ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
      ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
      ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
      ".pdf": "application/pdf",
      ".wasm": "application/wasm",
      ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
      ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
    };
    return types[ext] || "application/octet-stream";
  }

  // ── Idle shutdown ──

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);

    if (this.clients.length === 0 && this.isRunning()) {
      this.idleTimer = setTimeout(() => {
        this.outputChannel.appendLine("[live-server] No clients for 5 min — shutting down");
        this.stop();
      }, LivePreviewServer.IDLE_TIMEOUT_MS);
    }
  }

  // ── Port file ──

  private writePortFile(): void {
    try {
      const dir = path.join(this.workspacePath, ".jetro");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "live-server.json"),
        JSON.stringify({ port: this.port, pid: process.pid }, null, 2)
      );
    } catch { /* best effort */ }
  }

  private removePortFile(): void {
    try {
      fs.unlinkSync(path.join(this.workspacePath, ".jetro", "live-server.json"));
    } catch { /* already gone */ }
  }

  // ── Storage bridge ──

  private handleStoreGet(key: string, res: http.ServerResponse): void {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeKey) { res.writeHead(400).end("Invalid key"); return; }
    const filePath = path.join(this.workspacePath, ".jetro", "app-store", `${safeKey}.json`);
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("null");
      }
    } catch {
      res.writeHead(500).end("Read error");
    }
  }

  private handleStoreSet(key: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeKey) { res.writeHead(400).end("Invalid key"); return; }
    const dir = path.join(this.workspacePath, ".jetro", "app-store");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        if (body.length > 1024 * 1024) { res.writeHead(413).end("Too large"); return; }
        fs.writeFileSync(path.join(dir, `${safeKey}.json`), body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(500).end("Write error");
      }
    });
  }

  private handleQuery(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        const sql = body.sql;
        if (!sql || typeof sql !== "string") { res.writeHead(400).end('{"error":"Missing sql"}'); return; }
        // Use @duckdb/node-api open-per-call pattern (same as DuckDBService)
        const { DuckDBInstance } = await import("@duckdb/node-api");
        const dbPath = path.join(this.workspacePath, ".jetro", "cache.duckdb");
        const instance = await DuckDBInstance.create(dbPath);
        const conn = await instance.connect();
        try {
          const reader = await conn.runAndReadAll(sql);
          const rows = reader.getRowObjectsJS();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rows));
        } finally {
          conn.closeSync();
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  }
}
