import * as vscode from "vscode";
import * as path from "path";
import { FileManager } from "../services/fileManager";
import { AuthService } from "../services/authService";
import { ConnectionManager } from "../services/connectionManager";
import { DatabaseConnection } from "../types";

export class SettingsProvider {
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private fileManager: FileManager,
    private secrets: vscode.SecretStorage,
    private auth: AuthService,
    private connectionManager?: ConnectionManager
  ) {
    // Re-send auth state to panel when it changes
    this.auth.onAuthStateChanged(() => {
      this.refreshData();
    });
  }

  public async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "jetro.settings",
      "Jetro Settings",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      await this.handleMessage(msg);
    });

    this.panel.onDidDispose(() => {
      this.panel = null;
    });

    // Send initial data (don't let errors prevent the panel from showing)
    try {
      await this.refreshData();
    } catch (err) {
      console.error("[settings] refreshData failed:", err);
    }
  }

  private async refreshData(): Promise<void> {
    if (!this.panel) {
      return;
    }

    let datasources: Array<{ name: string; slug: string; baseUrl: string; auth: { type: string; secretRef: string }; endpoints: unknown[] }> = [];
    let templates: Array<{ slug: string; name: string; source: string }> = [];
    let financeEnabled = true;
    let connections: DatabaseConnection[] = [];
    let connectors: Array<Record<string, unknown>> = [];

    try {
      const datasourceSlugs = await this.fileManager.listDataSources();
      for (const slug of datasourceSlugs) {
        const ds = await this.fileManager.readDataSource(slug);
        if (ds) {
          datasources.push(ds);
        }
      }
    } catch {
      // No data sources available
    }

    // Bundled starter templates
    try {
      const bundledDir = path.join(this.extensionUri.fsPath, "agent", "templates");
      const bundledEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(bundledDir));
      for (const [filename] of bundledEntries) {
        if (!filename.endsWith(".json")) continue;
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(bundledDir, filename)));
          const tpl = JSON.parse(new TextDecoder().decode(bytes));
          if (tpl.name) {
            templates.push({ slug: filename.replace(".json", ""), name: tpl.name, source: "starter" });
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* no bundled templates dir */ }

    // Local user templates
    try {
      const templateSlugs = await this.fileManager.listTemplates();
      for (const slug of templateSlugs) {
        const displayName = slug.replace(/_/g, " ");
        if (!templates.some((t) => t.name.toLowerCase() === displayName.toLowerCase())) {
          templates.push({ slug, name: displayName, source: "local" });
        }
      }
    } catch {
      // No templates available
    }

    try {
      financeEnabled = await this.fileManager.isFinanceEnabled();
    } catch {
      // Default to finance enabled
    }

    try {
      const connSlugs = await this.fileManager.listConnections();
      for (const slug of connSlugs) {
        const conn = await this.fileManager.readConnection(slug);
        if (conn) connections.push(conn);
      }
    } catch {
      // No connections available
    }

    try {
      const connectorSlugs = await this.fileManager.listConnectors();
      for (const slug of connectorSlugs) {
        const c = await this.fileManager.readConnector(slug);
        if (c) connectors.push(c as unknown as Record<string, unknown>);
      }
    } catch {
      // No connectors available
    }

    const session = this.auth.getSession();

    this.panel.webview.postMessage({
      type: "init",
      data: { datasources, templates, session, financeEnabled, connections, connectors },
    });
  }

  private async handleMessage(msg: { type: string; data?: unknown }): Promise<void> {
    switch (msg.type) {
      case "addDataSource": {
        const { name, baseUrl, authType, apiKey, docsUrl } = msg.data as {
          name: string;
          baseUrl: string;
          authType: "header" | "query" | "bearer";
          apiKey: string;
          docsUrl: string;
        };
        const slug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
        const secretRef = slug + "_key";
        if (apiKey) {
          await this.secrets.store(secretRef, apiKey);
        }
        await this.fileManager.writeDataSource(name, {
          name,
          slug,
          baseUrl,
          auth: { type: authType, secretRef },
          docsUrl: docsUrl || undefined,
          endpoints: [],
          createdAt: new Date().toISOString(),
        });
        await this.refreshData();
        vscode.window.showInformationMessage(`Data source "${name}" added.`);
        break;
      }
      case "removeDataSource": {
        const { slug: dsSlug } = msg.data as { slug: string };
        const ds = await this.fileManager.readDataSource(dsSlug);
        if (ds) {
          await this.secrets.delete(ds.auth.secretRef);
        }
        await this.fileManager.deleteDataSource(dsSlug);
        await this.refreshData();
        vscode.window.showInformationMessage("Data source removed.");
        break;
      }
      case "signIn": {
        const { email, password } = msg.data as { email: string; password: string };
        try {
          await this.auth.signIn(email, password);
          vscode.window.showInformationMessage(`Signed in as ${email}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Sign in failed: ${err}`);
        }
        break;
      }
      case "signUp": {
        const { email: signUpEmail, password: signUpPw } = msg.data as { email: string; password: string };
        try {
          await this.auth.signUp(signUpEmail, signUpPw);
          vscode.window.showInformationMessage(`Account created! Signed in as ${signUpEmail}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Sign up failed: ${err}`);
        }
        break;
      }
      case "signInWithGoogle": {
        try {
          const session = await this.auth.signInWithGoogle();
          vscode.window.showInformationMessage(`Signed in as ${session.email}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Google sign in failed: ${err}`);
        }
        break;
      }
      case "signOut": {
        await this.auth.signOut();
        vscode.window.showInformationMessage("Signed out.");
        break;
      }
      case "toggleFinance": {
        const enabled = (msg.data as { enabled: boolean }).enabled;
        await this.fileManager.setFinanceEnabled(enabled);
        this.panel?.webview.postMessage({ type: "financeToggled", data: { enabled } });
        vscode.window.showInformationMessage(
          enabled ? "Finance features enabled" : "Finance features disabled"
        );
        break;
      }
      case "addConnection": {
        if (!this.connectionManager) break;
        const { name: connName, engine, host, port, database, filePath, password: connPw } = msg.data as {
          name: string; engine: string; host?: string; port?: string;
          database?: string; filePath?: string; password?: string;
        };
        if (!connName) break;
        await this.connectionManager.addConnection(
          { name: connName, engine: engine as DatabaseConnection["engine"], host, port: port ? Number(port) : undefined, database, filePath },
          connPw
        );
        await this.refreshData();
        vscode.window.showInformationMessage(`Connection "${connName}" added.`);
        break;
      }
      case "browseConnection": {
        const { slug: browseSlug, name: browseName } = msg.data as { slug: string; name?: string };
        vscode.commands.executeCommand("jetro.openConnector.browse", browseSlug, browseName);
        break;
      }
      case "openConnector": {
        vscode.commands.executeCommand("jetro.openConnector");
        break;
      }
      case "removeConnection": {
        const { slug: connSlug } = msg.data as { slug: string };
        if (this.connectionManager) {
          try { await this.connectionManager.detach(connSlug); } catch { /* not attached */ }
        }
        const conn = await this.fileManager.readConnection(connSlug);
        if (conn?.secretRef) {
          await this.secrets.delete(conn.secretRef);
        }
        await this.fileManager.deleteConnection(connSlug);
        await this.refreshData();
        vscode.window.showInformationMessage("Connection removed.");
        break;
      }
      case "testConnection": {
        if (!this.connectionManager) break;
        const { engine: testEngine, host: testHost, port: testPort, database: testDb, filePath: testFile, password: testPw } = msg.data as {
          engine: string; host?: string; port?: string; database?: string; filePath?: string; password?: string;
        };
        const ok = await this.connectionManager.testConnection(
          { engine: testEngine as DatabaseConnection["engine"], host: testHost, port: testPort ? Number(testPort) : undefined, database: testDb, filePath: testFile },
          testPw
        );
        this.panel?.webview.postMessage({
          type: "testResult",
          data: { success: ok },
        });
        break;
      }
      case "testConnector": {
        const { slug: testConnSlug } = msg.data as { slug: string };
        vscode.commands.executeCommand("jetro.testConnector", testConnSlug);
        break;
      }
      case "deleteConnector": {
        const { slug: delConnSlug } = msg.data as { slug: string };
        vscode.commands.executeCommand("jetro.deleteConnector", delConnSlug);
        // Refresh after a short delay to let the command complete
        setTimeout(() => this.refreshData(), 500);
        break;
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'nonce-${nonce}';">
  <style>
    :root {
      --jet-accent: #DEBFCA;
      --jet-accent-dim: rgba(222,191,202,0.12);
      --jet-up: #2e8b57;
      --jet-up-dim: rgba(46,139,87,0.15);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }

    /* ── Sections ── */
    .settings-section {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 16px 20px;
    }
    .settings-section:last-child { border-bottom: none; }
    .settings-section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
    }
    .settings-sub-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      font-family: 'SF Mono', 'Consolas', monospace;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    /* ── Row layout ── */
    .settings-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      font-size: 12px;
    }
    .settings-row .sr-icon { width: 20px; text-align: center; flex-shrink: 0; }
    .settings-row .sr-name { font-weight: 500; min-width: 100px; }
    .settings-row .sr-meta {
      color: var(--vscode-descriptionForeground);
      font-family: 'SF Mono', 'Consolas', monospace;
      font-size: 11px;
      flex: 1;
    }
    .settings-row .sr-status {
      font-family: 'SF Mono', 'Consolas', monospace;
      font-size: 10px;
    }
    .settings-row .sr-actions { display: flex; gap: 4px; }
    .settings-row .sr-actions button {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      border: 1px solid var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .settings-row .sr-actions button:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground);
    }
    .settings-divider {
      height: 1px;
      background: var(--vscode-panel-border);
      margin: 8px 0;
    }

    /* ── Forms ── */
    .settings-form {
      background: rgba(0,0,0,0.15);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 12px;
      margin-top: 8px;
      display: none;
    }
    .settings-form.visible { display: block; }
    .settings-form-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .settings-form-row label {
      min-width: 70px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .settings-form-row input,
    .settings-form-row select {
      flex: 1;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      color: var(--vscode-input-foreground);
      font-size: 11px;
      outline: none;
    }
    .settings-form-row input:focus { border-color: var(--vscode-focusBorder); }
    .settings-form-row select { appearance: auto; }
    .settings-form-actions {
      display: flex;
      gap: 4px;
      justify-content: flex-end;
      margin-top: 8px;
    }

    /* ── Buttons ── */
    .btn {
      padding: 6px 12px;
      font-size: 11px;
      border-radius: 3px;
      cursor: pointer;
      border: 1px solid var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-foreground);
    }
    .btn:hover { border-color: var(--jet-accent); color: var(--jet-accent); }
    .btn-primary {
      background: var(--jet-accent);
      color: #000;
      border-color: var(--jet-accent);
      font-weight: 600;
    }
    .btn-primary:hover { opacity: 0.9; color: #000; }
    .btn-row { display: flex; gap: 8px; margin-top: 12px; }
    .btn-add {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 8px;
      padding: 5px 10px;
      font-size: 11px;
      border-radius: 3px;
      border: 1px solid var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
    }
    .btn-add:hover { border-color: var(--jet-accent); color: var(--jet-accent); }
    .link-btn {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      text-decoration: underline;
      background: none;
      border: none;
      padding: 0;
      margin-top: 8px;
    }
    .link-btn:hover { color: var(--vscode-foreground); }

    /* ── Auth UI ── */
    .auth-signed-out, .auth-signed-in { display: none; }
    .auth-signed-out.visible, .auth-signed-in.visible { display: block; }
    .auth-form { max-width: 320px; }
    .auth-form .auth-field {
      margin-bottom: 10px;
    }
    .auth-form .auth-field input {
      width: 100%;
      padding: 6px 10px;
      font-size: 13px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-input-foreground);
      border-radius: 3px;
      outline: none;
    }
    .auth-form .auth-field input:focus { border-color: var(--vscode-focusBorder); }
    .auth-toggle {
      margin-top: 12px;
      font-size: 11px;
      opacity: 0.6;
    }
    .auth-toggle a {
      color: var(--jet-accent);
      cursor: pointer;
      text-decoration: none;
    }
    .auth-toggle a:hover { text-decoration: underline; }
    .auth-error {
      color: #F85149;
      font-size: 11px;
      margin-top: 4px;
      display: none;
    }
    .tier-badge {
      font-family: 'SF Mono', 'Consolas', monospace;
      font-size: 9px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--jet-up-dim);
      color: var(--jet-up);
    }
    .btn-signout {
      margin-top: 12px;
      padding: 6px 12px;
      font-size: 11px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      opacity: 0.7;
    }
    .btn-signout:hover { opacity: 1; border-color: #F85149; color: #F85149; }

    /* ── Empty state ── */
    .empty-state {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      padding: 4px 0;
      opacity: 0.6;
    }
  </style>
</head>
<body>

  <!-- SECTION A: Data Sources -->
  <div class="settings-section">
    <div class="settings-section-title">Data Sources</div>
    <div class="settings-sub-label">Built-in</div>
    <div class="settings-row">
      <span class="sr-icon" style="color:var(--jet-up)">&#10003;</span>
      <span class="sr-name">Jetro Equity Data</span>
      <span class="sr-meta">Equity API</span>
      <span class="sr-status" style="color:var(--jet-up)">Connected</span>
    </div>
    <div class="settings-row">
      <span class="sr-icon" style="color:var(--jet-up)">&#10003;</span>
      <span class="sr-name">Jetro Market Data</span>
      <span class="sr-meta">Market API</span>
      <span class="sr-status" style="color:var(--jet-up)">Connected</span>
    </div>
    <div class="settings-divider"></div>
    <div class="settings-sub-label">Custom</div>
    <div id="ds-list"></div>
    <button class="btn-add" id="btn-toggle-add-ds">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
      Add Data Source
    </button>
    <div class="settings-form" id="add-ds-form">
      <div class="settings-form-row"><label>Name</label><input id="ds-name" placeholder="e.g. Bloomberg" spellcheck="false"></div>
      <div class="settings-form-row"><label>Base URL</label><input id="ds-url" placeholder="https://api.example.com" spellcheck="false"></div>
      <div class="settings-form-row"><label>Auth</label>
        <select id="ds-auth">
          <option value="header">Header</option>
          <option value="bearer">Bearer</option>
          <option value="query">Query Param</option>
        </select>
      </div>
      <div class="settings-form-row"><label>API Key</label><input id="ds-key" type="password" placeholder="Enter API key" spellcheck="false"></div>
      <div class="settings-form-row"><label>Docs URL</label><input id="ds-docs" placeholder="https://docs.example.com" spellcheck="false"></div>
      <div class="settings-form-actions">
        <button class="btn" id="btn-cancel-ds">Cancel</button>
        <button class="btn btn-primary" id="btn-save-ds">Save</button>
      </div>
    </div>
  </div>

  <!-- SECTION: Connectors (agent-built) -->
  <div class="settings-section" id="section-connectors">
    <div class="settings-section-title">Connectors</div>
    <div class="settings-sub-label" style="opacity:0.5;font-size:11px;margin-bottom:8px;">Agent-built data connectors. Ask the AI agent to create connectors for APIs, databases, spreadsheets, etc.</div>
    <div id="connector-list"></div>
  </div>

  <!-- SECTION B: Report Templates -->
  <div class="settings-section">
    <div class="settings-section-title">Report Templates</div>
    <div id="tpl-list"></div>
  </div>

  <!-- SECTION: Finance Features -->
  <div class="settings-section">
    <div class="settings-section-title">Finance Features</div>
    <div class="settings-row" id="finance-toggle" style="cursor:pointer;">
      <span class="sr-icon" id="finance-toggle-icon">&#9744;</span>
      <span class="sr-name">Enable Finance Features</span>
      <span class="sr-meta">Stock search, market data, portfolio management, equity analysis</span>
    </div>
  </div>

  <!-- SECTION D: Account -->
  <div class="settings-section">
    <div class="settings-section-title">Account</div>

    <!-- Signed Out -->
    <div class="auth-signed-out" id="auth-signed-out">
      <div style="padding:8px 0;font-size:12px;opacity:0.6;">Not signed in. Sign in from the Jetro sidebar.</div>
    </div>

    <!-- Signed In -->
    <div class="auth-signed-in" id="auth-signed-in">
      <div class="settings-row">
        <span class="sr-icon">&#128100;</span>
        <span class="sr-name" id="acct-email" style="font-weight:600;"></span>
      </div>
      <button class="btn-signout" id="btn-sign-out">Sign Out</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    // ── Data sources ──
    function renderDataSources(datasources) {
      const container = document.getElementById('ds-list');
      if (datasources.length === 0) {
        container.innerHTML = '<div class="empty-state">No custom data sources</div>';
        return;
      }
      container.innerHTML = datasources.map(ds =>
        '<div class="settings-row">' +
          '<span class="sr-icon" style="color:#58a6ff">&#9673;</span>' +
          '<span class="sr-name">' + ds.name + '</span>' +
          '<span class="sr-meta">' + ds.baseUrl + ' \\u00b7 ' + ds.auth.type + ' auth</span>' +
          '<span class="sr-status" style="color:var(--jet-up)">\\u2713 Active</span>' +
          '<span class="sr-actions">' +
            '<button onclick="removeDs(\\'' + ds.slug + '\\')">Remove</button>' +
          '</span>' +
        '</div>'
      ).join('');
    }

    window.removeDs = function(slug) {
      vscode.postMessage({ type: 'removeDataSource', data: { slug } });
    };

    // ── Templates (passive list) ──
    function renderTemplates(templates) {
      const container = document.getElementById('tpl-list');
      if (!templates || templates.length === 0) {
        container.innerHTML = '<div class="empty-state">No templates yet</div>';
        return;
      }
      container.innerHTML = templates.map(t =>
        '<div class="settings-row">' +
          '<span class="sr-icon" style="color:var(--jet-accent)">&#128196;</span>' +
          '<span class="sr-name">' + t.name + '</span>' +
          '<span class="sr-meta">' + (t.source || t.updatedAt || '') + '</span>' +
        '</div>'
      ).join('');
    }

    // ── Buttons ──
    document.getElementById('btn-toggle-add-ds').addEventListener('click', () => {
      document.getElementById('add-ds-form').classList.toggle('visible');
    });

    document.getElementById('btn-cancel-ds').addEventListener('click', () => {
      document.getElementById('add-ds-form').classList.remove('visible');
    });

    document.getElementById('btn-save-ds').addEventListener('click', () => {
      const name = document.getElementById('ds-name').value.trim();
      const baseUrl = document.getElementById('ds-url').value.trim();
      const authType = document.getElementById('ds-auth').value;
      const apiKey = document.getElementById('ds-key').value;
      const docsUrl = document.getElementById('ds-docs').value.trim();
      if (!name || !baseUrl) return;
      vscode.postMessage({ type: 'addDataSource', data: { name, baseUrl, authType, apiKey, docsUrl } });
      document.getElementById('add-ds-form').classList.remove('visible');
      document.getElementById('ds-name').value = '';
      document.getElementById('ds-url').value = '';
      document.getElementById('ds-key').value = '';
      document.getElementById('ds-docs').value = '';
    });

    // ── Auth UI ──
    function renderAuthState(session) {
      const signedOut = document.getElementById('auth-signed-out');
      const signedIn = document.getElementById('auth-signed-in');
      if (session) {
        signedOut.classList.remove('visible');
        signedIn.classList.add('visible');
        document.getElementById('acct-email').textContent = session.email;
      } else {
        signedOut.classList.add('visible');
        signedIn.classList.remove('visible');
      }
    }

    // Sign out (auth is now handled in sidebar — settings only has sign out)
    document.getElementById('btn-sign-out').addEventListener('click', () => {
      vscode.postMessage({ type: 'signOut' });
    });

    // ── Finance toggle ──
    var financeEnabled = true;

    function renderFinanceToggle(enabled) {
      financeEnabled = enabled;
      var icon = document.getElementById('finance-toggle-icon');
      icon.innerHTML = financeEnabled ? '&#9745;' : '&#9744;';
      icon.style.color = financeEnabled ? 'var(--jet-accent)' : 'var(--vscode-descriptionForeground)';
    }

    document.getElementById('finance-toggle').addEventListener('click', function() {
      vscode.postMessage({ type: 'toggleFinance', data: { enabled: !financeEnabled } });
    });

    // ── Database Connections ──
    function renderConnections(connections) {
      var container = document.getElementById('conn-list');
      if (!connections || connections.length === 0) {
        container.innerHTML = '<div class="empty-state">No database connections</div>';
        return;
      }
      container.innerHTML = connections.map(function(c) {
        var meta = c.engine;
        if (c.host) meta += ' · ' + c.host;
        if (c.port) meta += ':' + c.port;
        if (c.database) meta += ' / ' + c.database;
        if (c.filePath) meta += ' · ' + c.filePath;
        var statusColor = c.attached ? 'var(--jet-up)' : 'var(--vscode-descriptionForeground)';
        var statusText = c.attached ? '\\u2713 Attached' : 'Not attached';
        return '<div class="settings-row">'
          + '<span class="sr-icon" style="color:#58a6ff">&#9673;</span>'
          + '<span class="sr-name">' + c.name + '</span>'
          + '<span class="sr-meta">' + meta + '</span>'
          + '<span class="sr-status" style="color:' + statusColor + '">' + statusText + '</span>'
          + '<span class="sr-actions">'
          +   '<button data-action="browse-conn" data-slug="' + c.slug + '" data-name="' + (c.name || '').replace(/"/g, '&quot;') + '">Browse</button>'
          +   '<button data-action="remove-conn" data-slug="' + c.slug + '">Remove</button>'
          + '</span>'
          + '</div>';
      }).join('');
    }

    // ── Agent-Built Connectors ──
    function renderConnectors(connectors) {
      var container = document.getElementById('connector-list');
      if (!container) return;
      if (!connectors || connectors.length === 0) {
        container.innerHTML = '<div class="empty-state">No connectors yet</div>';
        return;
      }
      var typeIcons = { api: 'API', spreadsheet: 'SH', database: 'DB', crm: 'CRM', mcp: 'MCP', custom: 'FN' };
      container.innerHTML = connectors.map(function(c) {
        var icon = typeIcons[(c.type || '').toLowerCase()] || 'FN';
        var authLabel = c.auth ? c.auth.method : 'none';
        return '<div class="settings-row">'
          + '<span class="sr-icon" style="color:#58a6ff;font-size:9px;">' + icon + '</span>'
          + '<span class="sr-name">' + (c.name || c.slug) + '</span>'
          + '<span class="sr-meta">' + (c.type || '') + ' · ' + authLabel + '</span>'
          + '<span class="sr-actions">'
          +   '<button data-action="test-connector" data-slug="' + c.slug + '">Test</button>'
          +   '<button data-action="delete-connector" data-slug="' + c.slug + '">Delete</button>'
          + '</span>'
          + '</div>';
      }).join('');
    }

    // Connector row actions
    var connectorList = document.getElementById('connector-list');
    if (connectorList) {
      connectorList.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var action = btn.dataset.action;
        if (action === 'test-connector') {
          vscode.postMessage({ type: 'testConnector', data: { slug: btn.dataset.slug } });
        } else if (action === 'delete-connector') {
          vscode.postMessage({ type: 'deleteConnector', data: { slug: btn.dataset.slug } });
        }
      });
    }

    // Connection row actions (delegated — CSP blocks inline onclick)
    var connList = document.getElementById('conn-list');
    if (connList) connList.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      if (action === 'browse-conn') {
        vscode.postMessage({ type: 'browseConnection', data: { slug: btn.dataset.slug, name: btn.dataset.name } });
      } else if (action === 'remove-conn') {
        vscode.postMessage({ type: 'removeConnection', data: { slug: btn.dataset.slug } });
      }
    });

    // Legacy connection UI removed — agent creates connectors via jet_connector tool

    // ── Message handling ──
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'init') {
        renderDataSources(msg.data.datasources);
        renderTemplates(msg.data.templates);
        renderAuthState(msg.data.session);
        renderFinanceToggle(msg.data.financeEnabled);
        renderConnections(msg.data.connections);
        renderConnectors(msg.data.connectors);
      }
      if (msg.type === 'financeToggled') {
        renderFinanceToggle(msg.data.enabled);
      }
      if (msg.type === 'testResult') {
        var resultEl = document.getElementById('conn-test-result');
        if (msg.data.success) {
          resultEl.textContent = '\\u2713 Connection successful';
          resultEl.style.color = 'var(--jet-up)';
        } else {
          resultEl.textContent = '\\u2717 Connection failed';
          resultEl.style.color = '#F85149';
        }
        resultEl.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
