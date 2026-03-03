import * as fs from "fs";
import * as path from "path";

interface ShareCacheEntry {
  id: string;
  elements: { id: string; canvasId: string; status: string; isLive: boolean }[];
  status: string;
}

// Fields that must never appear in shared snapshot data
const SNAPSHOT_DENY = new Set([
  "html", "framePath", "scriptPath", "refreshBinding",
  "listSlug", "canvasElementId", "JET_JWT", "JET_API_URL", "JET_WORKSPACE",
]);

/**
 * Re-bundles frames and uploads to backend when running in daemon mode.
 * Mirrors ShareManager.onElementRefreshed() but without VS Code APIs.
 */
export class ShareUploader {
  private lastUploadMap = new Map<string, number>();
  private static readonly DEBOUNCE_MS = 5 * 60 * 1000;
  private shareCache: ShareCacheEntry[] = [];
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private workspace: string,
    private apiUrl: string,
    private jwt: string
  ) {}

  async start(): Promise<void> {
    await this.syncShareIndex();
    // Sync every 30 minutes
    this.syncTimer = setInterval(() => this.syncShareIndex(), 30 * 60 * 1000);
  }

  shutdown(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async reUpload(canvasId: string, elementId: string): Promise<void> {
    // Check debounce — set timestamp BEFORE upload to prevent concurrent uploads
    const lastUpload = this.lastUploadMap.get(elementId) || 0;
    if (Date.now() - lastUpload < ShareUploader.DEBOUNCE_MS) {
      return;
    }

    // Find shares containing this element
    const shareIds = this.findSharesForElement(elementId);
    if (shareIds.length === 0) return;

    // Set debounce timestamp before upload (prevents race condition)
    this.lastUploadMap.set(elementId, Date.now());

    // Read frame HTML
    const html = await this.readAndBundleFrame(canvasId, elementId);
    if (!html) return;

    for (const shareId of shareIds) {
      try {
        const res = await fetch(`${this.apiUrl}/api/share/${shareId}/element/${elementId}`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${this.jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ html }),
        });
        if (res.ok) {
          console.log(`[daemon] Re-uploaded ${elementId} to share ${shareId}`);
        } else {
          console.error(`[daemon] Upload failed for ${elementId}: ${res.status}`);
        }
      } catch (err) {
        console.error(`[daemon] Upload error for ${elementId}: ${err}`);
      }
    }
  }

  /** Sync share index from backend. */
  async syncShareIndex(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/api/share/list`, {
        headers: { Authorization: `Bearer ${this.jwt}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { shares: ShareCacheEntry[] };

      // For each share, fetch full details to get element info
      const cache: ShareCacheEntry[] = [];
      for (const entry of data.shares) {
        try {
          const detailRes = await fetch(`${this.apiUrl}/api/share/${entry.id}`, {
            headers: { Authorization: `Bearer ${this.jwt}` },
          });
          if (detailRes.ok) {
            const detail = (await detailRes.json()) as { share: ShareCacheEntry };
            // Only cache the fields we need — strip ownerId, hmacToken, kvKey
            const safe = detail.share;
            cache.push({
              id: safe.id,
              elements: (safe.elements || []).map((e) => ({
                id: e.id,
                canvasId: e.canvasId,
                status: e.status,
                isLive: e.isLive,
              })),
              status: safe.status,
            });
          }
        } catch { /* skip */ }
      }

      this.shareCache = cache;

      // Write cache to disk for persistence
      const cachePath = path.join(this.workspace, ".jetro", "shares-cache.json");
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
      console.log(`[daemon] Synced ${cache.length} shares to cache`);
    } catch (err) {
      console.error(`[daemon] Share sync failed: ${err}`);
      // Try to load from disk cache
      const cachePath = path.join(this.workspace, ".jetro", "shares-cache.json");
      if (fs.existsSync(cachePath)) {
        try {
          this.shareCache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        } catch { /* corrupt cache */ }
      }
    }
  }

  private findSharesForElement(elementId: string): string[] {
    const result: string[] = [];
    for (const share of this.shareCache) {
      if (share.status !== "active") continue;
      const elem = share.elements?.find(
        (e) => e.id === elementId && e.status === "active"
      );
      if (elem) result.push(share.id);
    }
    return result;
  }

  /** Sanitize a path segment to prevent directory traversal. */
  private sanitizeSegment(seg: string): string {
    return seg.replace(/[^a-zA-Z0-9_\-]/g, "_");
  }

  private async readAndBundleFrame(
    canvasId: string,
    elementId: string
  ): Promise<string | null> {
    // Read canvas state from disk
    const registryPath = path.join(this.workspace, ".jetro", "canvas-registry.json");
    if (!fs.existsSync(registryPath)) return null;

    const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
      id: string;
      projectSlug?: string;
    }[];
    const entry = registry.find((e) => e.id === canvasId);
    if (!entry) return null;

    // Sanitize path segments to prevent traversal
    const safeId = this.sanitizeSegment(canvasId);
    const canvasPath = entry.projectSlug
      ? path.join(this.workspace, "projects", this.sanitizeSegment(entry.projectSlug), "canvases", `${safeId}.json`)
      : path.join(this.workspace, ".jetro", "canvases", `${safeId}.json`);

    // Verify resolved path is within workspace
    const resolvedCanvas = path.resolve(canvasPath);
    if (!resolvedCanvas.startsWith(this.workspace + path.sep)) return null;

    if (!fs.existsSync(canvasPath)) return null;

    const canvasState = JSON.parse(fs.readFileSync(canvasPath, "utf-8"));
    const elem = canvasState.elements?.find(
      (e: { id: string }) => e.id === elementId
    );
    if (!elem) return null;

    // Read frame HTML
    const data = elem.data || {};
    let frameHtml: string | null = null;

    if (typeof data.html === "string" && data.html.length > 0) {
      frameHtml = data.html;
    } else if (typeof data.framePath === "string") {
      const framePath = path.resolve(this.workspace, data.framePath);
      // Security: verify frame path is within workspace
      if (!framePath.startsWith(this.workspace + path.sep)) {
        console.error(`[daemon] Path traversal blocked for framePath: ${data.framePath}`);
        return null;
      }
      if (fs.existsSync(framePath)) {
        frameHtml = fs.readFileSync(framePath, "utf-8");
      }
    }

    if (!frameHtml) return null;

    // Sanitize HTML — strip blob URLs, __JET.query calls, workspace paths
    frameHtml = frameHtml.replace(
      /blob:[^"'\s]+plotly[^"'\s]*/gi,
      "https://cdn.plot.ly/plotly-2.35.2.min.js"
    );
    // Aggressive __JET.query stripping (multiple patterns)
    frameHtml = frameHtml.replace(/__JET\.query\b/g, "/* JET_REMOVED */");
    frameHtml = frameHtml.replace(/__JET\s*\[\s*["']query["']\s*\]/g, "/* JET_REMOVED */");
    frameHtml = frameHtml.replace(/window\.__JET\.query\b/g, "/* JET_REMOVED */");
    // Strip workspace paths
    if (this.workspace) {
      frameHtml = frameHtml.split(this.workspace).join(".");
    }

    // Branding defaults (design tokens removed — templates are self-contained)
    const firmName = "Jetro";
    const primaryColor = "#DEBFCA";
    const accentColor = "#007ACC";
    const fontHeading = "system-ui";
    const fontBody = "system-ui";

    const title = elem.data?.title || "Untitled";

    // Build safe snapshot — filter to allowlisted fields only
    const safeSnapshot = data.lastRefreshed
      ? sanitizeSnapshot(data, this.workspace)
      : null;
    const snapshotScript = safeSnapshot
      ? `<script>window.__JET_SNAPSHOT = ${safeJsonForScript(safeSnapshot)};</script>`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — ${escapeHtml(firmName)}</title>
  <style>
    :root {
      --jet-primary: ${primaryColor};
      --jet-accent: ${accentColor};
      --jet-bg: #1e1e1e;
      --jet-surface: #252526;
      --jet-text: #cccccc;
      --jet-text-bright: #e0e0e0;
      --jet-font-heading: ${fontHeading}, system-ui, sans-serif;
      --jet-font-body: ${fontBody}, system-ui, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; background: var(--jet-bg); color: var(--jet-text); font-family: var(--jet-font-body); }
    #jet-frame-content { width: 100%; min-height: 100vh; }
  </style>
</head>
<body>
  ${snapshotScript}
  <div id="jet-frame-content">${frameHtml}</div>
  <script>
    if (window.__JET_SNAPSHOT) {
      window.dispatchEvent(new CustomEvent('jet:refresh', { detail: window.__JET_SNAPSHOT }));
    }
  </script>
</body>
</html>`;
  }
}

/** Strip characters that could escape CSS context. */
function sanitizeCss(val: string): string {
  return val.replace(/[;{}@\\]|url\s*\(|import/gi, "").slice(0, 60);
}

/** Filter snapshot data to safe fields only. */
function sanitizeSnapshot(
  data: Record<string, unknown>,
  workspace: string
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  let hasFields = false;

  for (const [key, value] of Object.entries(data)) {
    if (SNAPSHOT_DENY.has(key)) continue;
    if (typeof value === "string" && value.startsWith("/") && value.includes("/.")) continue;
    if (typeof value === "string" && workspace && value.includes(workspace)) {
      result[key] = value.split(workspace).join(".");
    } else {
      result[key] = value;
    }
    hasFields = true;
  }

  return hasFields ? result : null;
}

/** Serialize JSON safe for embedding in <script> tags. */
function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(/<\/(script)/gi, "<\\/$1");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
