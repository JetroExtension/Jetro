import * as vscode from "vscode";
import * as http from "http";
import * as net from "net";
import { exec } from "child_process";
import WebSocket from "ws";
import { FileManager } from "./fileManager";
import { AuthService } from "./authService";
import { JETApiClient } from "./apiClient";
import type { ProjectDeployment } from "../types";
import { logTrouble } from "./troubleLog";

interface ManagedApp {
  projectSlug: string;
  containerId: string;
  port: number;
  relaySlug: string | null;
  relayWs: WebSocket | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 min — close relay WS after no viewer requests
const WAKE_POLL_INTERVAL = 30_000;   // 30s — check if viewers are waiting
const CONTAINER_PREFIX = "jet-app-";

export class DeployManager {
  private apps = new Map<string, ManagedApp>();
  private wakePollTimer: ReturnType<typeof setInterval> | null = null;
  private workspacePath: string;

  constructor(
    private fileManager: FileManager,
    private auth: AuthService,
    private api: JETApiClient,
    private outputChannel: vscode.OutputChannel,
    private secrets?: vscode.SecretStorage
  ) {
    this.workspacePath = fileManager.getRootPath();
  }

  // ── Prerequisites ──

  async checkDocker(): Promise<boolean> {
    return new Promise((resolve) => {
      exec("docker info", { timeout: 10_000 }, (err) => {
        if (err) {
          vscode.window.showWarningMessage(
            "Project deploy requires Docker. Install Docker Desktop?",
            "Open Download Page", "Cancel"
          ).then((choice) => {
            if (choice === "Open Download Page") {
              vscode.env.openExternal(vscode.Uri.parse("https://www.docker.com/products/docker-desktop/"));
            }
          });
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  // ── Container Environment ──

  /**
   * Build `-e` flags for connector credentials.
   * Reads all connector configs and fetches their secrets from the OS keychain.
   */
  private async buildCredentialFlags(): Promise<string> {
    if (!this.secrets) return "";
    const flags: string[] = [];
    try {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      const connectorsDir = path.join(this.workspacePath, ".jetro", "connectors");
      if (!fs.existsSync(connectorsDir)) return "";
      const slugs = fs.readdirSync(connectorsDir).filter((d: string) =>
        fs.statSync(path.join(connectorsDir, d)).isDirectory()
      );
      for (const slug of slugs) {
        try {
          const config = JSON.parse(
            fs.readFileSync(path.join(connectorsDir, slug, "connector.json"), "utf-8")
          );
          const credKey = config?.auth?.credentialKey;
          if (credKey) {
            const cred = await this.secrets.get(credKey);
            if (cred) {
              const envKey = `JET_CRED_${credKey.toUpperCase().replace(/-/g, "_")}`;
              flags.push(`-e ${envKey}="${cred.replace(/"/g, '\\"')}"`);
            }
          }
        } catch { /* skip malformed connectors */ }
      }
    } catch { /* no connectors dir */ }
    return flags.join(" ");
  }

  // ── Docker Lifecycle ──

  async start(projectSlug: string, deployDir: string): Promise<{ port: number; containerId: string }> {
    if (!(await this.checkDocker())) {
      throw new Error("Docker is not available");
    }

    const port = await this.findFreePort();
    const containerName = CONTAINER_PREFIX + projectSlug;
    const imageName = containerName;
    const dataDir = `${this.workspacePath}/projects/${projectSlug}`;

    // Detect container port from Dockerfile EXPOSE (default 8000)
    let containerPort = 8000;
    try {
      const dockerfile = require("fs").readFileSync(`${deployDir}/Dockerfile`, "utf-8");
      const exposeMatch = dockerfile.match(/EXPOSE\s+(\d+)/i);
      if (exposeMatch) containerPort = parseInt(exposeMatch[1], 10);
    } catch { /* use default */ }

    // Build image
    this.outputChannel.appendLine(`[deploy] Building image ${imageName}...`);
    try {
      await this.execAsync(`docker build -t ${imageName} "${deployDir}"`, { timeout: 300_000 });
    } catch (err) {
      logTrouble(this.workspacePath, {
        type: "deploy_build_error",
        projectSlug,
        message: "Docker build failed",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Check Dockerfile and requirements.txt for errors. Verify all files exist in the deploy/ directory.",
      });
      throw err;
    }
    this.outputChannel.appendLine(`[deploy] Image built.`);

    // Remove old container if exists (ignore errors)
    await this.execAsync(`docker rm -f ${containerName}`).catch(() => {});

    // Run container with Jetro SDK access
    this.outputChannel.appendLine(`[deploy] Starting container on port ${port} → ${containerPort}...`);
    const jetroDir = `${this.workspacePath}/.jetro`;
    const jwt = await this.auth.getToken() || "";
    const credFlags = await this.buildCredentialFlags();
    const runOutput = await this.execAsync(
      `docker run -d --name ${containerName}` +
      ` -v "${dataDir}:/app/data"` +
      ` -v "${jetroDir}:/app/.jetro:ro"` +
      ` -e JET_WORKSPACE=/app` +
      ` -e PYTHONPATH=/app/.jetro/lib` +
      ` -e JET_JWT="${jwt}"` +
      ` -e JET_API_URL=${vscode.workspace.getConfiguration("jetro").get<string>("apiUrl") || "http://localhost:8787"}` +
      ` ${credFlags}` +
      ` -p ${port}:${containerPort} ${imageName}`
    );
    const containerId = runOutput.trim();
    this.outputChannel.appendLine(`[deploy] Container running: ${containerId.slice(0, 12)}`);

    // Wait briefly and check if container crashed on startup
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const check = await this.execAsync(`docker ps --filter name=${containerName} --format "{{.ID}}"`);
      if (!check.trim()) {
        const logs = await this.execAsync(`docker logs ${containerName} --tail 30`).catch(() => "No logs");
        logTrouble(this.workspacePath, {
          type: "deploy_crash",
          projectSlug,
          message: "Container crashed immediately after starting",
          detail: logs,
          hint: "Check server.py for import errors, syntax issues, or missing dependencies in requirements.txt.",
        });
        throw new Error("Container crashed on startup. Check trouble.json for details.");
      }
    } catch (err) {
      if ((err as Error).message?.includes("Container crashed")) throw err;
      // docker ps failed — ignore, container might still be starting
    }

    // Track
    this.apps.set(projectSlug, {
      projectSlug,
      containerId,
      port,
      relaySlug: null,
      relayWs: null,
      idleTimer: null,
    });

    // Update project.json
    await this.fileManager.updateProjectDeployment(projectSlug, {
      status: "live",
      target: "local",
      port,
      containerId,
      lastDeployed: new Date().toISOString(),
    });

    return { port, containerId };
  }

  async stop(projectSlug: string): Promise<void> {
    const app = this.apps.get(projectSlug);
    const containerName = CONTAINER_PREFIX + projectSlug;

    // Disconnect relay
    this.disconnectRelay(projectSlug);

    // Stop container
    await this.execAsync(`docker stop ${containerName}`).catch(() => {});
    this.outputChannel.appendLine(`[deploy] Stopped ${containerName}`);

    // Update state
    if (app) this.apps.delete(projectSlug);
    await this.fileManager.updateProjectDeployment(projectSlug, {
      status: "stopped",
      port: null,
      containerId: null,
    });
  }

  async redeploy(projectSlug: string): Promise<{ port: number; containerId: string }> {
    const proj = await this.fileManager.readProject(projectSlug);
    const deployDir = `${this.workspacePath}/projects/${projectSlug}/deploy`;

    // Stop and remove old
    await this.stop(projectSlug);
    await this.execAsync(`docker rm -f ${CONTAINER_PREFIX}${projectSlug}`).catch(() => {});

    // Rebuild and run
    const result = await this.start(projectSlug, deployDir);

    // Increment version
    const version = (proj?.deployment?.version ?? 0) + 1;
    await this.fileManager.updateProjectDeployment(projectSlug, { version });

    // Restore relay slug and reconnect
    if (proj?.deployment?.slug) {
      const app = this.apps.get(projectSlug);
      if (app) {
        app.relaySlug = proj.deployment.slug;
        this.connectRelay(projectSlug).catch(() => {});
      }
    }

    return result;
  }

  async remove(projectSlug: string): Promise<void> {
    const proj = await this.fileManager.readProject(projectSlug);
    const containerName = CONTAINER_PREFIX + projectSlug;

    // Stop and disconnect relay
    this.disconnectRelay(projectSlug);

    // Remove container + image
    await this.execAsync(`docker rm -f ${containerName}`).catch(() => {});
    await this.execAsync(`docker rmi ${containerName}`).catch(() => {});
    this.outputChannel.appendLine(`[deploy] Removed container + image: ${containerName}`);

    // Deregister slug from backend
    if (proj?.deployment?.slug) {
      try {
        const jwt = await this.auth.getToken();
        if (jwt) {
          await this.api.deployDeregister(jwt, proj.deployment.slug);
        }
      } catch {
        // Non-critical
      }
    }

    this.apps.delete(projectSlug);
    await this.fileManager.updateProjectDeployment(projectSlug, {
      status: "not_deployed",
      port: null,
      containerId: null,
      url: null,
      slug: null,
      version: 0,
    });
  }

  // ── Slug Registration ──

  /** Generate a quirky, memorable, DNS-safe app slug: {word_a}{word_b}-{suffix} */
  generateAppSlug(): string {
    const { WORDS_A, WORDS_B } = require("./slugWords");
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const a = WORDS_A[(bytes[0] << 8 | bytes[1]) % WORDS_A.length];
    const b = WORDS_B[(bytes[2] << 8 | bytes[3]) % WORDS_B.length];
    const suffix = Array.from(bytes.slice(4), (v: number) =>
      "abcdefghijklmnopqrstuvwxyz0123456789"[v % 36]
    ).join("");
    return `${a}${b}-${suffix}`;
  }

  async registerSlug(projectSlug: string, appSlug?: string): Promise<string> {
    if (!appSlug) appSlug = this.generateAppSlug();
    const jwt = await this.auth.getToken();
    if (!jwt) throw new Error("Not authenticated");

    const result = await this.api.deployRegister(jwt, appSlug);
    const url = result.url;

    // Track relay slug
    const app = this.apps.get(projectSlug);
    if (app) app.relaySlug = appSlug;

    // Update project.json
    await this.fileManager.updateProjectDeployment(projectSlug, {
      slug: appSlug,
      url,
    });

    this.outputChannel.appendLine(`[deploy] Registered slug: ${appSlug} → ${url}`);
    return url;
  }

  // ── DO Relay ──

  async connectRelay(projectSlug: string): Promise<void> {
    const app = this.apps.get(projectSlug);
    if (!app?.relaySlug || app.relayWs) return; // no slug or already connected

    const jwt = await this.auth.getToken();
    if (!jwt) return;

    const relayDomain = vscode.workspace.getConfiguration("jetro").get<string>("relayDomain") || "localhost:8787";
    const wsProtocol = relayDomain.startsWith("localhost") ? "ws" : "wss";
    const wsUrl = `${wsProtocol}://${app.relaySlug}.${relayDomain}/ws/connect?token=${encodeURIComponent(jwt)}`;
    this.outputChannel.appendLine(`[deploy] Connecting relay: ${app.relaySlug}...`);

    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      this.outputChannel.appendLine(`[deploy] Relay connected: ${app.relaySlug}`);
      this.resetIdleTimer(projectSlug);
    });

    ws.on("message", async (data) => {
      try {
        const req = JSON.parse(data.toString());
        const res = await this.proxyToContainer(app, req);
        ws.send(JSON.stringify({ requestId: req.requestId, ...res }));
        this.resetIdleTimer(projectSlug);
      } catch (err) {
        this.outputChannel.appendLine(`[deploy] Relay proxy error: ${err}`);
      }
    });

    ws.on("close", () => {
      app.relayWs = null;
      if (app.idleTimer) clearTimeout(app.idleTimer);
      this.outputChannel.appendLine(`[deploy] Relay disconnected: ${app.relaySlug}`);
    });

    ws.on("error", (err) => {
      this.outputChannel.appendLine(`[deploy] Relay error: ${err.message}`);
    });

    app.relayWs = ws;
  }

  disconnectRelay(projectSlug: string): void {
    const app = this.apps.get(projectSlug);
    if (!app) return;
    if (app.relayWs) {
      app.relayWs.close();
      app.relayWs = null;
    }
    if (app.idleTimer) {
      clearTimeout(app.idleTimer);
      app.idleTimer = null;
    }
  }

  private resetIdleTimer(projectSlug: string): void {
    const app = this.apps.get(projectSlug);
    if (!app) return;
    if (app.idleTimer) clearTimeout(app.idleTimer);
    app.idleTimer = setTimeout(() => {
      this.outputChannel.appendLine(`[deploy] Idle timeout — disconnecting relay: ${app.relaySlug}`);
      this.disconnectRelay(projectSlug);
    }, IDLE_TIMEOUT);
  }

  private proxyToContainer(app: ManagedApp, req: {
    requestId: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string | null;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve) => {
      const opts: http.RequestOptions = {
        hostname: "127.0.0.1",
        port: app.port,
        path: req.path,
        method: req.method,
        headers: { ...req.headers, host: "127.0.0.1" },
        timeout: 30_000,
      };

      const proxyReq = http.request(opts, (proxyRes) => {
        const chunks: Buffer[] = [];
        proxyRes.on("data", (c) => chunks.push(c));
        proxyRes.on("end", () => {
          const body = Buffer.concat(chunks).toString("base64");
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(", ");
          }
          resolve({ status: proxyRes.statusCode || 502, headers, body });
        });
      });

      proxyReq.on("error", () => {
        resolve({ status: 502, headers: {}, body: btoa("Container unavailable") });
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        resolve({ status: 504, headers: {}, body: btoa("Gateway Timeout") });
      });

      if (req.body) proxyReq.write(req.body);
      proxyReq.end();
    });
  }

  // ── Wake Channel ──

  startWakeListener(): void {
    if (this.wakePollTimer) return;
    this.wakePollTimer = setInterval(() => this.pollWake(), WAKE_POLL_INTERVAL);
    this.outputChannel.appendLine("[deploy] Wake listener started (30s poll)");
  }

  stopWakeListener(): void {
    if (this.wakePollTimer) {
      clearInterval(this.wakePollTimer);
      this.wakePollTimer = null;
    }
  }

  private async pollWake(): Promise<void> {
    // Only check slugs that are live but relay disconnected
    const slugsToCheck: string[] = [];
    const slugToProject = new Map<string, string>();
    for (const [slug, app] of this.apps) {
      if (app.relaySlug && !app.relayWs) {
        slugsToCheck.push(app.relaySlug);
        slugToProject.set(app.relaySlug, slug);
      }
    }
    if (slugsToCheck.length === 0) return;

    try {
      const jwt = await this.auth.getToken();
      if (!jwt) return;
      const result = await this.api.deployWake(jwt, slugsToCheck);
      for (const wokenSlug of result.wake) {
        const projSlug = slugToProject.get(wokenSlug);
        if (projSlug) {
          this.outputChannel.appendLine(`[deploy] Wake: viewer waiting for ${wokenSlug}`);
          await this.connectRelay(projSlug);
        }
      }
    } catch {
      // Network error — keep polling
    }
  }

  // ── Restoration ──

  async restoreFromDisk(): Promise<void> {
    const projectSlugs = await this.fileManager.listProjects();
    let hasLiveApps = false;

    for (const slug of projectSlugs) {
      const proj = await this.fileManager.readProject(slug);
      if (proj?.deployment?.status === "live" && proj.deployment.containerId) {
        // Check if container is actually running
        try {
          const output = await this.execAsync(
            `docker ps --filter name=${CONTAINER_PREFIX}${slug} --format "{{.ID}}"`
          );
          if (output.trim()) {
            // Container still running — re-track
            this.apps.set(slug, {
              projectSlug: slug,
              containerId: output.trim(),
              port: proj.deployment.port || 0,
              relaySlug: proj.deployment.slug || null,
              relayWs: null,
              idleTimer: null,
            });
            hasLiveApps = true;
            this.outputChannel.appendLine(`[deploy] Restored: ${slug} (port ${proj.deployment.port})`);
            // Proactively connect relay (don't wait for wake poll)
            if (proj.deployment.slug) {
              this.connectRelay(slug).catch(() => {});
            }
          } else {
            // Container not running — mark as stopped
            await this.fileManager.updateProjectDeployment(slug, {
              status: "stopped",
              port: null,
              containerId: null,
            });
          }
        } catch {
          // Docker not available or container gone
          await this.fileManager.updateProjectDeployment(slug, {
            status: "stopped",
            port: null,
            containerId: null,
          });
        }
      }
    }

    // Start wake listener if any apps are live
    if (hasLiveApps) {
      this.startWakeListener();
    }
  }

  // ── Cleanup ──

  async stopAll(): Promise<void> {
    this.stopWakeListener();
    for (const [slug] of this.apps) {
      this.disconnectRelay(slug);
    }
    this.apps.clear();
    // Note: we do NOT stop Docker containers on deactivate —
    // they keep running and can be reconnected on next activation
  }

  // ── Helpers ──

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
      srv.on("error", reject);
    });
  }

  private execAsync(cmd: string, opts?: { timeout?: number }): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, {
        timeout: opts?.timeout || 60_000,
        maxBuffer: 10 * 1024 * 1024,
        cwd: this.workspacePath,
      }, (err, stdout, stderr) => {
        if (err) {
          this.outputChannel.appendLine(`[deploy] cmd error: ${cmd}\n${stderr}`);
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  getApp(projectSlug: string): ManagedApp | undefined {
    return this.apps.get(projectSlug);
  }

  getApps(): Map<string, ManagedApp> {
    return this.apps;
  }
}
