import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { FileManager } from "./services/fileManager";
import { DuckDBService } from "./services/duckdb";
import { SidebarProvider } from "./sidebar/SidebarProvider";
import { CanvasProvider } from "./canvas/CanvasProvider";
import { StatusBar } from "./statusbar/StatusBar";
import { JetDataTool } from "./tools/jetData";
import { JetRenderTool } from "./tools/jetRender";
import { JetSaveTool } from "./tools/jetSave";
import { JetQueryTool } from "./tools/jetQuery";
import { JetSkillTool } from "./tools/jetSkill";
import { JetTemplateTool } from "./tools/jetTemplate";
import { JetParseTool } from "./tools/jetParse";
import { JetExecTool } from "./tools/jetExec";
import { SettingsProvider } from "./settings/SettingsProvider";
import { PortfolioImporter } from "./services/portfolioImporter";
import { AuthService } from "./services/authService";
import { JETApiClient } from "./services/apiClient";
import { BootstrapService } from "./services/bootstrapService";
import { RefreshService } from "./services/refreshService";
import { RefreshBindingManager } from "./services/refreshBindingManager";
import { AgentRefreshRunner } from "./services/agentRefreshRunner";
import { DatasetImporter } from "./services/datasetImporter";
import { ConnectionManager } from "./services/connectionManager";
import { ConnectorProvider } from "./connector/ConnectorProvider";
import { FrameBundler } from "./services/frameBundler";
import { ShareManager } from "./services/shareManager";
import { DeployManager } from "./services/deployManager";
import { logTrouble } from "./services/troubleLog";
import { CompanionServer } from "./services/companionServer";
import { PtyManager } from "./services/ptyManager";
import { NativeManager } from "./services/nativeManager";
import { RefreshBinding, DatasetMetadata, DataModel, SavedQuery, JetExecInput, JetSaveInput, ToolDefinition } from "./types";
import { TOOL_DEFAULTS } from "./manifests/toolDefaults";

function formatRelativeTime(date: Date): string {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hours ago`;
  if (sec < 172800) return "yesterday";
  return `${Math.floor(sec / 86400)} days ago`;
}

let outputChannel: vscode.OutputChannel;
let statusBar: StatusBar;
let refreshService: RefreshService | undefined;
let duckdb: DuckDBService;
let companionServer: CompanionServer | undefined;

/** Detect if running inside code-server (browser-based VS Code) */
const isCodeServer = typeof process !== "undefined" && !!process.env.VSCODE_PROXY_URI;

/** Detect if running inside Jetro-VSCodium (our custom IDE build) */
const isJetroApp = vscode.env.appName === "Jetro" || !!process.env.JETRO_APP;

/**
 * Open a URL in the user's browser. In code-server, vscode.env.openExternal
 * rewrites localhost URLs to /proxy/{port}/ which breaks direct server access.
 * Workaround: use the exec command to call system `open` / `xdg-open` directly.
 */
async function openInBrowser(url: string): Promise<void> {
  if (isCodeServer) {
    const { exec } = require("child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} "${url}"`);
  } else {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // 1. Output channel
  outputChannel = vscode.window.createOutputChannel("Jetro");
  outputChannel.appendLine(`[${timestamp()}] Jetro v0.1.0 activated`);
  context.subscriptions.push(outputChannel);

  // 2. Status bar
  statusBar = new StatusBar();
  statusBar.show();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  // 2b. Jetro App (VSCodium) — apply defaults on activation
  if (isJetroApp) {
    outputChannel.appendLine(`[${timestamp()}] Running inside Jetro App`);

    // Hide secondary sidebar
    vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    setTimeout(() => vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar"), 5000);

    // Close welcome tab if it's open
    setTimeout(() => {
      vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    }, 2000);

    // Hide Source Control, Run/Debug, Testing from activity bar (first launch only)
    const hiddenKey = "jetro.activityBarHidden.v1";
    if (!context.globalState.get<boolean>(hiddenKey)) {
      setTimeout(async () => {
        try {
          await vscode.commands.executeCommand("vscode.setViewContainerVisibility", { id: "workbench.view.scm", visible: false });
          await vscode.commands.executeCommand("vscode.setViewContainerVisibility", { id: "workbench.view.debug", visible: false });
          await vscode.commands.executeCommand("vscode.setViewContainerVisibility", { id: "workbench.view.testing", visible: false });
          outputChannel.appendLine(`[${timestamp()}] Hidden default activity bar items`);
        } catch {
          outputChannel.appendLine(`[${timestamp()}] Could not hide activity bar items (command not available)`);
        }
        context.globalState.update(hiddenKey, true);
      }, 3000);
    }

    // Install Codex on first launch (Claude Code + Qwen are bundled as built-in)
    const agentsKey = "jetro.agentExtensionsInstalled.v1";
    if (!context.globalState.get<boolean>(agentsKey)) {
      const agentExtensions = [
        "openai.chatgpt",  // Codex — too large to bundle (~232MB), install from Open VSX
      ];

      outputChannel.appendLine(`[${timestamp()}] First launch — installing agent extensions...`);
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Jetro", cancellable: false },
        async (progress) => {
          for (const ext of agentExtensions) {
            try {
              progress.report({ message: `Installing ${ext.split(".")[0]}...` });
              await vscode.commands.executeCommand("workbench.extensions.installExtension", ext);
              outputChannel.appendLine(`[${timestamp()}] Installed ${ext}`);
            } catch (err) {
              outputChannel.appendLine(`[${timestamp()}] Failed to install ${ext}: ${err}`);
            }
          }
          progress.report({ message: "Codex extension installed." });
          context.globalState.update(agentsKey, true);
          const action = await vscode.window.showInformationMessage(
            "Jetro has installed the Codex extension. Restart to activate.",
            "Restart Now"
          );
          if (action === "Restart Now") {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        }
      );
    }
  }

  // 3. Workspace detection
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    outputChannel.appendLine(
      `[${timestamp()}] No workspace folder open. Some features disabled.`
    );
    statusBar.setDisconnected();

    // In Jetro App, auto-open folder picker so user can select a workspace
    if (isJetroApp) {
      vscode.commands.executeCommand("vscode.openFolder");
    }
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri;
  const workspacePath = workspaceRoot.fsPath;

  // 4. File manager
  const fileManager = new FileManager(workspaceRoot);

  // 5. Native dependencies — ensure Node runtime + MCP server are available
  const nativeManager = new NativeManager(context.extensionPath, outputChannel);

  // Download Node binary if user doesn't have node/npx (one-time, ~45 MB)
  const nodeReady = await nativeManager.ensureNode();

  // Copy MCP server to ~/.jetro/mcp-server/ (shared across editors/workspaces)
  const globalMcpServerPath = nativeManager.copyMcpServer();

  // Get the best MCP command (system npx > bundled node > bare npx fallback)
  const mcpCommand = nativeManager.getMcpCommand(globalMcpServerPath);
  outputChannel.appendLine(`[${timestamp()}] MCP command: ${mcpCommand.command} ${mcpCommand.args[0]}`);

  // DuckDB uses @duckdb/node-api (NAPI) — no download needed, works across all Node/Electron versions

  // 6. Workspace initialization
  // Only create workspace files if this is already a Jetro workspace (.jetro/ exists)
  // or if the user signs in later. Prevents polluting unrelated project folders.
  const jetroDir = vscode.Uri.joinPath(workspaceRoot, ".jetro");
  let workspaceInitialized = false;
  try {
    await vscode.workspace.fs.stat(jetroDir);
    outputChannel.appendLine(`[${timestamp()}] Initializing workspace...`);
    await fileManager.initWorkspace();
    await fileManager.ensureMcpConfigs(mcpCommand);
    workspaceInitialized = true;
  } catch {
    outputChannel.appendLine(`[${timestamp()}] New workspace — Jetro files will be created on sign-in`);
  }

  // 6. DuckDB
  duckdb = new DuckDBService(workspacePath);
  try {
    await duckdb.init();
    outputChannel.appendLine(`[${timestamp()}] DuckDB cache loaded`);
  } catch (err) {
    outputChannel.appendLine(
      `[${timestamp()}] DuckDB init failed: ${err}. Continuing without cache.`
    );
  }

  // 7. Migrate old portfolios into projects (one-time)
  const migrated = await fileManager.migratePortfoliosToProjects();
  if (migrated > 0) {
    outputChannel.appendLine(`[${timestamp()}] Migrated ${migrated} portfolio(s) into projects`);
  }

  // 8. Index workspace
  const index = await fileManager.indexWorkspace();
  outputChannel.appendLine(
    `[${timestamp()}] Indexed: ${index.stocks.length} stocks · ${index.lists.length} lists · ${index.projects.length} projects · ${index.recipes.length} recipes · ${index.datasources.length} data sources`
  );

  // 7. Sidebar
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    fileManager,
    outputChannel
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewId,
      sidebarProvider
    )
  );

  // 8. Canvas
  const canvasProvider = new CanvasProvider(context.extensionUri, fileManager);
  context.subscriptions.push(...canvasProvider.setupFrameFileWatcher());

  // 8b. Auth + API client (create early — constructors are sync)
  const authService = new AuthService(context.secrets, context.globalState, outputChannel);
  const apiClient = new JETApiClient(outputChannel);
  const bootstrapService = new BootstrapService(outputChannel);

  // Wire auth into sidebar early so getHtml() can check sign-in state
  // (resolveWebviewView may fire as soon as the sidebar becomes visible)
  sidebarProvider.setServices(authService, apiClient);

  // Refresh binding manager — create and wire up BEFORE serializer registration
  // so that canvasOpenListeners are ready when VS Code restores panels.
  const bindingManager = new RefreshBindingManager(canvasProvider, authService, outputChannel, context.extensionPath, fileManager, context.secrets);
  canvasProvider.onCanvasOpen((id) => bindingManager.onCanvasOpened(id));
  canvasProvider.onCanvasClose((id) => bindingManager.onCanvasClosed(id));
  canvasProvider.onElementRemove(() => sidebarProvider.refreshAll());
  canvasProvider.onElementUnbind((canvasId, elementId) => bindingManager.removeBinding(canvasId, elementId));
  context.subscriptions.push({ dispose: () => bindingManager.dispose() });

  // Agent refresh runner — headless CLI agent for prompt-based bindings
  const agentRunner = new AgentRefreshRunner(
    workspacePath,
    outputChannel,
    () => authService.getToken()
  );
  bindingManager.setAgentRunner(agentRunner);
  context.subscriptions.push({ dispose: () => agentRunner.dispose() });

  // Live preview server — HTTP + SSE for "Open in Browser"
  const { LivePreviewServer } = await import("./services/livePreviewServer");
  const livePreviewServer = new LivePreviewServer(
    workspacePath,
    outputChannel,
    (port) => statusBar.setLiveServer(port),
    () => statusBar.hideLiveServer(),
    context.extensionPath,
  );
  context.subscriptions.push({ dispose: () => livePreviewServer.dispose() });

  // Share manager — frame bundler + share lifecycle
  const frameBundler = new FrameBundler(fileManager, workspacePath);
  const shareManager = new ShareManager(canvasProvider, frameBundler, authService, fileManager, outputChannel);
  companionServer?.setShareManager(shareManager);
  const deployManager = new DeployManager(fileManager, authService, apiClient, outputChannel, context.secrets);
  companionServer?.setDeployManager(deployManager);
  bindingManager.setShareManager(shareManager);
  bindingManager.setLivePusher((elementId, data) => {
    if (livePreviewServer.isRunning()) {
      livePreviewServer.pushData(elementId, data);
    }
  });

  // Start live server on canvas open for asset serving, push fileUrlBase to webview
  canvasProvider.onCanvasOpen(async (canvasId) => {
    try {
      if (!livePreviewServer.isRunning()) {
        await livePreviewServer.start();
      }
      const fileUrlBase = livePreviewServer.getFileUrlBase();
      if (fileUrlBase) {
        canvasProvider.postToCanvas(canvasId, {
          type: "canvas.fileServerReady",
          data: { fileUrlBase },
        });
      }
    } catch (err) {
      outputChannel.appendLine(`[live-server] Auto-start for asset serving failed: ${err}`);
    }
  });

  // Wire toggle binding (pause/resume) from canvas
  canvasProvider.onToggleBinding(async (canvasId, elementId) => {
    try {
      const bindings = await bindingManager.getBindings(canvasId);
      const binding = bindings.find((b) => b.elementId === elementId);
      if (!binding) return;
      if (binding.enabled) {
        await bindingManager.pauseBinding(canvasId, elementId);
        outputChannel.appendLine(`[extension] Paused binding ${elementId}`);
      } else {
        await bindingManager.resumeBinding(canvasId, elementId);
        outputChannel.appendLine(`[extension] Resumed binding ${elementId}`);
      }
    } catch (err) {
      outputChannel.appendLine(`[extension] Toggle binding error: ${err}`);
    }
  });

  // Wire "Open in Browser" via live preview server
  canvasProvider.onOpenInBrowser(async (elementId, html, title) => {
    try {
      // Check if this element's canvas belongs to a deployed project — redirect to Docker container
      const activeCanvasId = canvasProvider.getActiveCanvasId();
      if (activeCanvasId) {
        const registry = await fileManager.readCanvasRegistry();
        const entry = registry.find((e) => e.id === activeCanvasId);
        if (entry?.projectSlug) {
          const proj = await fileManager.readProject(entry.projectSlug);
          if (proj?.deployment?.status === "live" && proj.deployment.port) {
            const url = `http://localhost:${proj.deployment.port}`;
            await openInBrowser(url);
            outputChannel.appendLine(`[deploy] Opened deployed preview: ${url}`);
            return;
          }
        }
      }

      // Default: open via LivePreviewServer
      const port = await livePreviewServer.start();
      livePreviewServer.setElementHtml(elementId, html);
      const url = `http://127.0.0.1:${port}/frame/${encodeURIComponent(elementId)}`;
      await openInBrowser(url);
      outputChannel.appendLine(`[live-server] Opened ${title} in browser: ${url}`);
    } catch (err) {
      outputChannel.appendLine(`[live-server] Failed to open in browser: ${err}`);
      vscode.window.showErrorMessage(`Failed to start live server: ${err}`);
    }
  });

  // Wire share button clicks from canvas webview
  canvasProvider.onShareElement(async (canvasId, elementId) => {
    const title = await vscode.window.showInputBox({
      prompt: "Share title",
      placeHolder: "e.g. Q3 Portfolio Review",
    });
    if (!title) return; // user cancelled

    try {
      const result = await shareManager.createShare({
        title,
        canvasId,
        elementIds: [elementId],
      });
      await vscode.env.clipboard.writeText(result.url);
      vscode.window.showInformationMessage(
        `Share created! URL copied to clipboard.`,
        "Open in Browser"
      ).then((action) => {
        if (action === "Open in Browser") {
          openInBrowser(result.url);
        }
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Share failed: ${err}`);
    }
  });

  // PTY manager — single terminal session for companion
  // node-pty runs in a separate child process (pty-server.js), not in Electron.
  const ptyManager = new PtyManager(workspacePath, context.extensionPath, outputChannel);
  context.subscriptions.push({ dispose: () => ptyManager.dispose() });

  // Companion server — browser-based mirror of sidebar + canvas + terminal
  companionServer = new CompanionServer(
    17710,
    workspacePath,
    context.extensionPath,
    fileManager,
    duckdb,
    outputChannel,
    ptyManager,
  );
  companionServer.onCompanionCanvasChanged = (canvasId) => {
    canvasProvider.setActiveCanvasId(canvasId);
    outputChannel.appendLine(`[companion] Active canvas set to: ${canvasId}`);
  };
  companionServer.start().catch((err) => {
    outputChannel.appendLine(`[companion] Failed to start: ${err}`);
  });
  context.subscriptions.push({ dispose: () => companionServer?.dispose() });

  // Broadcast canvas changes to companion clients
  canvasProvider.onCanvasOpen(async (canvasId) => {
    if (!companionServer?.isRunning() || companionServer.clientCount === 0) return;
    const registry = await fileManager.readCanvasRegistry();
    const entry = registry.find((c) => c.id === canvasId);
    const state = await fileManager.readCanvasById(canvasId, entry?.projectSlug ?? null);
    if (state) {
      companionServer.broadcast({ type: "canvas.setState", canvasId, state });
    }
  });

  // Intercept canvas mutations to also broadcast to companion
  const origAddElement = canvasProvider.addElement.bind(canvasProvider);
  canvasProvider.addElement = async (element, canvasId) => {
    await origAddElement(element, canvasId);
    if (companionServer?.isRunning() && companionServer.clientCount > 0) {
      const id = canvasProvider.getActiveCanvasId() || canvasId;
      if (id) companionServer.broadcast({ type: "canvas.addElement", canvasId: id, element });
    }
  };

  const origUpdateElement = canvasProvider.updateElement.bind(canvasProvider);
  canvasProvider.updateElement = async (elementId, data, canvasId) => {
    await origUpdateElement(elementId, data, canvasId);
    if (companionServer?.isRunning() && companionServer.clientCount > 0) {
      const id = canvasProvider.getActiveCanvasId() || canvasId;
      if (id) companionServer.broadcast({ type: "canvas.updateElement", canvasId: id, elementId, data });
    }
  };

  const origRefreshElement = canvasProvider.refreshElement.bind(canvasProvider);
  canvasProvider.refreshElement = async (elementId, payload, canvasId) => {
    await origRefreshElement(elementId, payload, canvasId);
    if (companionServer?.isRunning() && companionServer.clientCount > 0) {
      const id = canvasProvider.getActiveCanvasId() || canvasId;
      if (id) companionServer.broadcast({ type: "canvas.refreshElement", canvasId: id, elementId, payload });
    }
  };

  // Forward frame file changes to companion
  canvasProvider.onFileChanged((filePath, html) => {
    if (companionServer?.isRunning() && companionServer.clientCount > 0) {
      companionServer.broadcast({ type: "canvas.fileChanged", filePath, html });
    }
  });

  // NOW register serializer — listeners are wired up, safe to restore panels
  canvasProvider.registerSerializer(context);
  // Migrate old single-canvas format → multi-canvas registry
  await fileManager.migrateOldCanvasFormat();

  const restoredSession = await authService.restore();

  // Write global auth file so MCP servers always have fresh JWT + workspace
  async function writeGlobalAuth(): Promise<void> {
    try {
      const jwt = await authService.getToken();
      const session = authService.getSession();
      const globalDir = path.join(os.homedir(), ".jetro");
      const globalAuthPath = path.join(globalDir, "auth.json");
      if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });
      fs.writeFileSync(globalAuthPath, JSON.stringify({
        jwt: jwt || "",
        email: session?.email || "",
        workspace: workspacePath,
        updatedAt: new Date().toISOString(),
      }, null, 2) + "\n");
    } catch { /* best effort */ }
  }

  // If user has a saved session AND this is already a Jetro workspace, refresh configs.
  // Do NOT create workspace files in new folders just because a session exists —
  // that would pollute every folder the user opens.
  if (restoredSession && workspaceInitialized) {
    const jwt = await authService.getToken();
    if (jwt) {
      await fileManager.ensureMcpConfigs(mcpCommand, jwt);
    }
  }
  // Always write global auth if session exists (even in non-initialized workspaces)
  if (restoredSession) {
    await writeGlobalAuth();
  }

  // Wire up sidebar services right after restore (before slow bootstrap)
  // so search works immediately without waiting for bootstrap network call
  sidebarProvider.setServices(authService, apiClient, canvasProvider);
  sidebarProvider.setShareManager(shareManager);
  sidebarProvider.setDeployManager(deployManager);

  // Notify sidebar of runtime status
  if (!nodeReady) {
    sidebarProvider.sendRuntimeStatus(false, "MCP runtime not ready. Check your internet and retry.", true);
  } else {
    sidebarProvider.sendRuntimeStatus(true);
  }

  // Re-bootstrap after sign-in from sidebar auth gate
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.postAuthBootstrap", async () => {
      outputChannel.appendLine(`[${timestamp()}] Post-auth bootstrap triggered`);
      // Initialize workspace on first sign-in (creates .jetro/, data/, etc.)
      if (!workspaceInitialized) {
        outputChannel.appendLine(`[${timestamp()}] First sign-in — initializing workspace...`);
        await fileManager.initWorkspace();
        workspaceInitialized = true;
        // Re-init DuckDB now that .jetro/ exists
        try {
          await duckdb.init();
          outputChannel.appendLine(`[${timestamp()}] DuckDB initialized after sign-in`);
        } catch (err) {
          outputChannel.appendLine(`[${timestamp()}] DuckDB re-init failed: ${err}`);
        }
      }
      // Re-write MCP configs with fresh JWT so agent can call authenticated APIs
      const jwt = await authService.getToken();
      if (jwt) {
        await fileManager.ensureMcpConfigs(mcpCommand, jwt);
      }
      const result = await bootstrapService.bootstrap(apiClient, authService, fileManager, context.extensionPath);
      if (result === "ok") {
        await bootstrapService.injectAgentContext(fileManager, context.extensionPath);
        statusBar.setConnected();
      } else {
        await bootstrapService.injectFallbackContext(fileManager, context.extensionUri);
      }
      await sidebarProvider.refreshAll();
      shareManager.warmCache().catch(() => {});
      // Open canvas after first sign-in (user was seeing auth gate, no canvas yet)
      if (canvasProvider.getPanelCount() === 0) {
        const id = await canvasProvider.resolveUniversalCanvas();
        await canvasProvider.open(id);
      }
    })
  );

  // Refresh sidebar + MCP configs + global auth when auth state changes
  authService.onAuthStateChanged(async () => {
    if (workspaceInitialized) {
      const jwt = await authService.getToken();
      await fileManager.ensureMcpConfigs(mcpCommand, jwt ?? undefined);
    }
    await writeGlobalAuth();
    sidebarProvider.refreshAll();
  });

  // Restore running deployments (checks Docker containers)
  deployManager.restoreFromDisk().catch((err) => {
    outputChannel.appendLine(`[${timestamp()}] Deploy restore error: ${err}`);
  });
  context.subscriptions.push({ dispose: () => { deployManager.stopAll(); } });

  if (restoredSession) {
    outputChannel.appendLine(`[${timestamp()}] Auth: restored session for ${restoredSession.email}`);

    // Bootstrap — fetch skills/prompts from backend
    const bootstrapResult = await bootstrapService.bootstrap(apiClient, authService, fileManager, context.extensionPath);
    if (bootstrapResult === "cancelled") {
      outputChannel.appendLine(`[${timestamp()}] Account cancelled — running cleanup`);
      await fileManager.runCancellationCleanup();
      statusBar.setDisconnected();
      vscode.window.showWarningMessage(
        "Your Jetro subscription has ended. Research data and notes are preserved."
      );
      return;
    }
    if (bootstrapResult === "ok" && workspaceInitialized) {
      await bootstrapService.injectAgentContext(fileManager, context.extensionPath);
    } else if (workspaceInitialized) {
      // Bootstrap failed but session exists — write fallback CLAUDE.md
      await bootstrapService.injectFallbackContext(fileManager, context.extensionUri);
    }

    // Warm share details cache so live re-uploads work for existing shares
    shareManager.warmCache().catch(() => {});
  } else if (workspaceInitialized) {
    // No auth — write fallback CLAUDE.md only if this is a Jetro workspace
    await bootstrapService.injectFallbackContext(fileManager, context.extensionUri);
  }

  // 8d. Portfolio Importer
  const portfolioImporter = new PortfolioImporter(fileManager, duckdb, outputChannel);

  // 8e. Data services (always initialized)
  const datasetImporter = new DatasetImporter(fileManager, duckdb, outputChannel);
  const connectionManager = new ConnectionManager(fileManager, duckdb, context.secrets, outputChannel);

  // 8c. Settings (after connectionManager so it can be passed)
  const settingsProvider = new SettingsProvider(context.extensionUri, fileManager, context.secrets, authService, connectionManager);

  // 8f. Read finance toggle and register data resources
  const financeEnabled = await fileManager.isFinanceEnabled();
  statusBar.setFinanceEnabled(financeEnabled);
  sidebarProvider.setFinanceEnabled(financeEnabled);

  // Register existing datasets in DuckDB
  const datasetSlugs = await fileManager.listDatasets();
  for (const slug of datasetSlugs) {
    try {
      await datasetImporter.registerExisting(slug);
    } catch (err) {
      outputChannel.appendLine(`[${timestamp()}] Dataset registration failed for ${slug}: ${err}`);
    }
  }

  // Load models as DuckDB views
  const modelSlugs = await fileManager.listModels();
  for (const slug of modelSlugs) {
    const model = await fileManager.readModel(slug);
    if (model?.sql) {
      try {
        await duckdb.loadModel(slug, model.sql);
      } catch (err) {
        outputChannel.appendLine(`[${timestamp()}] Model load failed for ${slug}: ${err}`);
      }
    }
  }

  // Restore database connections
  await connectionManager.restoreConnections();

  // 8g. Connector panel (visual data source manager)
  const connectorProvider = new ConnectorProvider(
    context.extensionUri,
    connectionManager,
    duckdb,
    fileManager,
    outputChannel,
    () => sidebarProvider.refreshAll(),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.openConnector", (projectSlug?: string, engine?: string) => {
      connectorProvider.open(projectSlug, engine);
    }),
    vscode.commands.registerCommand("jetro.openConnector.browse", (slug: string, name?: string) => {
      connectorProvider.openSchema(slug, name);
    }),
  );

  // 9. MCP tools
  const jetData = new JetDataTool(fileManager, duckdb, authService, apiClient, outputChannel);
  const jetRender = new JetRenderTool(
    canvasProvider,
    fileManager,
    outputChannel,
    sidebarProvider
  );
  const jetSave = new JetSaveTool(fileManager, duckdb, sidebarProvider, context.secrets, outputChannel);
  const jetQuery = new JetQueryTool(duckdb, outputChannel);
  const jetSkill = new JetSkillTool(authService, apiClient, outputChannel);
  const jetTemplate = new JetTemplateTool(context.extensionPath, fileManager, outputChannel);
  const jetParse = new JetParseTool(fileManager, outputChannel);
  const jetExec = new JetExecTool(authService, workspacePath, outputChannel, fileManager, context.secrets);
  datasetImporter.setParseTool(jetParse);

  // (bindingManager already created above, before serializer registration)

  // Register tools using VS Code LM Tools API if available
  try {
    if (vscode.lm && "registerTool" in vscode.lm) {
      const registerTool = (vscode.lm as unknown as Record<string, Function>)
        .registerTool;

      // Build invoke handler map — local execution logic, service wiring
      const invokeHandlers: Record<string, (_options: unknown, input: unknown) => Promise<unknown>> = {
        jet_data: async (_opt, input) => {
          return bootstrapService.wrapResponse(
            await jetData.execute(input as { provider: "fmp" | "polygon"; endpoint: string; params?: Record<string, unknown> })
          );
        },
        jet_render: async (_opt, input) => {
          const typedInput = input as { type: string; data: Record<string, unknown>; id?: string; config?: Record<string, unknown>; projectSlug?: string; canvasId?: string; refreshBinding?: { scriptPath?: string; intervalMs?: number; bindingType?: string; refreshPrompt?: string; elementTitle?: string; sourceDomain?: string; timeoutMs?: number } };
          const result = await jetRender.execute(typedInput as Parameters<typeof jetRender.execute>[0]);

          // Auto-create refresh binding if provided
          if ((typedInput.refreshBinding?.scriptPath || typedInput.refreshBinding?.refreshPrompt) && result.elementId) {
            const canvasId = typedInput.canvasId || canvasProvider.getActiveCanvasId();
            if (canvasId) {
              const isPrompt = typedInput.refreshBinding.bindingType === "prompt" || !!typedInput.refreshBinding.refreshPrompt;
              const binding: RefreshBinding = {
                elementId: result.elementId,
                bindingType: isPrompt ? "prompt" : "script",
                intervalMs: typedInput.refreshBinding.intervalMs || (isPrompt ? 300000 : 120000),
                enabled: true,
                createdAt: new Date().toISOString(),
              };
              if (typedInput.refreshBinding.scriptPath) binding.scriptPath = typedInput.refreshBinding.scriptPath;
              if (typedInput.refreshBinding.refreshPrompt) binding.refreshPrompt = typedInput.refreshBinding.refreshPrompt;
              if (typedInput.refreshBinding.elementTitle) binding.elementTitle = typedInput.refreshBinding.elementTitle;
              if (typedInput.refreshBinding.sourceDomain) binding.sourceDomain = typedInput.refreshBinding.sourceDomain;
              if (typedInput.refreshBinding.timeoutMs) binding.timeoutMs = typedInput.refreshBinding.timeoutMs;
              await bindingManager.addBinding(canvasId, binding);
              outputChannel.appendLine(`[jet.render] Auto-bound refresh: ${result.elementId} → ${binding.bindingType === "prompt" ? "AI prompt" : binding.scriptPath}`);
            }
          }

          return bootstrapService.wrapResponse(result);
        },
        jet_save: async (_opt, input) => {
          const typedInput = input as { type: string; name: string; payload: Record<string, unknown> };
          const result = await jetSave.execute(typedInput as JetSaveInput);
          if (typedInput.type === "credential") {
            writeDaemonCredentials().catch((err) => {
              outputChannel.appendLine(`[credentials] Daemon creds refresh failed: ${err}`);
            });
          }
          return bootstrapService.wrapResponse(result);
        },
        jet_query: async (_opt, input) => {
          return bootstrapService.wrapResponse(await jetQuery.execute(input as { sql: string }));
        },
        jet_skill: async (_opt, input) => {
          return bootstrapService.wrapResponse(await jetSkill.execute(input as { name: string }));
        },
        jet_template: async (_opt, input) => {
          return bootstrapService.wrapResponse(await jetTemplate.execute(input as { name: string }));
        },
        jet_canvas: async (_opt, input) => {
          const typedInput = input as {
            action: string; canvasId?: string; elementId?: string;
            position?: { x: number; y: number }; size?: { width?: number; height?: number };
            operations?: Array<{ elementId: string; position?: { x: number; y: number }; size?: { width?: number; height?: number } }>;
            refreshBinding?: { scriptPath: string; intervalMs?: number; sourceDomain?: string; timeoutMs?: number };
            projectSlug?: string;
          };
          // Resolve canvasId from projectSlug if needed (backward compat)
          let targetId = typedInput.canvasId;
          if (!targetId && typedInput.projectSlug) {
            targetId = await canvasProvider.resolveProjectCanvas(typedInput.projectSlug);
          }

          let result: string;
          switch (typedInput.action) {
            case "list": {
              const entries = await canvasProvider.list();
              result = JSON.stringify({
                canvases: entries.map((e) => ({ id: e.id, name: e.name, projectSlug: e.projectSlug })),
                activeCanvasId: canvasProvider.getActiveCanvasId(),
              });
              break;
            }
            case "read": {
              const readId = targetId || canvasProvider.getActiveCanvasId();
              if (!readId) { result = JSON.stringify({ elementCount: 0, elements: [] }); break; }
              const state = await canvasProvider.getState(readId);
              if (!state) { result = JSON.stringify({ elementCount: 0, elements: [] }); break; }
              result = JSON.stringify({
                canvasId: readId, canvasName: state.name, elementCount: state.elements.length,
                elements: state.elements.map((el) => {
                  const binding = (state.refreshBindings || []).find((b) => b.elementId === el.id);
                  return {
                    id: el.id, type: el.type, position: el.position, size: el.size,
                    title: (el.data as Record<string, unknown>)?.title || (el.data as Record<string, unknown>)?.name || el.type,
                    refreshBinding: binding ? { scriptPath: binding.scriptPath, intervalMs: binding.intervalMs, enabled: binding.enabled, lastRun: binding.lastRun } : undefined,
                  };
                }),
              });
              break;
            }
            case "move":
              if (targetId) await canvasProvider.open(targetId);
              await canvasProvider.moveElement(typedInput.elementId!, typedInput.position!, targetId);
              result = JSON.stringify({ moved: typedInput.elementId });
              break;
            case "resize":
              if (targetId) await canvasProvider.open(targetId);
              await canvasProvider.resizeElement(typedInput.elementId!, typedInput.size!, targetId);
              result = JSON.stringify({ resized: typedInput.elementId });
              break;
            case "delete": {
              if (targetId) await canvasProvider.open(targetId);
              await canvasProvider.removeElement(typedInput.elementId!, targetId);
              const delCid = targetId || canvasProvider.getActiveCanvasId();
              if (delCid && typedInput.elementId) {
                await bindingManager.removeBinding(delCid, typedInput.elementId);
              }
              result = JSON.stringify({ deleted: typedInput.elementId });
              break;
            }
            case "arrange":
              if (targetId) await canvasProvider.open(targetId);
              await canvasProvider.arrangeElements(typedInput.operations!, targetId);
              result = JSON.stringify({ arranged: typedInput.operations!.length });
              break;
            case "bind": {
              const cid = targetId || canvasProvider.getActiveCanvasId();
              if (!cid || !typedInput.elementId || !typedInput.refreshBinding?.scriptPath) {
                result = JSON.stringify({ error: "bind requires elementId + refreshBinding.scriptPath" });
                break;
              }
              const binding: RefreshBinding = {
                elementId: typedInput.elementId,
                scriptPath: typedInput.refreshBinding.scriptPath,
                intervalMs: typedInput.refreshBinding.intervalMs || 120000,
                enabled: true,
                createdAt: new Date().toISOString(),
              };
              if (typedInput.refreshBinding.sourceDomain) binding.sourceDomain = typedInput.refreshBinding.sourceDomain;
              if (typedInput.refreshBinding.timeoutMs) binding.timeoutMs = typedInput.refreshBinding.timeoutMs;
              await bindingManager.addBinding(cid, binding);
              result = JSON.stringify({ bound: typedInput.elementId, intervalMs: binding.intervalMs });
              break;
            }
            case "unbind": {
              const cid = targetId || canvasProvider.getActiveCanvasId();
              if (!cid || !typedInput.elementId) { result = JSON.stringify({ error: "unbind requires elementId" }); break; }
              await bindingManager.removeBinding(cid, typedInput.elementId);
              result = JSON.stringify({ unbound: typedInput.elementId });
              break;
            }
            case "bindings": {
              const cid = targetId || canvasProvider.getActiveCanvasId();
              if (!cid) { result = JSON.stringify({ bindings: [] }); break; }
              const bindings = await bindingManager.getBindings(cid);
              result = JSON.stringify({ canvasId: cid, bindings });
              break;
            }
            case "trigger": {
              const cid = targetId || canvasProvider.getActiveCanvasId();
              if (!cid || !typedInput.elementId) { result = JSON.stringify({ error: "trigger requires elementId" }); break; }
              await bindingManager.trigger(cid, typedInput.elementId);
              result = JSON.stringify({ triggered: typedInput.elementId });
              break;
            }
            default:
              result = JSON.stringify({ error: `Unknown action: ${typedInput.action}` });
          }
          return bootstrapService.wrapResponse(result);
        },
        jet_parse: async (_opt, input) => {
          return bootstrapService.wrapResponse(
            await jetParse.execute(input as { file: string; projectSlug?: string; outputName?: string; options?: { ocr?: boolean; pages?: string } })
          );
        },
        jet_exec: async (_opt, input) => {
          return bootstrapService.wrapResponse(await jetExec.execute(input as JetExecInput));
        },
      };

      // Register tools — descriptions + schemas from KV, fallback to local defaults
      const kvDefs = bootstrapService.getToolDefinitions();
      const toolIds = ["jet_data", "jet_render", "jet_save", "jet_query", "jet_skill", "jet_template", "jet_canvas", "jet_parse", "jet_exec"];

      for (const id of toolIds) {
        const def: ToolDefinition | undefined = kvDefs.get(id) ?? TOOL_DEFAULTS[id];
        const invoke = invokeHandlers[id];
        if (!def || !invoke) {
          outputChannel.appendLine(`[${timestamp()}] WARN: Missing definition or handler for tool ${id}, skipping`);
          continue;
        }
        registerTool(id, {
          displayName: def.displayName,
          description: def.description,
          inputSchema: def.inputSchema,
          invoke,
        });
      }

      const source = kvDefs.size > 0 ? "KV" : "fallback";
      outputChannel.appendLine(
        `[${timestamp()}] Registered ${toolIds.length} LM tools (source: ${source})`
      );
    }
  } catch {
    outputChannel.appendLine(
      `[${timestamp()}] LM Tools API not available. Tools available via commands only.`
    );
  }

  // 10. Commands
  // Open companion web app in browser
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.openCompanion", async () => {
      if (!companionServer?.isRunning()) {
        try {
          await companionServer?.start();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to start companion server: ${err}`);
          return;
        }
      }
      await openInBrowser(`http://127.0.0.1:${companionServer!.getPort()}`);
    })
  );

  // Open companion web app with a specific canvas pre-selected
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.openCompanionCanvas", async (canvasId: string) => {
      if (!canvasId) return;
      if (!companionServer?.isRunning()) {
        try {
          await companionServer?.start();
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to start companion server: ${err}`);
          return;
        }
      }
      await openInBrowser(`http://127.0.0.1:${companionServer!.getPort()}/?canvas=${encodeURIComponent(canvasId)}`);
    })
  );

  // Open universal canvas — resolves (or creates) the first universal canvas
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.openCanvas", async () => {
      const id = await canvasProvider.resolveUniversalCanvas();
      await canvasProvider.open(id);
    })
  );

  // Open project-specific canvas — resolves (or creates) the first canvas for a project
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.openProjectCanvas", async (slug: string) => {
      if (slug) {
        const id = await canvasProvider.resolveProjectCanvas(slug);
        await canvasProvider.open(id);
      }
    })
  );

  // Open canvas by ID (used by sidebar)
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.openCanvasById", async (canvasId: string) => {
      if (canvasId) {
        await canvasProvider.open(canvasId);
      }
    })
  );

  // Create a new canvas (used by sidebar)
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.createCanvas", async (name: string, projectSlug?: string | null) => {
      if (name) {
        await canvasProvider.create(name, projectSlug);
        await sidebarProvider.refreshAll();
      }
    })
  );

  // Delete a canvas (used by sidebar)
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.deleteCanvas", async (canvasId: string) => {
      if (canvasId) {
        await canvasProvider.delete(canvasId);
        await sidebarProvider.refreshAll();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.restoreCanvas", async (canvasId?: string) => {
      const id = canvasId || canvasProvider.getActiveCanvasId();
      if (!id) {
        vscode.window.showWarningMessage("No canvas selected.");
        return;
      }
      const registry = await fileManager.readCanvasRegistry();
      const entry = registry.find((e) => e.id === id);
      const versions = await fileManager.listCanvasVersions(id, entry?.projectSlug ?? null);
      if (versions.length === 0) {
        vscode.window.showWarningMessage("No version history available for this canvas.");
        return;
      }
      const items = versions.slice(0, 20).map((v) => {
        const date = new Date(v.timestamp);
        const ago = formatRelativeTime(date);
        return { label: date.toLocaleString(), description: ago, timestamp: v.timestamp };
      });
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a version to restore",
        title: "Canvas Version History",
      });
      if (pick) {
        const ok = await canvasProvider.restore(id, (pick as typeof items[0]).timestamp);
        if (ok) {
          vscode.window.showInformationMessage(`Canvas restored to ${pick.label}.`);
          await sidebarProvider.refreshAll();
        } else {
          vscode.window.showWarningMessage("Failed to restore canvas version.");
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.canvasHistory", async (canvasId?: string) => {
      const id = canvasId || canvasProvider.getActiveCanvasId();
      if (!id) {
        vscode.window.showWarningMessage("No canvas selected.");
        return;
      }
      const registry = await fileManager.readCanvasRegistry();
      const entry = registry.find((e) => e.id === id);
      const projectSlug = entry?.projectSlug ?? null;
      const versions = await fileManager.listCanvasVersions(id, projectSlug);
      if (versions.length === 0) {
        vscode.window.showInformationMessage("No version history for this canvas.");
        return;
      }
      const items: Array<{ label: string; description: string; detail: string; timestamp: number }> = [];
      for (const v of versions.slice(0, 30)) {
        const data = await fileManager.readCanvasVersion(id, projectSlug, v.timestamp);
        const elCount = data?.elements?.length ?? 0;
        const edgeCount = data?.edges?.length ?? 0;
        items.push({
          label: new Date(v.timestamp).toLocaleString(),
          description: `${elCount} elements, ${edgeCount} edges`,
          detail: formatRelativeTime(new Date(v.timestamp)),
          timestamp: v.timestamp,
        });
      }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a version to preview or restore",
        title: "Canvas History",
      });
      if (!pick) return;
      const action = await vscode.window.showQuickPick(
        [
          { label: "Restore this version", value: "restore" },
          { label: "View as JSON", value: "view" },
        ],
        { placeHolder: "What do you want to do?" }
      );
      if (action?.value === "restore") {
        const ok = await canvasProvider.restore(id, (pick as typeof items[0]).timestamp);
        if (ok) {
          vscode.window.showInformationMessage(`Canvas restored to ${pick.label}.`);
          await sidebarProvider.refreshAll();
        }
      } else if (action?.value === "view") {
        const ver = versions.find((v) => v.timestamp === (pick as typeof items[0]).timestamp);
        if (ver) {
          await vscode.window.showTextDocument(ver.uri, { preview: true });
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.deleteCanvasElement", async (canvasId: string, elementId: string) => {
      if (canvasId && elementId) {
        await canvasProvider.removeElement(elementId, canvasId);
        await bindingManager.removeBinding(canvasId, elementId);
        await sidebarProvider.refreshAll();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.toggleCanvasElement", async (canvasId: string, elementId: string) => {
      if (canvasId && elementId) {
        const canvasState = await canvasProvider.getState(canvasId);
        if (canvasState) {
          const el = canvasState.elements?.find((e) => e.id === elementId);
          if (el) {
            const hidden = !(el.data as Record<string, unknown>)?._hidden;
            await canvasProvider.updateElement(elementId, { _hidden: hidden }, canvasId);
            await sidebarProvider.refreshAll();
          }
        }
      }
    })
  );

  // Global pause/resume for all refresh bindings
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.toggleGlobalPause", async () => {
      const configPath = path.join(workspacePath, ".jetro", "daemon-config.json");
      let config: { paused: boolean } = { paused: false };
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch { /* default to unpaused */ }
      config.paused = !config.paused;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      outputChannel.appendLine(`[extension] Global pause: ${config.paused}`);

      // Actually pause/resume all bindings so canvas nodes reflect the state
      const canvasIds = bindingManager.getCanvasIdsWithBindings();
      for (const cid of canvasIds) {
        if (config.paused) {
          await bindingManager.pauseAll(cid);
        } else {
          await bindingManager.resumeAll(cid);
        }
      }

      statusBar.setDaemonStatus(bindingManager.getActiveTimerCount(), config.paused);
      companionServer?.broadcast({
        type: "daemon.status",
        paused: config.paused,
        activeBindingCount: bindingManager.getActiveTimerCount(),
      });
      vscode.window.showInformationMessage(
        config.paused ? "Jetro: All bindings paused" : "Jetro: Bindings resumed"
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.openSettings", async () => {
      await settingsProvider.open();
    })
  );

  // Refresh Monitor panel
  const { RefreshMonitorPanel } = await import("./panels/refreshMonitorPanel");
  const refreshMonitor = new RefreshMonitorPanel(agentRunner, bindingManager, outputChannel);
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.refreshMonitor", () => {
      refreshMonitor.open();
    })
  );
  context.subscriptions.push({ dispose: () => refreshMonitor.dispose() });

  // Reinitialize MCP — re-downloads runtime if needed, rewrites all configs
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.reinitializeMcp", async () => {
      outputChannel.appendLine(`[${timestamp()}] Reinitialize MCP triggered`);
      try {
        const newNodePath = await nativeManager.ensureNode();
        nativeManager.copyMcpServer();
        const newMcpCommand = nativeManager.getMcpCommand(globalMcpServerPath);
        const jwt = await authService.getToken();
        await fileManager.ensureMcpConfigs(newMcpCommand, jwt ?? undefined);
        await writeGlobalAuth();
        vscode.window.showInformationMessage("Jetro MCP server reinitialized. Restart your agent to pick up changes.");
        outputChannel.appendLine(`[${timestamp()}] MCP reinitialized: ${newMcpCommand.command}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Jetro MCP reinitialize failed: ${err}`);
        outputChannel.appendLine(`[${timestamp()}] MCP reinitialize error: ${err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.setupVenv", async () => {
      const channel = vscode.window.createOutputChannel("Jetro Setup");
      channel.show();
      channel.appendLine("[venv] Setting up Python environment...");
      try {
        const venvPath = await fileManager.setupVenv(channel);
        channel.appendLine(`[venv] Ready at ${venvPath}`);
        vscode.window.showInformationMessage("Jetro Python environment ready.");
      } catch (err) {
        channel.appendLine(`[venv] Error: ${err}`);
        vscode.window.showErrorMessage("Failed to set up Python environment. Check output for details.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.importPortfolio", async () => {
      await portfolioImporter.importFromFile();
      await sidebarProvider.refreshAll();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.seedMockData", async () => {
      await seedMockData(fileManager, outputChannel);
      await sidebarProvider.refreshAll();
      vscode.window.showInformationMessage(
        "Jetro: Mock data seeded successfully!"
      );
    })
  );

  // Unified "+ Add Data" command — replaces importDataset and importProjectData
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.addData", async (projectSlug?: string) => {
      // Build QuickPick items: user-managed sources + agent-built connectors
      const items: (vscode.QuickPickItem & { value?: string })[] = [
        { label: "$(file) Local Files", description: "CSV, Parquet, Excel, JSON", value: "files" },
        { label: "$(book) Documents", description: "PDF, DOCX, PPTX, EPUB, RTF, images, and more", value: "documents" },
        { label: "$(globe) URL", description: "Fetch remote CSV, Parquet, or JSON", value: "url" },
      ];

      // Load available connectors
      const connectorSlugs = await fileManager.listConnectors();
      items.push({ label: "Connectors", kind: vscode.QuickPickItemKind.Separator });
      if (connectorSlugs.length === 0) {
        items.push({ label: "$(info) No connectors yet", description: "Ask the agent to create one", value: "_none" });
      } else {
        for (const slug of connectorSlugs) {
          const c = await fileManager.readConnector(slug);
          if (c) {
            const authLabel = c.auth?.method || "none";
            items.push({
              label: `$(plug) ${c.name}`,
              description: `${c.type} · ${authLabel}`,
              value: `connector:${slug}`,
            });
          }
        }
      }

      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: projectSlug ? `Add data to project "${projectSlug}"` : "Add data source",
      });
      if (!choice || !(choice as { value?: string }).value) return;
      const val = (choice as { value: string }).value;

      try {
        switch (val) {
          case "files":
            await datasetImporter.importFromFile(projectSlug);
            break;
          case "documents":
            await datasetImporter.importDocuments(projectSlug);
            break;
          case "url": {
            const url = await vscode.window.showInputBox({
              placeHolder: "https://example.com/data.csv",
              prompt: "Enter URL of data file (CSV, Parquet, JSON)",
            });
            if (!url) return;
            await datasetImporter.importFromUrl(url, projectSlug);
            break;
          }
          case "_none":
            break;
          default:
            if (val.startsWith("connector:")) {
              const connSlug = val.slice("connector:".length);
              const connector = await fileManager.readConnector(connSlug);
              if (!connector) break;

              if (projectSlug) {
                // Link connector to project
                const project = await fileManager.readProject(projectSlug);
                if (project) {
                  const linked = (project.linkedConnectors || []) as string[];
                  if (!linked.includes(connSlug)) {
                    linked.push(connSlug);
                    (project as unknown as Record<string, unknown>).linkedConnectors = linked;
                    project.updatedAt = new Date().toISOString();
                    await fileManager.writeProject(project.name, project);
                  }
                  vscode.window.showInformationMessage(
                    `Connector "${connector.name}" linked to project. The agent will use it.`
                  );
                }
              } else {
                vscode.window.showInformationMessage(
                  `Connector "${connector.name}" is available. Ask the agent to use it.`
                );
              }
            }
            break;
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Add data failed: ${err instanceof Error ? err.message : err}`);
      }

      await sidebarProvider.refreshAll();
    })
  );

  // Add files to a project (file picker → copy to sources/)
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.addProjectFiles", async (projectSlug: string) => {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: "Add to Project",
        filters: { "All Files": ["*"] },
      });
      if (!files || files.length === 0) return;
      for (const file of files) {
        const content = await vscode.workspace.fs.readFile(file);
        const fileName = path.basename(file.fsPath);
        await fileManager.addProjectSource(projectSlug, fileName, content);
      }
      await sidebarProvider.refreshAll();
      vscode.window.showInformationMessage(`Added ${files.length} file(s) to project.`);
    })
  );

  // Legacy aliases (sidebar messages may still use these)
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.importDataset", () =>
      vscode.commands.executeCommand("jetro.addData")
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.importProjectData", (projectSlug?: string) =>
      vscode.commands.executeCommand("jetro.addData", projectSlug)
    )
  );

  // Connector commands
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.deleteConnector", async (slug: string) => {
      if (!slug) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete connector "${slug}"? This removes the connector and its stored credentials.`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") return;

      // Read config to get credential key
      const config = await fileManager.readConnector(slug);
      if (config?.auth?.credentialKey) {
        await context.secrets.delete(config.auth.credentialKey);
      }
      await fileManager.deleteConnector(slug);
      await sidebarProvider.refreshAll();
      vscode.window.showInformationMessage(`Connector "${slug}" deleted.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.testConnector", async (slug: string) => {
      if (!slug) return;
      outputChannel.appendLine(`[connector] Testing ${slug}...`);

      const config = await fileManager.readConnector(slug);
      if (!config) {
        vscode.window.showErrorMessage(`Connector "${slug}" not found.`);
        return;
      }

      // Resolve Python interpreter
      const rootPath = fileManager.getRoot().fsPath;
      const venvPython = `${rootPath}/.jetro/venv/bin/python3`;
      let interpreter = "python3";
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(venvPython));
        interpreter = venvPython;
      } catch { /* use system python */ }

      const testCode = [
        "import json, os, sys",
        `os.environ['JET_WORKSPACE'] = ${JSON.stringify(rootPath)}`,
        `sys.path.insert(0, os.path.join(${JSON.stringify(rootPath)}, '.jetro', 'lib'))`,
        "from jet.connectors import use",
        `client = use(${JSON.stringify(slug)})`,
        "if hasattr(client, 'fetch'):",
        "    result = client.fetch()",
        "elif hasattr(client, 'test'):",
        "    result = client.test()",
        "else:",
        "    result = {'status': 'ok', 'message': 'Client instantiated'}",
        "print(json.dumps(result, default=str))",
      ].join("\n");

      // Build env with credential
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        JET_WORKSPACE: rootPath,
        PYTHONPATH: `${rootPath}/.jetro/lib`,
      };
      if (config.auth?.credentialKey) {
        const cred = await context.secrets.get(config.auth.credentialKey);
        if (cred) {
          env[`JET_CRED_${config.auth.credentialKey.toUpperCase().replace(/-/g, "_")}`] = cred;
        }
      }

      const { exec } = require("child_process");
      exec(
        `${interpreter} -c ${JSON.stringify(testCode)}`,
        { cwd: rootPath, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env },
        (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            outputChannel.appendLine(`[connector] Test failed: ${stderr || error.message}`);
            vscode.window.showErrorMessage(`Connector test failed: ${stderr || error.message}`);
          } else {
            outputChannel.appendLine(`[connector] Test OK: ${stdout}`);
            vscode.window.showInformationMessage(`Connector "${slug}" test passed.`);
          }
        }
      );
    })
  );

  // Publish dashboard command (General mode)
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.publishDashboard", async (canvasId?: string) => {
      const id = canvasId || canvasProvider.getActiveCanvasId();
      if (!id) {
        vscode.window.showWarningMessage("No active canvas to publish");
        return;
      }
      const registry = await fileManager.readCanvasRegistry();
      const entry = registry.find((e) => e.id === id);
      if (!entry?.projectSlug) {
        vscode.window.showWarningMessage("Only project canvases can be published as dashboards");
        return;
      }
      const state = await canvasProvider.getState(id);
      if (!state) return;

      await fileManager.writeDashboard(entry.name, {
        canvasId: id,
        projectSlug: entry.projectSlug,
        name: entry.name,
        publishedAt: new Date().toISOString(),
      });
      await sidebarProvider.refreshAll();
      vscode.window.showInformationMessage(`Dashboard "${entry.name}" published to Library`);
    })
  );

  // Activate project — register project datasets + models in DuckDB
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.activateProject", async (projectSlug: string) => {
      const count = await duckdb.registerProjectDatasets(projectSlug, fileManager);
      await duckdb.loadProjectModels(projectSlug, fileManager);
      outputChannel.appendLine(`[project] Registered ${count} datasets for project ${projectSlug}`);
    })
  );

  // View list on canvas — renders a table with the list's tickers
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.viewListOnCanvas", async (slug: string) => {
      if (!slug) return;
      const list = await fileManager.readList(slug);
      if (!list) return;

      // Resolve target canvas (active or default universal)
      const listCanvasId = canvasProvider.getActiveCanvasId() || await canvasProvider.resolveUniversalCanvas();

      // If the list already has an agent-created table on canvas, just open the canvas
      // (don't overwrite the agent's custom metrics with a basic price table)
      if (list.canvasElementId) {
        await canvasProvider.open(listCanvasId);
        outputChannel.appendLine(`[viewListOnCanvas] Revealed existing table for ${list.name}`);
        return;
      }

      // No existing table — build from stored columns or fallback to basic price table
      await canvasProvider.open(listCanvasId);
      let headers: string[];
      let rows: (string | number)[][] = [];

      if (list.columns && list.columns.length > 0) {
        // Column-aware table: use stored column definitions
        headers = list.columns.map((c) => c.label);
        for (const ticker of list.tickers) {
          const row: (string | number)[] = [];
          // Pre-fetch all data sources the columns might need
          const dataCache: Record<string, Record<string, unknown> | null> = {};
          for (const col of list.columns) {
            if (col.source === "fmp" && col.endpoint) {
              // Derive data type from endpoint for local cache lookup
              const ep = col.endpoint.replace(/\{ticker\}/g, "").replace(/^\//, "");
              const dataType = ep.split("/")[0] || "profile";
              if (!dataCache[dataType]) {
                dataCache[dataType] = await fileManager.readStockData(ticker, dataType as "profile" | "ratios" | "financials" | "score" | "quote") as Record<string, unknown> | null;
              }
            }
          }
          for (const col of list.columns) {
            if (col.key === "ticker" || col.key === "stock" || col.key === "symbol") {
              row.push(ticker);
            } else if (col.key === "name" || col.key === "company") {
              const p = dataCache["profile"] || {};
              row.push((p.name as string) || (p.companyName as string) || ticker);
            } else if (col.source === "fmp" && col.endpoint && col.field) {
              const ep = col.endpoint.replace(/\{ticker\}/g, "").replace(/^\//, "");
              const dataType = ep.split("/")[0] || "profile";
              const data = dataCache[dataType] || {};
              const val = data[col.field];
              if (typeof val === "number") {
                if (col.format === "percent") {
                  row.push((val >= 0 ? "" : "") + val.toFixed(2) + "%");
                } else if (col.format === "currency") {
                  row.push("₹" + val.toLocaleString());
                } else {
                  row.push(Number(val.toFixed(2)));
                }
              } else {
                row.push(val != null ? String(val) : "-");
              }
            } else {
              row.push("-");
            }
          }
          rows.push(row);
        }
        outputChannel.appendLine(`[viewListOnCanvas] Built column-aware table (${list.columns.length} cols) for ${list.name}`);
      } else {
        // Fallback: basic price table
        headers = ["Ticker", "Name", "Price", "Change"];
        for (const ticker of list.tickers) {
          const profile = await fileManager.readStockData(ticker, "profile") as Record<string, unknown> | null;
          const quote = await fileManager.readStockData(ticker, "quote") as Record<string, unknown> | null;
          const p = profile || {};
          const q = quote || {};
          const price = (q.price ?? p.price ?? "-") as string | number;
          const changePct = (q.changesPercentage ?? p.changePct ?? "-") as string | number;
          rows.push([
            ticker,
            (p.name as string) || (p.companyName as string) || ticker,
            typeof price === "number" ? price.toLocaleString() : String(price),
            typeof changePct === "number" ? (changePct >= 0 ? "+" : "") + changePct.toFixed(2) + "%" : String(changePct),
          ]);
        }
      }

      // Build HTML table for the frame
      const thCells = headers.map(h => `<th>${h}</th>`).join("");
      const trRows = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("\n");
      const tableHtml = `<table><thead><tr>${thCells}</tr></thead><tbody>${trRows}</tbody></table>`;

      const elementId = `list-${slug}-${Date.now()}`;
      const element = {
        id: elementId,
        type: "frame" as const,
        position: { x: 40, y: 40 },
        size: { width: 500, height: 400 },
        data: {
          title: list.name,
          html: tableHtml,
          listSlug: slug,
          refreshable: list.refreshable,
          lastRefreshed: new Date().toISOString(),
        },
        connections: [] as string[],
      };

      await canvasProvider.addElement(element, listCanvasId);
      list.canvasElementId = elementId;
      await fileManager.writeList(slug, list);

      outputChannel.appendLine(`[viewListOnCanvas] Created frame for ${list.name} (${list.tickers.length} tickers)`);
    })
  );

  // Refresh a list — re-reads data and pushes to the canvas frame via jet:refresh
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.refreshList", async (slug: string) => {
      if (!slug) return;
      const list = await fileManager.readList(slug);
      if (!list) return;

      outputChannel.appendLine(`[refreshList] Refreshing list: ${list.name}`);
      let tableData: { headers: string[]; rows: (string | number)[][] } | null = null;

      // ── Path 1: Script-based refresh (fast path) ──
      // Script outputs JSON to stdout: { headers: string[], rows: (string|number)[][] }
      if (list.scriptPath) {
        try {
          const cp = await import("child_process");
          const pathMod = await import("path");
          const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
          const scriptFullPath = pathMod.resolve(workspacePath, list.scriptPath);
          // Pass API credentials as env vars so the script can fetch fresh data
          const jwt = await authService.getToken();
          const scriptEnv = {
            ...process.env,
            JET_API_URL: vscode.workspace.getConfiguration("jetro").get<string>("apiUrl") || "http://localhost:8787",
            JET_JWT: jwt || "",
            JET_WORKSPACE: workspacePath,
          };
          const stdout = await new Promise<string>((resolve, reject) => {
            cp.exec(
              `python3 "${scriptFullPath}"`,
              { cwd: workspacePath, timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: scriptEnv },
              (err, out) => { if (err) reject(err); else resolve(out); }
            );
          });
          const parsed = JSON.parse(stdout.trim());
          if (Array.isArray(parsed.headers) && Array.isArray(parsed.rows)) {
            tableData = parsed;
            outputChannel.appendLine(`[refreshList] Script OK: ${parsed.rows.length} rows`);
          }
        } catch (scriptErr) {
          outputChannel.appendLine(`[refreshList] Script failed: ${scriptErr}. Falling back to quote refresh.`);
        }
      }

      // ── Path 2: Column-definition refresh (deterministic) ──
      // If list has stored column definitions, rebuild table from API data.
      if (!tableData && list.columns && list.columns.length > 0) {
        try {
          const colHeaders = list.columns.map((c) => c.label);
          const colRows: (string | number)[][] = [];

          for (const ticker of list.tickers) {
            const row: (string | number)[] = [];
            const dataCache: Record<string, Record<string, unknown> | null> = {};

            // Pre-fetch needed data types
            for (const col of list.columns) {
              if (col.source === "fmp" && col.endpoint) {
                const ep = col.endpoint.replace(/\{ticker\}/g, "").replace(/^\//, "");
                const dataType = ep.split("/")[0] || "profile";
                if (!dataCache[dataType]) {
                  dataCache[dataType] = await fileManager.readStockData(ticker, dataType as "profile" | "ratios" | "financials" | "score" | "quote") as Record<string, unknown> | null;
                }
              }
            }

            for (const col of list.columns) {
              if (col.key === "ticker" || col.key === "stock" || col.key === "symbol") {
                row.push(ticker);
              } else if (col.key === "name" || col.key === "company") {
                const p = dataCache["profile"] || {};
                row.push((p.name as string) || (p.companyName as string) || ticker);
              } else if (col.source === "fmp" && col.endpoint && col.field) {
                const ep = col.endpoint.replace(/\{ticker\}/g, "").replace(/^\//, "");
                const dataType = ep.split("/")[0] || "profile";
                const data = dataCache[dataType] || {};
                const val = data[col.field];
                if (typeof val === "number") {
                  if (col.format === "percent") {
                    row.push(val.toFixed(2) + "%");
                  } else if (col.format === "currency") {
                    row.push("₹" + val.toLocaleString());
                  } else {
                    row.push(Number(val.toFixed(2)));
                  }
                } else {
                  row.push(val != null ? String(val) : "-");
                }
              } else {
                row.push("-");
              }
            }
            colRows.push(row);
          }

          tableData = { headers: colHeaders, rows: colRows };
          outputChannel.appendLine(
            `[refreshList] Column-def refresh: ${list.columns.length} columns for ${colRows.length} rows`
          );
        } catch (colErr) {
          outputChannel.appendLine(`[refreshList] Column refresh failed: ${colErr}. Falling back to quote refresh.`);
        }
      }

      // ── Path 3: Quote-based partial refresh (fallback) ──
      // Reads the existing canvas table, fetches fresh quotes, and updates
      // price-related columns in place (CMP/Price/Change/Change%).
      if (!tableData && list.canvasElementId) {
        try {
          // Search all canvases for the element (it could be in any canvas)
          let canvasState: import("./types").CanvasState | null = null;
          const allCanvases = await fileManager.readCanvasRegistry();
          for (const c of allCanvases) {
            const s = await fileManager.readCanvasById(c.id, c.projectSlug);
            if (s?.elements.some((e) => e.id === list.canvasElementId)) {
              canvasState = s;
              break;
            }
          }
          const existingEl = canvasState?.elements.find((e) => e.id === list.canvasElementId);
          if (existingEl?.data) {
            const oldHeaders = existingEl.data.headers as string[] | undefined;
            const oldRows = existingEl.data.rows as (string | number)[][] | undefined;
            if (oldHeaders && oldRows && oldRows.length > 0) {
              // Identify price-related columns by header name
              const priceKeys: Record<string, (q: Record<string, unknown>) => string | number> = {
                "price": (q) => typeof q.price === "number" ? Number(q.price).toLocaleString() : "-",
                "cmp": (q) => typeof q.price === "number" ? Number(q.price).toLocaleString() : "-",
                "ltp": (q) => typeof q.price === "number" ? Number(q.price).toLocaleString() : "-",
                "change": (q) => {
                  const pct = q.changesPercentage as number | undefined;
                  return typeof pct === "number" ? (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%" : "-";
                },
                "change%": (q) => {
                  const pct = q.changesPercentage as number | undefined;
                  return typeof pct === "number" ? (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%" : "-";
                },
                "chg%": (q) => {
                  const pct = q.changesPercentage as number | undefined;
                  return typeof pct === "number" ? (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%" : "-";
                },
              };

              // Map column indices that we can auto-update
              const colUpdaters: { idx: number; fn: (q: Record<string, unknown>) => string | number }[] = [];
              for (let i = 0; i < oldHeaders.length; i++) {
                const key = oldHeaders[i].toLowerCase().trim();
                if (priceKeys[key]) colUpdaters.push({ idx: i, fn: priceKeys[key] });
              }

              // Find ticker column (first column is almost always the ticker/stock)
              const tickerColIdx = oldHeaders.findIndex((h) =>
                /^(ticker|stock|symbol|scrip)$/i.test(h.trim())
              );
              const tCol = tickerColIdx >= 0 ? tickerColIdx : 0;

              // Fetch fresh quotes and update rows
              const newRows = await Promise.all(
                oldRows.map(async (row) => {
                  const ticker = String(row[tCol]).replace(/\s.*$/, ""); // strip any suffix after ticker
                  if (!ticker || ticker === "-") return [...row];
                  const quote = await fileManager.readStockData(ticker, "quote") as Record<string, unknown> | null;
                  if (!quote) return [...row];
                  const updated = [...row];
                  for (const { idx, fn } of colUpdaters) {
                    updated[idx] = fn(quote);
                  }
                  return updated;
                })
              );
              tableData = { headers: oldHeaders, rows: newRows };
              outputChannel.appendLine(
                `[refreshList] Quote refresh: updated ${colUpdaters.length} columns for ${newRows.length} rows`
              );
            }
          }
        } catch (readErr) {
          outputChannel.appendLine(`[refreshList] Canvas read failed: ${readErr}`);
        }
      }

      // ── Push refresh data to canvas frame via jet:refresh ──
      if (tableData && list.canvasElementId) {
        // Find which canvas has this element
        const registry = await fileManager.readCanvasRegistry();
        let targetCanvasId = canvasProvider.getActiveCanvasId() || await canvasProvider.resolveUniversalCanvas();
        for (const c of registry) {
          const s = await fileManager.readCanvasById(c.id, c.projectSlug);
          if (s?.elements.some((e) => e.id === list.canvasElementId)) {
            targetCanvasId = c.id;
            break;
          }
        }
        await canvasProvider.open(targetCanvasId);
        // Push data into frame via jet:refresh postMessage
        canvasProvider.postToCanvas(targetCanvasId, {
          type: "canvas.refreshElement",
          data: {
            id: list.canvasElementId,
            payload: { ...tableData, lastRefreshed: new Date().toISOString() },
          },
        });
        outputChannel.appendLine(`[refreshList] Pushed refresh data to frame for ${list.name}`);
      } else if (!list.canvasElementId) {
        // No canvas element yet — create one
        await vscode.commands.executeCommand("jetro.viewListOnCanvas", slug);
      }

      // Update lastRefreshed on the list file
      list.lastRefreshed = new Date().toISOString();
      await fileManager.writeList(slug, list);
      await sidebarProvider.refreshAll();

      outputChannel.appendLine(`[refreshList] Done: ${list.name}`);
    })
  );

  // Wire up canvas refresh-list button to the refreshList command
  canvasProvider.onRefreshList(async (req) => {
    if (req.listSlug) {
      await vscode.commands.executeCommand("jetro.refreshList", req.listSlug);
    }
  });

  // Wire up frame query handler — frames can query DuckDB via __JET.query(sql)
  canvasProvider.onFrameQuery(async (canvasId, elementId, requestId, sql) => {
    try {
      const results = await duckdb.executeQuery(sql);
      await canvasProvider.sendFrameQueryResult(canvasId, elementId, requestId, results);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outputChannel.appendLine(`[frameQuery] Error for ${elementId}: ${message}`);
      await canvasProvider.sendFrameQueryResult(canvasId, elementId, requestId, null, message);
    }
  });

  // Daemon start/stop commands
  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.daemonStart", async () => {
      const cp = await import("child_process");
      const daemonPath = path.join(context.extensionPath, "dist", "daemon.js");
      const jwt = await authService.getToken();
      const child = cp.spawn("node", [daemonPath, "start"], {
        env: {
          ...process.env,
          JET_WORKSPACE: workspacePath,
          JET_JWT: jwt || "",
          JET_API_URL: vscode.workspace.getConfiguration("jetro").get<string>("apiUrl") || "http://localhost:8787",
        },
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      outputChannel.appendLine(`[daemon] Started (PID: ${child.pid})`);
      vscode.window.showInformationMessage("Jetro daemon started");
      await sidebarProvider.refreshAll();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("jetro.daemonStop", async () => {
      const cp = await import("child_process");
      const daemonPath = path.join(context.extensionPath, "dist", "daemon.js");
      try {
        cp.execSync(`node "${daemonPath}" stop`, {
          env: { ...process.env, JET_WORKSPACE: workspacePath },
        });
        outputChannel.appendLine("[daemon] Stopped");
        vscode.window.showInformationMessage("Jetro daemon stopped");
      } catch (err) {
        outputChannel.appendLine(`[daemon] Stop error: ${err}`);
        vscode.window.showWarningMessage("Failed to stop daemon — it may not be running");
      }
      await sidebarProvider.refreshAll();
    })
  );

  // 10b. Watch workspace for external changes (e.g. MCP server writes)
  // Must watch all data locations: .jetro/, projects/, data/
  const jetWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, ".jetro/**/*.json")
  );
  const projWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, "projects/**/*")
  );
  const dataWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, "data/**/*.json")
  );
  let refreshDebounce: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefresh = () => {
    if (refreshDebounce) clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(() => sidebarProvider.refreshAll(), 1000);
  };

  // Track which element files we've already rendered to avoid duplicates
  const renderedElements = new Set<string>();

  const handleFileChange = async (uri: vscode.Uri) => {
    const rel = vscode.workspace.asRelativePath(uri);
    debouncedRefresh();

    // Auto-render elements to canvas when MCP server writes them
    // Elements are saved at .jetro/element/{slug}.json or .jetro/render_queue/{id}.json
    if (rel.includes("/render_queue/")) {
      try {
        // Small delay to ensure the MCP server finishes writing the file.
        // The file watcher can fire before write completes, yielding partial JSON.
        await new Promise((r) => setTimeout(r, 150));
        const data = await vscode.workspace.fs.readFile(uri);
        const element = JSON.parse(new TextDecoder().decode(data));

        // Validate essential fields — if missing, the file was read too early
        if (!element.type && !element.command) {
          outputChannel.appendLine(`[watcher] Render queue file missing type/command, retrying: ${rel}`);
          await new Promise((r) => setTimeout(r, 500));
          const retryData = await vscode.workspace.fs.readFile(uri);
          const retryElement = JSON.parse(new TextDecoder().decode(retryData));
          Object.assign(element, retryElement);
        }

        // Deploy commands from jet_deploy MCP tool
        if (element && element.command === "deploy") {
          const cmdId = element.id as string;
          const deployAction = element.action as string;
          const projSlug = element.projectSlug as string;
          const resultUri = vscode.Uri.joinPath(
            workspaceRoot, ".jetro", "render_queue", `result-${cmdId}.json`
          );
          try {
            let deployResult: Record<string, unknown> = {};
            switch (deployAction) {
              case "start": {
                const deployDir = path.join(workspacePath, "projects", projSlug, "deploy");
                const { port, containerId } = await deployManager.start(projSlug, deployDir);
                deployResult = { status: "live", port, containerId };
                break;
              }
              case "stop":
                await deployManager.stop(projSlug);
                deployResult = { status: "stopped" };
                break;
              case "redeploy": {
                const { port: rPort, containerId: rId } = await deployManager.redeploy(projSlug);
                deployResult = { status: "live", port: rPort, containerId: rId };
                break;
              }
              case "publish": {
                const url = await deployManager.registerSlug(projSlug);
                await deployManager.connectRelay(projSlug);
                deployManager.startWakeListener();
                deployResult = { status: "published", url };
                break;
              }
              case "remove":
                await deployManager.remove(projSlug);
                deployResult = { status: "removed" };
                break;
              case "status": {
                const app = deployManager.getApp(projSlug);
                const relayDomain = vscode.workspace.getConfiguration("jetro").get<string>("relayDomain") || "";
                deployResult = { status: app ? "live" : "stopped", port: app?.port ?? null, url: app?.relaySlug && relayDomain ? `https://${app.relaySlug}.${relayDomain}` : null };
                break;
              }
            }
            await vscode.workspace.fs.writeFile(
              resultUri,
              new TextEncoder().encode(JSON.stringify(deployResult))
            );
            outputChannel.appendLine(`[watcher] Deploy ${deployAction} → ${JSON.stringify(deployResult)}`);
            await sidebarProvider.refreshAll();
          } catch (err) {
            await vscode.workspace.fs.writeFile(
              resultUri,
              new TextEncoder().encode(JSON.stringify({ error: String(err) }))
            );
            outputChannel.appendLine(`[watcher] Deploy error: ${err}`);
            logTrouble(workspacePath, {
              type: "deploy_crash",
              projectSlug: projSlug,
              message: `Deploy ${deployAction} failed`,
              detail: err instanceof Error ? err.message : String(err),
              hint: "Check server.py, Dockerfile, and requirements.txt for errors.",
            });
          }
          try { await vscode.workspace.fs.delete(uri); } catch { /* ignore */ }
          return;
        }

        // Canvas commands (move/resize/delete/arrange) from jet_canvas MCP tool
        if (element && element.command) {
          try {
            // Resolve canvas target: explicit canvasId > projectSlug > active
            let cmdCanvasId = element.canvasId as string | undefined;
            if (!cmdCanvasId && element.projectSlug) {
              cmdCanvasId = await canvasProvider.resolveProjectCanvas(element.projectSlug as string);
            }
            if (!cmdCanvasId) {
              cmdCanvasId = canvasProvider.getActiveCanvasId() || await canvasProvider.resolveUniversalCanvas();
            }

            switch (element.command) {
              case "move":
                await canvasProvider.open(cmdCanvasId);
                await canvasProvider.moveElement(element.elementId, element.position, cmdCanvasId);
                outputChannel.appendLine(`[watcher] Moved ${element.elementId} to (${element.position.x}, ${element.position.y})`);
                break;
              case "resize":
                await canvasProvider.open(cmdCanvasId);
                await canvasProvider.resizeElement(element.elementId, element.size, cmdCanvasId);
                outputChannel.appendLine(`[watcher] Resized ${element.elementId}`);
                break;
              case "delete":
                await canvasProvider.open(cmdCanvasId);
                await canvasProvider.removeElement(element.elementId, cmdCanvasId);
                await bindingManager.removeBinding(cmdCanvasId, element.elementId);
                outputChannel.appendLine(`[watcher] Deleted ${element.elementId}`);
                break;
              case "arrange":
                await canvasProvider.open(cmdCanvasId);
                await canvasProvider.arrangeElements(element.operations, cmdCanvasId);
                outputChannel.appendLine(`[watcher] Arranged ${element.operations.length} elements`);
                break;
              case "bind": {
                const rb = element.refreshBinding;
                if (element.elementId && (rb?.scriptPath || rb?.refreshPrompt)) {
                  const isPrompt = rb.bindingType === "prompt" || !!rb.refreshPrompt;
                  const binding: RefreshBinding = {
                    elementId: element.elementId as string,
                    bindingType: isPrompt ? "prompt" : "script",
                    intervalMs: (rb.intervalMs as number) || (isPrompt ? 300000 : 120000),
                    enabled: true,
                    createdAt: new Date().toISOString(),
                  };
                  if (rb.scriptPath) binding.scriptPath = rb.scriptPath as string;
                  if (rb.refreshPrompt) binding.refreshPrompt = rb.refreshPrompt as string;
                  if (rb.elementTitle) binding.elementTitle = rb.elementTitle as string;
                  if (rb.sourceDomain) {
                    binding.sourceDomain = rb.sourceDomain as string;
                    binding.consecutiveSuccesses = 0;
                    binding.patternSubmitted = false;
                  }
                  await bindingManager.addBinding(cmdCanvasId, binding);
                  outputChannel.appendLine(`[watcher] Bound ${element.elementId} → ${binding.bindingType === "prompt" ? "AI prompt" : binding.scriptPath} (${binding.intervalMs}ms)`);
                }
                break;
              }
              case "setupVenv": {
                outputChannel.appendLine("[watcher] setupVenv command received — triggering venv setup");
                vscode.commands.executeCommand("jetro.setupVenv");
                break;
              }
              case "unbind": {
                if (element.elementId) {
                  await bindingManager.removeBinding(cmdCanvasId, element.elementId as string);
                  outputChannel.appendLine(`[watcher] Unbound ${element.elementId}`);
                }
                break;
              }
              case "trigger": {
                if (element.elementId) {
                  await bindingManager.trigger(cmdCanvasId, element.elementId as string);
                  outputChannel.appendLine(`[watcher] Triggered refresh for ${element.elementId}`);
                }
                break;
              }
              case "c2Toggle": {
                await canvasProvider.open(cmdCanvasId);
                if (element.enabled) {
                  await canvasProvider.enableC2(cmdCanvasId);
                  const cs = await canvasProvider.getState(cmdCanvasId);
                  const wc = cs?.c2?.wires?.length ?? 0;
                  const fc = new Set([...(cs?.c2?.wires ?? []).map((w: { sourceId: string }) => w.sourceId), ...(cs?.c2?.wires ?? []).map((w: { targetId: string }) => w.targetId)]).size;
                  statusBar.setC2Info(wc, fc);
                } else {
                  await canvasProvider.disableC2(cmdCanvasId);
                  statusBar.hideC2();
                }
                outputChannel.appendLine(`[watcher] C2 ${element.enabled ? "enabled" : "disabled"} on ${cmdCanvasId}`);
                break;
              }
              case "addWire": {
                await canvasProvider.open(cmdCanvasId);
                if (element.wire) {
                  await canvasProvider.addWire(cmdCanvasId, element.wire);
                  const csA = await canvasProvider.getState(cmdCanvasId);
                  if (csA?.c2?.enabled) {
                    const wcA = csA.c2.wires?.length ?? 0;
                    const fcA = new Set([...(csA.c2.wires ?? []).map((w: { sourceId: string }) => w.sourceId), ...(csA.c2.wires ?? []).map((w: { targetId: string }) => w.targetId)]).size;
                    statusBar.setC2Info(wcA, fcA);
                  }
                  outputChannel.appendLine(`[watcher] Added wire ${element.wire.id} (${element.wire.channel}) on ${cmdCanvasId}`);
                }
                break;
              }
              case "removeWire": {
                await canvasProvider.open(cmdCanvasId);
                if (element.wireId) {
                  await canvasProvider.removeWire(cmdCanvasId, element.wireId as string);
                  const csR = await canvasProvider.getState(cmdCanvasId);
                  if (csR?.c2?.enabled) {
                    const wcR = csR.c2.wires?.length ?? 0;
                    const fcR = new Set([...(csR.c2.wires ?? []).map((w: { sourceId: string }) => w.sourceId), ...(csR.c2.wires ?? []).map((w: { targetId: string }) => w.targetId)]).size;
                    statusBar.setC2Info(wcR, fcR);
                  }
                  outputChannel.appendLine(`[watcher] Removed wire ${element.wireId} from ${cmdCanvasId}`);
                }
                break;
              }
              case "restore": {
                await canvasProvider.open(cmdCanvasId);
                // State was already written to disk by MCP — just reload from disk
                const restoredState = await fileManager.readCanvasById(
                  cmdCanvasId,
                  element.projectSlug || null
                );
                if (restoredState && canvasProvider.isOpenById(cmdCanvasId)) {
                  // Push state directly via addElement won't work; use getState refresh
                  // The panel was just opened — wirePanel already sent setState from disk
                  outputChannel.appendLine(`[watcher] Restored canvas ${cmdCanvasId} from version history`);
                }
                break;
              }
              case "share": {
                // Share commands from MCP jet_share tool — write result back
                const cmdId = element.cmdId as string;
                let shareResult: unknown;
                try {
                  switch (element.action) {
                    case "create":
                      shareResult = await shareManager.createShare({
                        title: element.title as string,
                        canvasId: cmdCanvasId,
                        elementIds: element.elementIds as string[],
                      });
                      break;
                    case "list":
                      shareResult = await shareManager.listShares();
                      break;
                    case "addElement":
                      await shareManager.addElement(
                        element.shareId as string,
                        element.elementId as string,
                        cmdCanvasId,
                        element.title as string
                      );
                      shareResult = { ok: true };
                      break;
                    case "removeElement":
                      await shareManager.removeElement(
                        element.shareId as string,
                        element.elementId as string
                      );
                      shareResult = { ok: true };
                      break;
                    case "pause":
                      await shareManager.pauseShare(element.shareId as string);
                      shareResult = { ok: true };
                      break;
                    case "resume":
                      await shareManager.resumeShare(element.shareId as string);
                      shareResult = { ok: true };
                      break;
                    case "revoke":
                      await shareManager.revokeShare(element.shareId as string);
                      shareResult = { ok: true };
                      break;
                    default:
                      shareResult = { error: `Unknown share action: ${element.action}` };
                  }
                } catch (err) {
                  shareResult = { error: String(err) };
                }
                // Write result file for MCP to read
                if (cmdId) {
                  const resultUri = vscode.Uri.joinPath(
                    workspaceRoot,
                    ".jetro",
                    "render_queue",
                    `result-${cmdId}.json`
                  );
                  await vscode.workspace.fs.writeFile(
                    resultUri,
                    new TextEncoder().encode(JSON.stringify(shareResult))
                  );
                }
                outputChannel.appendLine(`[watcher] Share command "${element.action}" → ${JSON.stringify(shareResult)}`);
                break;
              }
            }
          } catch (err) {
            outputChannel.appendLine(`[watcher] Canvas command error: ${err}`);
          }
          try { await vscode.workspace.fs.delete(uri); } catch { /* ignore */ }
          return;
        }

        if (element && element.type) {
          // This is a render request from the MCP server
          const id = element.id || `mcp-${Date.now()}`;
          const isUpdate = renderedElements.has(id);
          renderedElements.add(id);

          // Normalize data — agents sometimes pass a JSON string instead of an object
          let elementData = element.data || element;
          if (typeof elementData === "string") {
            try { elementData = JSON.parse(elementData); } catch { elementData = { html: elementData }; }
          }

          // Safety layer: if a frame element still has a file path reference
          // (e.g. MCP server sent data.src as a path), resolve it now
          if (element.type === "frame" && elementData) {
            const filePath =
              (typeof elementData.file === "string" && elementData.file) ||
              (typeof elementData.filePath === "string" && elementData.filePath) ||
              (typeof elementData.src === "string" && elementData.src && !elementData.src.startsWith("http") && (elementData.src.includes("/") || elementData.src.includes(".")) ? elementData.src : null);
            if (filePath && !elementData.html) {
              try {
                const html = await fileManager.readFrameFile(filePath);
                if (html) {
                  elementData = { ...elementData, html, file: undefined, filePath: undefined };
                  if (typeof elementData.src === "string" && !elementData.src.startsWith("http")) {
                    elementData = { ...elementData, src: undefined };
                  }
                  outputChannel.appendLine(`[watcher] Resolved frame file: ${filePath} (${html.length} chars)`);
                }
              } catch (err) {
                outputChannel.appendLine(`[watcher] Warning: could not read frame file ${filePath}: ${err}`);
              }
            }
          }

          // Resolve target canvas
          let renderCanvasId = element.config?.canvasId as string | undefined;
          if (!renderCanvasId && element.config?.projectSlug) {
            renderCanvasId = await canvasProvider.resolveProjectCanvas(element.config.projectSlug as string);
          }
          if (!renderCanvasId) {
            renderCanvasId = canvasProvider.getActiveCanvasId() || await canvasProvider.resolveUniversalCanvas();
          }

          if (isUpdate) {
            // In-place update: push new data to existing element
            await canvasProvider.updateElement(id, elementData, renderCanvasId);
            outputChannel.appendLine(`[watcher] Updated element ${id} in-place on canvas [${renderCanvasId}]`);
          } else {
            // New element
            // Note auto-save: persist markdown as .md file (mirrors jetRender logic)
            if (element.type === "note" && elementData) {
              const md = typeof elementData.markdown === "string" ? elementData.markdown
                : typeof elementData.content === "string" ? elementData.content
                : typeof elementData.text === "string" ? elementData.text
                : "";
              if (md.length > 0) {
                if (!elementData.markdown) elementData = { ...elementData, markdown: md };
                const noteTitle = typeof elementData.title === "string" ? elementData.title : "note";
                const projSlug = (element.config?.projectSlug as string) || undefined;
                try {
                  const savedPath = await fileManager.writeNoteFile(noteTitle, md, projSlug);
                  elementData = { ...elementData, _filePath: savedPath };
                  outputChannel.appendLine(`[watcher] Auto-saved note → ${savedPath}`);
                  sidebarProvider.refreshAll();
                } catch (err) {
                  outputChannel.appendLine(`[watcher] Note auto-save failed: ${err}`);
                }
              }
            }

            await canvasProvider.open(renderCanvasId);
            await canvasProvider.addElement({
              id,
              type: element.type,
              position: element.position || { x: 40 + Math.random() * 60, y: 40 + renderedElements.size * 280 },
              size: element.size || { width: element.config?.width || 340, height: element.type === "frame" ? 400 : 200 },
              data: elementData,
              connections: [],
            }, renderCanvasId);
            outputChannel.appendLine(`[watcher] Rendered element ${id} (${element.type}) to canvas [${renderCanvasId}]`);

            // Auto-create refresh binding if the element includes one
            if (element.refreshBinding?.scriptPath || element.refreshBinding?.refreshPrompt) {
              const erb = element.refreshBinding;
              const isPrompt = erb.bindingType === "prompt" || !!erb.refreshPrompt;
              const binding: RefreshBinding = {
                elementId: id,
                bindingType: isPrompt ? "prompt" : "script",
                intervalMs: (erb.intervalMs as number) || (isPrompt ? 300000 : 120000),
                enabled: true,
                createdAt: new Date().toISOString(),
              };
              if (erb.scriptPath) binding.scriptPath = erb.scriptPath as string;
              if (erb.refreshPrompt) binding.refreshPrompt = erb.refreshPrompt as string;
              if (erb.elementTitle) binding.elementTitle = erb.elementTitle as string;
              await bindingManager.addBinding(renderCanvasId, binding);
              outputChannel.appendLine(`[watcher] Auto-bound refresh: ${id} → ${binding.bindingType === "prompt" ? "AI prompt" : binding.scriptPath} (${binding.intervalMs}ms)`);
              sidebarProvider.refreshAll(); // Update live dot in canvas tree
            }
          }
          // Clean up the render queue file
          try { await vscode.workspace.fs.delete(uri); } catch { /* ignore */ }
        }
      } catch (err) {
        outputChannel.appendLine(`[watcher] Error rendering element: ${err}`);
        logTrouble(workspacePath, {
          type: "render_error",
          message: `Failed to render element`,
          detail: err instanceof Error ? err.message : String(err),
          hint: "Check the frame HTML or data for errors.",
        });
      }
    }

    // Auto-load canvas state when a canvas JSON file is written (new multi-canvas format)
    if (rel.includes("/canvases/") && rel.endsWith(".json")) {
      try {
        const canvasFileName = rel.split("/").pop()?.replace(".json", "");
        if (canvasFileName) {
          // Look up in registry to find project association
          const registry = await fileManager.readCanvasRegistry();
          const entry = registry.find((e) => e.id === canvasFileName);
          if (entry) {
            const canvasState = await fileManager.readCanvasById(entry.id, entry.projectSlug);
            // Skip auto-open if this write originated from companion (auto-save / toggle binding)
            if (companionServer?.isRecentCompanionWrite(entry.id)) {
              return;
            }
            if (canvasState && canvasState.elements?.length > 0 && !canvasProvider.isOpenById(entry.id)) {
              await canvasProvider.open(entry.id, { name: entry.name, projectSlug: entry.projectSlug });
              outputChannel.appendLine(`[watcher] Loaded canvas "${entry.name}" (${entry.id})`);
            }
          }
        }
      } catch (err) {
        outputChannel.appendLine(`[watcher] Error loading canvas: ${err}`);
      }
    }
  };

  for (const watcher of [jetWatcher, projWatcher, dataWatcher]) {
    watcher.onDidCreate(handleFileChange);
    watcher.onDidChange(handleFileChange);
    watcher.onDidDelete(debouncedRefresh);
    context.subscriptions.push(watcher);
  }

  // 10c. Dataset file watcher (auto-registers new files in data/datasets/)
  const datasetPattern = new vscode.RelativePattern(workspaceRoot, "data/datasets/**/*.{csv,tsv,parquet,json,jsonl,ndjson}");
  const datasetWatcher = vscode.workspace.createFileSystemWatcher(datasetPattern);
  datasetWatcher.onDidCreate(async (uri) => {
    const relPath = vscode.workspace.asRelativePath(uri);
    const parts = relPath.split("/"); // data/datasets/{slug}/{file}
    if (parts.length >= 4) {
      const slug = parts[2];
      const metadata = await fileManager.readDataset(slug);
      if (metadata) {
        try {
          await datasetImporter.registerExisting(slug);
          outputChannel.appendLine(`[watcher] Re-registered dataset ${slug} after file change`);
        } catch (err) {
          outputChannel.appendLine(`[watcher] Dataset re-register failed: ${err}`);
        }
      }
    }
  });
  context.subscriptions.push(datasetWatcher);

  // 10d. Connector credential queue watcher
  // MCP server writes {slug}.json to .jetro/connector_queue/ with store/delete commands.
  // Extension picks them up, stores/deletes credentials in SecretStorage, then removes the file.
  const connQueuePattern = new vscode.RelativePattern(workspaceRoot, ".jetro/connector_queue/*.json");
  const connQueueWatcher = vscode.workspace.createFileSystemWatcher(connQueuePattern);
  const processConnectorQueue = async (uri: vscode.Uri) => {
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      const cmd = JSON.parse(new TextDecoder().decode(raw)) as {
        action: "store" | "delete";
        slug: string;
        credentialKey?: string;
        credential?: string;
      };

      if (cmd.action === "store" && cmd.credentialKey && cmd.credential) {
        await context.secrets.store(cmd.credentialKey, cmd.credential);
        outputChannel.appendLine(`[connector] Stored credential for ${cmd.slug}`);
      } else if (cmd.action === "delete" && cmd.credentialKey) {
        await context.secrets.delete(cmd.credentialKey);
        outputChannel.appendLine(`[connector] Deleted credential for ${cmd.slug}`);
      }

      // Delete the queue file immediately
      await vscode.workspace.fs.delete(uri);
    } catch (err) {
      outputChannel.appendLine(`[connector] Queue processing error: ${err}`);
    }
  };
  connQueueWatcher.onDidCreate(processConnectorQueue);
  connQueueWatcher.onDidChange(processConnectorQueue);
  context.subscriptions.push(connQueueWatcher);

  // Process any leftover queue files from previous sessions
  try {
    const queueDir = vscode.Uri.joinPath(workspaceRoot, ".jetro", "connector_queue");
    const entries = await vscode.workspace.fs.readDirectory(queueDir);
    for (const [name, type] of entries) {
      if (type === vscode.FileType.File && name.endsWith(".json")) {
        await processConnectorQueue(vscode.Uri.joinPath(queueDir, name));
      }
    }
  } catch {
    // Queue dir may not exist yet
  }

  // 11. Status bar is ready (market timer removed)

  // Write daemon credentials file (for standalone daemon that can't access SecretStorage)
  const writeDaemonCredentials = async () => {
    try {
      const credsJson = await fileManager.buildCredentialsEnv(context.secrets);
      const daemonDir = path.join(workspacePath, ".jetro", "daemon");
      const credsFile = path.join(daemonDir, "credentials.json");
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.writeFileSync(credsFile, credsJson, { mode: 0o600 });
    } catch (err) {
      outputChannel.appendLine(`[credentials] Failed to write daemon creds: ${err}`);
    }
  };
  // Write daemon credentials on activation
  writeDaemonCredentials().catch(() => {});

  // Daemon status — poll every 10s and update status bar + companion
  const updateDaemonStatus = () => {
    let paused = false;
    try {
      const config = JSON.parse(
        fs.readFileSync(path.join(workspacePath, ".jetro", "daemon-config.json"), "utf-8")
      );
      paused = config.paused === true;
    } catch { /* default unpaused */ }
    const activeCount = bindingManager.getActiveTimerCount();
    statusBar.setDaemonStatus(activeCount, paused);
    if (companionServer?.isRunning()) {
      companionServer.broadcast({
        type: "daemon.status",
        paused,
        activeBindingCount: activeCount,
      });
    }
  };
  const daemonStatusTimer = setInterval(updateDaemonStatus, 10_000);
  setTimeout(updateDaemonStatus, 3000); // Initial after settling
  context.subscriptions.push({ dispose: () => clearInterval(daemonStatusTimer) });

  if (restoredSession) {
    statusBar.setConnected();

    // 12. Start periodic refresh (2 min interval)
    refreshService = new RefreshService(
      authService,
      apiClient,
      fileManager,
      outputChannel,
      () => sidebarProvider.refreshAll(),
      2 * 60 * 1000
    );
    refreshService.start();
    context.subscriptions.push({ dispose: () => refreshService?.stop() });

    // Telemetry: sync local resource counts to backend every 30 minutes
    const telemetrySync = async () => {
      try {
        const jwt = await authService.getToken();
        if (!jwt) return;
        const [canvasRegistry, projects, lists, recipes, connectors] = await Promise.all([
          fileManager.readCanvasRegistry(),
          fileManager.listProjects(),
          fileManager.listLists(),
          fileManager.listRecipes(),
          fileManager.listConnectors(),
        ]);
        await apiClient.telemetry(jwt, {
          canvases: canvasRegistry.length,
          projects: projects.length,
          lists: lists.length,
          recipes: recipes.length,
          connectors: connectors.length,
        });
      } catch { /* best-effort */ }
    };
    // Run once after 2 minutes, then every 30 minutes
    const telemetryInitTimer = setTimeout(telemetrySync, 2 * 60 * 1000);
    const telemetryTimer = setInterval(telemetrySync, 30 * 60 * 1000);
    context.subscriptions.push({
      dispose: () => { clearTimeout(telemetryInitTimer); clearInterval(telemetryTimer); },
    });

    outputChannel.appendLine(
      `[${timestamp()}] Ready — 6 tools · DuckDB cache · ${bootstrapService.getSkills().length} skills · ${bootstrapService.getTemplates().length} templates · refresh every 2m`
    );
  } else {
    statusBar.setDisconnected();
    outputChannel.appendLine(
      `[${timestamp()}] Ready (offline) — sign in to enable data + skills`
    );
  }

  // Auto-open universal canvas on extension load — only if signed in AND workspace is initialized.
  // Without the workspaceInitialized guard, this creates .jetro/ in unrelated folders.
  if (restoredSession && workspaceInitialized) {
    setTimeout(async () => {
      if (!canvasProvider.didSerializerRestore() && canvasProvider.getActiveCanvasId() === null && canvasProvider.getPanelCount() === 0) {
        const id = await canvasProvider.resolveUniversalCanvas();
        await canvasProvider.open(id);
      }
    }, 1500);
  }
}

export async function deactivate(): Promise<void> {
  if (companionServer) {
    companionServer.stop();
  }
  if (refreshService) {
    refreshService.stop();
  }
  if (duckdb) {
    await duckdb.close();
  }
}

// ── Mock data seeding ──

async function seedMockData(
  fm: FileManager,
  out: vscode.OutputChannel
): Promise<void> {
  out.appendLine(`[${timestamp()}] Seeding mock data...`);

  // Stock profiles
  const stocks = [
    {
      ticker: "ALKEM.NS",
      profile: {
        ticker: "ALKEM.NS", name: "Alkem Laboratories Ltd", sector: "Healthcare",
        industry: "Pharmaceuticals", mcap: 62000, price: 5180, change: 42.5,
        changePct: 0.83, exchange: "NSE",
      },
      ratios: {
        pe: 28.5, roce: 22.1, debtToEquity: 0.04, npm: 14.2,
        ebitdaMargin: 19.8, roe: 18.5, currentRatio: 2.1,
      },
      score: {
        jetroScore: 78, grade: "A", verdict: "Strong Buy",
        breakdown: { quality: 82, value: 71, growth: 75, momentum: 80 },
      },
    },
    {
      ticker: "CIPLA.NS",
      profile: {
        ticker: "CIPLA.NS", name: "Cipla Ltd", sector: "Healthcare",
        industry: "Pharmaceuticals", mcap: 115000, price: 1425, change: -8.2,
        changePct: -0.57, exchange: "NSE",
      },
      ratios: {
        pe: 24.8, roce: 18.3, debtToEquity: 0.08, npm: 16.1,
        ebitdaMargin: 24.5, roe: 15.2, currentRatio: 2.4,
      },
      score: {
        jetroScore: 72, grade: "A-", verdict: "Buy",
        breakdown: { quality: 75, value: 68, growth: 70, momentum: 74 },
      },
    },
    {
      ticker: "SUNPHARMA.NS",
      profile: {
        ticker: "SUNPHARMA.NS", name: "Sun Pharmaceutical Industries Ltd",
        sector: "Healthcare", industry: "Pharmaceuticals", mcap: 420000,
        price: 1750, change: 22.3, changePct: 1.29, exchange: "NSE",
      },
      ratios: {
        pe: 35.2, roce: 16.8, debtToEquity: 0.15, npm: 18.9,
        ebitdaMargin: 28.3, roe: 14.1, currentRatio: 1.8,
      },
      score: {
        jetroScore: 65, grade: "B+", verdict: "Hold",
        breakdown: { quality: 68, value: 55, growth: 72, momentum: 66 },
      },
    },
  ];

  for (const stock of stocks) {
    await fm.writeStockData(stock.ticker, "profile", stock.profile);
    await fm.writeStockData(stock.ticker, "ratios", stock.ratios);
    await fm.writeStockData(stock.ticker, "score", stock.score);
  }

  // Lists
  await fm.writeList("CNS Watchlist", {
    name: "CNS Watchlist",
    tickers: ["ALKEM.NS", "CIPLA.NS", "SUNPHARMA.NS", "TORNTPHARM.NS", "LUPIN.NS"],
    refreshable: false,
    createdAt: "2026-02-28T09:00:00Z",
  });

  await fm.writeList("Pharma Top 50", {
    name: "Pharma Top 50",
    tickers: [
      "SUNPHARMA.NS", "DRREDDY.NS", "CIPLA.NS", "DIVISLAB.NS", "AUROPHARMA.NS",
      "BIOCON.NS", "TORNTPHARM.NS", "ALKEM.NS", "LUPIN.NS", "ZYDUSLIFE.NS",
      "GLENMARK.NS", "IPCALAB.NS", "ABBOTINDIA.NS", "GLAXO.NS", "PFIZER.NS",
    ],
    criteria: "sector:pharma, mcap>5000Cr, sort:mcap desc, limit:50",
    refreshable: true,
    lastRefreshed: "2026-02-28T09:00:00Z",
    createdAt: "2026-02-20T09:00:00Z",
  });

  // Project
  const projectSlug = await fm.writeProject("CNS Pharma Research", {
    name: "CNS Pharma Research",
    slug: "cns_pharma_research",
    status: "active",
    securities: ["ALKEM.NS", "CIPLA.NS", "SUNPHARMA.NS"],
    sources: [],
    createdAt: "2026-02-25T09:00:00Z",
    updatedAt: "2026-03-01T09:00:00Z",
  });

  // Canvas state (multi-canvas format)
  const seedCanvasId = `${projectSlug}_canvas`;
  const seedCanvasState = {
    name: "CNS Pharma Research Board",
    elements: [
      {
        id: "frame-compare",
        type: "frame",
        position: { x: 40, y: 40 },
        size: { width: 500, height: 400 },
        data: {
          title: "Margin Comparison",
          html: "<table><thead><tr><th>Metric</th><th>ALKEM</th><th>CIPLA</th><th>SUNPHARMA</th></tr></thead><tbody><tr><td>PE</td><td>28.5</td><td>24.8</td><td>35.2</td></tr><tr><td>ROCE</td><td>22.1%</td><td>18.3%</td><td>16.8%</td></tr><tr><td>NPM</td><td>14.2%</td><td>16.1%</td><td>18.9%</td></tr><tr><td>D/E</td><td>0.04</td><td>0.08</td><td>0.15</td></tr><tr><td>Jetro Score</td><td>78</td><td>72</td><td>65</td></tr></tbody></table>",
        },
        connections: [],
      },
      {
        id: "note-thesis",
        type: "note",
        position: { x: 560, y: 40 },
        size: { width: 320, height: 200 },
        data: {
          title: "CNS Pharma Investment Thesis",
          markdown:
            "India's **psychotropic drug market** is growing at 12-15% CAGR, driven by rising mental health awareness and regulatory tailwinds.\n\n*Alkem* stands out with the strongest quality metrics — low debt, high ROCE, and dominant market share in neuropsychiatry APIs.\n\nKey risk: **regulatory concentration** — NDPS license dependency creates both moat and tail risk.",
        },
        connections: [],
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  await fm.writeCanvasById(seedCanvasId, seedCanvasState as import("./types").CanvasState, projectSlug);
  // Add to registry
  const seedRegistry = await fm.readCanvasRegistry();
  if (!seedRegistry.some((e) => e.id === seedCanvasId)) {
    seedRegistry.push({
      id: seedCanvasId,
      name: "CNS Pharma Research Board",
      projectSlug,
      createdAt: new Date().toISOString(),
    });
    await fm.writeCanvasRegistry(seedRegistry);
  }

  // Thesis
  await fm.writeThesis(
    projectSlug,
    `# CNS Pharma Investment Thesis

## Overview

India's central nervous system (CNS) pharmaceutical market represents one of the most compelling structural growth opportunities in the Indian healthcare sector. The psychotropic drug market is growing at 12-15% CAGR, driven by:

- Rising mental health awareness
- Government policy tailwinds (National Mental Health Programme)
- Regulatory moats via NDPS licensing
- API manufacturing advantages

## Key Picks

### Alkem Laboratories (ALKEM.NS) — Strong Buy

- **Jetro Score: 78 (A)**
- Dominant in neuropsychiatry APIs
- Low debt (D/E: 0.04), high ROCE (22.1%)
- Market leader in Clonazepam, Escitalopram

### Cipla (CIPLA.NS) — Buy

- **Jetro Score: 72 (A-)**
- Diversified CNS portfolio
- Strong R&D pipeline
- International markets exposure

### Sun Pharma (SUNPHARMA.NS) — Hold

- **Jetro Score: 65 (B+)**
- Largest by market cap
- Premium valuation (PE: 35.2)
- Specialty portfolio growing

## Risk Factors

1. **Regulatory concentration** — NDPS license dependency
2. **API supply chain** — import dependency for key intermediates
3. **Price control** — NLEM coverage risk
`
  );

  // Config
  await fm.writeConfig({
    theme: "dark",
    defaultProject: "cns_pharma_research",
    dataRefreshInterval: "4h",
  });

  // CLAUDE.md is generated by bootstrap (system prompt + skill/template catalog)
  // No static routing table needed — it's all in the backend system prompt.

  // ── Phase 1.5 Mock Data ──

  // Recipes
  await fm.writeRecipe("Sector PE Heatmap", {
    name: "Sector PE Heatmap",
    slug: "sector_pe_heatmap",
    description: "Compare PE ratios across sector peers, weight by market cap, normalize against 5Y median",
    inputs: [
      { name: "sector", type: "string", required: true },
      { name: "period", type: "string", default: "5Y" },
    ],
    steps: [
      "Fetch all tickers in {sector} using jet.query",
      "Pull PE ratios and market cap via jet.data",
      "Compute cap-weighted median PE",
      "Render a DataTable with deviation from median highlighted",
    ],
    outputHint: "table",
    createdAt: "2026-02-28T09:00:00Z",
  });

  await fm.writeRecipe("Margin Trend Tracker", {
    name: "Margin Trend Tracker",
    slug: "margin_trend_tracker",
    description: "Track operating margin trends for a company over the last 8 quarters",
    inputs: [{ name: "ticker", type: "string", required: true }],
    steps: [
      "Fetch quarterly income statements for {ticker} via jet.data",
      "Calculate operating margin for each quarter",
      "Render a line chart showing margin trend",
    ],
    outputHint: "chart",
    createdAt: "2026-02-28T10:00:00Z",
  });

  // Data Source (mock — no real key)
  await fm.writeDataSource("Bloomberg", {
    name: "Bloomberg",
    slug: "bloomberg",
    baseUrl: "https://api.bloomberg.com/v1",
    auth: {
      type: "header",
      headerName: "X-Bloomberg-Key",
      secretRef: "bloomberg_api_key",
    },
    docsUrl: "https://docs.bloomberg.com",
    endpoints: [
      { name: "fundamentals", path: "/data/fundamentals/{ticker}", method: "GET", params: ["fields", "period"] },
    ],
    createdAt: "2026-02-28T09:00:00Z",
  });

  // Portfolio-mode project (writePortfolio auto-creates project.json with mode: "portfolio")
  const mockCapital = 1000000;
  const mockUnits = mockCapital / 100; // 10000 units, NAV/unit starts at 100
  await fm.writePortfolio("Pharma Core", {
    name: "Pharma Core",
    holdings: [
      { ticker: "ALKEM.NS", name: "Alkem Laboratories", weight: 0.40, shares: 150, avgCost: 4800, sector: "Pharmaceuticals" },
      { ticker: "CIPLA.NS", name: "Cipla Ltd", weight: 0.35, shares: 200, avgCost: 1200, sector: "Pharmaceuticals" },
      { ticker: "SUNPHARMA.NS", name: "Sun Pharmaceutical", weight: 0.25, shares: 100, avgCost: 1600, sector: "Pharmaceuticals" },
    ],
    initialCapital: mockCapital,
    cash: 52000,
    currency: "INR",
    benchmark: "NIFTY_PHARMA.NS",
    rebalance: "quarterly",
    rebalanceTargets: [
      { ticker: "ALKEM.NS", weight: 0.40 },
      { ticker: "CIPLA.NS", weight: 0.35 },
      { ticker: "SUNPHARMA.NS", weight: 0.25 },
    ],
    inceptionDate: "2024-01-15",
    units: mockUnits,
    currentNAV: 1428000,
    navPerUnit: 142.8,
  });

  // NAV history for the mock portfolio (unitised: navPerUnit starts at 100)
  await fm.writeNAVHistory("pharma_core", [
    { date: "2024-01-15", nav: 1000000, navPerUnit: 100.0, units: mockUnits, benchmark: 100.0 },
    { date: "2024-04-15", nav: 1085000, navPerUnit: 108.5, units: mockUnits, benchmark: 105.2 },
    { date: "2024-07-15", nav: 1152000, navPerUnit: 115.2, units: mockUnits, benchmark: 112.1 },
    { date: "2024-10-15", nav: 1221000, navPerUnit: 122.1, units: mockUnits, benchmark: 118.3 },
    { date: "2025-01-15", nav: 1284000, navPerUnit: 128.4, units: mockUnits, benchmark: 121.7 },
    { date: "2025-04-15", nav: 1317000, navPerUnit: 131.7, units: mockUnits, benchmark: 125.0 },
    { date: "2025-07-15", nav: 1360000, navPerUnit: 136.0, units: mockUnits, benchmark: 129.4 },
    { date: "2025-10-15", nav: 1395000, navPerUnit: 139.5, units: mockUnits, benchmark: 132.8 },
    { date: "2026-01-15", nav: 1412000, navPerUnit: 141.2, units: mockUnits, benchmark: 135.1 },
    { date: "2026-02-28", nav: 1428000, navPerUnit: 142.8, units: mockUnits, benchmark: 137.5 },
  ]);

  // ── BI Mode mock data ──

  const biDatasetMeta: DatasetMetadata = {
    name: "Sample Sales",
    slug: "sample_sales",
    files: ["sales_2025.csv"],
    columns: [
      { name: "date", type: "DATE", nullable: false },
      { name: "product", type: "VARCHAR", nullable: false },
      { name: "region", type: "VARCHAR", nullable: false },
      { name: "revenue", type: "DOUBLE", nullable: false },
      { name: "units", type: "INTEGER", nullable: false },
    ],
    rowCount: 1000,
    sizeBytes: 45000,
    duckdbTable: "ds_sample_sales",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fm.writeDataset("Sample Sales", biDatasetMeta);

  const biModel: DataModel = {
    name: "Monthly Revenue",
    slug: "monthly_revenue",
    sql: "CREATE OR REPLACE VIEW monthly_revenue AS SELECT date_trunc('month', date) as month, region, SUM(revenue) as total_revenue, SUM(units) as total_units FROM ds_sample_sales GROUP BY 1, 2",
    description: "Monthly revenue by region",
    dependsOn: ["ds_sample_sales"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fm.writeModel("Monthly Revenue", biModel);

  const biQuery: SavedQuery = {
    name: "Top Products by Revenue",
    slug: "top_products_by_revenue",
    sql: "SELECT product, SUM(revenue) as total_revenue, SUM(units) as total_units FROM ds_sample_sales GROUP BY product ORDER BY total_revenue DESC LIMIT 10",
    description: "Top 10 products ranked by total revenue",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fm.writeQuery("Top Products by Revenue", biQuery);

  out.appendLine(
    `[${timestamp()}] ✓ Mock data seeded: 3 stocks · 2 lists · 1 project · 2 recipes · 1 portfolio · 1 datasource · tokens · 1 dataset · 1 model · 1 query`
  );
}
