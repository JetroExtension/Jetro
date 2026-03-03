import * as vscode from "vscode";
import { ConnectionManager } from "../services/connectionManager";
import { DuckDBService } from "../services/duckdb";
import { FileManager } from "../services/fileManager";
import type { DatabaseConnection } from "../types";

export class ConnectorProvider {
  private panel: vscode.WebviewPanel | undefined;
  private projectSlug: string | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private connectionManager: ConnectionManager,
    private duckdb: DuckDBService,
    private fileManager: FileManager,
    private outputChannel: vscode.OutputChannel,
    private onRefresh: () => void,
  ) {}

  open(projectSlug?: string, preselectedEngine?: string): void {
    this.projectSlug = projectSlug || null;

    if (this.panel) {
      this.panel.reveal();
      this.panel.webview.postMessage({
        type: "connector.init",
        data: { projectSlug: this.projectSlug, preselectedEngine },
      });
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "jetro.connector",
      projectSlug ? `Data \u00B7 ${projectSlug}` : "Data Connections",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "webview"),
        ],
      },
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.postMessage({
      type: "connector.init",
      data: { projectSlug: this.projectSlug, preselectedEngine },
    });
  }

  /** Open directly to schema browser for an existing connection */
  openSchema(slug: string, name?: string): void {
    this.projectSlug = null;

    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "jetro.connector",
        `Schema \u00B7 ${name || slug}`,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.extensionUri, "webview"),
          ],
        },
      );

      this.panel.webview.html = this.getHtml(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }

    this.panel.webview.postMessage({
      type: "connector.init",
      data: { browseSlug: slug, browseName: name || slug },
    });
  }

  private async handleMessage(msg: { type: string; data?: unknown }): Promise<void> {
    switch (msg.type) {
      case "connector.test": {
        const { config, password } = msg.data as {
          config: Partial<DatabaseConnection>;
          password: string;
        };
        const result = await this.connectionManager.testConnectionSafe(config, password);
        this.panel?.webview.postMessage({ type: "connector.testResult", data: result });
        break;
      }

      case "connector.save": {
        const { config, password } = msg.data as {
          config: Partial<DatabaseConnection>;
          password: string;
        };
        try {
          const slug = await this.connectionManager.addConnection(config, password);
          await this.connectionManager.attach(slug);
          // Auto-link to project if opened from project context
          if (this.projectSlug) {
            const proj = await this.fileManager.readProject(this.projectSlug);
            if (proj) {
              const linked = proj.linkedConnections || [];
              if (!linked.includes(slug)) {
                linked.push(slug);
                proj.linkedConnections = linked;
                proj.updatedAt = new Date().toISOString();
                await this.fileManager.writeProject(proj.name, proj);
              }
            }
          }
          this.onRefresh();
          this.panel?.webview.postMessage({
            type: "connector.saved",
            data: { slug, success: true },
          });
        } catch (err) {
          this.panel?.webview.postMessage({
            type: "connector.saved",
            data: {
              slug: "",
              success: false,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
        break;
      }

      case "connector.schema": {
        const { slug } = msg.data as { slug: string };
        try {
          const tree = await this.duckdb.getAttachedSchema(slug);
          this.panel?.webview.postMessage({
            type: "connector.schemaTree",
            data: { slug, tree },
          });
        } catch (err) {
          this.outputChannel.appendLine(
            `[connector] Schema error for ${slug}: ${err}`
          );
          this.panel?.webview.postMessage({
            type: "connector.schemaTree",
            data: { slug, tree: { schemas: [] } },
          });
        }
        break;
      }

      case "connector.importTable": {
        const { connectionSlug, tableName, alias } = msg.data as {
          connectionSlug: string;
          tableName: string;
          alias: string;
        };
        try {
          await this.duckdb.executeDDL(
            `CREATE OR REPLACE VIEW "${alias}" AS SELECT * FROM ${connectionSlug}.${tableName}`
          );

          if (this.projectSlug) {
            await this.fileManager.writeProjectDataset(this.projectSlug, alias, {
              name: alias,
              slug: alias,
              files: [],
              columns: [],
              rowCount: 0,
              sizeBytes: 0,
              duckdbTable: alias,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }

          this.onRefresh();
          this.panel?.webview.postMessage({
            type: "connector.imported",
            data: { tableName, alias },
          });
        } catch (err) {
          this.outputChannel.appendLine(
            `[connector] Import error: ${err}`
          );
        }
        break;
      }

      case "connector.browseFile": {
        const files = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          filters: {
            "Database Files": ["db", "sqlite", "sqlite3", "duckdb"],
          },
        });
        if (files && files.length > 0) {
          this.panel?.webview.postMessage({
            type: "connector.filePicked",
            data: { path: files[0].fsPath },
          });
        }
        break;
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "webview", "connector.js")
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "webview", "connector.css")
    );

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} data: https:; font-src ${webview.cspSource} https:;">
  <link rel="stylesheet" href="${cssUri}">
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: auto; background: var(--vscode-editor-background, #1e1e1e); }
    #connector-root { width: 100%; min-height: 100%; }
  </style>
</head>
<body>
  <div id="connector-root"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
