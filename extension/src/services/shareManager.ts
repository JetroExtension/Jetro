import * as vscode from "vscode";
import { CanvasProvider } from "../canvas/CanvasProvider";
import { FrameBundler } from "./frameBundler";
import { AuthService } from "./authService";
import { FileManager } from "./fileManager";
import { Share, ShareIndexEntry, ShareBranding } from "../types";

const DEFAULT_API_URL = "http://localhost:8787";
const API_TIMEOUT_MS = 15_000;

export class ShareManager {
  /** In-memory cache of share index, refreshed on listShares(). */
  private indexCache: ShareIndexEntry[] = [];

  /** Full share details cache: shareId → Share */
  private shareDetailsCache = new Map<string, Share>();

  /** Debounce map: elementId → last upload timestamp (ms). */
  private lastUploadMap = new Map<string, number>();

  private baseUrl: string;

  constructor(
    private canvasProvider: CanvasProvider,
    private bundler: FrameBundler,
    private auth: AuthService,
    private fileManager: FileManager,
    private outputChannel: vscode.OutputChannel
  ) {
    const config = vscode.workspace.getConfiguration("jetro");
    this.baseUrl = config.get<string>("apiUrl") || DEFAULT_API_URL;
  }

  // ── Share CRUD ──

  async createShare(params: {
    title: string;
    canvasId: string;
    elementIds: string[];
  }): Promise<{ shareId: string; url: string }> {
    const canvasState = await this.canvasProvider.getState(params.canvasId);
    if (!canvasState) {
      throw new Error("Canvas not found");
    }

    const branding = this.bundler.extractBranding(null);

    const elements: { id: string; canvasId: string; title: string; html: string; isLive: boolean }[] = [];

    for (const elemId of params.elementIds) {
      const elem = canvasState.elements.find((e) => e.id === elemId);
      if (!elem) {
        throw new Error(`Element ${elemId} not found in canvas`);
      }

      const rawHtml = await this.bundler.readFrameHtml(elem.data || {});
      if (!rawHtml) {
        throw new Error(`No frame HTML found for element "${(elem.data?.title as string) || elemId}"`);
      }

      const elemTitle = (elem.data?.title as string) || "Untitled";

      // Get snapshot data if available (last refresh data)
      const snapshotData = elem.data?.lastRefreshed
        ? (elem.data as unknown as Record<string, unknown>)
        : undefined;

      const bundledHtml = await this.bundler.bundle(
        rawHtml,
        elemTitle,
        null,
        snapshotData
      );

      // Check the canvas-level refreshBindings array (bindings are NOT stored in elem.data)
      const binding = canvasState.refreshBindings?.find(
        (b) => b.elementId === elemId && b.enabled
      );

      elements.push({
        id: elem.id,
        canvasId: params.canvasId,
        title: elemTitle,
        html: bundledHtml,
        isLive: !!binding,
      });
    }

    const result = await this.apiCall<{ shareId: string; url: string; hmacToken: string }>(
      "POST",
      "/api/share",
      { title: params.title, elements, branding }
    );

    this.outputChannel.appendLine(`[share] Created share "${params.title}" → ${result.url}`);

    // Refresh index cache and populate details cache so live re-uploads work immediately
    await this.listShares();
    await this.getShare(result.shareId);

    return { shareId: result.shareId, url: result.url };
  }

  /**
   * Adaptive debounce based on binding interval:
   *   interval < 1 min  → debounce 60s
   *   interval 1–5 min  → debounce 5 min
   *   interval > 5 min  → match the binding interval
   */
  private getDebounceMs(intervalMs: number | undefined): number {
    if (!intervalMs || intervalMs < 60_000) return 60_000;
    if (intervalMs <= 300_000) return 300_000;
    return intervalMs;
  }

  /**
   * Called after a refresh binding fires and element data is updated.
   * Re-bundles and re-uploads element HTML. Debounce adapts to binding frequency.
   */
  async onElementRefreshed(canvasId: string, elementId: string): Promise<void> {
    // Find shares containing this element (early exit if not shared)
    const shareIds = this.findSharesForElement(elementId);
    if (shareIds.length === 0) return;

    const canvasState = await this.canvasProvider.getState(canvasId);
    if (!canvasState) return;

    // Look up the binding to get its interval for adaptive debounce
    const binding = canvasState.refreshBindings?.find((b) => b.elementId === elementId);
    const debounceMs = this.getDebounceMs(binding?.intervalMs);

    // Check debounce
    const lastUpload = this.lastUploadMap.get(elementId) || 0;
    if (Date.now() - lastUpload < debounceMs) {
      return;
    }

    // Set debounce timestamp BEFORE upload to prevent concurrent uploads
    this.lastUploadMap.set(elementId, Date.now());

    const elem = canvasState.elements.find((e) => e.id === elementId);
    if (!elem) return;

    const rawHtml = await this.bundler.readFrameHtml(elem.data || {});
    if (!rawHtml) return;

    const elemTitle = (elem.data?.title as string) || "Untitled";
    const snapshotData = elem.data as unknown as Record<string, unknown>;
    const bundledHtml = await this.bundler.bundle(
      rawHtml,
      elemTitle,
      null,
      snapshotData
    );

    for (const shareId of shareIds) {
      try {
        await this.apiCall("PUT", `/api/share/${shareId}/element/${elementId}`, {
          html: bundledHtml,
        });
        this.outputChannel.appendLine(
          `[share] Re-uploaded element "${elemTitle}" to share ${shareId}`
        );
      } catch (err) {
        this.outputChannel.appendLine(
          `[share] Failed to re-upload element "${elemTitle}" to ${shareId}: ${err}`
        );
      }
    }
  }

  async pauseShare(shareId: string): Promise<void> {
    await this.apiCall("PUT", `/api/share/${shareId}`, { status: "paused" });
    await this.listShares();
    this.outputChannel.appendLine(`[share] Paused share ${shareId}`);
  }

  async resumeShare(shareId: string): Promise<void> {
    await this.apiCall("PUT", `/api/share/${shareId}`, { status: "active" });

    // Re-upload all live elements immediately (bypass debounce)
    const share = await this.getShare(shareId);
    if (share) {
      for (const elem of share.elements) {
        if (elem.isLive && elem.status === "active") {
          this.lastUploadMap.delete(elem.id); // bypass debounce
          this.onElementRefreshed(elem.canvasId, elem.id).catch(() => {});
        }
      }
    }

    await this.listShares();
    this.outputChannel.appendLine(`[share] Resumed share ${shareId}`);
  }

  async pauseElement(shareId: string, elementId: string): Promise<void> {
    await this.apiCall("PUT", `/api/share/${shareId}/element/${elementId}`, {
      status: "paused",
    });
    this.outputChannel.appendLine(`[share] Paused element ${elementId} in share ${shareId}`);
  }

  async resumeElement(shareId: string, elementId: string): Promise<void> {
    await this.apiCall("PUT", `/api/share/${shareId}/element/${elementId}`, {
      status: "active",
    });
    this.lastUploadMap.delete(elementId);
    this.outputChannel.appendLine(`[share] Resumed element ${elementId} in share ${shareId}`);
  }

  async addElement(
    shareId: string,
    elementId: string,
    canvasId: string,
    title: string
  ): Promise<void> {
    const canvasState = await this.canvasProvider.getState(canvasId);
    if (!canvasState) throw new Error("Canvas not found");

    const elem = canvasState.elements.find((e) => e.id === elementId);
    if (!elem) throw new Error("Element not found");

    const rawHtml = await this.bundler.readFrameHtml(elem.data || {});
    if (!rawHtml) throw new Error("No frame HTML found");

    const snapshotData = elem.data as unknown as Record<string, unknown>;
    const bundledHtml = await this.bundler.bundle(rawHtml, title, null, snapshotData);

    const binding = canvasState.refreshBindings?.find(
      (b) => b.elementId === elementId && b.enabled
    );

    await this.apiCall("POST", `/api/share/${shareId}/element`, {
      id: elementId,
      canvasId,
      title,
      html: bundledHtml,
      isLive: !!binding,
    });

    await this.listShares();
    await this.getShare(shareId); // refresh details cache so live re-uploads work
    this.outputChannel.appendLine(`[share] Added element "${title}" to share ${shareId}`);
  }

  async removeElement(shareId: string, elementId: string): Promise<void> {
    await this.apiCall("DELETE", `/api/share/${shareId}/element/${elementId}`);
    await this.listShares();
    this.outputChannel.appendLine(`[share] Removed element ${elementId} from share ${shareId}`);
  }

  async revokeShare(shareId: string): Promise<void> {
    await this.apiCall("DELETE", `/api/share/${shareId}`);
    this.shareDetailsCache.delete(shareId);
    await this.listShares();
    this.outputChannel.appendLine(`[share] Revoked share ${shareId}`);
  }

  async listShares(): Promise<ShareIndexEntry[]> {
    const result = await this.apiCall<{ shares: ShareIndexEntry[] }>(
      "GET",
      "/api/share/list"
    );
    this.indexCache = result.shares;
    return this.indexCache;
  }

  async getShare(shareId: string): Promise<Share | null> {
    try {
      const result = await this.apiCall<{ share: Share }>(
        "GET",
        `/api/share/${shareId}`
      );
      this.shareDetailsCache.set(shareId, result.share);
      return result.share;
    } catch {
      return null;
    }
  }

  getCachedIndex(): ShareIndexEntry[] {
    return this.indexCache;
  }

  // ── Helpers ──

  /**
   * Find shares that contain a given element.
   * Uses cached share details. Returns share IDs.
   */
  findSharesForElement(elementId: string): string[] {
    const result: string[] = [];
    for (const [shareId, share] of this.shareDetailsCache) {
      if (share.status !== "active") continue;
      const elem = share.elements.find(
        (e) => e.id === elementId && e.status === "active"
      );
      if (elem) result.push(shareId);
    }
    return result;
  }

  /**
   * Populate share details cache for all shares in the index.
   * Called on extension activation so findSharesForElement() works.
   */
  async warmCache(): Promise<void> {
    try {
      const shares = await this.listShares();
      for (const entry of shares) {
        if (entry.status === "active") {
          await this.getShare(entry.id);
        }
      }
    } catch (err) {
      this.outputChannel.appendLine(`[share] Cache warm failed: ${err}`);
    }
  }

  private async apiCall<T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const jwt = await this.auth.getToken();
    if (!jwt) {
      throw new Error("Not authenticated");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${jwt}`,
      };
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }

      const res = await fetch(`${this.baseUrl}${path}`, init);

      if (res.status === 401) {
        throw new Error("Authentication expired");
      }
      if (!res.ok) {
        // Don't include raw response body in error — it may contain internal server details
        throw new Error(`API error ${res.status} on ${method} ${path}`);
      }

      return (await res.json()) as T;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request timed out: ${method} ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
