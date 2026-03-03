import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";

/**
 * NativeManager — locates system Node.js and manages the MCP server.
 *
 * OSS version: uses system-installed Node.js (no R2 download).
 * Requires Node.js 18+ on PATH.
 */
export class NativeManager {
  private readonly globalDir: string;
  private nodePath: string | null = null;

  constructor(
    private extensionPath: string,
    private outputChannel: vscode.OutputChannel
  ) {
    this.globalDir = path.join(os.homedir(), ".jetro");
  }

  // ── Node.js Runtime ──

  getNodePath(): string {
    return this.nodePath || "node";
  }

  isNodeReady(): boolean {
    return this.nodePath !== null;
  }

  /**
   * Locate system Node.js. Returns true if found (v18+), false otherwise.
   */
  async ensureNode(): Promise<boolean> {
    if (this.nodePath) return true;

    // Try common locations
    const candidates = [
      "node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ];

    // Add nvm/fnm/volta paths
    const home = os.homedir();
    const nvmDir = process.env.NVM_DIR || path.join(home, ".nvm");
    const nvmCurrent = path.join(nvmDir, "current", "bin", "node");
    if (fs.existsSync(nvmCurrent)) candidates.unshift(nvmCurrent);

    const voltaNode = path.join(home, ".volta", "bin", "node");
    if (fs.existsSync(voltaNode)) candidates.unshift(voltaNode);

    const fnmNode = path.join(home, ".local", "share", "fnm", "node-versions");
    if (fs.existsSync(fnmNode)) {
      try {
        const versions = fs.readdirSync(fnmNode).sort().reverse();
        if (versions.length > 0) {
          candidates.unshift(path.join(fnmNode, versions[0], "installation", "bin", "node"));
        }
      } catch { /* ignore */ }
    }

    for (const candidate of candidates) {
      try {
        const version = await this.getNodeVersion(candidate);
        if (version) {
          const major = parseInt(version.replace("v", "").split(".")[0], 10);
          if (major >= 18) {
            this.nodePath = candidate;
            this.outputChannel.appendLine(`[native] Found Node.js ${version} at ${candidate}`);
            return true;
          }
          this.outputChannel.appendLine(`[native] Node.js ${version} at ${candidate} is too old (need v18+)`);
        }
      } catch { /* try next */ }
    }

    this.outputChannel.appendLine("[native] Node.js not found. Install Node.js 18+ from https://nodejs.org");
    vscode.window.showWarningMessage(
      "Jetro requires Node.js 18+ for MCP tools. Install from nodejs.org.",
      "Open Download Page"
    ).then((choice) => {
      if (choice === "Open Download Page") {
        vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org"));
      }
    });
    return false;
  }

  private getNodeVersion(nodePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      exec(`"${nodePath}" --version`, { timeout: 5000 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const v = stdout.trim();
        resolve(v.startsWith("v") ? v : null);
      });
    });
  }

  /**
   * Get the MCP command config.
   * Uses system Node + globally deployed MCP server.
   */
  getMcpCommand(mcpServerPath: string): { command: string; args: string[]; binDir: string | null } {
    const nodePath = this.getNodePath();
    return {
      command: nodePath,
      args: [mcpServerPath],
      binDir: nodePath !== "node" ? path.dirname(nodePath) : null,
    };
  }

  // ── MCP Server ──

  /**
   * Copy the bundled MCP server to ~/.jetro/mcp-server/.
   * Called on every activation to ensure the latest version is deployed.
   */
  copyMcpServer(): string {
    const bundledPath = path.join(this.extensionPath, "mcp-server", "out", "index.js");
    const bundledPkg = path.join(this.extensionPath, "mcp-server", "package.json");
    const globalMcpDir = path.join(this.globalDir, "mcp-server");
    const globalMcpPath = path.join(globalMcpDir, "index.js");
    const globalPkgPath = path.join(globalMcpDir, "package.json");

    fs.mkdirSync(globalMcpDir, { recursive: true });
    if (fs.existsSync(bundledPath)) fs.copyFileSync(bundledPath, globalMcpPath);
    if (fs.existsSync(bundledPkg)) fs.copyFileSync(bundledPkg, globalPkgPath);

    this.outputChannel.appendLine(`[native] MCP server deployed to ${globalMcpDir}`);
    return globalMcpPath;
  }

  // ── DuckDB ──
  // DuckDB uses @duckdb/node-api (NAPI) — binary ships in node_modules.
  // No download needed.
}
