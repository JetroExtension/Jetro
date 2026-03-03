import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { FileManager } from "../services/fileManager";
import { AuthService, SignUpPendingVerification } from "../services/authService";
import { JETApiClient } from "../services/apiClient";
import { CanvasProvider } from "../canvas/CanvasProvider";
import { ShareManager } from "../services/shareManager";
export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "jetro.sidebar";
  private _view?: vscode.WebviewView;
  private fileManager: FileManager;
  private auth?: AuthService;
  private api?: JETApiClient;
  private canvasProvider?: CanvasProvider;
  private outputChannel: vscode.OutputChannel;
  private shareManager?: ShareManager;
  private deployManager?: import("../services/deployManager").DeployManager;
  private financeEnabled = true;

  constructor(
    private readonly extensionUri: vscode.Uri,
    fileManager: FileManager,
    outputChannel?: vscode.OutputChannel
  ) {
    this.fileManager = fileManager;
    this.outputChannel = outputChannel || vscode.window.createOutputChannel("Jetro");
  }

  /** Inject auth + API client after construction (avoids circular deps). */
  setServices(auth: AuthService, api: JETApiClient, canvasProvider?: CanvasProvider): void {
    this.auth = auth;
    this.api = api;
    if (canvasProvider) this.canvasProvider = canvasProvider;
  }

  /** Inject share manager for sidebar share listing + actions. */
  setShareManager(manager: ShareManager): void {
    this.shareManager = manager;
  }

  /** Inject deploy manager for sidebar deploy controls. */
  setDeployManager(manager: import("../services/deployManager").DeployManager): void {
    this.deployManager = manager;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      // Wait for webview JS to be ready before sending data
      if (msg.type === "webviewReady") {
        this.refreshAll().catch((err) => {
          this.outputChannel.appendLine(`[sidebar] refreshAll error: ${err}`);
        });
        return;
      }
      await this.handleMessage(msg);
    });
  }

  /** Send runtime status to the sidebar (shows/hides the runtime banner) */
  public sendRuntimeStatus(ready: boolean, message?: string, showRetry?: boolean): void {
    this._view?.webview.postMessage({
      type: "runtimeStatus",
      data: { ready, message, showRetry },
    });
  }

  public async refreshAll(): Promise<void> {
    if (!this._view) {
      return;
    }

    // Send auth state first — sidebar shows gate or content based on this
    const session = this.auth?.getSession();
    this._view.webview.postMessage({
      type: "authState",
      data: { signedIn: !!session, email: session?.email ?? null },
    });

    // If not signed in, don't bother loading workspace data
    if (!session) {
      return;
    }

    const index = await this.fileManager.indexWorkspace();

    // Load lists data
    const lists = [];
    for (const slug of index.lists) {
      const list = await this.fileManager.readList(slug);
      if (list) {
        lists.push({ slug, ...list });
      }
    }

    // Load canvas registry early (needed by project enrichment below)
    const canvasRegistry = await this.fileManager.readCanvasRegistry();

    // Load projects data (including source/note file lists + canvas details)
    const projects = [];
    for (const slug of index.projects) {
      const project = await this.fileManager.readProject(slug);
      if (project) {
        const files = await this.fileManager.listProjectFiles(slug);
        const allFiles = await this.fileManager.listAllProjectFiles(slug);

        // Build rich canvas data for project card (elements, sources, bindings)
        const projCanvasEntries = canvasRegistry.filter((c) => c.projectSlug === slug);
        const projCanvases = [];
        for (const entry of projCanvasEntries) {
          const cState = await this.fileManager.readCanvasById(entry.id, entry.projectSlug);
          const elements = (cState?.elements || []).map((el) => ({
            id: el.id,
            type: el.type,
            name: (el.data as Record<string, unknown>)?.title as string
              || (el.data as Record<string, unknown>)?.name as string
              || el.type,
            hidden: !!(el.data as Record<string, unknown>)?._hidden,
            hasBinding: (cState?.refreshBindings || []).some((b) => b.elementId === el.id),
          }));
          projCanvases.push({
            ...entry,
            elementCount: elements.length,
            elements,
          });
        }

        // Enrich portfolio-mode projects with summary stats
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

        projects.push({ ...project, files, allFiles, canvases: projCanvases, portfolioSummary });
      }
    }

    // Load stock profiles for quick view
    const stocks: Record<string, unknown> = {};
    for (const ticker of index.stocks) {
      const profile = await this.fileManager.readStockData(ticker, "profile");
      const ratios = await this.fileManager.readStockData(ticker, "ratios");
      const score = await this.fileManager.readStockData(ticker, "score");
      stocks[ticker] = { profile, ratios, score };
    }

    // Load recipes data
    const recipes = [];
    for (const slug of index.recipes) {
      const recipe = await this.fileManager.readRecipe(slug);
      if (recipe) {
        recipes.push(recipe);
      }
    }

    // Load canvas registry with element details (registry already loaded above)
    const canvases = [];
    for (const entry of canvasRegistry) {
      const state = await this.fileManager.readCanvasById(entry.id, entry.projectSlug);
      const elements = (state?.elements || []).map((el) => ({
        id: el.id,
        type: el.type,
        name: (el.data as Record<string, unknown>)?.title as string
          || (el.data as Record<string, unknown>)?.name as string
          || (el.data as Record<string, unknown>)?.ticker as string
          || el.type,
        hidden: !!(el.data as Record<string, unknown>)?._hidden,
        hasBinding: (state?.refreshBindings || []).some((b) => b.elementId === el.id),
      }));
      canvases.push({
        ...entry,
        elementCount: elements.length,
        elements,
      });
    }

    // Aggregate all bindings across all canvases for Status tab
    const allBindings: { canvasId: string; canvasName: string; elementName: string; binding: Record<string, unknown> }[] = [];
    for (const entry of canvasRegistry) {
      const state = await this.fileManager.readCanvasById(entry.id, entry.projectSlug);
      for (const b of state?.refreshBindings || []) {
        const elem = (state?.elements || []).find((e) => e.id === b.elementId);
        const elemName = (elem?.data as Record<string, unknown>)?.title as string || b.elementId;
        allBindings.push({
          canvasId: entry.id,
          canvasName: entry.name || entry.id,
          elementName: elemName,
          binding: b as unknown as Record<string, unknown>,
        });
      }
    }
    let bindingsPaused = false;
    try {
      const dcPath = path.join(this.fileManager.getRootPath(), ".jetro", "daemon-config.json");
      const dc = JSON.parse(fs.readFileSync(dcPath, "utf-8"));
      bindingsPaused = dc.paused === true;
    } catch { /* not paused */ }

    // Load project-scoped data (datasets, models, queries) for all projects
    for (const proj of projects) {
      const p = proj as Record<string, unknown>;
      p.datasets = [];
      try {
        const dsSlugs = await this.fileManager.listProjectDatasets(proj.slug);
        for (const s of dsSlugs) {
          const ds = await this.fileManager.readProjectDataset(proj.slug, s);
          if (ds) (p.datasets as unknown[]).push(ds);
        }
      } catch { /* no datasets */ }

      p.models = [];
      try {
        const mSlugs = await this.fileManager.listProjectModels(proj.slug);
        for (const s of mSlugs) {
          const m = await this.fileManager.readProjectModel(proj.slug, s);
          if (m) (p.models as unknown[]).push(m);
        }
      } catch { /* no models */ }

      p.queries = [];
      try {
        const qSlugs = await this.fileManager.listProjectQueries(proj.slug);
        for (const s of qSlugs) {
          const q = await this.fileManager.readProjectQuery(proj.slug, s);
          if (q) (p.queries as unknown[]).push(q);
        }
      } catch { /* no queries */ }
    }

    // Load BI mode data (global)
    const datasets = [];
    for (const slug of index.datasets) {
      const ds = await this.fileManager.readDataset(slug);
      if (ds) datasets.push(ds);
    }
    const connections = [];
    for (const slug of index.connections) {
      const conn = await this.fileManager.readConnection(slug);
      if (conn) connections.push(conn);
    }
    const connectors: Array<Record<string, unknown>> = [];
    for (const slug of (index.connectors || [])) {
      const c = await this.fileManager.readConnector(slug);
      if (c) connectors.push(c as unknown as Record<string, unknown>);
    }
    const models = [];
    for (const slug of index.models) {
      const model = await this.fileManager.readModel(slug);
      if (model) models.push(model);
    }
    const savedQueries = [];
    for (const slug of index.queries) {
      const q = await this.fileManager.readQuery(slug);
      if (q) savedQueries.push(q);
    }
    const queryHistory = await this.fileManager.readQueryHistory();
    const dashboards = [];
    for (const canvasId of await this.fileManager.listDashboards()) {
      const d = await this.fileManager.readDashboard(canvasId);
      if (d) dashboards.push(d);
    }

    // Load shares from backend (if share manager is wired)
    let shares: unknown[] = [];
    if (this.shareManager) {
      try {
        shares = await this.shareManager.listShares();
      } catch { /* no shares or not authenticated */ }
    }

    // Check daemon status
    let daemon: { running: boolean; pid?: number } = { running: false };
    try {
      const pidFile = path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "",
        ".jetro", "daemon", "daemon.pid"
      );
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, "utf-8"));
        try {
          process.kill(pid, 0);
          daemon = { running: true, pid };
        } catch { /* process dead, stale PID */ }
      }
    } catch { /* no daemon dir */ }

    // Load template catalog (bundled starters + local user templates)
    const templates: Array<{ name: string; description: string; source: string }> = [];
    try {
      const bundledDir = path.join(this.extensionUri.fsPath, "agent", "templates");
      const bundledEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(bundledDir));
      for (const [filename] of bundledEntries) {
        if (!filename.endsWith(".json")) continue;
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(bundledDir, filename)));
          const tpl = JSON.parse(new TextDecoder().decode(bytes));
          if (tpl.name) {
            templates.push({ name: tpl.name, description: tpl.description || "", source: "starter" });
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* no bundled templates dir */ }
    try {
      const localSlugs = await this.fileManager.listTemplates();
      for (const slug of localSlugs) {
        const displayName = slug.replace(/_/g, " ");
        if (!templates.some((t) => t.name.toLowerCase() === displayName.toLowerCase())) {
          templates.push({ name: displayName, description: "", source: "local" });
        }
      }
    } catch { /* no local templates */ }

    this._view.webview.postMessage({
      type: "init",
      data: {
        lists, projects, stocks, recipes, canvases, index,
        financeEnabled: this.financeEnabled,
        datasets, connections, connectors, models, savedQueries, queryHistory, dashboards,
        shares, daemon, templates, allBindings, bindingsPaused,
        deployStatus: await (async () => {
          if (!this.deployManager) return {};
          const status: Record<string, { relayConnected: boolean; port: number; relaySlug: string | null; containerAlive: boolean }> = {};
          for (const [slug, app] of this.deployManager.getApps()) {
            let alive = false;
            try {
              const { execSync } = require("child_process");
              const out = execSync(`docker ps --filter name=jet-app-${slug} --format "{{.ID}}"`, { timeout: 3000 }).toString().trim();
              alive = !!out;
            } catch { /* docker not running or container dead */ }
            status[slug] = { relayConnected: !!app.relayWs, port: app.port, relaySlug: app.relaySlug, containerAlive: alive };
            // Auto-cleanup: if container died, update project status
            if (!alive) {
              this.fileManager.updateProjectDeployment(slug, { status: "stopped", port: null, containerId: null }).catch(() => {});
              this.deployManager.getApps().delete(slug);
            }
          }
          return status;
        })(),
      },
    });
  }

  public postMessage(msg: unknown): void {
    this._view?.webview.postMessage(msg);
  }

  setFinanceEnabled(enabled: boolean): void {
    this.financeEnabled = enabled;
    this._view?.webview.postMessage({ type: "financeChanged", data: { financeEnabled: enabled } });
  }

  private async handleMessage(msg: { type: string; data?: unknown }): Promise<void> {
    switch (msg.type) {
      case "openExternal": {
        const { url } = msg.data as { url: string };
        if (url.startsWith("https://")) {
          vscode.env.openExternal(vscode.Uri.parse(url));
        }
        break;
      }
      case "authSignIn": {
        const { email, password, staySignedIn } = msg.data as { email: string; password: string; staySignedIn: boolean };
        try {
          await this.auth?.signIn(email, password, staySignedIn);
          this._view?.webview.postMessage({ type: "authState", data: { signedIn: true, email } });
          // Trigger bootstrap + full sidebar refresh now that we have auth
          vscode.commands.executeCommand("jetro.postAuthBootstrap");
        } catch (err) {
          this._view?.webview.postMessage({
            type: "authError",
            data: { form: "signin", message: err instanceof Error ? err.message : "Sign-in failed" },
          });
        }
        break;
      }
      case "reinitializeMcp": {
        vscode.commands.executeCommand("jetro.reinitializeMcp");
        break;
      }
      case "authResetPassword": {
        const { email } = msg.data as { email: string };
        try {
          await this.auth?.resetPassword(email);
          this._view?.webview.postMessage({
            type: "authResetSent",
            data: { email },
          });
        } catch (err) {
          this._view?.webview.postMessage({
            type: "authError",
            data: { form: "signin", message: err instanceof Error ? err.message : "Failed to send reset email" },
          });
        }
        break;
      }
      case "authSignUp": {
        const { email, password, staySignedIn } = msg.data as { email: string; password: string; staySignedIn: boolean };
        try {
          await this.auth?.signUp(email, password, staySignedIn);
          this._view?.webview.postMessage({ type: "authState", data: { signedIn: true, email } });
          vscode.commands.executeCommand("jetro.postAuthBootstrap");
        } catch (err) {
          if (err instanceof SignUpPendingVerification) {
            // Success — show verification message and switch to sign-in form
            this._view?.webview.postMessage({
              type: "authVerificationSent",
              data: { email: err.email },
            });
          } else {
            this._view?.webview.postMessage({
              type: "authError",
              data: { form: "signup", message: err instanceof Error ? err.message : "Sign-up failed" },
            });
          }
        }
        break;
      }
      case "authResendVerification": {
        // Switch to sign-in form — signing in with an unverified email auto-resends verification
        const pendingEmail = this.auth?.getPendingVerificationEmail();
        this._view?.webview.postMessage({
          type: "authShowSigninForResend",
          data: { email: pendingEmail || "" },
        });
        break;
      }
      case "authClearPendingVerification": {
        await this.auth?.clearPendingVerification();
        break;
      }
      case "shareElements": {
        const { canvasId: shareCanvasId, elementIds } = msg.data as { canvasId: string; elementIds: string[] };
        if (!shareCanvasId || !elementIds?.length || !this.shareManager) break;
        const shareTitle = await vscode.window.showInputBox({
          prompt: elementIds.length === 1 ? "Share title" : `Share title (${elementIds.length} elements)`,
          placeHolder: "e.g. Q3 Portfolio Review",
        });
        if (!shareTitle) break;
        try {
          const result = await this.shareManager.createShare({
            title: shareTitle,
            canvasId: shareCanvasId,
            elementIds,
          });
          await vscode.env.clipboard.writeText(result.url);
          vscode.window.showInformationMessage(
            `Share created! URL copied to clipboard.`,
            "Open in Browser"
          ).then((action) => {
            if (action === "Open in Browser") {
              vscode.env.openExternal(vscode.Uri.parse(result.url));
            }
          });
          await this.refreshAll();
        } catch (err) {
          vscode.window.showErrorMessage(`Share failed: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }
      case "selectStock": {
        const { ticker } = msg.data as { ticker: string };
        const stockData = await this.fileManager.readStockAll(ticker);
        this._view?.webview.postMessage({
          type: "stockSelected",
          data: { ticker, ...stockData },
        });
        break;
      }
      case "createProject": {
        const { name } = msg.data as { name: string };
        const slug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
        await this.fileManager.writeProject(name, {
          name,
          slug,
          status: "active",
          securities: [],
          sources: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        // Auto-create and open a default canvas so the agent is scoped immediately
        if (this.canvasProvider) {
          await this.canvasProvider.create("Canvas 1", slug);
        }
        await this.refreshAll();
        break;
      }
      case "createList": {
        const { name: listName } = msg.data as { name: string };
        await this.fileManager.writeList(listName, {
          name: listName,
          tickers: [],
          refreshable: false,
          createdAt: new Date().toISOString(),
        });
        await this.refreshAll();
        break;
      }
      case "togglePortfolioMode": {
        const { slug: tpmSlug } = msg.data as { slug: string };
        const tpmProject = await this.fileManager.readProject(tpmSlug);
        if (tpmProject) {
          if (tpmProject.mode === "portfolio") {
            tpmProject.mode = undefined;
            tpmProject.updatedAt = new Date().toISOString();
            await this.fileManager.writeProject(tpmProject.name, tpmProject);
            await this.fileManager.deletePortfolioData(tpmSlug);
          } else {
            tpmProject.mode = "portfolio";
            tpmProject.updatedAt = new Date().toISOString();
            await this.fileManager.writeProject(tpmProject.name, tpmProject);
          }
          await this.refreshAll();
        }
        break;
      }
      case "openRecipe": {
        const { slug: recipeSlug } = msg.data as { slug: string };
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          const recipeUri = vscode.Uri.joinPath(
            workspaceFolder.uri,
            ".jetro",
            "recipes",
            `${recipeSlug}.json`
          );
          vscode.window.showTextDocument(recipeUri);
        }
        break;
      }
      case "openSettings":
        vscode.commands.executeCommand("jetro.openSettings");
        break;
      case "openCanvas": {
        const { canvasId: openCid } = (msg.data || {}) as { canvasId?: string };
        if (openCid) {
          vscode.commands.executeCommand("jetro.openCanvasById", openCid);
        } else {
          vscode.commands.executeCommand("jetro.openCanvas");
        }
        break;
      }
      case "openCompanion":
        vscode.commands.executeCommand("jetro.openCompanion");
        break;
      case "renameProject": {
        const { slug: renameSlug, newName } = msg.data as { slug: string; newName: string };
        const existing = await this.fileManager.readProject(renameSlug);
        if (existing) {
          existing.name = newName;
          existing.updatedAt = new Date().toISOString();
          // Write using slug (slugify(slug) === slug) to keep same folder
          await this.fileManager.writeProject(renameSlug, existing);
        }
        await this.refreshAll();
        break;
      }
      case "deleteProject": {
        const { slug: delProjSlug } = msg.data as { slug: string };
        if (delProjSlug) {
          const confirm = await vscode.window.showWarningMessage(
            `Delete project "${delProjSlug}"? This removes all project files.`,
            { modal: true },
            "Delete"
          );
          if (confirm === "Delete") {
            await this.fileManager.deleteProject(delProjSlug);
            await this.refreshAll();
          }
        }
        break;
      }
      case "setProjectStatus": {
        const { slug: statusSlug, status } = msg.data as { slug: string; status: string };
        const proj = await this.fileManager.readProject(statusSlug);
        if (proj) {
          proj.status = status as "active" | "draft" | "done";
          proj.updatedAt = new Date().toISOString();
          await this.fileManager.writeProject(statusSlug, proj);
          await this.refreshAll();
        }
        break;
      }
      case "deleteList": {
        const { slug: delListSlug } = msg.data as { slug: string };
        if (delListSlug) {
          await this.fileManager.deleteList(delListSlug);
          await this.refreshAll();
        }
        break;
      }
      case "renameList": {
        const { slug: rnListSlug, newName: rnListName } = msg.data as { slug: string; newName: string };
        const list = await this.fileManager.readList(rnListSlug);
        if (list) {
          list.name = rnListName;
          await this.fileManager.writeList(rnListSlug, list);
          await this.refreshAll();
        }
        break;
      }
      case "deleteRecipe": {
        const { slug: delRecipeSlug } = msg.data as { slug: string };
        if (delRecipeSlug) {
          await this.fileManager.deleteRecipe(delRecipeSlug);
          await this.refreshAll();
        }
        break;
      }
      case "triggerRefresh": {
        const { canvasId: trCanvasId, elementId: trElementId } = msg.data as { canvasId: string; elementId: string };
        if (trCanvasId && trElementId && this.canvasProvider) {
          vscode.commands.executeCommand("jetro.triggerRefresh", trCanvasId, trElementId);
        }
        break;
      }
      case "deleteDataset": {
        const { slug: delDsSlug } = msg.data as { slug: string };
        if (delDsSlug) {
          await this.fileManager.deleteDataset(delDsSlug);
          await this.refreshAll();
        }
        break;
      }
      case "deleteTemplate": {
        const { slug: delTplSlug } = msg.data as { slug: string };
        if (delTplSlug) {
          await this.fileManager.deleteTemplate(delTplSlug);
          await this.refreshAll();
        }
        break;
      }
      case "openTemplate": {
        const { slug: openTplSlug } = msg.data as { slug: string };
        const wfTpl = vscode.workspace.workspaceFolders?.[0];
        if (wfTpl && openTplSlug) {
          const tplUri = vscode.Uri.joinPath(wfTpl.uri, ".jetro", "templates", `${openTplSlug}.html`);
          vscode.window.showTextDocument(tplUri);
        }
        break;
      }
      case "openProjectCanvas": {
        const { slug: projSlug } = msg.data as { slug: string };
        if (projSlug) {
          vscode.commands.executeCommand("jetro.openProjectCanvas", projSlug);
        }
        break;
      }
      case "openCanvasById": {
        const { canvasId } = msg.data as { canvasId: string };
        if (canvasId) {
          vscode.commands.executeCommand("jetro.openCanvasById", canvasId);
        }
        break;
      }
      case "openCanvasInCompanion": {
        const { canvasId: companionCanvasId } = msg.data as { canvasId: string };
        if (companionCanvasId) {
          vscode.commands.executeCommand("jetro.openCompanionCanvas", companionCanvasId);
        }
        break;
      }
      case "createCanvas": {
        const { name: canvasName, projectSlug: canvasProject } = msg.data as {
          name: string;
          projectSlug?: string;
        };
        if (canvasName) {
          vscode.commands.executeCommand(
            "jetro.createCanvas",
            canvasName,
            canvasProject || null
          );
          // refreshAll will be called by the command handler
        }
        break;
      }
      case "deleteCanvas": {
        const { canvasId: delId } = msg.data as { canvasId: string };
        if (delId) {
          vscode.commands.executeCommand("jetro.deleteCanvas", delId);
        }
        break;
      }
      case "canvasHistory": {
        const { canvasId: hCanvasId } = msg.data as { canvasId: string };
        if (hCanvasId) {
          vscode.commands.executeCommand("jetro.canvasHistory", hCanvasId);
        }
        break;
      }
      case "deleteElement": {
        const { canvasId: dCanvasId, elementId: dElId } = msg.data as { canvasId: string; elementId: string };
        if (dCanvasId && dElId) {
          vscode.commands.executeCommand("jetro.deleteCanvasElement", dCanvasId, dElId);
        }
        break;
      }
      case "toggleElement": {
        const { canvasId: tCanvasId, elementId: tElId } = msg.data as { canvasId: string; elementId: string };
        if (tCanvasId && tElId) {
          vscode.commands.executeCommand("jetro.toggleCanvasElement", tCanvasId, tElId);
        }
        break;
      }
      case "renameCanvas": {
        const { canvasId: renId, newName: renName } = msg.data as {
          canvasId: string;
          newName: string;
        };
        if (renId && renName) {
          const registry = await this.fileManager.readCanvasRegistry();
          const entry = registry.find((e) => e.id === renId);
          if (entry) {
            entry.name = renName;
            await this.fileManager.writeCanvasRegistry(registry);
          }
          await this.refreshAll();
        }
        break;
      }
      case "viewListOnCanvas": {
        const { slug: listSlug } = msg.data as { slug: string };
        vscode.commands.executeCommand("jetro.viewListOnCanvas", listSlug);
        break;
      }
      case "refreshList": {
        const { slug: refreshSlug } = msg.data as { slug: string };
        vscode.commands.executeCommand("jetro.refreshList", refreshSlug);
        break;
      }
      case "openProjectFile": {
        const { projectSlug: pfSlug, fileName: pfFile, dir: pfDir } = msg.data as {
          projectSlug: string; fileName: string; dir: string;
        };
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          const fileUri = vscode.Uri.joinPath(
            workspaceFolder.uri,
            "projects",
            pfSlug,
            pfDir,
            pfFile
          );
          vscode.window.showTextDocument(fileUri).then(undefined, () => {
            // If it can't be opened as text (binary), open externally
            vscode.env.openExternal(fileUri);
          });
        }
        break;
      }
      case "deleteProjectFile": {
        const { projectSlug: delPSlug, fileName: delFile, dir: delDir } = msg.data as {
          projectSlug: string; fileName: string; dir: string;
        };
        const confirmDel = await vscode.window.showWarningMessage(
          `Delete "${delFile}" from project?`,
          { modal: true },
          "Delete"
        );
        if (confirmDel === "Delete") {
          try {
            const wsFolder = vscode.workspace.workspaceFolders?.[0];
            if (wsFolder) {
              const relPath = delDir === "." ? delFile : `${delDir}/${delFile}`;
              const delUri = vscode.Uri.joinPath(wsFolder.uri, "projects", delPSlug, relPath);
              await vscode.workspace.fs.delete(delUri);
              await this.refreshAll();
            }
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to delete: ${err}`);
          }
        }
        break;
      }
      case "parseProjectFile": {
        const { projectSlug: parseSlug, fileName: parseFile } = msg.data as {
          projectSlug: string; fileName: string;
        };
        const filePath = `projects/${parseSlug}/sources/${parseFile}`;
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Parsing ${parseFile}...` },
          async () => {
            try {
              const { JetParseTool } = await import("../tools/jetParse");
              const parser = new JetParseTool(this.fileManager, vscode.window.createOutputChannel("Jetro"));
              await parser.execute({ file: filePath, projectSlug: parseSlug });
              await this.refreshAll();
              vscode.window.showInformationMessage(`Parsed ${parseFile} successfully`);
            } catch (err) {
              vscode.window.showErrorMessage(`Parse failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        );
        break;
      }
      case "viewNoteOnCanvas": {
        const { projectSlug: noteSlug, fileName: noteFile } = msg.data as {
          projectSlug: string; fileName: string;
        };
        const noteName = noteFile.replace(/\.md$/, "");
        const noteContent = await this.fileManager.readProjectNote(noteSlug, noteName);
        if (noteContent) {
          // Render as a note element on the project's canvas
          vscode.commands.executeCommand("jetro.openProjectCanvas", noteSlug);
        }
        break;
      }
      case "fetchStock": {
        const { symbol, name: companyName, exchange: exch } = msg.data as { symbol: string; name?: string; exchange?: string };
        if (!this.auth || !this.api) {
          vscode.window.showWarningMessage("Not connected — sign in to fetch stock data.");
          break;
        }
        const jwt = await this.auth.getToken();
        if (!jwt) break;

        // Show progress
        this._view?.webview.postMessage({
          type: "fetchingStock",
          data: { symbol, status: "loading" },
        });

        try {
          // Fetch profile from Equity API
          const profileData = await this.api.data(jwt, "fmp", `/profile/${symbol}`);
          const profile = Array.isArray(profileData) ? profileData[0] : profileData;

          if (profile) {
            // Save locally so it appears in sidebar
            await this.fileManager.writeStockData(symbol, "profile", profile);
            await this.refreshAll();

            // Show in quick view (switch to market tab)
            this._view?.webview.postMessage({
              type: "stockFetched",
              data: { symbol, profile },
            });
          }

          // Pre-fill agent chat with the ticker
          const prompt = `I want to research ${companyName || symbol} (${symbol}). Fetch its financial ratios and key metrics, and render a company card to the Research Board.`;
          try {
            await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
          } catch {
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(
              `${symbol} profile saved. Prompt copied to clipboard — paste it in the chat panel.`
            );
          }
        } catch (err) {
          this._view?.webview.postMessage({
            type: "fetchingStock",
            data: { symbol, status: "error" },
          });
          vscode.window.showErrorMessage(`Failed to fetch ${symbol}: ${err}`);
        }
        break;
      }
      case "searchSymbols": {
        const { query: sq } = msg.data as { query: string };
        if (!this.auth || !this.api) {
          this.outputChannel.appendLine("[search] No auth/api — skipping symbol search");
          this._view?.webview.postMessage({ type: "searchResults", data: { query: sq, results: [] } });
          break;
        }
        const jwt = await this.auth.getToken();
        if (!jwt) {
          this.outputChannel.appendLine("[search] No JWT — skipping symbol search");
          this._view?.webview.postMessage({ type: "searchResults", data: { query: sq, results: [] } });
          break;
        }
        try {
          const raw = await this.api.data(jwt, "fmp", "/search", {
            query: sq,
            limit: "10",
          });
          // API may return a plain array or a wrapped object like { result: [...] }
          const results = Array.isArray(raw) ? raw
            : Array.isArray((raw as Record<string, unknown>)?.result) ? (raw as Record<string, unknown>).result
            : Array.isArray((raw as Record<string, unknown>)?.data) ? (raw as Record<string, unknown>).data
            : [];
          this._view?.webview.postMessage({
            type: "searchResults",
            data: { query: sq, results },
          });
        } catch (err) {
          this.outputChannel.appendLine(`[search] Error searching "${sq}": ${err}`);
          this._view?.webview.postMessage({
            type: "searchResults",
            data: { query: sq, results: [] },
          });
        }
        break;
      }
      case "promptInput": {
        const { kind } = msg.data as { kind: string };
        const labels: Record<string, string> = { list: "List", portfolio: "Portfolio" };
        const label = labels[kind] || kind;
        const inputName = await vscode.window.showInputBox({
          prompt: `Enter ${label} name`,
          placeHolder: `My ${label}...`,
        });
        if (inputName) {
          if (kind === "list") {
            await this.handleMessage({ type: "createList", data: { name: inputName } });
          } else if (kind === "portfolio") {
            await this.handleMessage({ type: "createPortfolio", data: { name: inputName } });
          }
        }
        break;
      }
      case "addProjectFiles": {
        const addFilesProjSlug = (msg.data as { projectSlug: string }).projectSlug;
        vscode.commands.executeCommand("jetro.addProjectFiles", addFilesProjSlug);
        break;
      }
      case "addData": {
        const projSlug = msg.data ? (msg.data as { projectSlug?: string }).projectSlug : undefined;
        vscode.commands.executeCommand("jetro.addData", projSlug);
        break;
      }
      case "importDataset":
        vscode.commands.executeCommand("jetro.addData");
        break;
      case "importProjectData": {
        const { projectSlug: importProjSlug } = msg.data as { projectSlug: string };
        vscode.commands.executeCommand("jetro.addData", importProjSlug);
        break;
      }
      case "addConnection":
        vscode.commands.executeCommand("jetro.addData");
        break;
      case "selectDataset": {
        const { slug: dsSlug } = msg.data as { slug: string };
        // Preview first 100 rows in editor
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder && dsSlug) {
          const ds = await this.fileManager.readDataset(dsSlug);
          if (ds && ds.files.length > 0) {
            const fileUri = vscode.Uri.joinPath(
              workspaceFolder.uri, "data", "datasets", dsSlug, ds.files[0]
            );
            vscode.window.showTextDocument(fileUri).then(undefined, () => {
              vscode.env.openExternal(fileUri);
            });
          }
        }
        break;
      }
      case "publishDashboard": {
        const { canvasId: pubCanvasId } = msg.data as { canvasId: string };
        vscode.commands.executeCommand("jetro.publishDashboard", pubCanvasId);
        break;
      }
      case "newProjectCanvas": {
        const { projectSlug: newCanvasProjSlug } = msg.data as { projectSlug: string };
        const canvasName = await vscode.window.showInputBox({ prompt: "Canvas name" });
        if (canvasName && this.canvasProvider) {
          const canvasId = await this.canvasProvider.create(canvasName, newCanvasProjSlug);
          await this.canvasProvider.open(canvasId);
        }
        break;
      }
      case "linkResource": {
        const { projectSlug: linkProjSlug, resourceType } = msg.data as { projectSlug: string; resourceType: string };
        const project = await this.fileManager.readProject(linkProjSlug);
        if (!project) break;

        // Build QuickPick items from global resources not yet linked
        let items: vscode.QuickPickItem[] = [];
        if (resourceType === "connector") {
          const allConnectors = await this.fileManager.listConnectors();
          const linked = new Set(project.linkedConnectors || []);
          for (const slug of allConnectors) {
            if (linked.has(slug)) continue;
            const conn = await this.fileManager.readConnector(slug);
            if (conn) items.push({ label: conn.name, description: conn.type, detail: slug });
          }
        } else if (resourceType === "connection") {
          const allConns = await this.fileManager.listConnections();
          const linked = new Set(project.linkedConnections || []);
          for (const slug of allConns) {
            if (linked.has(slug)) continue;
            const conn = await this.fileManager.readConnection(slug);
            if (conn) items.push({ label: conn.name, description: conn.engine, detail: slug });
          }
        } else if (resourceType === "recipe") {
          const allRecipes = await this.fileManager.listRecipes();
          const linked = new Set(project.linkedRecipes || []);
          for (const slug of allRecipes) {
            if (linked.has(slug)) continue;
            const recipe = await this.fileManager.readRecipe(slug);
            if (recipe) items.push({ label: recipe.name, description: recipe.description, detail: slug });
          }
        } else if (resourceType === "template") {
          // Templates are .html files — list slugs from .jetro/templates/
          const index = await this.fileManager.indexWorkspace();
          const linked = new Set(project.linkedTemplates || []);
          for (const slug of index.templates) {
            if (linked.has(slug)) continue;
            items.push({ label: slug, detail: slug });
          }
        }

        if (items.length === 0) {
          vscode.window.showInformationMessage(`No unlinked ${resourceType}s available to link.`);
          break;
        }

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `Select a ${resourceType} to link to "${project.name}"`,
        });
        if (!picked) break;

        const resourceSlug = picked.detail!;
        const fieldMap: Record<string, "linkedConnectors" | "linkedConnections" | "linkedTemplates" | "linkedRecipes"> = {
          connector: "linkedConnectors",
          connection: "linkedConnections",
          template: "linkedTemplates",
          recipe: "linkedRecipes",
        };
        const field = fieldMap[resourceType];
        if (field) {
          const arr = (project[field] || []) as string[];
          if (!arr.includes(resourceSlug)) {
            arr.push(resourceSlug);
            (project as unknown as Record<string, unknown>)[field] = arr;
            project.updatedAt = new Date().toISOString();
            await this.fileManager.writeProject(project.name, project);
            await this.refreshAll();
          }
        }
        break;
      }
      case "unlinkResource": {
        const { projectSlug: unlinkProjSlug, resourceType: unlinkType, resourceSlug: unlinkSlug } =
          msg.data as { projectSlug: string; resourceType: string; resourceSlug: string };
        const proj = await this.fileManager.readProject(unlinkProjSlug);
        if (!proj) break;

        const unlinkFieldMap: Record<string, "linkedConnectors" | "linkedConnections" | "linkedTemplates" | "linkedRecipes"> = {
          connector: "linkedConnectors",
          connection: "linkedConnections",
          template: "linkedTemplates",
          recipe: "linkedRecipes",
        };
        const unlinkField = unlinkFieldMap[unlinkType];
        if (unlinkField) {
          (proj as unknown as Record<string, unknown>)[unlinkField] =
            ((proj[unlinkField] || []) as string[]).filter((s) => s !== unlinkSlug);
          proj.updatedAt = new Date().toISOString();
          await this.fileManager.writeProject(proj.name, proj);
          await this.refreshAll();
        }
        break;
      }
      case "openLinkedConnection": {
        const { slug: connSlug } = msg.data as { slug: string };
        vscode.commands.executeCommand("jetro.openConnector.browse", connSlug);
        break;
      }
      case "openLinkedRecipe": {
        const { slug: linkedRecipeSlug } = msg.data as { slug: string };
        const wf = vscode.workspace.workspaceFolders?.[0];
        if (wf) {
          const recipeUri = vscode.Uri.joinPath(wf.uri, ".jetro", "recipes", `${linkedRecipeSlug}.json`);
          vscode.window.showTextDocument(recipeUri);
        }
        break;
      }
      case "openLinkedTemplate": {
        const { slug: linkedTplSlug } = msg.data as { slug: string };
        const wf2 = vscode.workspace.workspaceFolders?.[0];
        if (wf2) {
          const tplUri = vscode.Uri.joinPath(wf2.uri, ".jetro", "templates", `${linkedTplSlug}.html`);
          vscode.window.showTextDocument(tplUri);
        }
        break;
      }
      case "toggleBindingPause": {
        const { canvasId: bCanvasId, elementId: bElemId } = msg.data as { canvasId: string; elementId: string };
        if (this.canvasProvider) {
          const state = await this.fileManager.readCanvasById(bCanvasId, null);
          if (state?.refreshBindings) {
            const b = state.refreshBindings.find((rb) => rb.elementId === bElemId);
            if (b) {
              b.enabled = !b.enabled;
              await this.fileManager.writeCanvasById(bCanvasId, state, null);
              this.outputChannel.appendLine(`[bindings] ${b.enabled ? "Resumed" : "Paused"}: ${bElemId}`);
            }
          }
        }
        await this.refreshAll();
        break;
      }
      case "toggleGlobalPause": {
        // Delegate to the command which handles timers, binding states, status bar, and canvas badges
        await vscode.commands.executeCommand("jetro.toggleGlobalPause");
        await this.refreshAll();
        break;
      }
      case "triggerBinding": {
        const { canvasId: tCanvasId, elementId: tElemId } = msg.data as { canvasId: string; elementId: string };
        vscode.commands.executeCommand("jetro.triggerBinding", tCanvasId, tElemId);
        break;
      }
      case "deploy-preview": {
        const { port: previewPort } = msg.data as { port: string };
        if (previewPort) {
          vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${previewPort}`));
        }
        break;
      }
      case "deploy-stop": {
        const { slug: dStopSlug } = msg.data as { slug: string };
        if (this.deployManager) {
          try {
            await this.deployManager.stop(dStopSlug);
            vscode.window.showInformationMessage(`Stopped deployment: ${dStopSlug}`);
          } catch (err) { vscode.window.showErrorMessage(`Stop failed: ${err}`); }
          await this.refreshAll();
        }
        break;
      }
      case "deploy-start": {
        const { slug: dStartSlug } = msg.data as { slug: string };
        if (this.deployManager) {
          try {
            const deployDir = `${this.fileManager.getRootPath()}/projects/${dStartSlug}/deploy`;
            await this.deployManager.start(dStartSlug, deployDir);
            vscode.window.showInformationMessage(`Restarted deployment: ${dStartSlug}`);
          } catch (err) { vscode.window.showErrorMessage(`Start failed: ${err}`); }
          await this.refreshAll();
        }
        break;
      }
      case "deploy-redeploy": {
        const { slug: dReSlug } = msg.data as { slug: string };
        if (this.deployManager) {
          try {
            await this.deployManager.redeploy(dReSlug);
            vscode.window.showInformationMessage(`Redeployed: ${dReSlug}`);
          } catch (err) { vscode.window.showErrorMessage(`Redeploy failed: ${err}`); }
          await this.refreshAll();
        }
        break;
      }
      case "deploy-remove": {
        const { slug: dRmSlug } = msg.data as { slug: string };
        const confirm = await vscode.window.showWarningMessage(
          `Remove deployment for ${dRmSlug}? This stops the container and deregisters the public URL.`,
          { modal: true }, "Remove"
        );
        if (confirm === "Remove" && this.deployManager) {
          try {
            await this.deployManager.remove(dRmSlug);
            vscode.window.showInformationMessage(`Removed deployment: ${dRmSlug}`);
          } catch (err) { vscode.window.showErrorMessage(`Remove failed: ${err}`); }
          await this.refreshAll();
        }
        break;
      }
      case "deploy-copyUrl": {
        const { url: dUrl } = msg.data as { url: string };
        await vscode.env.clipboard.writeText(dUrl);
        vscode.window.showInformationMessage("URL copied to clipboard");
        break;
      }
      case "copyShareLink": {
        const { url: shareUrl } = msg.data as { url: string };
        if (shareUrl) {
          await vscode.env.clipboard.writeText(shareUrl);
          vscode.window.showInformationMessage("Share link copied to clipboard");
        }
        break;
      }
      case "pauseShare": {
        const { shareId: pauseId } = msg.data as { shareId: string };
        if (pauseId && this.shareManager) {
          await this.shareManager.pauseShare(pauseId);
          await this.refreshAll();
        }
        break;
      }
      case "resumeShare": {
        const { shareId: resumeId } = msg.data as { shareId: string };
        if (resumeId && this.shareManager) {
          await this.shareManager.resumeShare(resumeId);
          await this.refreshAll();
        }
        break;
      }
      case "revokeShare": {
        const { shareId: revokeId } = msg.data as { shareId: string };
        if (revokeId && this.shareManager) {
          const confirm = await vscode.window.showWarningMessage(
            "Revoke this share? The URL will stop working permanently.",
            { modal: true },
            "Revoke"
          );
          if (confirm === "Revoke") {
            await this.shareManager.revokeShare(revokeId);
            await this.refreshAll();
          }
        }
        break;
      }
      case "startDaemon": {
        vscode.commands.executeCommand("jetro.daemonStart");
        break;
      }
      case "stopDaemon": {
        vscode.commands.executeCommand("jetro.daemonStop");
        break;
      }
      case "addConnection": {
        vscode.commands.executeCommand("jetro.openConnector");
        break;
      }
      case "browseConnection": {
        const { slug, name } = msg.data as { slug: string; name?: string };
        vscode.commands.executeCommand("jetro.openConnector.browse", slug, name);
        break;
      }
      case "testConnector": {
        const { slug: testSlug } = msg.data as { slug: string };
        vscode.commands.executeCommand("jetro.testConnector", testSlug);
        break;
      }
      case "deleteConnector": {
        const { slug: delSlug } = msg.data as { slug: string };
        vscode.commands.executeCommand("jetro.deleteConnector", delSlug);
        break;
      }
      case "refreshShares": {
        if (this.shareManager) {
          const shares = await this.shareManager.listShares();
          this._view?.webview.postMessage({ type: "sharesUpdated", data: { shares } });
        }
        break;
      }
      case "refresh":
        await this.refreshAll();
        break;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const alreadySignedIn = !!this.auth?.getSession();
    const pendingVerificationEmail = this.auth?.getPendingVerificationEmail() || "";

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src data:;">
  <style>
    :root {
      --jet-accent: #DEBFCA;
      --jet-accent-dim: rgba(222,191,202,0.12);
      --jet-blue: #58A6FF;
      --jet-blue-dim: rgba(88,166,255,0.12);
      --jet-up: #3FB950;
      --jet-up-dim: rgba(63,185,80,0.15);
      --jet-down: #F85149;
      --jet-down-dim: rgba(248,81,73,0.15);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      overflow-x: hidden;
    }

    /* B1: Custom scrollbar — force CSS scrollbar over native macOS overlay */
    * { scrollbar-color: rgba(222,191,202,0.2) transparent; scrollbar-width: thin; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(222,191,202,0.2); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(222,191,202,0.35); }
    ::-webkit-scrollbar-thumb:active { background: rgba(222,191,202,0.5); }

    /* ── Tab bar ── */
    .tab-bar {
      display: flex;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      position: sticky;
      top: 0;
      z-index: 10;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .tab-bar::-webkit-scrollbar { display: none; }
    .tab {
      flex-shrink: 0;
      padding: 8px 10px;
      text-align: center;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      cursor: pointer;
      color: var(--vscode-foreground);
      opacity: 0.6;
      border-bottom: 2px solid transparent;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .tab:hover { opacity: 0.85; }
    .tab.active {
      opacity: 1;
      border-bottom-color: var(--jet-accent);
      color: var(--jet-accent);
      text-shadow: 0 0 8px rgba(222,191,202,0.3);
    }

    /* ── Tab content ── */
    .tab-content { display: none; padding: 12px 12px 48px 12px; }
    .tab-content.active { display: block; }

    /* ── Section headers ── */
    .section-header {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-foreground);
      opacity: 0.7;
      margin: 16px 0 8px 0;
      padding-top: 3px;
      border-top: 1px solid rgba(222,191,202,0.18);
      box-shadow: 0 -1px 6px rgba(222,191,202,0.08);
    }
    .tab-content > div:first-child > .section-header { margin-top: 8px; border-top: none; padding-top: 0; box-shadow: none; }

    /* ── Search input ── */
    .search-input {
      width: 100%;
      padding: 6px 10px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-input-foreground);
      font-size: 13px;
      border-radius: 2px;
      outline: none;
    }
    .search-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .search-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    /* ── List items ── */
    .list-item {
      display: flex;
      align-items: center;
      padding: 6px 8px;
      cursor: pointer;
      border-radius: 3px;
      gap: 8px;
    }
    .list-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .list-item .icon {
      width: 20px;
      height: 20px;
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .list-item .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list-item .meta {
      font-size: 11px;
      opacity: 0.5;
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
    }

    /* ── List cards ── */
    .list-card-v2 {
      padding: 10px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin-bottom: 8px;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .list-card-v2:hover { border-color: var(--jet-accent); box-shadow: 0 1px 6px rgba(222,191,202,0.08); }
    .list-card-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .list-name { font-size: 12px; font-weight: 600; }
    .list-count { font-size: 10px; opacity: 0.5; }
    .list-desc {
      font-size: 11px;
      opacity: 0.5;
      margin-top: 4px;
      line-height: 1.4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list-card-actions {
      display: flex;
      gap: 4px;
      margin-top: 8px;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .list-card-v2:hover .list-card-actions { opacity: 1; }
    .list-card-actions button {
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 3px;
      border: 1px solid var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      opacity: 0.8;
      transition: all 0.12s ease;
    }
    .list-card-actions button:hover { border-color: var(--jet-accent); color: var(--jet-accent); }
    .list-card-actions button.danger:hover { border-color: var(--jet-down); color: var(--jet-down); }
    .auto-badge {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 2px;
      background: rgba(63,185,80,0.15);
      color: var(--jet-up);
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    /* ── Stock result icon ── */
    .stock-icon {
      background: var(--jet-blue-dim);
      color: var(--jet-blue);
    }

    /* ── Two-panel project layout ── */
    #tab-projects { padding: 0 !important; }
    #tab-projects.active { display: flex; flex-direction: column; overflow: hidden; height: 100%; }
    .projects-panel { display: flex; flex-direction: column; overflow: hidden; min-height: 60px; }
    #projects-top-panel { flex: 0 0 auto; height: 40%; }
    #projects-bottom-panel { flex: 1; }
    .panel-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px 4px; flex-shrink: 0;
    }
    .panel-label {
      font-size: 11px; font-weight: 600; opacity: 0.5;
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .panel-add-btn {
      width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
      border-radius: 3px; background: none; border: none; cursor: pointer;
      color: var(--vscode-foreground); opacity: 0.5; font-size: 14px;
      transition: all 0.12s ease;
    }
    .panel-add-btn:hover { opacity: 1; color: var(--jet-accent); background: rgba(222,191,202,0.08); }
    .panel-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 2px 6px; }
    .panel-divider {
      height: 5px; cursor: row-resize; background: var(--vscode-panel-border);
      position: relative; flex-shrink: 0;
    }
    .panel-divider::after {
      content: ''; position: absolute; left: 30%; right: 30%; top: 2px;
      height: 1px; background: rgba(222,191,202,0.3); border-radius: 1px;
    }
    .panel-divider:hover, .panel-divider.dragging { background: rgba(222,191,202,0.4); }

    /* ── Project row (flat list) ── */
    .project-row {
      display: flex; align-items: center; gap: 7px;
      padding: 6px 10px; cursor: pointer; border-radius: 3px;
      transition: background 0.1s ease;
    }
    .project-row:hover { background: var(--vscode-list-hoverBackground); }
    .project-row.selected {
      background: var(--jet-accent-dim);
      border-left: 2px solid var(--jet-accent);
      padding-left: 8px;
    }
    .project-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    }
    .project-dot.active { background: var(--jet-up); }
    .project-dot.draft { background: var(--jet-accent); }
    .project-dot.done { background: var(--jet-blue); }
    .project-name {
      font-size: 13px; font-weight: 500; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .project-name-input {
      flex: 1; font-size: 13px; font-weight: 600;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-focusBorder);
      color: var(--vscode-input-foreground);
      padding: 1px 4px; border-radius: 2px; outline: none;
    }
    .status-badge {
      font-size: 9px; padding: 2px 6px; border-radius: 3px;
      text-transform: uppercase; font-weight: 600;
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
    }
    .badge-active { background: var(--jet-up-dim); color: var(--jet-up); }
    .badge-draft { background: var(--jet-accent-dim); color: var(--jet-accent); }
    .badge-done { background: var(--jet-blue-dim); color: var(--jet-blue); }

    /* ── Detail panel sections ── */
    .detail-section-hdr {
      display: flex; align-items: center; gap: 4px;
      padding: 6px 8px 3px; font-size: 11px; font-weight: 600;
      color: var(--vscode-foreground); opacity: 0.6; cursor: pointer;
      border-top: 1px solid rgba(222,191,202,0.06);
    }
    .detail-section-hdr:first-child { border-top: none; }
    .detail-section-hdr .section-add-btn {
      margin-left: auto; opacity: 0; font-size: 12px; cursor: pointer;
      background: none; border: none; color: var(--jet-accent); padding: 0 4px;
      transition: opacity 0.12s;
    }
    .detail-section-hdr:hover .section-add-btn { opacity: 0.7; }
    .detail-section-hdr .section-add-btn:hover { opacity: 1; }
    .detail-section-hdr .section-chevron {
      font-size: 9px; transition: transform 0.15s; display: inline-block;
    }
    .detail-section-hdr .section-chevron.open { transform: rotate(90deg); }
    .detail-section-items { padding-left: 4px; }
    .detail-empty {
      display: flex; align-items: center; justify-content: center;
      height: 100%; font-size: 12px; opacity: 0.35; font-style: italic;
    }
    .project-tree-group {
      display: flex; align-items: center; gap: 4px;
      padding: 3px 4px; font-size: 11px; font-weight: 600;
      color: var(--vscode-foreground); opacity: 0.6;
    }
    .project-tree-item {
      display: flex; align-items: center; gap: 6px;
      padding: 2px 4px 2px 18px; font-size: 12px; cursor: pointer;
      border-radius: 3px;
    }
    .project-tree-item:hover { background: var(--vscode-list-hoverBackground); }
    .project-tree-item .pt-ticker {
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
      font-size: 11px; opacity: 0.7;
    }
    .project-linked-item {
      display: flex; align-items: center; gap: 6px;
      padding: 2px 4px 2px 18px; font-size: 12px; cursor: pointer;
      border-radius: 3px;
    }
    .project-linked-item:hover { background: var(--vscode-list-hoverBackground); }
    .project-linked-item .linked-icon {
      font-size: 10px; opacity: 0.5; width: 18px; text-align: center;
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
    }
    .project-linked-item .linked-name { flex: 1; }
    .project-linked-item .linked-meta {
      font-size: 10px; opacity: 0.35;
    }
    .project-linked-item .unlink-btn {
      opacity: 0; font-size: 10px; cursor: pointer;
      background: none; border: none; color: #f85149; padding: 0 2px;
    }
    .project-linked-item:hover .unlink-btn { opacity: 0.7; }
    .project-linked-item .unlink-btn:hover { opacity: 1; }
    .project-tree-group .link-add-btn {
      opacity: 0; font-size: 10px; cursor: pointer;
      background: none; border: none; color: var(--jet-accent); padding: 0 2px;
      margin-left: 4px;
    }
    .project-tree-group:hover .link-add-btn { opacity: 0.7; }
    .project-tree-group .link-add-btn:hover { opacity: 1; }
    .project-tree-group .tree-arrow {
      display: inline-block; transition: transform 0.15s; font-size: 9px;
    }
    .project-tree-group .tree-arrow.open { transform: rotate(90deg); }
    .project-tree-group[data-action="toggleTreeSection"] { cursor: pointer; }
    .tree-section-items { display: none; border-left: 1px solid rgba(222,191,202,0.06); margin-left: 8px; padding-left: 4px; }
    .tree-section-items.open { display: block; }
    .project-file-item .file-delete-btn {
      opacity: 0; font-size: 10px; cursor: pointer;
      background: none; border: none; color: #f85149; padding: 0 2px;
      margin-left: auto;
    }
    .project-file-item:hover .file-delete-btn { opacity: 0.7; }
    .project-file-item .file-delete-btn:hover { opacity: 1; }
    .inline-input-row {
      display: none; gap: 6px; margin-top: 8px; align-items: center;
    }
    .inline-input-row.visible { display: flex; }
    .inline-input-row input {
      flex: 1; padding: 6px 8px; font-size: 13px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-focusBorder);
      color: var(--vscode-input-foreground);
      border-radius: 3px; outline: none;
    }
    .inline-input-row button {
      padding: 6px 10px; font-size: 12px; border-radius: 3px; cursor: pointer;
      background: var(--jet-accent); color: #000; border: none; font-weight: 600;
    }
    .inline-input-row .cancel-btn {
      background: transparent; color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
    }

    /* ── List thesis ── */
    .list-thesis {
      padding: 2px 8px 6px 26px;
      font-size: 11px;
      font-style: italic;
      color: var(--vscode-foreground);
      opacity: 0.4;
      display: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list-card.expanded .list-thesis { display: block; }

    /* ── Project file items ── */
    .project-file-item {
      display: flex; align-items: center; gap: 6px;
      padding: 2px 4px 2px 18px; font-size: 11px; cursor: pointer;
      border-radius: 3px;
    }
    .project-file-item:hover { background: var(--vscode-list-hoverBackground); }
    .project-file-icon {
      font-size: 9px; font-weight: 700;
      padding: 1px 3px; border-radius: 2px;
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
    }
    .project-file-icon.pdf { background: rgba(248,81,73,0.15); color: var(--jet-down); }
    .project-file-icon.doc { background: var(--jet-blue-dim); color: var(--jet-blue); }
    .project-file-icon.note { background: var(--jet-up-dim); color: var(--jet-up); }
    .project-file-icon.other { background: var(--jet-accent-dim); color: var(--jet-accent); }
    .project-file-name {
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .project-file-action {
      font-size: 9px; padding: 1px 4px; border-radius: 2px;
      border: 1px solid var(--vscode-panel-border);
      background: transparent; color: var(--vscode-foreground);
      cursor: pointer; opacity: 0; transition: opacity 0.1s;
    }
    .project-file-item:hover .project-file-action { opacity: 0.6; }
    .project-file-action:hover { border-color: var(--jet-accent); color: var(--jet-accent); opacity: 1 !important; }

    /* ── Button ── */
    .btn-new {
      width: 100%;
      padding: 8px;
      border: 1px dashed var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-foreground);
      opacity: 0.6;
      cursor: pointer;
      font-size: 12px;
      border-radius: 4px;
      margin-top: 8px;
    }
    .btn-new:hover {
      border-color: var(--jet-accent);
      color: var(--jet-accent);
      opacity: 1;
    }

    /* ── List icon ── */
    .list-icon {
      color: var(--jet-accent);
      font-size: 12px;
    }
    .auto-badge {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 2px;
      background: var(--jet-accent-dim);
      color: var(--jet-accent);
    }

    /* ── (Market pulse — removed) ── */
    .pulse-row {
      display: none;
      padding: 4px 8px;
      font-size: 12px;
    }
    .pulse-row .change.up { color: var(--jet-up); }
    .pulse-row .change.down { color: var(--jet-down); }

    /* ── Empty state ── */
    .empty-state {
      text-align: center;
      padding: 24px 12px;
      opacity: 0.4;
      font-size: 12px;
      font-style: italic;
    }

    /* ── Data Tab: Dataset/Connection Items (wireframe-matched) ── */
    .dataset-item { padding: 6px 12px; cursor: pointer; }
    .dataset-item:hover { background: var(--vscode-list-hoverBackground); }
    .dataset-hdr { display: flex; align-items: center; gap: 6px; }
    .dataset-icon {
      font-size: 9px; font-weight: 700; flex-shrink: 0;
      width: 20px; height: 20px; border-radius: 3px;
      display: flex; align-items: center; justify-content: center;
      background: rgba(79,139,255,0.15); color: #4F8BFF;
    }
    .dataset-name {
      font-size: 12px; font-weight: 500; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .dataset-size {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      font-family: 'SF Mono','Consolas','Menlo',monospace; flex-shrink: 0;
    }
    .dataset-meta {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      font-family: 'SF Mono','Consolas','Menlo',monospace;
      margin-top: 2px; padding-left: 26px;
    }
    .dataset-table { margin-top: 1px; padding-left: 26px; }
    .dataset-table code {
      font-family: 'SF Mono','Consolas','Menlo',monospace;
      font-size: 10px; color: #58A6FF;
      background: rgba(88,166,255,0.1);
      padding: 0 4px; border-radius: 2px;
    }
    .conn-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: var(--vscode-descriptionForeground);
    }
    .conn-dot.connected { background: #3FB950; }
    .section-count {
      font-size: 10px; opacity: 0.4;
      margin-left: 6px; font-weight: 400;
    }

    /* ── Models ── */
    .tree-item {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 12px; font-size: 12px;
    }
    .model-icon { color: #BC8CFF; font-size: 12px; }
    .decoration.muted { font-size: 9px; opacity: 0.4; margin-left: auto; }

    /* ── Schema Browser ── */
    .schema-table { margin-bottom: 2px; }
    .schema-table-hdr {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 12px; cursor: pointer;
      font-size: 12px; font-family: 'SF Mono','Consolas','Menlo',monospace;
    }
    .schema-table-hdr:hover { background: var(--vscode-list-hoverBackground); }
    .schema-chevron { font-size: 10px; opacity: 0.4; transition: transform 0.15s; }
    .schema-table.open .schema-chevron { transform: rotate(90deg); }
    .schema-col {
      display: flex; align-items: center; gap: 6px;
      padding: 2px 12px 2px 32px; font-size: 11px;
      font-family: 'SF Mono','Consolas','Menlo',monospace;
    }
    .schema-col-name { color: var(--vscode-foreground); opacity: 0.8; }
    .schema-col-type { opacity: 0.4; font-size: 10px; margin-left: auto; }

    /* ── Queries Tab ── */
    .query-hist-item { padding: 4px 12px; cursor: pointer; }
    .query-hist-item:hover { background: var(--vscode-list-hoverBackground); }
    .query-hist-name { font-size: 12px; font-weight: 500; }
    .query-hist-sql {
      font-family: 'SF Mono','Consolas','Menlo',monospace;
      font-size: 10px; opacity: 0.6;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      max-width: 260px;
    }
    .query-hist-meta {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      display: flex; gap: 6px; margin-top: 1px;
    }

    /* ── New project button (used for + Add Data / + New Query) ── */
    .new-project-btn {
      display: flex; align-items: center; justify-content: center; gap: 6px;
      width: calc(100% - 16px); margin: 6px 8px;
      padding: 6px 0; border: none; border-radius: 4px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 12px; font-weight: 500; cursor: pointer;
    }
    .new-project-btn:hover { background: var(--vscode-button-hoverBackground); }

    /* ── Portfolio ── */
    .btn-secondary {
      margin-top: 4px;
      font-size: 11px;
      opacity: 0.5;
    }
    .portfolio-card {
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      margin-bottom: 6px;
      cursor: pointer;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .portfolio-card:hover { border-color: var(--jet-accent); box-shadow: 0 1px 6px rgba(222,191,202,0.08); }
    .portfolio-card.selected { border-color: var(--jet-accent); background: var(--jet-accent-dim); }
    .portfolio-card .pf-name { font-weight: 600; font-size: 12px; }
    .portfolio-card .pf-holdings {
      font-size: 11px; opacity: 0.6; margin-top: 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .portfolio-card .pf-stats {
      display: flex; gap: 8px; margin-top: 4px; font-size: 11px;
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
    }
    .pf-quick-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px;
    }
    .pf-quick-cell {
      padding: 6px; text-align: center;
      border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    }
    .pf-quick-cell .pf-cell-label {
      font-size: 9px; text-transform: uppercase; opacity: 0.5;
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
    }
    .pf-quick-cell .pf-cell-value {
      font-size: 13px; font-weight: 600;
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
    }
    .pf-sparkline {
      width: 100%; height: 40px; margin: 8px 0;
      border: 1px solid var(--vscode-panel-border); border-radius: 3px;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; opacity: 0.4;
    }
    .pf-actions { display: flex; gap: 6px; margin-top: 6px; }
    .pf-actions button {
      flex: 1; padding: 5px; font-size: 11px; border-radius: 3px; cursor: pointer;
      border: 1px solid var(--vscode-panel-border);
      background: transparent; color: var(--vscode-foreground);
    }
    .pf-actions button:hover { border-color: var(--jet-accent); color: var(--jet-accent); }

    /* ── Library items ── */
    .library-item {
      display: flex;
      align-items: center;
      padding: 6px 8px;
      gap: 8px;
      border-radius: 3px;
      transition: background 0.1s ease;
    }
    .library-item:hover {
      background: rgba(222,191,202,0.04);
    }
    .library-item .badge-count {
      font-size: 10px;
      padding: 0 5px;
      border-radius: 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .canvas-tree-toggle {
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 5px 8px;
      font-size: 12px;
      border-radius: 3px;
      transition: background 0.12s ease;
    }
    .canvas-tree-toggle:hover { background: var(--vscode-list-hoverBackground); }
    .canvas-tree-toggle .arrow {
      font-size: 10px;
      opacity: 0.5;
      width: 14px;
      text-align: center;
      transition: transform 0.15s;
      flex-shrink: 0;
    }
    .canvas-tree-toggle .arrow.open { transform: rotate(90deg); }
    .canvas-tree-toggle .arrow.empty { visibility: hidden; }
    .canvas-elements { display: none; margin-left: 12px; padding-left: 12px; border-left: 1px solid rgba(222,191,202,0.08); }
    .canvas-elements.open { display: block; }
    .canvas-element-row {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      border-radius: 3px;
    }
    .canvas-element-row { transition: background 0.1s ease; }
    .canvas-element-row:hover { background: var(--vscode-list-hoverBackground); }
    .canvas-element-row .el-icon { font-size: 10px; opacity: 0.5; flex-shrink: 0; }
    .canvas-element-row .el-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .canvas-element-row .el-name.hidden { opacity: 0.35; text-decoration: line-through; }
    .canvas-element-row .el-actions { display: flex; gap: 2px; opacity: 0; }
    .canvas-element-row:hover .el-actions { opacity: 1; }
    .canvas-element-row .el-actions button {
      background: none; border: none; cursor: pointer;
      color: var(--vscode-descriptionForeground);
      font-size: 10px; padding: 1px 3px; border-radius: 2px; line-height: 1;
    }
    .canvas-element-row .el-check { accent-color: var(--jet-accent); margin-right: 2px; cursor: pointer; opacity: 0; transition: opacity 0.1s; }
    .canvas-element-row:hover .el-check, .canvas-element-row .el-check:checked { opacity: 1; }
    .share-selected-bar {
      position: sticky; bottom: 0; z-index: 20; display: none;
      padding: 8px 12px; background: var(--jet-accent); color: #1a1a1a;
      font-size: 12px; font-weight: 600; cursor: pointer; text-align: center;
      border-radius: 6px; margin: 8px; transition: opacity 0.15s;
    }
    .share-selected-bar:hover { opacity: 0.9; }
    .share-selected-bar.visible { display: block; }
    .canvas-element-row .el-actions button:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground);
    }
    .el-live-dot {
      width: 5px; height: 5px;
      background: #3fb950;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .recipe-item {
      padding: 6px 8px;
      border-radius: 3px;
      cursor: pointer;
    }
    .recipe-item:hover { background: var(--vscode-list-hoverBackground); }
    .recipe-item .recipe-name { font-size: 12px; }
    .recipe-item .recipe-meta { font-size: 10px; opacity: 0.5; margin-top: 1px; }


    /* ── Search groups ── */
    .search-group-header {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-foreground);
      opacity: 0.5;
      padding: 10px 8px 4px;
      font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
    }
    .search-group-header:first-child { padding-top: 6px; }
    .fetch-agent-item {
      display: flex;
      align-items: center;
      padding: 8px;
      margin: 8px 0;
      gap: 8px;
      cursor: pointer;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 12px;
      opacity: 0.7;
    }
    .fetch-agent-item:hover {
      border-color: var(--jet-accent);
      color: var(--jet-accent);
      opacity: 1;
    }
    .fetch-agent-icon {
      width: 20px;
      height: 20px;
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      background: var(--jet-accent-dim);
      color: var(--jet-accent);
    }
    .project-icon { background: var(--jet-up-dim); color: var(--jet-up); }
    .list-icon-badge { background: var(--jet-accent-dim); color: var(--jet-accent); }
    .portfolio-icon { background: rgba(188,140,255,0.12); color: #BC8CFF; }
    .recipe-icon { background: var(--jet-blue-dim); color: var(--jet-blue); }

    /* ── Context menu ── */
    .jet-context-menu {
      position: fixed;
      background: var(--vscode-menu-background, #252526);
      border: 1px solid var(--vscode-menu-border, #454545);
      border-radius: 4px;
      padding: 4px 0;
      min-width: 160px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 1000;
      font-size: 12px;
    }
    .jet-context-item {
      padding: 4px 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--vscode-menu-foreground, #ccc);
    }
    .jet-context-item:hover {
      background: var(--vscode-menu-selectionBackground, #094771);
      color: var(--vscode-menu-selectionForeground, #fff);
    }
    .jet-context-item.danger { color: var(--jet-down); }
    .jet-context-item.danger:hover { background: rgba(248,81,73,0.2); color: var(--jet-down); }
    .jet-context-separator {
      height: 1px;
      margin: 4px 0;
      background: var(--vscode-menu-separatorBackground, #454545);
    }

    .canvas-history-btn {
      background: none; border: none; cursor: pointer;
      opacity: 0.35; padding: 2px; color: inherit; display: inline-flex;
      align-items: center; line-height: 1;
    }
    .canvas-history-btn:hover { opacity: 1; }
    .canvas-history-btn svg { width: 13px; height: 13px; }

    /* ── Gear footer ── */
    .gear-footer {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 6px 12px;
      display: flex;
      align-items: center;
      font-size: 11px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      z-index: 100;
    }
    .footer-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      opacity: 0.5;
      padding: 2px 4px;
      border-radius: 3px;
      transition: all 0.15s ease;
    }
    .footer-btn:hover { opacity: 0.9; color: var(--jet-accent); text-shadow: 0 0 6px rgba(222,191,202,0.2); }
    .footer-spacer { flex: 1; }
    .gear-icon { font-size: 14px; }

    /* ── Auth Gate ── */
    .auth-gate {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 20px;
    }
    .auth-gate.hidden { display: none; }
    .auth-logo {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 1px;
      color: var(--jet-accent);
      margin-bottom: 28px;
    }
    .auth-form { width: 100%; max-width: 260px; }
    .auth-field {
      margin-bottom: 10px;
    }
    .auth-field input {
      width: 100%;
      padding: 8px 10px;
      font-size: 12px;
      border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      outline: none;
    }
    .auth-field input:focus {
      border-color: var(--jet-accent);
    }
    .auth-btn {
      width: 100%;
      padding: 9px 0;
      font-size: 12px;
      font-weight: 600;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      background: var(--jet-accent);
      color: #1a1a1a;
      transition: opacity 0.15s;
    }
    .auth-btn:hover { opacity: 0.9; }
    .auth-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .auth-error {
      font-size: 11px;
      color: var(--jet-down);
      margin-bottom: 8px;
      min-height: 16px;
    }
    .auth-toggle {
      font-size: 11px;
      text-align: center;
      margin-top: 16px;
      opacity: 0.6;
    }
    .auth-toggle a {
      color: var(--jet-accent);
      cursor: pointer;
      text-decoration: none;
    }
    .auth-toggle a:hover { text-decoration: underline; }
    .auth-stay-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 10px 0 14px;
      font-size: 11px;
      opacity: 0.7;
    }
    .auth-stay-row input[type="checkbox"] {
      accent-color: var(--jet-accent);
    }
    .auth-field-pw {
      position: relative;
    }
    .auth-field-pw input {
      padding-right: 32px;
    }
    .pw-toggle {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      cursor: pointer;
      opacity: 0.4;
      font-size: 14px;
      user-select: none;
      line-height: 1;
    }
    .pw-toggle:hover { opacity: 0.8; }
  </style>
</head>
<body>
  <!-- Auth Gate: covers entire sidebar until signed in -->
  <div class="auth-gate${alreadySignedIn ? " hidden" : ""}" id="auth-gate">
    <div class="auth-logo">JETRO</div>

    <!-- Verification Pending Banner (shown when user signed up but hasn't verified) -->
    <div class="auth-form" id="auth-verify-banner" style="display:${pendingVerificationEmail ? "" : "none"}; text-align:center;">
      <div style="font-size:20px; margin-bottom:8px;">&#9993;</div>
      <div style="font-size:12px; font-weight:600; margin-bottom:6px;">Verification pending</div>
      <div style="font-size:11px; opacity:0.7; margin-bottom:12px;">We sent an email to<br><strong id="verify-email-display">${pendingVerificationEmail}</strong></div>
      <button class="auth-btn" id="btn-resend-verify" style="margin-bottom:8px;">Resend Email</button>
      <button class="auth-btn" id="btn-verify-signin" style="background:transparent; border:1px solid rgba(222,191,202,0.3); margin-bottom:12px;">Sign In</button>
      <div class="auth-toggle">
        <a id="link-verify-new-account">Create a new account</a>
      </div>
    </div>

    <!-- Sign In Form -->
    <div class="auth-form" id="auth-signin-form" style="display:${pendingVerificationEmail ? "none" : ""}">
      <div class="auth-field">
        <input id="signin-email" type="email" placeholder="Email address" autocomplete="email" />
      </div>
      <div class="auth-field auth-field-pw">
        <input id="signin-password" type="password" placeholder="Password" autocomplete="current-password" />
        <span class="pw-toggle" data-target="signin-password">&#x1F441;</span>
      </div>
      <div class="auth-error" id="signin-error"></div>
      <div class="auth-stay-row">
        <input type="checkbox" id="signin-stay" checked />
        <label for="signin-stay">Stay signed in</label>
      </div>
      <button class="auth-btn" id="btn-signin">Sign In</button>
      <div class="auth-toggle" style="margin-bottom:4px;">
        <a id="link-forgot-password" style="font-size:11px;">Forgot password?</a>
      </div>
      <div class="auth-toggle">
        Don't have an account? <a id="link-to-signup">Create one</a>
      </div>
    </div>

    <!-- Sign Up Form (hidden by default) -->
    <div class="auth-form" id="auth-signup-form" style="display:none;">
      <div class="auth-field">
        <input id="signup-email" type="email" placeholder="Email address" autocomplete="email" />
      </div>
      <div class="auth-field auth-field-pw">
        <input id="signup-password" type="password" placeholder="Password (6+ characters)" autocomplete="new-password" />
        <span class="pw-toggle" data-target="signup-password">&#x1F441;</span>
      </div>
      <div class="auth-field auth-field-pw">
        <input id="signup-confirm" type="password" placeholder="Confirm password" autocomplete="new-password" />
        <span class="pw-toggle" data-target="signup-confirm">&#x1F441;</span>
      </div>
      <div class="auth-error" id="signup-error"></div>
      <div class="auth-stay-row">
        <input type="checkbox" id="signup-stay" checked />
        <label for="signup-stay">Stay signed in</label>
      </div>
      <button class="auth-btn" id="btn-signup">Create Account</button>
      <div class="auth-toggle" style="margin-top:10px;font-size:10px;opacity:0.45;line-height:1.5;">
        By creating an account you agree to our<br>
        <a href="#" id="link-terms">Terms of Service</a> &amp; <a href="#" id="link-privacy">Privacy Policy</a>
      </div>
      <div class="auth-toggle">
        Already have an account? <a id="link-to-signin">Sign in</a>
      </div>
    </div>
  </div>

  <!-- Runtime status banner (shown when MCP server isn't ready) -->
  <div id="runtime-banner" style="display:none; background:#2d1b00; border:1px solid #664400; border-radius:4px; padding:8px 10px; margin:4px 8px; font-size:11px; color:#ffaa33;">
    <span id="runtime-msg">Setting up Jetro runtime...</span>
    <button id="runtime-retry" style="display:none; margin-top:6px; background:#664400; color:#fff; border:none; border-radius:3px; padding:3px 10px; cursor:pointer; font-size:10px;">Retry Setup</button>
  </div>

  <div class="tab-bar">
    <div class="tab active" data-tab="library">Library</div>
    <div class="tab" data-tab="projects">Projects</div>
    <div class="tab" data-tab="market" data-finance="true">Market</div>
    <div class="tab" data-tab="status">Status</div>
  </div>

  <!-- PROJECTS TAB -->
  <div class="tab-content" id="tab-projects">
    <div id="projects-top-panel" class="projects-panel">
      <div class="panel-header">
        <span class="panel-label">Projects</span>
        <button class="panel-add-btn" id="btn-new-project-v2" title="New Project">+</button>
      </div>
      <div class="panel-scroll" id="projects-list"></div>
      <div class="inline-input-row" id="new-project-input" style="padding:0 8px 4px;">
        <input type="text" placeholder="Project name..." id="new-project-name" />
        <button id="new-project-create">Create</button>
        <button class="cancel-btn" id="new-project-cancel">&#x2715;</button>
      </div>
    </div>
    <div id="projects-divider" class="panel-divider"></div>
    <div id="projects-bottom-panel" class="projects-panel">
      <div class="panel-scroll" id="project-detail"></div>
      <div class="share-selected-bar" id="share-selected-bar-projects">Share Selected</div>
    </div>
  </div>

  <!-- LIBRARY TAB -->
  <div class="tab-content active" id="tab-library">
    <!-- Finance mode: Canvases -->
    <div>
      <div class="section-header" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Canvases</span>
        <span class="section-action" id="btn-new-canvas" style="cursor:pointer;opacity:0.6;font-size:14px;" title="New Canvas">+</span>
      </div>
      <div id="new-canvas-row" style="display:none;padding:0 12px 8px;">
        <div style="display:flex;gap:4px;">
          <input class="search-input" type="text" placeholder="Canvas name..." id="new-canvas-name" style="flex:1;margin:0;">
          <select id="new-canvas-project" style="background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:3px;font-size:11px;padding:2px 4px;">
            <option value="">Universal</option>
          </select>
        </div>
        <div style="display:flex;gap:4px;margin-top:4px;">
          <button id="new-canvas-create" style="flex:1;padding:3px 8px;font-size:11px;background:var(--jet-accent);color:#000;border:none;border-radius:3px;cursor:pointer;">Create</button>
          <button id="new-canvas-cancel" style="padding:3px 8px;font-size:11px;background:transparent;color:var(--vscode-foreground);border:1px solid #3c3c3c;border-radius:3px;cursor:pointer;">&#x2715;</button>
        </div>
      </div>
      <div id="library-canvases"></div>
      <div class="share-selected-bar" id="share-selected-bar">Share Selected</div>
    </div>

    <!-- Data -->
    <div>
      <div class="section-header" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Data</span>
        <span class="section-action" id="btn-add-data" style="cursor:pointer;opacity:0.6;font-size:14px;" title="Add Data">+</span>
      </div>
      <div id="library-datasets"></div>
    </div>

    <!-- Connectors (agent-built) -->
    <div>
      <div class="section-header">Connectors</div>
      <div id="library-connectors"></div>
    </div>

    <!-- Published Apps -->
    <div>
      <div class="section-header">Published Apps</div>
      <div id="library-dashboards"></div>
    </div>

    <!-- Templates -->
    <div>
      <div class="section-header">Templates</div>
      <div id="library-templates"></div>
    </div>

    <!-- Shares -->
    <div>
      <div class="section-header" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Shares</span>
        <span class="section-action" id="btn-refresh-shares" style="cursor:pointer;opacity:0.6;font-size:12px;" title="Refresh">&#x27F3;</span>
      </div>
      <div id="library-shares"><div class="empty-state">No shares yet</div></div>
    </div>

    <!-- Recipes -->
    <div>
      <div class="section-header">Recipes</div>
      <div id="library-recipes"></div>
    </div>

    <!-- Daemon status -->
    <div>
      <div class="section-header">Daemon</div>
      <div id="daemon-status"><div class="empty-state">Checking...</div></div>
    </div>
  </div>

  <!-- MARKET TAB -->
  <div class="tab-content" id="tab-market">
    <div class="section-header">Lists</div>
    <div id="market-lists"></div>
    <button class="btn-new" id="btn-new-list">+ New list...</button>
  </div>

  <!-- STATUS TAB -->
  <div class="tab-content" id="tab-status">
    <div class="section-header" style="display:flex;justify-content:space-between;align-items:center;">
      <span>Live Scripts</span>
      <span id="status-global-toggle" class="section-action" style="cursor:pointer;font-size:10px;padding:2px 6px;border:1px solid #3c3c3c;border-radius:3px;opacity:0.7;" title="Pause/Resume all bindings"></span>
    </div>
    <div id="status-bindings-list"></div>
  </div>

  <!-- FOOTER -->
  <div class="gear-footer">
    <span class="footer-btn" id="footer-settings">
      <span class="gear-icon">&#9881;</span>
      <span>Settings</span>
    </span>
    <span class="footer-spacer"></span>
    <span class="footer-btn" id="footer-companion" title="Open Companion Web App">
      <span class="gear-icon">&#8599;</span>
      <span>Companion</span>
    </span>
  </div>

  <script nonce="${nonce}">
    console.log('[JET] sidebar script start');
    document.title = 'JET-JS-OK';

    try {
    const vscode = acquireVsCodeApi();

    // ── Auth Gate Logic ──
    var authGate = document.getElementById('auth-gate');
    var signinForm = document.getElementById('auth-signin-form');
    var signupForm = document.getElementById('auth-signup-form');

    function showAuthGate() { if (authGate) authGate.classList.remove('hidden'); }
    function hideAuthGate() { if (authGate) authGate.classList.add('hidden'); }
    function showSignin() { if (signinForm) signinForm.style.display = ''; if (signupForm) signupForm.style.display = 'none'; }
    function showSignup() { if (signinForm) signinForm.style.display = 'none'; if (signupForm) signupForm.style.display = ''; }

    var verifyBanner = document.getElementById('auth-verify-banner');

    function showVerifyBanner() { if (verifyBanner) verifyBanner.style.display = ''; if (signinForm) signinForm.style.display = 'none'; if (signupForm) signupForm.style.display = 'none'; }
    function hideVerifyBanner() { if (verifyBanner) verifyBanner.style.display = 'none'; }

    // Toggle between forms
    var linkToSignup = document.getElementById('link-to-signup');
    var linkToSignin = document.getElementById('link-to-signin');
    if (linkToSignup) linkToSignup.addEventListener('click', function(e) { e.preventDefault(); hideVerifyBanner(); showSignup(); });
    if (linkToSignin) linkToSignin.addEventListener('click', function(e) { e.preventDefault(); hideVerifyBanner(); showSignin(); });

    // Verification banner buttons
    var btnResendVerify = document.getElementById('btn-resend-verify');
    if (btnResendVerify) btnResendVerify.addEventListener('click', function() {
      btnResendVerify.disabled = true;
      btnResendVerify.textContent = 'Sending...';
      vscode.postMessage({ type: 'authResendVerification' });
      setTimeout(function() { btnResendVerify.disabled = false; btnResendVerify.textContent = 'Resend Email'; }, 3000);
    });

    var btnVerifySignin = document.getElementById('btn-verify-signin');
    if (btnVerifySignin) btnVerifySignin.addEventListener('click', function() {
      hideVerifyBanner();
      showSignin();
      // Pre-fill email from the verification banner
      var verifyEmailEl = document.getElementById('verify-email-display');
      var signinEmailEl = document.getElementById('signin-email');
      if (verifyEmailEl && signinEmailEl) signinEmailEl.value = verifyEmailEl.textContent || '';
    });

    var linkVerifyNewAccount = document.getElementById('link-verify-new-account');
    if (linkVerifyNewAccount) linkVerifyNewAccount.addEventListener('click', function(e) {
      e.preventDefault();
      vscode.postMessage({ type: 'authClearPendingVerification' });
      hideVerifyBanner();
      showSignup();
    });

    // Runtime retry button
    var rtRetryBtn = document.getElementById('runtime-retry');
    if (rtRetryBtn) rtRetryBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'reinitializeMcp' });
    });

    // Forgot password
    var linkForgot = document.getElementById('link-forgot-password');
    if (linkForgot) linkForgot.addEventListener('click', function(e) {
      e.preventDefault();
      var email = document.getElementById('signin-email');
      var errEl = document.getElementById('signin-error');
      if (!email || !email.value.trim()) {
        if (errEl) { errEl.style.color = 'var(--jet-down)'; errEl.textContent = 'Enter your email address above, then click Forgot password.'; }
        return;
      }
      if (errEl) { errEl.style.color = ''; errEl.textContent = ''; }
      vscode.postMessage({ type: 'authResetPassword', data: { email: email.value.trim() } });
    });

    // Sign In
    var btnSignin = document.getElementById('btn-signin');
    if (btnSignin) btnSignin.addEventListener('click', function() {
      var email = document.getElementById('signin-email');
      var pass = document.getElementById('signin-password');
      var stay = document.getElementById('signin-stay');
      var errEl = document.getElementById('signin-error');
      if (errEl) errEl.textContent = '';
      if (!email || !email.value.trim() || !pass || !pass.value) {
        if (errEl) errEl.textContent = 'Please enter email and password.';
        return;
      }
      btnSignin.disabled = true;
      btnSignin.textContent = 'Signing in...';
      vscode.postMessage({
        type: 'authSignIn',
        data: { email: email.value.trim(), password: pass.value, staySignedIn: stay ? stay.checked : true }
      });
    });

    // Sign Up
    var btnSignup = document.getElementById('btn-signup');
    if (btnSignup) btnSignup.addEventListener('click', function() {
      var email = document.getElementById('signup-email');
      var pass = document.getElementById('signup-password');
      var confirm = document.getElementById('signup-confirm');
      var stay = document.getElementById('signup-stay');
      var errEl = document.getElementById('signup-error');
      if (errEl) errEl.textContent = '';
      if (!email || !email.value.trim()) {
        if (errEl) errEl.textContent = 'Please enter an email address.';
        return;
      }
      if (!pass || pass.value.length < 6) {
        if (errEl) errEl.textContent = 'Password must be at least 6 characters.';
        return;
      }
      if (!confirm || pass.value !== confirm.value) {
        if (errEl) errEl.textContent = 'Passwords do not match.';
        return;
      }
      btnSignup.disabled = true;
      btnSignup.textContent = 'Creating account...';
      vscode.postMessage({
        type: 'authSignUp',
        data: { email: email.value.trim(), password: pass.value, staySignedIn: stay ? stay.checked : true }
      });
    });

    // Enter key on password fields
    var signinPass = document.getElementById('signin-password');
    if (signinPass) signinPass.addEventListener('keydown', function(e) { if (e.key === 'Enter' && btnSignin) btnSignin.click(); });
    var signinEmail = document.getElementById('signin-email');
    if (signinEmail) signinEmail.addEventListener('keydown', function(e) { if (e.key === 'Enter' && signinPass) signinPass.focus(); });
    var signupConfirm = document.getElementById('signup-confirm');
    if (signupConfirm) signupConfirm.addEventListener('keydown', function(e) { if (e.key === 'Enter' && btnSignup) btnSignup.click(); });

    // External links (terms, privacy) — open in browser
    var linkTerms = document.getElementById('link-terms');
    var linkPrivacy = document.getElementById('link-privacy');
    // Configure your own terms/privacy URLs here
    if (linkTerms) linkTerms.addEventListener('click', function(e) { e.preventDefault(); });
    if (linkPrivacy) linkPrivacy.addEventListener('click', function(e) { e.preventDefault(); });

    // Password visibility toggles
    document.querySelectorAll('.pw-toggle').forEach(function(toggle) {
      toggle.addEventListener('click', function() {
        var targetId = toggle.getAttribute('data-target');
        var input = document.getElementById(targetId);
        if (input) {
          var isPassword = input.type === 'password';
          input.type = isPassword ? 'text' : 'password';
          toggle.style.opacity = isPassword ? '0.8' : '0.4';
        }
      });
    });

    // State
    let state = { lists: [], projects: [], stocks: {}, recipes: [], canvases: [], templates: [], index: null, selectedTicker: null };

    var financeEnabled = true;

    // ── Smart re-render: skip sections whose data hasn't changed ──
    var prevDataStrings = {};
    function dataStr(data) {
      try { return JSON.stringify(data); } catch(e) { return '' + Math.random(); }
    }
    function dataChanged(key, data) {
      var s = dataStr(data);
      if (s === prevDataStrings[key]) return false;
      prevDataStrings[key] = s;
      return true;
    }
    // Capture which canvas trees are expanded (by canvas ID)
    function captureOpenCanvasTrees() {
      var ids = [];
      document.querySelectorAll('.canvas-elements.open').forEach(function(el) {
        if (el.dataset.canvasId) ids.push(el.dataset.canvasId);
      });
      return ids;
    }
    function restoreOpenCanvasTrees(ids) {
      ids.forEach(function(id) {
        document.querySelectorAll('.canvas-elements[data-canvas-id="' + id + '"]').forEach(function(elDiv) {
          elDiv.classList.add('open');
        });
        document.querySelectorAll('.canvas-tree-toggle[data-canvas-id="' + id + '"]').forEach(function(toggle) {
          var a = toggle.querySelector('.arrow'); if (a) a.classList.add('open');
        });
      });
    }
    // ── Context Menu ──
    var activeContextMenu = null;
    function showContextMenu(x, y, items) {
      dismissContextMenu();
      var menu = document.createElement('div');
      menu.className = 'jet-context-menu';
      items.forEach(function(item) {
        if (item.separator) {
          var sep = document.createElement('div');
          sep.className = 'jet-context-separator';
          menu.appendChild(sep);
          return;
        }
        var el = document.createElement('div');
        el.className = 'jet-context-item' + (item.danger ? ' danger' : '');
        el.textContent = item.label;
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          dismissContextMenu();
          if (item.onClick) item.onClick();
        });
        menu.appendChild(el);
      });
      // Position — ensure menu stays within viewport
      document.body.appendChild(menu);
      var rect = menu.getBoundingClientRect();
      if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
      if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      activeContextMenu = menu;
    }
    function dismissContextMenu() {
      if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
      }
    }
    document.addEventListener('click', dismissContextMenu);
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') dismissContextMenu(); });

    // Right-click on project items
    document.addEventListener('contextmenu', function(e) {
      // Project context menu
      var projEl = e.target.closest('.project-row');
      if (projEl) {
        e.preventDefault();
        var slug = projEl.dataset.slug;
        var status = projEl.dataset.status || 'active';
        var projMode = projEl.dataset.mode;
        var pfToggleLabel = projMode === 'portfolio' ? 'Disable Portfolio Mode' : 'Enable Portfolio Mode';
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Open Canvas', onClick: function() { vscode.postMessage({ type: 'openProjectCanvas', data: { slug: slug } }); } },
          { label: 'Rename', onClick: function() {
            renamingProject = slug;
            selectedProject = slug;
            renderProjectList(); renderProjectDetail();
          }},
          { separator: true },
          { label: pfToggleLabel, onClick: function() { vscode.postMessage({ type: 'togglePortfolioMode', data: { slug: slug } }); } },
          { separator: true },
          status !== 'active' ? { label: 'Set Active', onClick: function() { vscode.postMessage({ type: 'setProjectStatus', data: { slug: slug, status: 'active' } }); } } : null,
          status !== 'draft' ? { label: 'Set Draft', onClick: function() { vscode.postMessage({ type: 'setProjectStatus', data: { slug: slug, status: 'draft' } }); } } : null,
          status !== 'done' ? { label: 'Set Done', onClick: function() { vscode.postMessage({ type: 'setProjectStatus', data: { slug: slug, status: 'done' } }); } } : null,
          { separator: true },
          { label: 'Delete', danger: true, onClick: function() { vscode.postMessage({ type: 'deleteProject', data: { slug: slug } }); } },
        ].filter(Boolean));
        return;
      }

      // List context menu
      var listEl = e.target.closest('.list-card-v2');
      if (listEl) {
        e.preventDefault();
        var listSlug = listEl.dataset.slug;
        showContextMenu(e.clientX, e.clientY, [
          { label: 'View on Canvas', onClick: function() { vscode.postMessage({ type: 'viewListOnCanvas', data: { slug: listSlug } }); } },
          { label: 'Rename', onClick: function() { vscode.postMessage({ type: 'renameList', data: { slug: listSlug } }); } },
          { label: 'Refresh', onClick: function() { vscode.postMessage({ type: 'refreshList', data: { slug: listSlug } }); } },
          { separator: true },
          { label: 'Delete', danger: true, onClick: function() { vscode.postMessage({ type: 'deleteList', data: { slug: listSlug } }); } },
        ]);
        return;
      }

      // Dataset context menu
      var dsEl = e.target.closest('.dataset-item, [data-action="selectDataset"]');
      if (dsEl) {
        e.preventDefault();
        var dsSlug = dsEl.dataset.slug;
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Query', onClick: function() { vscode.postMessage({ type: 'selectDataset', data: { slug: dsSlug } }); } },
          { separator: true },
          { label: 'Delete', danger: true, onClick: function() { vscode.postMessage({ type: 'deleteDataset', data: { slug: dsSlug } }); } },
        ]);
        return;
      }

      // Canvas tree context menu (right-click on canvas name row)
      var canvasEl = e.target.closest('.canvas-tree-toggle');
      if (canvasEl) {
        e.preventDefault();
        var canvasId = canvasEl.dataset.canvasId;
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Open', onClick: function() { vscode.postMessage({ type: 'openCanvasById', data: { canvasId: canvasId } }); } },
          { label: 'Open in Web App', onClick: function() { vscode.postMessage({ type: 'openCanvasInCompanion', data: { canvasId: canvasId } }); } },
          { label: 'Rename', onClick: function() { vscode.postMessage({ type: 'renameCanvas', data: { canvasId: canvasId } }); } },
          { separator: true },
          { label: 'Delete', danger: true, onClick: function() { vscode.postMessage({ type: 'deleteCanvas', data: { canvasId: canvasId } }); } },
        ]);
        return;
      }

      // Canvas element context menu (right-click on element row)
      var elRow = e.target.closest('.canvas-element-row');
      if (elRow) {
        e.preventDefault();
        var elCanvasId = elRow.closest('.canvas-elements') ? elRow.closest('.canvas-elements').dataset.canvasId : '';
        var elId = elRow.dataset.elementId;
        var isHidden = elRow.querySelector('.el-name.hidden');
        var elCheck = elRow.querySelector('.el-check');
        var menuItems = [
          { label: isHidden ? 'Show' : 'Hide', onClick: function() { vscode.postMessage({ type: 'toggleElement', data: { canvasId: elCanvasId, elementId: elId } }); } },
        ];
        // Only show Share for frame/embed elements (those with checkboxes)
        if (elCheck) {
          menuItems.push({ label: 'Share', onClick: function() { vscode.postMessage({ type: 'shareElements', data: { canvasId: elCanvasId, elementIds: [elId] } }); } });
        }
        menuItems.push({ separator: true });
        menuItems.push({ label: 'Delete', danger: true, onClick: function() { vscode.postMessage({ type: 'deleteElement', data: { canvasId: elCanvasId, elementId: elId } }); } });
        showContextMenu(e.clientX, e.clientY, menuItems);
        return;
      }

      // Library item context menu (generic library items like datasets, templates, reports)
      var libItem = e.target.closest('.library-item');
      if (libItem && libItem.dataset.slug) {
        e.preventDefault();
        var libSlug = libItem.dataset.slug;
        var libType = libItem.dataset.type || 'dataset';
        var items = [];
        if (libType === 'recipe') {
          items.push({ label: 'Rename', onClick: function() { vscode.postMessage({ type: 'renameRecipe', data: { slug: libSlug } }); } });
          items.push({ separator: true });
          items.push({ label: 'Delete', danger: true, onClick: function() { vscode.postMessage({ type: 'deleteRecipe', data: { slug: libSlug } }); } });
        } else if (libType === 'template') {
          items.push({ label: 'Open', onClick: function() { vscode.postMessage({ type: 'openTemplate', data: { slug: libSlug } }); } });
          items.push({ separator: true });
          items.push({ label: 'Delete', danger: true, onClick: function() { vscode.postMessage({ type: 'deleteTemplate', data: { slug: libSlug } }); } });
        } else {
          items.push({ label: 'Query', onClick: function() { vscode.postMessage({ type: 'selectDataset', data: { slug: libSlug } }); } });
          if (libType === 'dataset') {
            items.push({ separator: true });
            items.push({ label: 'Delete', danger: true, onClick: function() { vscode.postMessage({ type: 'deleteDataset', data: { slug: libSlug } }); } });
          }
        }
        showContextMenu(e.clientX, e.clientY, items);
        return;
      }
    });

    function applyFinanceToggle(enabled) {
      financeEnabled = enabled;
      // Show/hide finance-only tabs (Portfolio, Market)
      document.querySelectorAll('[data-finance="true"]').forEach(function(tab) {
        tab.style.display = enabled ? '' : 'none';
      });
    }

    // ── Helper: switch to a tab ──
    function switchTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      var tabEl = document.querySelector('[data-tab="' + tabName + '"]');
      if (tabEl) tabEl.classList.add('active');
      var contentEl = document.getElementById('tab-' + tabName);
      if (contentEl) contentEl.classList.add('active');
    }

    // ── Tab switching ──
    document.querySelectorAll('.tab').forEach(function(tab) {
      tab.addEventListener('click', function() { switchTab(tab.dataset.tab); });
    });

    // ── Global event delegation for data-action clicks ──
    document.addEventListener('click', function(e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      var action = el.dataset.action;

      switch (action) {
        case 'selectStock':
          state.selectedTicker = el.dataset.ticker;
          vscode.postMessage({ type: 'selectStock', data: { ticker: el.dataset.ticker } });
          switchTab('market');
          break;
        case 'selectProject':
          if (el.dataset.slug) {
            selectedProject = el.dataset.slug;
            renderProjectList();
            renderProjectDetail();
          } else {
            switchTab('projects');
          }
          break;
        case 'toggleDetailSection':
          if (el.dataset.section) {
            collapsedSections[el.dataset.section] = !collapsedSections[el.dataset.section];
            renderProjectDetail();
          }
          break;
        case 'openProjectCanvas':
          vscode.postMessage({ type: 'openProjectCanvas', data: { slug: el.dataset.slug } });
          break;
        case 'renameStart':
          renamingProject = el.dataset.slug;
          selectedProject = el.dataset.slug;
          renderProjectList(); renderProjectDetail();
          break;
        case 'fetchStock':
          vscode.postMessage({ type: 'fetchStock', data: { symbol: el.dataset.symbol, name: el.dataset.name, exchange: el.dataset.exchange } });
          break;
        case 'openRecipe':
          vscode.postMessage({ type: 'openRecipe', data: { slug: el.dataset.slug } });
          break;
        case 'viewListOnCanvas':
          vscode.postMessage({ type: 'viewListOnCanvas', data: { slug: el.dataset.slug } });
          break;
        case 'refreshList':
          vscode.postMessage({ type: 'refreshList', data: { slug: el.dataset.slug } });
          break;
        case 'renameList':
          vscode.postMessage({ type: 'renameList', data: { slug: el.dataset.slug } });
          break;
        case 'deleteList':
          vscode.postMessage({ type: 'deleteList', data: { slug: el.dataset.slug } });
          break;
        case 'openCanvasById':
          vscode.postMessage({ type: 'openCanvasById', data: { canvasId: el.dataset.canvasId } });
          break;
        case 'toggleCanvasTree':
          var clickedArrow = e.target && (e.target.classList.contains('arrow') || e.target.closest('.arrow'));
          var treeParent = el.closest('.canvas-tree');
          var elDiv = treeParent ? treeParent.querySelector('.canvas-elements') : null;
          var arrowEl = el.querySelector('.arrow');
          if (clickedArrow) {
            // Arrow click: just toggle expand/collapse
            if (elDiv) {
              elDiv.classList.toggle('open');
              if (arrowEl) arrowEl.classList.toggle('open');
            }
          } else {
            // Row click: open canvas + expand tree
            var cid = el.dataset.canvasId;
            if (cid) vscode.postMessage({ type: 'openCanvas', data: { canvasId: cid } });
            if (elDiv && !elDiv.classList.contains('open')) {
              elDiv.classList.add('open');
              if (arrowEl) arrowEl.classList.add('open');
            }
          }
          break;
        case 'canvasHistory':
          e.stopPropagation();
          vscode.postMessage({ type: 'canvasHistory', data: { canvasId: el.dataset.canvasId } });
          break;
        case 'deleteElement':
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteElement', data: { canvasId: el.dataset.canvasId, elementId: el.dataset.elementId } });
          break;
        case 'toggleElement':
          e.stopPropagation();
          vscode.postMessage({ type: 'toggleElement', data: { canvasId: el.dataset.canvasId, elementId: el.dataset.elementId } });
          break;
        case 'toggleTreeSection':
          var secId = el.dataset.section;
          var secItems = document.querySelector('.tree-section-items[data-section="' + secId + '"]');
          var secArrow = el.querySelector('.tree-arrow');
          if (secItems) secItems.classList.toggle('open');
          if (secArrow) secArrow.classList.toggle('open');
          break;
        case 'deleteProjectFile':
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteProjectFile', data: { projectSlug: el.dataset.slug, fileName: el.dataset.file, dir: el.dataset.dir } });
          break;
        case 'openProjectFile':
          vscode.postMessage({ type: 'openProjectFile', data: { projectSlug: el.dataset.slug, fileName: el.dataset.file, dir: el.dataset.dir } });
          break;
        case 'parseProjectFile':
          e.stopPropagation();
          vscode.postMessage({ type: 'parseProjectFile', data: { projectSlug: el.dataset.slug, fileName: el.dataset.file } });
          break;
        case 'viewNoteOnCanvas':
          e.stopPropagation();
          vscode.postMessage({ type: 'viewNoteOnCanvas', data: { projectSlug: el.dataset.slug, fileName: el.dataset.file } });
          break;
        case 'addProjectFiles':
          vscode.postMessage({ type: 'addProjectFiles', data: { projectSlug: el.dataset.slug } });
          break;
        case 'addData':
          vscode.postMessage({ type: 'addData', data: { projectSlug: el.dataset.slug || undefined } });
          break;
        case 'importDataset':
          vscode.postMessage({ type: 'addData' });
          break;
        case 'browseConnection':
          e.stopPropagation();
          vscode.postMessage({ type: 'browseConnection', data: { slug: el.dataset.slug, name: el.dataset.name } });
          break;
        case 'testConnector':
          e.stopPropagation();
          vscode.postMessage({ type: 'testConnector', data: { slug: el.dataset.slug } });
          break;
        case 'deleteConnector':
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteConnector', data: { slug: el.dataset.slug } });
          break;
        case 'selectDataset':
          vscode.postMessage({ type: 'selectDataset', data: { slug: el.dataset.slug } });
          break;
        case 'selectConnection':
          vscode.postMessage({ type: 'selectConnection', data: { slug: el.dataset.slug } });
          break;
        case 'publishDashboard':
          vscode.postMessage({ type: 'publishDashboard', data: { canvasId: el.dataset.canvasId } });
          break;
        case 'importProjectData':
          vscode.postMessage({ type: 'importProjectData', data: { projectSlug: el.dataset.slug } });
          break;
        case 'newProjectCanvas':
          vscode.postMessage({ type: 'newProjectCanvas', data: { projectSlug: el.dataset.slug } });
          break;
        case 'previewDataset':
          vscode.postMessage({ type: 'selectDataset', data: { slug: el.dataset.slug, projectSlug: el.dataset.project } });
          break;
        case 'openModel':
          vscode.postMessage({ type: 'openModel', data: { slug: el.dataset.slug, projectSlug: el.dataset.project } });
          break;
        case 'openQuery':
          vscode.postMessage({ type: 'openQuery', data: { slug: el.dataset.slug, projectSlug: el.dataset.project } });
          break;
        case 'linkResource':
          e.stopPropagation();
          vscode.postMessage({ type: 'linkResource', data: { projectSlug: el.dataset.project, resourceType: el.dataset.resourceType } });
          break;
        case 'unlinkResource':
          e.stopPropagation();
          vscode.postMessage({ type: 'unlinkResource', data: { projectSlug: el.dataset.project, resourceType: el.dataset.resourceType, resourceSlug: el.dataset.resourceSlug } });
          break;
        case 'openLinkedConnection':
          vscode.postMessage({ type: 'openLinkedConnection', data: { slug: el.dataset.slug, projectSlug: el.dataset.project } });
          break;
        case 'openLinkedRecipe':
          vscode.postMessage({ type: 'openLinkedRecipe', data: { slug: el.dataset.slug, projectSlug: el.dataset.project } });
          break;
        case 'openLinkedTemplate':
          vscode.postMessage({ type: 'openLinkedTemplate', data: { slug: el.dataset.slug, projectSlug: el.dataset.project } });
          break;
        case 'toggleSchemaTable':
          var colsDiv = el.nextElementSibling;
          if (colsDiv) colsDiv.style.display = colsDiv.style.display === 'none' ? '' : 'none';
          break;
        case 'toggleBindingPause':
          vscode.postMessage({ type: 'toggleBindingPause', data: { canvasId: el.dataset.canvasId, elementId: el.dataset.elementId } });
          break;
        case 'triggerBinding':
          vscode.postMessage({ type: 'triggerBinding', data: { canvasId: el.dataset.canvasId, elementId: el.dataset.elementId } });
          break;
        case 'deploy-preview':
          vscode.postMessage({ type: 'deploy-preview', data: { port: el.dataset.port } });
          break;
        case 'deploy-stop':
          vscode.postMessage({ type: 'deploy-stop', data: { slug: el.dataset.slug } });
          break;
        case 'deploy-start':
          vscode.postMessage({ type: 'deploy-start', data: { slug: el.dataset.slug } });
          break;
        case 'deploy-redeploy':
          vscode.postMessage({ type: 'deploy-redeploy', data: { slug: el.dataset.slug } });
          break;
        case 'deploy-remove':
          vscode.postMessage({ type: 'deploy-remove', data: { slug: el.dataset.slug } });
          break;
        case 'deploy-copyUrl':
          vscode.postMessage({ type: 'deploy-copyUrl', data: { url: el.dataset.url } });
          break;
        case 'copyShareLink':
          vscode.postMessage({ type: 'copyShareLink', data: { url: el.dataset.shareUrl } });
          break;
        case 'pauseShare':
          vscode.postMessage({ type: 'pauseShare', data: { shareId: el.dataset.shareId } });
          break;
        case 'resumeShare':
          vscode.postMessage({ type: 'resumeShare', data: { shareId: el.dataset.shareId } });
          break;
        case 'revokeShare':
          vscode.postMessage({ type: 'revokeShare', data: { shareId: el.dataset.shareId } });
          break;
        case 'startDaemon':
          vscode.postMessage({ type: 'startDaemon' });
          break;
        case 'stopDaemon':
          vscode.postMessage({ type: 'stopDaemon' });
          break;
        case 'quickNewProject':
          vscode.postMessage({ type: 'promptInput', data: { kind: 'project' } });
          break;
        case 'quickNewCanvas':
          var canvasBtn = document.getElementById('btn-new-canvas');
          if (canvasBtn) canvasBtn.click();
          break;
        case 'quickNewList':
          vscode.postMessage({ type: 'promptInput', data: { kind: 'list' } });
          break;
      }
    });

    function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // ── Render functions ──
    var selectedProject = null;
    var renamingProject = null;
    var collapsedSections = {};

    function renderProjectList() {
      var container = document.getElementById('projects-list');
      if (!container) return;
      if (state.projects.length === 0) {
        container.innerHTML = '<div class="empty-state">No projects yet</div>';
        return;
      }
      // Auto-select first project if none selected
      if (!selectedProject && state.projects.length > 0) {
        selectedProject = state.projects[0].slug;
      }
      var html = '';
      state.projects.forEach(function(p) {
        var slug = p.slug || '';
        var isSelected = selectedProject === slug;
        var selectedClass = isSelected ? ' selected' : '';
        var badgeClass = 'badge-' + (p.status || 'draft');

        html += '<div class="project-row' + selectedClass + '" data-slug="' + esc(slug) + '" data-status="' + esc(p.status || 'draft') + '"' + (p.mode ? ' data-mode="' + esc(p.mode) + '"' : '') + ' data-action="selectProject">';
        html += '<span class="project-dot ' + esc(p.status || 'draft') + '"></span>';

        if (renamingProject === slug) {
          html += '<input class="project-name-input" data-action="renameInput" data-slug="' + esc(slug) + '" value="' + esc(p.name) + '" />';
        } else {
          html += '<span class="project-name" title="Double-click to rename">' + esc(p.name) + '</span>';
        }

        if (p.mode === 'portfolio') {
          html += '<span class="status-badge" style="background:rgba(222,191,202,0.15);color:#DEBFCA;margin-left:4px;" title="Portfolio mode">$</span>';
        }
        html += '<span class="status-badge ' + badgeClass + '">' + esc(p.status || 'draft') + '</span>';
        html += '</div>';
      });
      container.innerHTML = html;

      if (renamingProject) {
        var renameInput = container.querySelector('.project-name-input');
        if (renameInput) renameInput.focus();
      }
    }

    function renderProjectDetail() {
      var container = document.getElementById('project-detail');
      if (!container) return;
      if (!selectedProject) {
        container.innerHTML = '<div class="detail-empty">Select a project</div>';
        return;
      }
      var p = state.projects.find(function(pr) { return pr.slug === selectedProject; });
      if (!p) {
        container.innerHTML = '<div class="detail-empty">Project not found</div>';
        return;
      }

      var slug = p.slug;
      var elIcons = { frame: '\\u2B21', note: '\\u2630', pdf: '\\u25A5', embed: '\\u25C8' };
      var openTreeIds = captureOpenCanvasTrees();
      var html = '';

      // ── Helper: build collapsible detail section ──
      function detailSection(key, label, count, addAction, addResType, content) {
        var isCollapsed = collapsedSections[key];
        var chevClass = 'section-chevron' + (isCollapsed ? '' : ' open');
        var countHtml = count !== null && count !== undefined ? ' <span style="font-size:10px;opacity:0.4;">' + count + '</span>' : '';
        var addBtn = addAction ? '<button class="section-add-btn" data-action="' + esc(addAction) + '" data-slug="' + esc(slug) + '" data-project="' + esc(slug) + '"' +
          (addResType ? ' data-resource-type="' + esc(addResType) + '"' : '') + ' title="Add">+</button>' : '';
        var h = '<div class="detail-section-hdr" data-action="toggleDetailSection" data-section="' + esc(key) + '">' +
          '<span class="' + chevClass + '">&#9656;</span> ' + label + countHtml + addBtn + '</div>';
        if (!isCollapsed) h += '<div class="detail-section-items">' + content + '</div>';
        return h;
      }

      // ── Canvases ──
      var projCanvases = p.canvases || [];
      var canvasContent = '';
      if (projCanvases.length > 0) {
        projCanvases.forEach(function(c) {
          var hasEls = c.elements && c.elements.length > 0;
          canvasContent += '<div class="canvas-tree">';
          canvasContent += '<div class="canvas-tree-toggle" data-action="toggleCanvasTree" data-canvas-id="' + esc(c.id) + '">' +
            '<span class="arrow' + (hasEls ? '' : ' empty') + '">\\u25B6</span>' +
            '<span style="font-size:12px;opacity:0.5;">\\u25A6</span>' +
            '<span style="flex:1;margin-left:4px;">' + esc(c.name || c.id) + '</span>' +
            '<span class="meta" style="font-size:10px;opacity:0.4;">' + (c.elementCount || 0) + '</span>' +
            '<button class="canvas-history-btn" title="Version history" data-action="canvasHistory" data-canvas-id="' + esc(c.id) + '"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2.5 1.5"/></svg></button>' +
          '</div>';
          var els = c.elements || [];
          if (els.length > 0) {
            canvasContent += '<div class="canvas-elements" data-canvas-id="' + esc(c.id) + '">';
            els.forEach(function(el) {
              var icon = elIcons[el.type] || '\\u25FB';
              var isFrame = el.type === 'frame' || el.type === 'embed';
              canvasContent += '<div class="canvas-element-row" data-element-id="' + esc(el.id) + '">';
              if (isFrame) canvasContent += '<input type="checkbox" class="el-check" data-canvas-id="' + esc(c.id) + '" data-element-id="' + esc(el.id) + '" />';
              if (el.hasBinding) canvasContent += '<span class="el-live-dot" title="Live refresh"></span>';
              canvasContent += '<span class="el-icon">' + icon + '</span>';
              canvasContent += '<span class="el-name' + (el.hidden ? ' hidden' : '') + '">' + esc(el.name) + '</span>';
              canvasContent += '<span class="el-actions">';
              canvasContent += '<button title="' + (el.hidden ? 'Show' : 'Hide') + '" data-action="toggleElement" data-canvas-id="' + esc(c.id) + '" data-element-id="' + esc(el.id) + '">' + (el.hidden ? '\\u25C9' : '\\u25CB') + '</button>';
              canvasContent += '<button title="Delete" data-action="deleteElement" data-canvas-id="' + esc(c.id) + '" data-element-id="' + esc(el.id) + '" style="color:#f85149;">\\u2715</button>';
              canvasContent += '</span>';
              canvasContent += '</div>';
            });
            canvasContent += '</div>';
          }
          canvasContent += '</div>';
        });
      } else {
        canvasContent = '<div class="project-tree-item" style="opacity:0.4;cursor:default;">No canvases</div>';
      }
      html += detailSection('canvases', 'Canvases', projCanvases.length, 'newProjectCanvas', null, canvasContent);

      // ── Datasets (conditional) ──
      var projDatasets = p.datasets || [];
      if (projDatasets.length > 0) {
        var dsContent = '';
        projDatasets.forEach(function(ds) {
          dsContent += '<div class="project-file-item" data-action="previewDataset" data-project="' + esc(slug) + '" data-slug="' + esc(ds.slug) + '">' +
            '<span class="project-file-icon other">DS</span>' +
            '<span class="project-file-name">' + esc(ds.name) + '</span>' +
            '<span style="font-size:10px;opacity:0.35;">' + (ds.rowCount ? ds.rowCount.toLocaleString() + ' rows' : '') + '</span>' +
          '</div>';
        });
        html += detailSection('datasets', 'Datasets', projDatasets.length, null, null, dsContent);
      }

      // ── Files & Docs ──
      var allFiles = p.allFiles || [];
      var filesContent = '';
      if (allFiles.length > 0) {
        allFiles.forEach(function(f) {
          var ext = (f.name.split('.').pop() || '').toLowerCase();
          var iconClass = ext === 'pdf' ? 'pdf' : (ext === 'md') ? 'note' : (ext === 'json') ? 'other' : (ext === 'py') ? 'other' : (ext === 'docx' || ext === 'doc') ? 'doc' : 'other';
          var iconLabel = ext.toUpperCase().slice(0,3);
          var dirLabel = '<span style="font-size:9px;opacity:0.35;margin-left:4px;">' + esc(f.dir) + '</span>';
          filesContent += '<div class="project-file-item" data-action="openProjectFile" data-slug="' + esc(slug) + '" data-file="' + esc(f.name) + '" data-dir="' + esc(f.dir) + '">' +
            '<span class="project-file-icon ' + iconClass + '">' + esc(iconLabel) + '</span>' +
            '<span class="project-file-name">' + esc(f.name) + dirLabel + '</span>' +
            '<button class="file-delete-btn" data-action="deleteProjectFile" data-slug="' + esc(slug) + '" data-file="' + esc(f.name) + '" data-dir="' + esc(f.dir) + '" title="Delete file">\u2715</button>' +
            '<button class="project-file-action" data-action="addSourceAsContext" data-file="' + esc(f.name) + '" data-project="' + esc(slug) + '" title="Add as @ context">@</button>' +
          '</div>';
        });
      } else {
        filesContent = '<div class="project-tree-item" style="opacity:0.4;cursor:default;">No files yet</div>';
      }
      html += detailSection('files', 'Files & Docs', allFiles.length, 'addProjectFiles', null, filesContent);

      // ── Models (conditional) ──
      var projModels = p.models || [];
      if (projModels.length > 0) {
        var modContent = '';
        projModels.forEach(function(m) {
          modContent += '<div class="project-file-item" data-action="openModel" data-project="' + esc(slug) + '" data-slug="' + esc(m.slug) + '">' +
            '<span class="project-file-icon note">M</span>' +
            '<span class="project-file-name">' + esc(m.name) + '</span>' +
          '</div>';
        });
        html += detailSection('models', 'Models', projModels.length, null, null, modContent);
      }

      // ── Queries (conditional) ──
      var projQueries = p.queries || [];
      if (projQueries.length > 0) {
        var qContent = '';
        projQueries.forEach(function(q) {
          qContent += '<div class="project-file-item" data-action="openQuery" data-project="' + esc(slug) + '" data-slug="' + esc(q.slug) + '">' +
            '<span class="project-file-icon other">Q</span>' +
            '<span class="project-file-name">' + esc(q.name) + '</span>' +
          '</div>';
        });
        html += detailSection('queries', 'Queries', projQueries.length, null, null, qContent);
      }

      // ── Connectors ──
      var linkedConns = (p.linkedConnectors || p.linkedConnections || []);
      var resolvedConns = linkedConns.map(function(s) {
        return (state.connectors || []).find(function(c) { return c.slug === s; });
      }).filter(Boolean);
      var connTypeIcons = { api: 'API', spreadsheet: 'SH', database: 'DB', crm: 'CRM', mcp: 'MCP', custom: 'FN' };
      var connContent = '';
      if (resolvedConns.length > 0) {
        resolvedConns.forEach(function(conn) {
          var icon = connTypeIcons[conn.type] || 'FN';
          connContent += '<div class="project-linked-item" data-slug="' + esc(conn.slug) + '" data-project="' + esc(slug) + '">' +
            '<span class="linked-icon">' + esc(icon) + '</span>' +
            '<span class="linked-name">' + esc(conn.name) + '</span>' +
            '<span class="linked-meta">' + esc(conn.type || '') + '</span>' +
            '<button class="unlink-btn" data-action="unlinkResource" data-project="' + esc(slug) + '" data-resource-type="connector" data-resource-slug="' + esc(conn.slug) + '" title="Unlink">\\u2715</button>' +
          '</div>';
        });
      } else {
        connContent = '<div class="project-tree-item" style="opacity:0.4;cursor:default;">None linked</div>';
      }
      html += detailSection('connectors', 'Connectors', resolvedConns.length, 'linkResource', 'connector', connContent);

      // ── Recipes ──
      var linkedRecs = (p.linkedRecipes || []);
      var resolvedRecs = linkedRecs.map(function(s) {
        return (state.recipes || []).find(function(r) { return r.slug === s; });
      }).filter(Boolean);
      var recContent = '';
      if (resolvedRecs.length > 0) {
        resolvedRecs.forEach(function(rec) {
          recContent += '<div class="project-linked-item" data-action="openLinkedRecipe" data-slug="' + esc(rec.slug) + '" data-project="' + esc(slug) + '">' +
            '<span class="linked-icon">\\u2699</span>' +
            '<span class="linked-name">' + esc(rec.name) + '</span>' +
            '<span class="linked-meta">' + esc(rec.outputHint || '') + '</span>' +
            '<button class="unlink-btn" data-action="unlinkResource" data-project="' + esc(slug) + '" data-resource-type="recipe" data-resource-slug="' + esc(rec.slug) + '" title="Unlink">\\u2715</button>' +
          '</div>';
        });
      } else {
        recContent = '<div class="project-tree-item" style="opacity:0.4;cursor:default;">None linked</div>';
      }
      html += detailSection('recipes', 'Recipes', resolvedRecs.length, 'linkResource', 'recipe', recContent);

      // ── Templates ──
      var linkedTpls = (p.linkedTemplates || []);
      var tplContent = '';
      if (linkedTpls.length > 0) {
        linkedTpls.forEach(function(tplSlug) {
          tplContent += '<div class="project-linked-item" data-action="openLinkedTemplate" data-slug="' + esc(tplSlug) + '" data-project="' + esc(slug) + '">' +
            '<span class="linked-icon">\\u25A8</span>' +
            '<span class="linked-name">' + esc(tplSlug) + '</span>' +
            '<button class="unlink-btn" data-action="unlinkResource" data-project="' + esc(slug) + '" data-resource-type="template" data-resource-slug="' + esc(tplSlug) + '" title="Unlink">\\u2715</button>' +
          '</div>';
        });
      } else {
        tplContent = '<div class="project-tree-item" style="opacity:0.4;cursor:default;">None linked</div>';
      }
      html += detailSection('templates', 'Templates', linkedTpls.length, 'linkResource', 'template', tplContent);

      // ── Deployment ──
      if (p.deployment && p.deployment.status !== 'not_deployed') {
        var dep = p.deployment;
        var depDot = dep.status === 'live' ? '#3FB950' : '#888';
        var depLabel = dep.status === 'live' ? 'Live' : 'Stopped';
        var depContent = '<div style="padding:4px 8px;">';
        depContent += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">';
        depContent += '<span style="color:' + depDot + ';font-size:8px;">\\u25CF</span>';
        depContent += '<span style="font-size:12px;font-weight:600;">' + depLabel + '</span>';
        if (dep.version) depContent += '<span style="font-size:10px;opacity:0.4;">v' + dep.version + '</span>';
        if (dep.lastDeployed) depContent += '<span style="font-size:10px;opacity:0.4;margin-left:auto;">' + timeAgo(dep.lastDeployed) + '</span>';
        depContent += '</div>';
        if (dep.url) {
          depContent += '<div style="font-size:11px;color:var(--jet-accent);cursor:pointer;margin-bottom:6px;word-break:break-all;" data-action="deploy-copyUrl" data-url="' + esc(dep.url) + '" title="Click to copy">' + esc(dep.url.replace('https://','')) + '</div>';
        }
        depContent += '<div style="display:flex;gap:4px;">';
        if (dep.status === 'live') {
          depContent += '<button data-action="deploy-stop" data-slug="' + esc(slug) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:2px 8px;">Stop</button>';
          depContent += '<button data-action="deploy-redeploy" data-slug="' + esc(slug) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:2px 8px;">Redeploy</button>';
        } else {
          depContent += '<button data-action="deploy-start" data-slug="' + esc(slug) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:2px 8px;">Restart</button>';
        }
        depContent += '<button data-action="deploy-remove" data-slug="' + esc(slug) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#f85149;cursor:pointer;padding:2px 8px;">Remove</button>';
        depContent += '</div></div>';
        html += detailSection('deployment', 'Deployment', null, null, null, depContent);
      }

      // ── Portfolio Stats ──
      if (p.portfolioSummary) {
        var ps = p.portfolioSummary;
        var retClass = ps.returnPct >= 0 ? 'up' : 'down';
        var pfContent = '<div class="pf-summary-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:2px 8px;padding:2px 8px 4px 4px;font-size:10px;">' +
          '<div><span style="opacity:0.5;">NAV/u</span> ' + ps.navPerUnit.toFixed(2) + '</div>' +
          '<div><span style="opacity:0.5;">Return</span> <span class="change ' + retClass + '">' + ps.returnPct.toFixed(1) + '%</span></div>' +
          '<div><span style="opacity:0.5;">Holdings</span> ' + ps.holdings + '</div>' +
          '<div><span style="opacity:0.5;">Cash</span> ' + formatNum(ps.cash) + '</div>' +
          '<div><span style="opacity:0.5;">Capital</span> ' + formatNum(ps.initialCapital) + '</div>' +
          '<div><span style="opacity:0.5;">Bench</span> ' + esc(ps.benchmark ? ps.benchmark.replace('.NS','').replace('^','') : 'None') + '</div>' +
        '</div>';
        html += detailSection('portfolio', 'Portfolio', null, null, null, pfContent);
      }

      container.innerHTML = html;
      restoreOpenCanvasTrees(openTreeIds);
    }

    function renderLists() {
      var container = document.getElementById('market-lists');
      if (state.lists.length === 0) {
        container.innerHTML = '<div class="empty-state">No lists yet</div>';
        return;
      }
      var html = '';
      state.lists.forEach(function(l) {
        var slug = l.slug || '';
        var tickers = l.tickers || [];
        var auto = l.refreshable ? ' <span class="auto-badge">auto</span>' : '';
        var desc = l.thesis || 'No description';
        html += '<div class="list-card-v2" data-slug="' + esc(slug) + '">' +
          '<div class="list-card-top">' +
            '<span class="list-name">' + esc(l.name) + auto + '</span>' +
            '<span class="list-count">' + tickers.length + ' stock' + (tickers.length !== 1 ? 's' : '') + '</span>' +
          '</div>' +
          '<div class="list-desc">' + esc(desc) + '</div>' +
          '<div class="list-card-actions">' +
            '<button data-action="viewListOnCanvas" data-slug="' + esc(slug) + '" title="View on canvas">&#9670; Canvas</button>' +
            (l.refreshable ? '<button data-action="refreshList" data-slug="' + esc(slug) + '" title="Refresh">&#8635; Refresh</button>' : '') +
            '<button data-action="renameList" data-slug="' + esc(slug) + '" title="Rename">&#9998;</button>' +
            '<button class="danger" data-action="deleteList" data-slug="' + esc(slug) + '" title="Delete">&#10005;</button>' +
          '</div>' +
        '</div>';
      });
      container.innerHTML = html;
    }

    function renderLibraryConnectors(connectors) {
      var container = document.getElementById('library-connectors');
      if (!container) return;
      if (!connectors || connectors.length === 0) {
        container.innerHTML = '<div class="empty-state">No connectors yet — ask the agent to create one</div>';
        return;
      }
      var typeIcons = { api: 'API', spreadsheet: 'SH', database: 'DB', crm: 'CRM', mcp: 'MCP', custom: 'FN' };
      container.innerHTML = connectors.map(function(c) {
        var icon = typeIcons[(c.type || '').toLowerCase()] || (c.type || 'FN').slice(0,3).toUpperCase();
        var authLabel = c.auth ? c.auth.method : 'none';
        return '<div class="library-item" data-slug="' + esc(c.slug) + '" data-type="connector" data-name="' + esc(c.name) + '">' +
          '<span style="font-size:9px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:3px;background:var(--jet-blue-dim);color:var(--jet-blue);margin-right:6px;flex-shrink:0;">' + esc(icon) + '</span>' +
          '<span class="label" style="flex:1;">' + esc(c.name) + '</span>' +
          '<span class="meta">' + esc(authLabel) + '</span>' +
          '<button class="project-file-action" data-action="testConnector" data-slug="' + esc(c.slug) + '" title="Test" style="font-size:10px;padding:1px 5px;margin-left:4px;">Test</button>' +
          '<button class="project-file-action" data-action="deleteConnector" data-slug="' + esc(c.slug) + '" title="Delete" style="font-size:10px;padding:1px 5px;margin-left:2px;color:var(--jet-down);">&times;</button>' +
        '</div>';
      }).join('');
    }

    function renderLibraryDatasets(datasets) {
      var container = document.getElementById('library-datasets');
      if (!container) return;
      if (!datasets || datasets.length === 0) {
        container.innerHTML = '<div class="empty-state">No datasets imported</div>';
        return;
      }
      container.innerHTML = datasets.map(function(ds) {
        var meta = [];
        if (ds.rowCount) meta.push(ds.rowCount.toLocaleString() + ' rows');
        if (ds.columns) meta.push(ds.columns.length + ' cols');
        return '<div class="library-item" data-slug="' + esc(ds.slug) + '" data-type="dataset" data-action="selectDataset">' +
          '<span class="dataset-icon" style="font-size:10px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:3px;background:var(--jet-blue-dim);color:var(--jet-blue);margin-right:6px;flex-shrink:0;">DS</span>' +
          '<span class="label" style="flex:1;">' + esc(ds.name) + '</span>' +
          (meta.length ? '<span class="meta">' + meta.join(' \\u00b7 ') + '</span>' : '') +
        '</div>';
      }).join('');
    }

    function renderDashboards() {
      var container = document.getElementById('library-dashboards');
      if (!container) return;
      var deployed = (state.projects || []).filter(function(p) {
        return p.deployment && (p.deployment.status === 'live' || p.deployment.status === 'stopped');
      });
      if (deployed.length === 0) {
        container.innerHTML = '<div class="empty-state">No published apps yet.<br><span style="font-size:11px;opacity:0.6;">Deploy a project to see it here.</span></div>';
        return;
      }
      var html = '';
      var ds = state.deployStatus || {};
      deployed.forEach(function(p) {
        var dep = p.deployment;
        var isLive = dep.status === 'live';
        var appStatus = ds[p.slug];
        var relayOk = appStatus && appStatus.relayConnected;
        var containerAlive = appStatus ? appStatus.containerAlive : false;
        var dotColor = !isLive ? '#888' : (!containerAlive ? '#F85149' : (relayOk ? '#3FB950' : '#F0AD4E'));
        var statusLabel = !isLive ? 'Stopped' : (!containerAlive ? 'Container crashed' : (relayOk ? 'Live' : 'Relay disconnected'));
        var statusTip = !isLive ? 'Container is stopped. Click Restart to bring it back online.'
          : (!containerAlive ? 'Container crashed or exited. Check Docker logs. Try Redeploy to rebuild.'
          : (relayOk ? 'App is live and reachable at the public URL.'
          : 'Container is running but the relay is not connected. Viewers will see "App Offline". Try redeploying.'));
        html += '<div style="padding:6px 12px;border-bottom:1px solid #2a2a2a;">';
        html += '<div style="display:flex;align-items:center;gap:6px;">';
        html += '<span style="color:' + dotColor + ';font-size:8px;" title="' + statusTip + '">\\u25CF</span>';
        html += '<span style="flex:1;font-size:12px;">' + esc(p.name) + '</span>';
        html += '<span style="font-size:10px;color:' + dotColor + ';" title="' + statusTip + '">' + statusLabel + '</span>';
        if (dep.version) html += '<span style="font-size:10px;opacity:0.3;margin-left:4px;">v' + dep.version + '</span>';
        html += '</div>';
        if (dep.url) {
          html += '<div style="font-size:11px;color:var(--jet-accent);cursor:pointer;margin-top:2px;word-break:break-all;" data-action="deploy-copyUrl" data-url="' + esc(dep.url) + '" title="Click to copy">' + esc(dep.url.replace('https://','')) + '</div>';
        }
        html += '<div style="display:flex;gap:4px;margin-top:4px;">';
        if (isLive) {
          var previewPort = appStatus ? appStatus.port : dep.port;
          if (previewPort) {
            html += '<button data-action="deploy-preview" data-port="' + previewPort + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:var(--jet-accent);cursor:pointer;padding:2px 6px;">Preview</button>';
          }
          html += '<button data-action="deploy-stop" data-slug="' + esc(p.slug) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:2px 6px;">Stop</button>';
          html += '<button data-action="deploy-redeploy" data-slug="' + esc(p.slug) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:2px 6px;">Redeploy</button>';
        } else {
          html += '<button data-action="deploy-start" data-slug="' + esc(p.slug) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:2px 6px;">Restart</button>';
        }
        html += '<button data-action="deploy-remove" data-slug="' + esc(p.slug) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#f85149;cursor:pointer;padding:2px 6px;">Remove</button>';
        html += '</div>';
        html += '</div>';
      });
      container.innerHTML = html;
    }

    function renderTemplates() {
      var container = document.getElementById('library-templates');
      if (!container) return;
      var tpls = state.templates || [];
      if (tpls.length === 0) {
        container.innerHTML = '<div class="empty-state">No templates yet</div>';
        return;
      }
      container.innerHTML = tpls.map(function(t) {
        var meta = t.description || t.source || '';
        var slug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        var isLocal = t.source === 'local';
        return '<div class="library-item"' + (isLocal ? ' data-slug="' + esc(slug) + '" data-type="template"' : '') + '>' +
          '<span style="font-size:9px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:3px;background:var(--jet-accent-dim);color:var(--jet-accent);margin-right:6px;flex-shrink:0;">T</span>' +
          '<span class="label" style="flex:1;">' + esc(t.name) + '</span>' +
          '<span class="meta">' + esc(meta) + '</span>' +
        '</div>';
      }).join('');
    }

    function renderRecipes() {
      var container = document.getElementById('library-recipes');
      if (state.recipes.length === 0) {
        container.innerHTML = '<div class="empty-state">No recipes yet</div>';
        return;
      }
      container.innerHTML = state.recipes.map(function(r) {
        var meta = (r.inputs ? r.inputs.length : 0) + ' inputs \u00b7 ' + esc(r.outputHint || 'general');
        return '<div class="library-item" data-slug="' + esc(r.slug) + '" data-type="recipe" data-name="' + esc(r.name) + '" data-action="openRecipe">' +
          '<span style="font-size:9px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:3px;background:var(--jet-accent-dim);color:var(--jet-accent);margin-right:6px;flex-shrink:0;">R</span>' +
          '<span class="label" style="flex:1;">' + esc(r.name) + '</span>' +
          '<span class="meta">' + meta + '</span>' +
        '</div>';
      }).join('');
    }

    function renderCanvases() {
      var container = document.getElementById('library-canvases');
      if (!state.canvases || state.canvases.length === 0) {
        container.innerHTML = '<div class="empty-state">No canvases yet</div>';
        return;
      }

      var typeIcons = { card: '\\u25FB', table: '\\u25A4', chart: '\\u25EB', note: '\\u2630', index: '\\u25C8', pdf: '\\u25A5', frame: '\\u2B21', custom: '\\u25C7' };

      function renderCanvasTree(c) {
        var hasElements = c.elements && c.elements.length > 0;
        var h = '<div class="canvas-tree">';
        // Canvas header — click to expand/collapse
        h += '<div class="canvas-tree-toggle" data-action="toggleCanvasTree" data-canvas-id="' + esc(c.id) + '">';
        h += '<span class="arrow' + (hasElements ? '' : ' empty') + '">\\u25B6</span>';
        h += '<span style="font-size:12px;opacity:0.5;">\\u25A6</span>';
        h += '<span style="flex:1;margin-left:4px;">' + esc(c.name || c.id) + '</span>';
        h += '<span class="meta" style="font-size:10px;opacity:0.4;">' + (c.elementCount || 0) + '</span>';
        h += '<button class="canvas-history-btn" title="Version history" data-action="canvasHistory" data-canvas-id="' + esc(c.id) + '"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2.5 1.5"/></svg></button>';
        h += '</div>';
        // Element sub-list
        if (hasElements) {
          h += '<div class="canvas-elements" data-canvas-id="' + esc(c.id) + '">';
          c.elements.forEach(function(el) {
            var icon = typeIcons[el.type] || '\\u25FB';
            var isFrame = el.type === 'frame' || el.type === 'embed';
            h += '<div class="canvas-element-row" data-element-id="' + esc(el.id) + '">';
            if (isFrame) h += '<input type="checkbox" class="el-check" data-canvas-id="' + esc(c.id) + '" data-element-id="' + esc(el.id) + '" />';
            if (el.hasBinding) h += '<span class="el-live-dot" title="Live refresh"></span>';
            h += '<span class="el-icon">' + icon + '</span>';
            h += '<span class="el-name' + (el.hidden ? ' hidden' : '') + '">' + esc(el.name) + '</span>';
            h += '<span class="el-actions">';
            h += '<button title="' + (el.hidden ? 'Show' : 'Hide') + '" data-action="toggleElement" data-canvas-id="' + esc(c.id) + '" data-element-id="' + esc(el.id) + '">' + (el.hidden ? '\\u25C9' : '\\u25CB') + '</button>';
            h += '<button title="Delete" data-action="deleteElement" data-canvas-id="' + esc(c.id) + '" data-element-id="' + esc(el.id) + '" style="color:#f85149;">\\u2715</button>';
            h += '</span>';
            h += '</div>';
          });
          h += '</div>';
        }
        h += '</div>';
        return h;
      }

      // Group: universal first, then by project
      var universal = state.canvases.filter(function(c) { return !c.projectSlug; });
      var byProject = {};
      state.canvases.forEach(function(c) {
        if (c.projectSlug) {
          if (!byProject[c.projectSlug]) byProject[c.projectSlug] = [];
          byProject[c.projectSlug].push(c);
        }
      });

      var html = '';
      universal.forEach(function(c) { html += renderCanvasTree(c); });

      var projectSlugs = Object.keys(byProject);
      projectSlugs.forEach(function(slug) {
        var projectName = slug.replace(/_/g, ' ').replace(/\\b\\w/g, function(c) { return c.toUpperCase(); });
        var proj = (state.projects || []).find(function(p) { return p.slug === slug; });
        if (proj) projectName = proj.name;
        html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.4;padding:6px 12px 2px;margin-top:4px;">' + esc(projectName) + '</div>';
        byProject[slug].forEach(function(c) { html += renderCanvasTree(c); });
      });

      container.innerHTML = html;

      // Populate the project dropdown for new canvas creation
      var projectSelect = document.getElementById('new-canvas-project');
      if (projectSelect) {
        var optHtml = '<option value="">Universal</option>';
        (state.projects || []).forEach(function(p) {
          optHtml += '<option value="' + esc(p.slug) + '">' + esc(p.name) + '</option>';
        });
        projectSelect.innerHTML = optHtml;
      }
    }

    function timeAgo(iso) {
      var diff = Date.now() - new Date(iso).getTime();
      var mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + ' min ago';
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      return Math.floor(hrs / 24) + 'd ago';
    }

    function renderShares() {
      var container = document.getElementById('library-shares');
      if (!state.shares || state.shares.length === 0) {
        container.innerHTML = '<div class="empty-state">No shares yet. Share a canvas element to get started.</div>';
        return;
      }

      var html = '';
      state.shares.forEach(function(share) {
        var statusColor = share.status === 'active' ? '#3FB950' : '#888';
        var statusLabel = share.status === 'active' ? 'Active' : 'Paused';
        html += '<div class="share-item" style="padding:6px 12px;border-bottom:1px solid #2a2a2a;">';
        html += '<div style="display:flex;align-items:center;gap:6px;">';
        html += '<span style="color:' + statusColor + ';font-size:8px;">\\u25CF</span>';
        html += '<span style="flex:1;font-size:12px;">' + esc(share.title) + '</span>';
        html += '<span style="font-size:10px;opacity:0.5;">' + statusLabel + '</span>';
        html += '</div>';

        // Element details (if share has been fetched in detail)
        if (share.elements) {
          share.elements.forEach(function(el) {
            html += '<div style="padding:2px 0 2px 20px;font-size:11px;display:flex;align-items:center;gap:4px;opacity:0.7;">';
            html += '<span>\\u251C\\u2500</span>';
            html += '<span>' + esc(el.title) + '</span>';
            if (el.isLive && el.status === 'active') {
              html += '<span style="color:#3FB950;font-size:8px;">LIVE \\u25CF</span>';
            }
            if (el.lastUploaded) {
              html += '<span style="margin-left:auto;font-size:10px;opacity:0.5;">' + timeAgo(el.lastUploaded) + '</span>';
            }
            html += '</div>';
          });
        } else {
          html += '<div style="padding:2px 0 2px 20px;font-size:11px;opacity:0.5;">' + share.elementCount + ' element' + (share.elementCount !== 1 ? 's' : '') + '</div>';
        }

        // Action buttons
        html += '<div style="display:flex;gap:4px;padding:4px 0 2px 16px;">';
        html += '<button data-action="copyShareLink" data-share-url="' + esc(share.url) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:2px 6px;">Copy Link</button>';
        if (share.status === 'active') {
          html += '<button data-action="pauseShare" data-share-id="' + esc(share.id) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:2px 6px;">Pause</button>';
        } else {
          html += '<button data-action="resumeShare" data-share-id="' + esc(share.id) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:2px 6px;">Resume</button>';
        }
        html += '<button data-action="revokeShare" data-share-id="' + esc(share.id) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#f85149;cursor:pointer;padding:2px 6px;">Revoke</button>';
        html += '</div>';
        html += '</div>';
      });
      container.innerHTML = html;
    }

    function renderStatusTab() {
      var container = document.getElementById('status-bindings-list');
      var toggle = document.getElementById('status-global-toggle');
      if (!container) return;

      var bindings = state.allBindings || [];
      var paused = state.bindingsPaused || false;

      // Global toggle button
      if (toggle) {
        toggle.textContent = paused ? '\\u25B6 Resume All' : '\\u23F8 Pause All';
        toggle.style.color = paused ? 'var(--jet-up)' : 'var(--jet-down)';
      }

      if (bindings.length === 0) {
        container.innerHTML = '<div class="empty-state" style="font-size:11px;">No active refresh bindings.<br><span style="opacity:0.5;">Ask the agent to add a live refresh to a canvas element.</span></div>';
        return;
      }

      function fmtInterval(ms) {
        if (ms < 60000) return (ms / 1000) + 's';
        if (ms < 3600000) return (ms / 60000) + 'm';
        return (ms / 3600000).toFixed(1) + 'h';
      }

      var html = '';
      bindings.forEach(function(item) {
        var b = item.binding;
        var isEnabled = b.enabled !== false;
        var isPaused = paused || !isEnabled;
        var dotColor = isPaused ? '#888' : 'var(--jet-up)';
        var statusText = paused ? 'Global pause' : (!isEnabled ? 'Paused' : 'Active');
        var typeLabel = b.bindingType === 'prompt' ? 'AI Prompt' : 'Script';
        var intervalLabel = fmtInterval(b.intervalMs || 120000);

        html += '<div class="canvas-element-row" style="padding:4px 8px;border-bottom:1px solid #2a2a2a;flex-direction:column;align-items:stretch;gap:2px;">';

        // Top row: status dot + element name + canvas name
        html += '<div style="display:flex;align-items:center;gap:6px;">';
        html += '<span style="color:' + dotColor + ';font-size:8px;">\\u25CF</span>';
        html += '<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(item.elementName) + '</span>';
        html += '<span style="font-size:10px;opacity:0.4;">' + esc(item.canvasName) + '</span>';
        html += '</div>';

        // Detail row: type + interval + status + last run
        html += '<div style="display:flex;align-items:center;gap:6px;padding-left:14px;font-size:10px;opacity:0.6;">';
        html += '<span>' + typeLabel + '</span>';
        html += '<span>\\u00B7</span>';
        html += '<span>' + intervalLabel + '</span>';
        html += '<span>\\u00B7</span>';
        html += '<span style="color:' + (isPaused ? '#888' : 'var(--jet-up)') + ';">' + statusText + '</span>';
        if (b.lastRun) {
          html += '<span>\\u00B7</span>';
          html += '<span>' + timeAgo(b.lastRun) + '</span>';
        }
        if (b.lastError) {
          html += '<span style="color:var(--jet-down);" title="' + esc(b.lastError) + '">\\u26A0</span>';
        }
        html += '</div>';

        // Action buttons
        html += '<div style="display:flex;gap:4px;padding-left:14px;margin-top:2px;">';
        html += '<button data-action="toggleBindingPause" data-canvas-id="' + esc(item.canvasId) + '" data-element-id="' + esc(b.elementId) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:1px 6px;">' + (isEnabled ? 'Pause' : 'Resume') + '</button>';
        html += '<button data-action="triggerBinding" data-canvas-id="' + esc(item.canvasId) + '" data-element-id="' + esc(b.elementId) + '" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:1px 6px;">Run Now</button>';
        html += '</div>';

        html += '</div>';
      });
      container.innerHTML = html;
    }

    function renderDaemonStatus() {
      var container = document.getElementById('daemon-status');
      if (!state.daemon) {
        container.innerHTML = '<div class="empty-state" style="font-size:11px;">Daemon not checked yet</div>';
        return;
      }
      if (state.daemon.running) {
        container.innerHTML = '<div style="padding:6px 12px;font-size:11px;">' +
          '<span style="color:#3FB950;">\\u25CF</span> Running (PID ' + state.daemon.pid + ')' +
          '<div style="margin-top:4px;display:flex;gap:4px;">' +
          '<button data-action="stopDaemon" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:2px 6px;">Stop</button>' +
          '</div></div>';
      } else {
        container.innerHTML = '<div style="padding:6px 12px;font-size:11px;">' +
          '<span style="color:#888;">\\u25CB</span> Stopped' +
          '<div style="margin-top:4px;display:flex;gap:4px;">' +
          '<button data-action="startDaemon" style="font-size:10px;background:none;border:1px solid #3c3c3c;border-radius:3px;color:#ccc;cursor:pointer;padding:2px 6px;">Start</button>' +
          '</div></div>';
      }
    }


    function fmtSize(bytes) {
      if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
      if (bytes > 1024) return (bytes / 1024).toFixed(0) + ' KB';
      return bytes + ' B';
    }


    // ── Buttons (null-safe) ──
    function safeBind(id, evt, fn) { var el = document.getElementById(id); if (el) el.addEventListener(evt, fn); else console.warn('[JET] missing #' + id); }

    safeBind('btn-new-project-v2', 'click', function() {
      var row = document.getElementById('new-project-input');
      if (row) row.classList.add('visible');
      var inp = document.getElementById('new-project-name');
      if (inp) inp.focus();
    });

    safeBind('new-project-create', 'click', function() {
      var input = document.getElementById('new-project-name');
      var name = input ? input.value.trim() : '';
      if (name) {
        vscode.postMessage({ type: 'createProject', data: { name: name } });
        if (input) input.value = '';
      }
      var row = document.getElementById('new-project-input');
      if (row) row.classList.remove('visible');
    });

    safeBind('new-project-cancel', 'click', function() {
      var inp = document.getElementById('new-project-name');
      if (inp) inp.value = '';
      var row = document.getElementById('new-project-input');
      if (row) row.classList.remove('visible');
    });

    safeBind('new-project-name', 'keydown', function(e) {
      if (e.key === 'Enter') {
        var btn = document.getElementById('new-project-create');
        if (btn) btn.click();
      } else if (e.key === 'Escape') {
        var btn = document.getElementById('new-project-cancel');
        if (btn) btn.click();
      }
    });

    // Rename: handle Enter/Escape on rename input (delegated since it's dynamic)
    document.addEventListener('keydown', function(e) {
      if (e.target && e.target.classList && e.target.classList.contains('project-name-input')) {
        if (e.key === 'Enter') {
          var newName = e.target.value.trim();
          var slug = e.target.dataset.slug;
          if (newName && slug) {
            vscode.postMessage({ type: 'renameProject', data: { slug: slug, newName: newName } });
          }
          renamingProject = null;
          renderProjectList(); renderProjectDetail();
        } else if (e.key === 'Escape') {
          renamingProject = null;
          renderProjectList(); renderProjectDetail();
        }
      }
    });

    // Rename: handle blur (click away)
    document.addEventListener('focusout', function(e) {
      if (e.target && e.target.classList && e.target.classList.contains('project-name-input')) {
        var newName = e.target.value.trim();
        var slug = e.target.dataset.slug;
        if (newName && slug && renamingProject) {
          vscode.postMessage({ type: 'renameProject', data: { slug: slug, newName: newName } });
        }
        renamingProject = null;
        setTimeout(function() { renderProjectList(); renderProjectDetail(); }, 100);
      }
    });

    safeBind('btn-new-list', 'click', function() {
      vscode.postMessage({ type: 'promptInput', data: { kind: 'list' } });
    });

    // ── New Canvas button ──
    safeBind('btn-new-canvas', 'click', function() {
      var row = document.getElementById('new-canvas-row');
      if (!row) return;
      row.style.display = row.style.display === 'none' ? '' : 'none';
      if (row.style.display !== 'none') {
        var inp = document.getElementById('new-canvas-name');
        if (inp) inp.focus();
      }
    });

    safeBind('btn-add-connection', 'click', function() {
      vscode.postMessage({ type: 'addConnection' });
    });

    safeBind('btn-add-data', 'click', function() {
      vscode.postMessage({ type: 'addData' });
    });

    safeBind('btn-refresh-shares', 'click', function() {
      vscode.postMessage({ type: 'refreshShares' });
    });

    safeBind('new-canvas-create', 'click', function() {
      var input = document.getElementById('new-canvas-name');
      var projectSelect = document.getElementById('new-canvas-project');
      var name = input ? input.value.trim() : '';
      if (name) {
        var projectSlug = projectSelect ? (projectSelect.value || undefined) : undefined;
        vscode.postMessage({ type: 'createCanvas', data: { name: name, projectSlug: projectSlug } });
        if (input) input.value = '';
      }
      var row = document.getElementById('new-canvas-row');
      if (row) row.style.display = 'none';
    });

    safeBind('new-canvas-cancel', 'click', function() {
      var inp = document.getElementById('new-canvas-name');
      if (inp) inp.value = '';
      var row = document.getElementById('new-canvas-row');
      if (row) row.style.display = 'none';
    });

    safeBind('new-canvas-name', 'keydown', function(e) {
      if (e.key === 'Enter') {
        var btn = document.getElementById('new-canvas-create');
        if (btn) btn.click();
      } else if (e.key === 'Escape') {
        var btn = document.getElementById('new-canvas-cancel');
        if (btn) btn.click();
      }
    });


    safeBind('status-global-toggle', 'click', function() {
      vscode.postMessage({ type: 'toggleGlobalPause' });
    });
    safeBind('footer-settings', 'click', function() {
      vscode.postMessage({ type: 'openSettings' });
    });

    safeBind('footer-companion', 'click', function() {
      vscode.postMessage({ type: 'openCompanion' });
    });

    // ── Divider drag logic ──
    (function() {
      var divider = document.getElementById('projects-divider');
      var topPanel = document.getElementById('projects-top-panel');
      if (!divider || !topPanel) return;
      var startY = 0, startH = 0, dragging = false;
      divider.addEventListener('mousedown', function(e) {
        e.preventDefault();
        startY = e.clientY;
        startH = topPanel.offsetHeight;
        dragging = true;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'row-resize';
      });
      document.addEventListener('mousemove', function(e) {
        if (!dragging) return;
        if (Math.abs(e.clientY - startY) < 3) return;
        var container = topPanel.parentElement;
        if (!container) return;
        var maxH = container.offsetHeight - 80;
        if (maxH < 60) return;
        var newH = Math.max(60, Math.min(maxH, startH + (e.clientY - startY)));
        topPanel.style.height = newH + 'px';
        topPanel.style.flex = 'none';
      });
      document.addEventListener('mouseup', function() {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      });
    })();

    // ── Message handling ──
    // ── Multi-select share: checkbox change + "Share Selected" bars (library + projects) ──
    function updateShareBars() {
      ['share-selected-bar', 'share-selected-bar-projects'].forEach(function(barId) {
        var bar = document.getElementById(barId);
        if (!bar) return;
        // Count checked items within this bar's parent panel
        var panel = bar.parentElement;
        var checked = panel ? panel.querySelectorAll('.el-check:checked') : [];
        if (checked.length > 0) {
          bar.textContent = 'Share ' + checked.length + ' element' + (checked.length > 1 ? 's' : '');
          bar.classList.add('visible');
        } else {
          bar.classList.remove('visible');
        }
      });
    }
    document.addEventListener('change', function(e) {
      if (e.target && e.target.classList && e.target.classList.contains('el-check')) {
        updateShareBars();
      }
    });
    function handleShareBarClick(bar) {
      var panel = bar.parentElement;
      var checked = panel ? panel.querySelectorAll('.el-check:checked') : [];
      if (checked.length === 0) return;
      var canvasId = checked[0].dataset.canvasId;
      var elementIds = [];
      checked.forEach(function(cb) { elementIds.push(cb.dataset.elementId); });
      vscode.postMessage({ type: 'shareElements', data: { canvasId: canvasId, elementIds: elementIds } });
      checked.forEach(function(cb) { cb.checked = false; });
      updateShareBars();
    }
    var shareBar1 = document.getElementById('share-selected-bar');
    var shareBar2 = document.getElementById('share-selected-bar-projects');
    if (shareBar1) shareBar1.addEventListener('click', function() { handleShareBarClick(shareBar1); });
    if (shareBar2) shareBar2.addEventListener('click', function() { handleShareBarClick(shareBar2); });

    // Signal to the extension that the webview is ready to receive messages
    vscode.postMessage({ type: 'webviewReady' });

    window.addEventListener('message', function(event) {
      var msg = event.data;
      switch (msg.type) {
        case 'init':
          var isFirstInit = !state.index;
          state = Object.assign({}, state, msg.data);

          // Only re-render sections whose underlying data actually changed
          if (dataChanged('projects', state.projects)) { renderProjectList(); renderProjectDetail(); renderDashboards(); }
          if (dataChanged('lists', state.lists)) renderLists();

          if (dataChanged('canvases', state.canvases)) {
            var openTrees = captureOpenCanvasTrees();
            renderCanvases();
            restoreOpenCanvasTrees(openTrees);
            renderDashboards();
          }

          if (msg.data.templates) { state.templates = msg.data.templates; }
          if (dataChanged('templates', state.templates)) renderTemplates();

          if (dataChanged('recipes', state.recipes)) renderRecipes();
          if (msg.data.shares) { state.shares = msg.data.shares; renderShares(); }
          if (msg.data.daemon) { state.daemon = msg.data.daemon; renderDaemonStatus(); }

          applyFinanceToggle(msg.data.financeEnabled !== false);

          var datasets = msg.data.datasets || [];
          var connectors = msg.data.connectors || [];

          if (dataChanged('datasets', datasets)) {
            renderLibraryDatasets(datasets);
          }
          if (dataChanged('connectors', connectors)) {
            renderLibraryConnectors(connectors);
          }

          // Status tab
          if (msg.data.allBindings) { state.allBindings = msg.data.allBindings; }
          if (msg.data.deployStatus) { state.deployStatus = msg.data.deployStatus; }
          if (msg.data.bindingsPaused !== undefined) { state.bindingsPaused = msg.data.bindingsPaused; }
          renderStatusTab();
          break;
        case 'stockFetched':
          if (msg.data.profile) {
            state.stocks[msg.data.symbol] = { profile: msg.data.profile };
          }
          break;
        case 'financeChanged':
          applyFinanceToggle(msg.data.financeEnabled);
          break;
        case 'sharesUpdated':
          state.shares = msg.data.shares || [];
          renderShares();
          break;
        case 'daemonStatus':
          state.daemon = msg.data;
          renderDaemonStatus();
          break;
        case 'fetchingStock':
          var fmpC = document.getElementById('fmp-results');
          if (fmpC && msg.data.status === 'loading') {
            fmpC.innerHTML = '<div class="empty-state" style="padding:8px;font-size:11px;">Fetching ' + esc(msg.data.symbol) + '...</div>';
          } else if (fmpC && msg.data.status === 'error') {
            fmpC.innerHTML = '<div class="empty-state" style="padding:8px;font-size:11px;color:var(--jet-down);">Failed to fetch ' + esc(msg.data.symbol) + '</div>';
          }
          break;
        case 'authState':
          if (msg.data && msg.data.signedIn) {
            hideAuthGate();
            hideVerifyBanner();
          } else {
            showAuthGate();
            // Show verify banner if it was already visible (pending verification), otherwise sign-in form
            var bannerVisible = verifyBanner && verifyBanner.style.display !== 'none';
            if (!bannerVisible) showSignin();
            // Reset sign-in button state (may be stuck on "Signing in..." from previous session)
            if (btnSignin) { btnSignin.disabled = false; btnSignin.textContent = 'Sign In'; }
            if (btnSignup) { btnSignup.disabled = false; btnSignup.textContent = 'Create Account'; }
          }
          break;
        case 'authVerificationSent':
          // Sign-up succeeded — show verification banner
          if (btnSignup) { btnSignup.disabled = false; btnSignup.textContent = 'Create Account'; }
          var verifyEmailDisplay = document.getElementById('verify-email-display');
          if (verifyEmailDisplay && msg.data && msg.data.email) verifyEmailDisplay.textContent = msg.data.email;
          showVerifyBanner();
          break;
        case 'authShowSigninForResend':
          // Switch to sign-in form with email pre-filled and helpful message
          hideVerifyBanner();
          showSignin();
          var resendEmailField = document.getElementById('signin-email');
          if (resendEmailField && msg.data && msg.data.email) resendEmailField.value = msg.data.email;
          var resendHint = document.getElementById('signin-error');
          if (resendHint) { resendHint.style.color = 'var(--jet-up)'; resendHint.textContent = 'Sign in to resend the verification email.'; }
          break;
        case 'authResetSent':
          var resetMsg = document.getElementById('signin-error');
          if (resetMsg) {
            resetMsg.style.color = 'var(--jet-up)';
            resetMsg.textContent = 'Password reset email sent to ' + (msg.data && msg.data.email || '') + '. Check your inbox (and spam folder).';
          }
          break;
        case 'runtimeStatus': {
          var banner = document.getElementById('runtime-banner');
          var rtMsg = document.getElementById('runtime-msg');
          var rtRetry = document.getElementById('runtime-retry');
          if (banner && rtMsg) {
            if (msg.data && msg.data.ready) {
              banner.style.display = 'none';
            } else {
              banner.style.display = 'block';
              rtMsg.textContent = (msg.data && msg.data.message) || 'Runtime not ready';
              if (rtRetry) rtRetry.style.display = (msg.data && msg.data.showRetry) ? 'inline-block' : 'none';
            }
          }
          break;
        }
        case 'authError':
          // Re-enable buttons and show error
          if (btnSignin) { btnSignin.disabled = false; btnSignin.textContent = 'Sign In'; }
          if (btnSignup) { btnSignup.disabled = false; btnSignup.textContent = 'Create Account'; }
          var target = (msg.data && msg.data.form === 'signup') ? 'signup-error' : 'signin-error';
          var errEl = document.getElementById(target);
          if (errEl) { errEl.style.color = ''; errEl.textContent = (msg.data && msg.data.message) || 'Authentication failed.'; }
          break;
      }
    });

    console.log('[JET] sidebar script complete');
    } catch(err) {
      console.error('[JET] sidebar init error:', err);
      var errDiv = document.createElement('div');
      errDiv.style.cssText = 'padding:8px 12px;color:#F85149;font-size:11px;border:1px solid #F85149;margin:8px;border-radius:4px;';
      errDiv.innerHTML = '<b>Init error:</b> ' + (err.message || err);
      document.body.prepend(errDiv);
    }
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
