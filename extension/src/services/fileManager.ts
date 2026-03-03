import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { existsSync } from "fs";
import { exec } from "child_process";
import {
  StockProfile,
  StockRatios,
  StockScore,
  JETList,
  JETProject,
  CanvasState,
  CanvasRegistryEntry,
  CustomElementDef,
  WorkspaceIndex,
  Recipe,
  DataSourceConnector,
  Connector,
  Portfolio,
  NAVPoint,
  PortfolioTransaction,
  PortfolioMutationLog,
  DatasetMetadata,
  DatabaseConnection,
  DataModel,
  SavedQuery,
  QueryHistoryEntry,
  DashboardMeta,
  WebCredential,
} from "../types";

type StockDataType = "profile" | "ratios" | "financials" | "score" | "quote";

export class FileManager {
  private root: vscode.Uri;

  constructor(workspaceRoot: vscode.Uri) {
    this.root = workspaceRoot;
  }

  getRootPath(): string {
    return this.root.fsPath;
  }

  public getRoot(): vscode.Uri {
    return this.root;
  }

  // ── Helpers ──

  private uri(...segments: string[]): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...segments);
  }

  private encode(content: string): Uint8Array {
    return new TextEncoder().encode(content);
  }

  private async readJson<T>(path: vscode.Uri): Promise<T | null> {
    try {
      const data = await vscode.workspace.fs.readFile(path);
      return JSON.parse(new TextDecoder().decode(data)) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(path: vscode.Uri, data: unknown): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    await vscode.workspace.fs.writeFile(path, this.encode(content));
  }

  private async writeText(path: vscode.Uri, content: string): Promise<void> {
    await vscode.workspace.fs.writeFile(path, this.encode(content));
  }

  private async exists(path: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureDir(path: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(path);
    } catch {
      // already exists
    }
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  }

  private async listDirs(parent: vscode.Uri): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(parent);
      return entries
        .filter(([, type]) => type === vscode.FileType.Directory)
        .map(([name]) => name);
    } catch {
      return [];
    }
  }

  private async listFiles(
    parent: vscode.Uri,
    ext?: string
  ): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(parent);
      return entries
        .filter(
          ([name, type]) =>
            type === vscode.FileType.File && (!ext || name.endsWith(ext))
        )
        .map(([name]) => name);
    } catch {
      return [];
    }
  }

  // ── Workspace init ──

  async initWorkspace(): Promise<void> {
    await this.ensureDir(this.uri("data", "stocks"));
    await this.ensureDir(this.uri("data", "lists"));
    await this.ensureDir(this.uri("projects"));
    await this.ensureDir(this.uri(".jetro"));
    await this.ensureDir(this.uri(".jetro", "elements"));
    await this.ensureDir(this.uri(".jetro", "recipes"));
    await this.ensureDir(this.uri(".jetro", "datasources"));
    await this.ensureDir(this.uri(".jetro", "connectors"));
    await this.ensureDir(this.uri(".jetro", "connector_queue"));
    await this.ensureDir(this.uri(".jetro", "templates"));
    await this.ensureDir(this.uri(".jetro", "render_queue"));
    await this.ensureDir(this.uri(".jetro", "frames"));
    await this.ensureDir(this.uri(".jetro", "sources"));
    await this.ensureDir(this.uri(".jetro", "notes"));
    // BI mode directories
    await this.ensureDir(this.uri("data", "datasets"));
    await this.ensureDir(this.uri(".jetro", "connections"));
    await this.ensureDir(this.uri(".jetro", "models"));
    await this.ensureDir(this.uri(".jetro", "queries"));
    await this.ensureDir(this.uri(".jetro", "dashboards"));
    await this.ensureDir(this.uri(".jetro", "credentials"));
    // Python SDK wrappers (jet.market, jet.mf)
    await this.ensureDir(this.uri(".jetro", "lib", "jet"));
    await this.ensureDir(this.uri(".jetro", "scripts"));
    await this.ensurePythonWrappers();
  }

  /**
   * Write/overwrite .mcp.json (workspace root) and .jetro/mcp-config.json
   * so Cursor/Claude Desktop and the agent refresh runner always have the
   * correct MCP server path and env vars. Called on every activation to
   * ensure extension updates propagate immediately.
   */
  async ensureMcpConfigs(
    mcpCommand: { command: string; args: string[]; binDir: string | null },
    jwt?: string
  ): Promise<void> {
    const workspacePath = this.root.fsPath;

    const env: Record<string, string> = {
      JET_WORKSPACE: workspacePath,
      JET_API_URL: vscode.workspace.getConfiguration("jetro").get<string>("apiUrl") || "http://localhost:8787",
    };
    if (jwt) {
      env.JET_JWT = jwt;
    }
    // Prepend the runtime's bin directory to PATH
    if (mcpCommand.binDir) {
      const sep = process.platform === "win32" ? ";" : ":";
      const currentPath = process.env.PATH || "";
      env.PATH = currentPath.includes(mcpCommand.binDir)
        ? currentPath
        : `${mcpCommand.binDir}${sep}${currentPath}`;
    }

    const serverEntry = {
      type: "stdio",
      command: mcpCommand.command,
      args: mcpCommand.args,
      env,
    };

    const rootMcp = { mcpServers: { jetro: serverEntry } };
    const internalMcp = { mcpServers: { jetro: { command: mcpCommand.command, args: mcpCommand.args, env } } };

    const enc = new TextEncoder();
    const rootMcpJson = enc.encode(JSON.stringify(rootMcp, null, 2) + "\n");
    const internalMcpJson = enc.encode(JSON.stringify(internalMcp, null, 2) + "\n");

    // Write to all known MCP config locations
    await vscode.workspace.fs.writeFile(this.uri(".mcp.json"), rootMcpJson);
    await vscode.workspace.fs.writeFile(this.uri(".jetro", "mcp-config.json"), internalMcpJson);

    // Cursor reads from .cursor/mcp.json (per-workspace)
    try {
      await vscode.workspace.fs.createDirectory(this.uri(".cursor"));
      await vscode.workspace.fs.writeFile(this.uri(".cursor", "mcp.json"), rootMcpJson);
    } catch { /* .cursor/ may not be writable in some setups */ }

    // Antigravity reads from ~/.gemini/antigravity/mcp_config.json (global)
    await this.mergeGlobalMcpConfig(
      path.join(os.homedir(), ".gemini", "antigravity", "mcp_config.json"),
      "jetro",
      { command: mcpCommand.command, args: mcpCommand.args, env }
    );
  }

  /**
   * Merge a single MCP server entry into a global config file.
   * Reads existing config, upserts the entry, writes back.
   * Creates the file if it doesn't exist.
   */
  private async mergeGlobalMcpConfig(
    configPath: string,
    serverName: string,
    serverConfig: Record<string, unknown>
  ): Promise<void> {
    try {
      const fs = await import("fs");
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) return; // Editor not installed

      let existing: Record<string, unknown> = { mcpServers: {} };
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        existing = JSON.parse(raw);
      } catch { /* file doesn't exist or is malformed */ }

      const servers = (existing.mcpServers || {}) as Record<string, unknown>;
      servers[serverName] = serverConfig;
      existing.mcpServers = servers;

      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
    } catch { /* ignore — best effort */ }
  }

  /**
   * Resolve the absolute path to npx binary.
   * Checks multiple locations to handle nvm, volta, fnm, homebrew, and system installs.
   * Works on macOS, Linux, and Windows.
   */
  /** Write jet.market / jet.mf / jet.api Python wrapper modules to .jetro/lib/jet/ */
  private async ensurePythonWrappers(): Promise<void> {
    const jetInit = this.uri(".jetro", "lib", "jet", "__init__.py");
    const jetMarket = this.uri(".jetro", "lib", "jet", "market.py");
    const jetMf = this.uri(".jetro", "lib", "jet", "mf.py");
    const jetApi = this.uri(".jetro", "lib", "jet", "api.py");
    const jetConnectors = this.uri(".jetro", "lib", "jet", "connectors.py");

    const initContent = "# Jetro Python SDK\n";
    const marketContent = [
      "# jet.market — Jetro Market Data module",
      "# Usage: from jet.market import Ticker, download",
      "from yfinance import Ticker, download, Tickers  # noqa: F401",
      "from yfinance import *  # noqa: F401, F403",
      "",
    ].join("\n");
    const mfContent = [
      "# jet.mf — Jetro Mutual Fund Data module",
      "# Usage: from jet.mf import MutualFund",
      "from mftool import Mftool",
      "MutualFund = Mftool",
      "__all__ = ['MutualFund', 'Mftool']",
      "",
    ].join("\n");
    const apiContent = [
      "# jet.api — Jetro API proxy helper",
      "# Usage: from jet.api import jet_api",
      "import json, os, urllib.request, ssl, certifi",
      "",
      'API = os.environ.get("JET_API_URL", "http://localhost:8787")',
      'JWT = os.environ.get("JET_JWT", "")',
      "",
      "",
      'def jet_api(endpoint, params=None, provider="fmp"):',
      '    """Call the Jetro data proxy API.',
      "",
      "    Args:",
      '        endpoint: FMP endpoint path, e.g. "/quote/AAPL"',
      "        params: Optional dict of query parameters",
      '        provider: API provider ("fmp" or "polygon")',
      "",
      "    Returns:",
      "        Parsed JSON response from the provider",
      '    """',
      '    body = {"provider": provider, "endpoint": endpoint}',
      "    if params:",
      '        body["params"] = params',
      "    req = urllib.request.Request(",
      '        f"{API}/api/data",',
      "        data=json.dumps(body).encode(),",
      "        headers={",
      '            "Authorization": f"Bearer {JWT}",',
      '            "Content-Type": "application/json",',
      '            "User-Agent": "Jetro/1.0",',
      "        },",
      "    )",
      "    ctx = ssl.create_default_context(cafile=certifi.where())",
      "    return json.loads(urllib.request.urlopen(req, context=ctx).read())",
      "",
    ].join("\n");

    const enc = new TextEncoder();
    // Always overwrite all SDK modules to ensure updates propagate
    await vscode.workspace.fs.writeFile(jetInit, enc.encode(initContent));
    await vscode.workspace.fs.writeFile(jetMarket, enc.encode(marketContent));
    await vscode.workspace.fs.writeFile(jetMf, enc.encode(mfContent));
    await vscode.workspace.fs.writeFile(jetApi, enc.encode(apiContent));

    // Always overwrite jet.connectors to ensure latest version
    const connectorsContent = [
      "# jet.connectors — load agent-built data connectors",
      "# Usage: from jet.connectors import use",
      "#   client = use('google_sheets', spreadsheetId='1abc...')",
      "#   data = client.fetch()",
      "import json, os, importlib.util",
      "",
      'WORKSPACE = os.environ.get("JET_WORKSPACE", os.getcwd())',
      'CONNECTORS_DIR = os.path.join(WORKSPACE, ".jetro", "connectors")',
      "",
      "",
      "def use(slug, **params):",
      '    """Load a connector by slug and return its Client instance.',
      "",
      "    Credentials are injected via JET_CRED_{KEY} environment variables",
      "    by the extension before script execution.",
      "",
      "    Args:",
      "        slug: Connector slug (directory name under .jetro/connectors/)",
      "        **params: Override default connector params",
      "",
      "    Returns:",
      "        Client instance from the connector's client.py module",
      '    """',
      "    conn_dir = os.path.join(CONNECTORS_DIR, slug)",
      '    config_path = os.path.join(conn_dir, "connector.json")',
      '    client_path = os.path.join(conn_dir, "client.py")',
      "",
      "    with open(config_path) as f:",
      "        config = json.load(f)",
      "",
      "    # Resolve params: spec defaults < overrides",
      "    resolved = {}",
      '    for key, spec in config.get("params", {}).items():',
      '        resolved[key] = params.get(key, spec.get("default"))',
      "    resolved.update({k: v for k, v in params.items() if k not in resolved})",
      "",
      "    # Get credential from env (injected by extension)",
      '    cred_key = config.get("auth", {}).get("credentialKey")',
      "    credential = None",
      "    if cred_key:",
      '        env_key = "JET_CRED_" + cred_key.upper().replace("-", "_")',
      "        credential = os.environ.get(env_key)",
      "",
      "    # Dynamic import client.py",
      "    spec_obj = importlib.util.spec_from_file_location(",
      '        f"jet_connector_{slug}", client_path)',
      "    mod = importlib.util.module_from_spec(spec_obj)",
      "    spec_obj.loader.exec_module(mod)",
      "",
      "    return mod.Client(config=config, params=resolved, credential=credential)",
      "",
    ].join("\n");
    await vscode.workspace.fs.writeFile(jetConnectors, enc.encode(connectorsContent));

    // Always overwrite jet.credentials to ensure latest version
    const jetCredentials = this.uri(".jetro", "lib", "jet", "credentials.py");
    const credentialsContent = [
      "# jet.credentials -- Jetro Credential Vault helper",
      "# Usage: from jet.credentials import get_credential, has_credential",
      "import json, os",
      "",
      "_CREDS_CACHE = None",
      "",
      "",
      "def _load():",
      "    global _CREDS_CACHE",
      "    if _CREDS_CACHE is None:",
      '        raw = os.environ.get("JET_CREDENTIALS", "{}")',
      "        try:",
      "            _CREDS_CACHE = json.loads(raw)",
      "        except json.JSONDecodeError:",
      "            _CREDS_CACHE = {}",
      "    return _CREDS_CACHE",
      "",
      "",
      "def get_credential(domain):",
      '    """Get credential for a domain.',
      "",
      "    Returns dict with: username, password, loginUrl, loginSelectors",
      "    or None if not found. Supports partial domain matching.",
      '    """',
      "    creds = _load()",
      "    if domain in creds:",
      "        return creds[domain]",
      "    for stored_domain, cred in creds.items():",
      "        if domain.endswith(stored_domain) or stored_domain.endswith(domain):",
      "            return cred",
      "    return None",
      "",
      "",
      "def has_credential(domain):",
      '    """Check if a credential exists for the given domain."""',
      "    return get_credential(domain) is not None",
      "",
      "",
      "def get_all_credentials():",
      '    """Get all available credentials as {domain: {username, password, ...}}."""',
      "    return _load()",
      "",
    ].join("\n");
    await vscode.workspace.fs.writeFile(jetCredentials, enc.encode(credentialsContent));

    // Always overwrite jet.browser to ensure latest version
    const jetBrowser = this.uri(".jetro", "lib", "jet", "browser.py");
    const browserContent = [
      "# jet.browser -- Jetro Stealth Browser helper",
      "# Usage: from jet.browser import launch_stealth, login_and_fetch",
      "import json, random, time",
      "",
      "_USER_AGENTS = [",
      '    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",',
      '    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",',
      '    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",',
      '    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",',
      "]",
      "",
      "_VIEWPORTS = [",
      '    {"width": 1920, "height": 1080},',
      '    {"width": 1440, "height": 900},',
      '    {"width": 1536, "height": 864},',
      '    {"width": 1366, "height": 768},',
      "]",
      "",
      "",
      "def launch_stealth(headless=True, **kwargs):",
      '    """Launch a stealth Playwright Chromium browser context.',
      "",
      "    Returns (pw, browser, context, page) tuple.",
      "    Caller MUST close: browser.close(); pw.stop()",
      "",
      "    Anti-detection: removes navigator.webdriver, realistic viewport/UA/locale,",
      "    disables AutomationControlled blink feature, fixes plugins/languages/chrome.runtime.",
      '    """',
      "    from playwright.sync_api import sync_playwright",
      "",
      "    pw = sync_playwright().start()",
      "",
      '    ua = kwargs.pop("user_agent", random.choice(_USER_AGENTS))',
      '    viewport = kwargs.pop("viewport", random.choice(_VIEWPORTS))',
      "",
      "    launch_args = [",
      '        "--disable-blink-features=AutomationControlled",',
      '        "--disable-features=IsolateOrigins,site-per-process",',
      '        "--no-first-run",',
      '        "--no-default-browser-check",',
      "    ]",
      '    if "args" in kwargs:',
      '        launch_args.extend(kwargs.pop("args"))',
      "",
      "    browser = pw.chromium.launch(",
      "        headless=headless,",
      "        args=launch_args,",
      "        **kwargs,",
      "    )",
      "",
      "    context = browser.new_context(",
      "        user_agent=ua,",
      "        viewport=viewport,",
      '        locale="en-US",',
      '        timezone_id="Asia/Kolkata",',
      '        color_scheme="light",',
      "        java_script_enabled=True,",
      "        bypass_csp=True,",
      "    )",
      "",
      "    # Stealth: remove webdriver indicators",
      '    context.add_init_script("""',
      "        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
      "        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });",
      "        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });",
      "        window.chrome = { runtime: {} };",
      "        const origQuery = window.navigator.permissions.query;",
      "        window.navigator.permissions.query = (params) => (",
      "            params.name === 'notifications' ?",
      "                Promise.resolve({ state: Notification.permission }) :",
      "                origQuery(params)",
      "        );",
      '    """)',
      "",
      "    page = context.new_page()",
      "    return pw, browser, context, page",
      "",
      "",
      "def login_and_fetch(url, domain=None, wait_selector=None, timeout=25000):",
      '    """Full credential-aware fetch with auto-login.',
      "",
      "    If credentials exist for the domain, performs login first.",
      "    Returns dict with: html, cookies, url (final URL after redirects).",
      '    """',
      "    from urllib.parse import urlparse",
      "    from jet.credentials import get_credential",
      "",
      "    if domain is None:",
      '        domain = urlparse(url).netloc.replace("www.", "")',
      "",
      "    cred = get_credential(domain)",
      "    pw, browser, context, page = launch_stealth()",
      "",
      "    try:",
      '        if cred and cred.get("loginUrl"):',
      '            page.goto(cred["loginUrl"], timeout=timeout, wait_until="networkidle")',
      "            time.sleep(random.uniform(0.5, 1.5))",
      "",
      '            selectors = cred.get("loginSelectors", {})',
      "            username_sel = selectors.get(",
      '                "usernameField",',
      "                'input[type=\"email\"], input[name=\"username\"], input[name=\"email\"], #username, #email'",
      "            )",
      "            password_sel = selectors.get(",
      '                "passwordField",',
      "                'input[type=\"password\"], #password'",
      "            )",
      "            submit_sel = selectors.get(",
      '                "submitButton",',
      "                'button[type=\"submit\"], input[type=\"submit\"], .login-btn, #login-btn'",
      "            )",
      "",
      '            page.fill(username_sel, cred["username"])',
      "            time.sleep(random.uniform(0.3, 0.7))",
      '            page.fill(password_sel, cred["password"])',
      "            time.sleep(random.uniform(0.3, 0.7))",
      "            page.click(submit_sel)",
      '            page.wait_for_load_state("networkidle", timeout=timeout)',
      "            time.sleep(random.uniform(1.0, 2.0))",
      "",
      '        page.goto(url, timeout=timeout, wait_until="networkidle")',
      "",
      "        if wait_selector:",
      "            page.wait_for_selector(wait_selector, timeout=timeout)",
      "",
      "        return {",
      '            "html": page.content(),',
      '            "cookies": context.cookies(),',
      '            "url": page.url,',
      "        }",
      "    finally:",
      "        browser.close()",
      "        pw.stop()",
      "",
    ].join("\n");
    await vscode.workspace.fs.writeFile(jetBrowser, enc.encode(browserContent));

    // Always overwrite jet.geo for geospatial utilities
    const jetGeo = this.uri(".jetro", "lib", "jet", "geo.py");
    const geoContent = [
      '"""jet.geo -- Geospatial utilities for Jetro refresh scripts.',
      "",
      "Usage:",
      "  from jet.geo import haversine, bbox, to_geojson_feature, to_geojson_collection",
      "  from jet.geo import to_cesium_entities, grid_points, bearing, destination_point",
      '"""',
      "",
      "import json",
      "import math",
      "",
      "",
      "def haversine(lat1, lon1, lat2, lon2):",
      '    """Distance between two points in km (Haversine formula)."""',
      "    R = 6371",
      "    dlat = math.radians(lat2 - lat1)",
      "    dlon = math.radians(lon2 - lon1)",
      "    a = (math.sin(dlat / 2) ** 2 +",
      "         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *",
      "         math.sin(dlon / 2) ** 2)",
      "    return R * 2 * math.asin(math.sqrt(a))",
      "",
      "",
      "def bearing(lat1, lon1, lat2, lon2):",
      '    """Initial bearing from point 1 to point 2 in degrees."""',
      "    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])",
      "    dlon = lon2 - lon1",
      "    x = math.sin(dlon) * math.cos(lat2)",
      "    y = (math.cos(lat1) * math.sin(lat2) -",
      "         math.sin(lat1) * math.cos(lat2) * math.cos(dlon))",
      "    return (math.degrees(math.atan2(x, y)) + 360) % 360",
      "",
      "",
      "def destination_point(lat, lon, bearing_deg, distance_km):",
      '    """Calculate destination point given start, bearing, and distance."""',
      "    R = 6371",
      "    d = distance_km / R",
      "    brng = math.radians(bearing_deg)",
      "    lat1 = math.radians(lat)",
      "    lon1 = math.radians(lon)",
      "    lat2 = math.asin(math.sin(lat1) * math.cos(d) +",
      "                      math.cos(lat1) * math.sin(d) * math.cos(brng))",
      "    lon2 = lon1 + math.atan2(math.sin(brng) * math.sin(d) * math.cos(lat1),",
      "                              math.cos(d) - math.sin(lat1) * math.sin(lat2))",
      "    return math.degrees(lat2), math.degrees(lon2)",
      "",
      "",
      "def bbox(center_lat, center_lon, radius_km):",
      '    """Bounding box around a center point."""',
      "    dlat = radius_km / 111.32",
      "    dlon = radius_km / (111.32 * math.cos(math.radians(center_lat)))",
      "    return {",
      '        "south": center_lat - dlat, "north": center_lat + dlat,',
      '        "west": center_lon - dlon, "east": center_lon + dlon,',
      "    }",
      "",
      "",
      "def grid_points(south, west, north, east, step_km=10):",
      '    """Generate a grid of lat/lon points within a bounding box."""',
      "    step_lat = step_km / 111.32",
      "    step_lon = step_km / (111.32 * math.cos(math.radians((south + north) / 2)))",
      "    points = []",
      "    lat = south",
      "    while lat <= north:",
      "        lon = west",
      "        while lon <= east:",
      "            points.append((lat, lon))",
      "            lon += step_lon",
      "        lat += step_lat",
      "    return points",
      "",
      "",
      'def to_geojson_feature(id, lat, lon, properties=None, geometry_type="Point"):',
      '    """Create a GeoJSON Feature."""',
      '    return {"type": "Feature", "id": id,',
      '            "geometry": {"type": geometry_type, "coordinates": [lon, lat]},',
      '            "properties": properties or {}}',
      "",
      "",
      "def to_geojson_collection(features):",
      '    """Wrap features in a FeatureCollection."""',
      '    return {"type": "FeatureCollection", "features": features}',
      "",
      "",
      'def to_cesium_entities(data, id_field="id", lat_field="lat", lon_field="lon",',
      '                       label_field="name"):',
      '    """Convert tabular data to Cesium entity format for refresh scripts.',
      "",
      "    Args:",
      "        data: List of dicts with at least id, lat, lon fields",
      "        id_field, lat_field, lon_field, label_field: column names",
      "",
      "    Returns:",
      "        List of dicts with id, lat, lon, label + extra fields",
      '    """',
      "    return [{",
      '        "id": row[id_field], "lat": row[lat_field], "lon": row[lon_field],',
      '        "label": row.get(label_field, ""),',
      "        **{k: v for k, v in row.items()",
      "           if k not in (id_field, lat_field, lon_field, label_field)}",
      "    } for row in data]",
      "",
      "",
      "def to_layer_update(layer_id, data):",
      '    """Format layer data for 3D frame refresh output.',
      "",
      "    Usage in refresh scripts:",
      "      print(json.dumps({",
      '          "layers": {',
      '              "ships": to_layer_update("ships", ship_data)',
      "          }",
      "      }))",
      '    """',
      '    return {"data": data}',
      "",
    ].join("\n");
    await vscode.workspace.fs.writeFile(jetGeo, enc.encode(geoContent));

    // Update __init__.py to declare all modules
    const updatedInitContent = "# Jetro Python SDK\n# Modules: market, mf, api, connectors, credentials, browser, geo\n";
    await vscode.workspace.fs.writeFile(jetInit, enc.encode(updatedInitContent));
  }

  /** Create a managed Python venv at .jetro/venv/ with scraping dependencies. */
  async setupVenv(output?: vscode.OutputChannel): Promise<string> {
    const rootPath = this.root.fsPath;
    const venvPath = `${rootPath}/.jetro/venv`;
    const requirementsPath = `${rootPath}/.jetro/requirements.txt`;

    const log = (msg: string) => output?.appendLine(`[venv] ${msg}`);

    // Write requirements.txt if missing
    if (!(await this.exists(this.uri(".jetro", "requirements.txt")))) {
      const deps = [
        "requests>=2.31.0",
        "beautifulsoup4>=4.12.0",
        "lxml>=5.0.0",
        "playwright>=1.40.0",
        "# Parse dependencies",
        "pymupdf>=1.24.0",
        "pymupdf4llm>=0.0.12",
        "markitdown[docx,pptx,xlsx]>=0.1.0",
        "rapidocr-onnxruntime>=1.3.0",
      ].join("\n");
      await this.writeText(this.uri(".jetro", "requirements.txt"), deps);
    }

    // Create venv if python3 binary doesn't exist
    if (!(await this.exists(this.uri(".jetro", "venv", "bin", "python3")))) {
      log("Creating Python virtual environment...");
      await this.execShell(`python3 -m venv "${venvPath}"`, rootPath);
      log("Installing scraping dependencies...");
      await this.execShell(`"${venvPath}/bin/pip" install -r "${requirementsPath}"`, rootPath);
      log("Installing Playwright Chromium...");
      await this.execShell(`"${venvPath}/bin/python3" -m playwright install chromium`, rootPath);
      log("Done.");
    } else {
      log("Venv already exists.");
    }

    return venvPath;
  }

  /** Ensure parse dependencies are installed in the managed venv. Lazy — only installs on first need. */
  async ensureParseDeps(output?: vscode.OutputChannel): Promise<string> {
    const rootPath = this.root.fsPath;
    const venvPython = `${rootPath}/.jetro/venv/bin/python3`;

    if (!(await this.exists(this.uri(".jetro", "venv", "bin", "python3")))) {
      return this.setupVenv(output);
    }

    // Check if pymupdf already installed
    try {
      await this.execShell(`"${venvPython}" -c "import pymupdf"`, rootPath);
      return `${rootPath}/.jetro/venv`;
    } catch {
      output?.appendLine("[venv] Installing parse dependencies...");
      await this.execShell(
        `"${rootPath}/.jetro/venv/bin/pip" install pymupdf pymupdf4llm "markitdown[docx,pptx,xlsx]" rapidocr-onnxruntime`,
        rootPath
      );
      output?.appendLine("[venv] Parse dependencies installed.");
      return `${rootPath}/.jetro/venv`;
    }
  }

  private execShell(cmd: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { cwd, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd}\n${stderr || err.message}`));
        else resolve(stdout);
      });
    });
  }

  // ── Stock data I/O ──

  async writeStockData(
    ticker: string,
    type: StockDataType,
    data: unknown
  ): Promise<void> {
    const dir = this.uri("data", "stocks", ticker);
    await this.ensureDir(dir);
    await this.writeJson(this.uri("data", "stocks", ticker, `${type}.json`), data);
  }

  async readStockData<T = unknown>(
    ticker: string,
    type: StockDataType
  ): Promise<T | null> {
    return this.readJson<T>(
      this.uri("data", "stocks", ticker, `${type}.json`)
    );
  }

  async readStockAll(ticker: string): Promise<{
    profile: StockProfile | null;
    ratios: StockRatios | null;
    financials: unknown;
    score: StockScore | null;
  }> {
    const [profile, ratios, financials, score] = await Promise.all([
      this.readStockData<StockProfile>(ticker, "profile"),
      this.readStockData<StockRatios>(ticker, "ratios"),
      this.readStockData(ticker, "financials"),
      this.readStockData<StockScore>(ticker, "score"),
    ]);
    return { profile, ratios, financials, score };
  }

  async listStocks(): Promise<string[]> {
    return this.listDirs(this.uri("data", "stocks"));
  }

  // ── List I/O ──

  async writeList(name: string, data: JETList): Promise<string> {
    const slug = this.slugify(name);
    await this.ensureDir(this.uri("data", "lists"));
    await this.writeJson(this.uri("data", "lists", `${slug}.json`), data);
    return slug;
  }

  async readList(slug: string): Promise<JETList | null> {
    return this.readJson<JETList>(this.uri("data", "lists", `${slug}.json`));
  }

  async listLists(): Promise<string[]> {
    const files = await this.listFiles(this.uri("data", "lists"), ".json");
    return files.map((f) => f.replace(".json", ""));
  }

  async deleteList(slug: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(
        this.uri("data", "lists", `${slug}.json`)
      );
    } catch {
      // not found
    }
  }

  // ── Project I/O ──

  async writeProject(name: string, data: JETProject): Promise<string> {
    const slug = this.slugify(name);
    const dir = this.uri("projects", slug);
    await this.ensureDir(dir);
    await this.ensureDir(this.uri("projects", slug, "notes"));
    await this.ensureDir(this.uri("projects", slug, "sources"));
    await this.writeJson(this.uri("projects", slug, "project.json"), data);
    return slug;
  }

  async readProject(slug: string): Promise<JETProject | null> {
    const raw = await this.readJson<Record<string, unknown>>(
      this.uri("projects", slug, "project.json")
    );
    if (!raw) return null;
    // Normalize: MCP agent may use 'title' instead of 'name', 'stocks' instead of 'securities'
    return {
      name: (raw.name as string) || (raw.title as string) || slug,
      slug: (raw.slug as string) || slug,
      status: (raw.status as JETProject["status"]) || "active",
      mode: (raw.mode as "portfolio" | undefined),
      securities: (raw.securities as string[]) || (raw.stocks as string[]) || (raw.ticker ? [raw.ticker as string] : []),
      sources: (raw.sources as string[]) || [],
      linkedConnections: (raw.linkedConnections as string[]) || [],
      linkedConnectors: (raw.linkedConnectors as string[]) || [],
      linkedTemplates: (raw.linkedTemplates as string[]) || [],
      linkedRecipes: (raw.linkedRecipes as string[]) || [],
      deployment: raw.deployment as JETProject["deployment"],
      createdAt: (raw.createdAt as string) || new Date().toISOString(),
      updatedAt: (raw.updatedAt as string) || new Date().toISOString(),
    };
  }

  async updateProjectDeployment(slug: string, update: Partial<import("../types").ProjectDeployment>): Promise<void> {
    const uri = this.uri("projects", slug, "project.json");
    const raw = await this.readJson<Record<string, unknown>>(uri);
    if (!raw) return;
    const existing = (raw.deployment || {}) as Record<string, unknown>;
    raw.deployment = { ...existing, ...update };
    raw.updatedAt = new Date().toISOString();
    await this.writeJson(uri, raw);
  }

  async deleteProject(slug: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri("projects", slug), { recursive: true });
    } catch { /* ignore if not found */ }
  }

  async listProjects(): Promise<string[]> {
    return this.listDirs(this.uri("projects"));
  }

  async writeCanvas(
    projectSlug: string,
    canvasState: CanvasState
  ): Promise<void> {
    await this.writeJson(
      this.uri("projects", projectSlug, "canvas.json"),
      canvasState
    );
  }

  async readCanvas(projectSlug: string): Promise<CanvasState | null> {
    return this.readJson<CanvasState>(
      this.uri("projects", projectSlug, "canvas.json")
    );
  }

  /** @deprecated Use readCanvasById / writeCanvasById instead. */
  async writeUniversalCanvas(canvasState: CanvasState): Promise<void> {
    await this.writeJson(this.uri(".jetro", "canvas.json"), canvasState);
  }

  /** @deprecated Use readCanvasById / writeCanvasById instead. */
  async readUniversalCanvas(): Promise<CanvasState | null> {
    return this.readJson<CanvasState>(this.uri(".jetro", "canvas.json"));
  }

  // ── Multi-canvas registry ──

  async readCanvasRegistry(): Promise<CanvasRegistryEntry[]> {
    return (
      (await this.readJson<CanvasRegistryEntry[]>(
        this.uri(".jetro", "canvas-registry.json")
      )) ?? []
    );
  }

  async writeCanvasRegistry(entries: CanvasRegistryEntry[]): Promise<void> {
    await this.writeJson(
      this.uri(".jetro", "canvas-registry.json"),
      entries
    );
  }

  private canvasPath(id: string, projectSlug: string | null): vscode.Uri {
    if (projectSlug) {
      return this.uri("projects", projectSlug, "canvases", `${id}.json`);
    }
    return this.uri(".jetro", "canvases", `${id}.json`);
  }

  async readCanvasById(
    id: string,
    projectSlug: string | null
  ): Promise<CanvasState | null> {
    return this.readJson<CanvasState>(this.canvasPath(id, projectSlug));
  }

  async writeCanvasById(
    id: string,
    canvasState: CanvasState,
    projectSlug: string | null
  ): Promise<void> {
    // Ensure parent dir exists
    if (projectSlug) {
      await this.ensureDir(this.uri("projects", projectSlug, "canvases"));
    } else {
      await this.ensureDir(this.uri(".jetro", "canvases"));
    }

    // Snapshot previous state for versioning before overwriting
    const existing = await this.readCanvasById(id, projectSlug);
    if (existing && existing.elements && existing.elements.length > 0) {
      // Force snapshot if element count is decreasing (deletion = dangerous)
      const force = canvasState.elements.length < existing.elements.length;
      this.snapshotCanvas(id, existing, projectSlug, force).catch(() => {});
    }

    await this.writeJson(this.canvasPath(id, projectSlug), canvasState);
  }

  // ── Canvas versioning ──

  private canvasHistoryDir(canvasId: string, projectSlug: string | null): vscode.Uri {
    if (projectSlug) {
      return this.uri("projects", projectSlug, "canvases", `${canvasId}.history`);
    }
    return this.uri(".jetro", "canvases", `${canvasId}.history`);
  }

  /**
   * Save a versioned snapshot of the canvas state.
   * Respects 60s throttle unless force=true.
   */
  async snapshotCanvas(
    canvasId: string,
    state: CanvasState,
    projectSlug: string | null,
    force?: boolean
  ): Promise<void> {
    // Skip empty canvases
    if (!state.elements || state.elements.length === 0) return;

    const dir = this.canvasHistoryDir(canvasId, projectSlug);
    await this.ensureDir(dir);

    // Throttle check
    if (!force) {
      const files = await this.listHistoryFiles(dir);
      if (files.length > 0) {
        const lastTs = this.extractHistoryTimestamp(files[files.length - 1]);
        if (Date.now() - lastTs < 60_000) return;
      }
    }

    // Write snapshot
    const versionFile = vscode.Uri.joinPath(dir, `v_${Date.now()}.json`);
    await this.writeJson(versionFile, state);

    // Async prune
    this.pruneCanvasHistory(dir).catch(() => {});
  }

  /** List all available versions for a canvas, newest first. */
  async listCanvasVersions(
    canvasId: string,
    projectSlug: string | null
  ): Promise<Array<{ timestamp: number; uri: vscode.Uri }>> {
    const dir = this.canvasHistoryDir(canvasId, projectSlug);
    const files = await this.listHistoryFiles(dir);
    return files
      .map((f) => ({
        timestamp: this.extractHistoryTimestamp(f),
        uri: vscode.Uri.joinPath(dir, f),
      }))
      .reverse(); // newest first
  }

  /** Restore a specific version by timestamp. Snapshots current state first (reversible). */
  async restoreCanvasVersion(
    canvasId: string,
    projectSlug: string | null,
    timestamp: number
  ): Promise<CanvasState | null> {
    const dir = this.canvasHistoryDir(canvasId, projectSlug);
    const versionFile = vscode.Uri.joinPath(dir, `v_${timestamp}.json`);
    try {
      const data = await vscode.workspace.fs.readFile(versionFile);
      const state = JSON.parse(new TextDecoder().decode(data)) as CanvasState;

      // Snapshot current state before overwriting (makes restore reversible)
      const currentState = await this.readCanvasById(canvasId, projectSlug);
      if (currentState && currentState.elements && currentState.elements.length > 0) {
        await this.snapshotCanvas(canvasId, currentState, projectSlug, true);
      }

      // Write restored version as current
      await this.writeJson(this.canvasPath(canvasId, projectSlug), state);
      return state;
    } catch {
      return null;
    }
  }

  /** Read a version file directly (for preview). */
  async readCanvasVersion(
    canvasId: string,
    projectSlug: string | null,
    timestamp: number
  ): Promise<CanvasState | null> {
    const dir = this.canvasHistoryDir(canvasId, projectSlug);
    const versionFile = vscode.Uri.joinPath(dir, `v_${timestamp}.json`);
    return this.readJson<CanvasState>(versionFile);
  }

  private async listHistoryFiles(dir: vscode.Uri): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      return entries
        .filter(([name, type]) => type === vscode.FileType.File && name.startsWith("v_") && name.endsWith(".json"))
        .map(([name]) => name)
        .sort();
    } catch {
      return [];
    }
  }

  private extractHistoryTimestamp(filename: string): number {
    const match = filename.match(/v_(\d+)\.json/);
    return match ? parseInt(match[1], 10) : 0;
  }

  private async pruneCanvasHistory(dir: vscode.Uri): Promise<void> {
    const files = await this.listHistoryFiles(dir);
    if (files.length === 0) return;

    const now = Date.now();
    const HOUR = 3_600_000;
    const DAY = 86_400_000;

    const toDelete: string[] = [];
    const buckets = new Map<string, string[]>();

    for (const file of files) {
      const ts = this.extractHistoryTimestamp(file);
      const age = now - ts;

      if (age > 30 * DAY) {
        toDelete.push(file);
      } else if (age > 7 * DAY) {
        const bucket = `day_${Math.floor(ts / DAY)}`;
        if (!buckets.has(bucket)) buckets.set(bucket, []);
        buckets.get(bucket)!.push(file);
      } else if (age > DAY) {
        const bucket = `hour_${Math.floor(ts / HOUR)}`;
        if (!buckets.has(bucket)) buckets.set(bucket, []);
        buckets.get(bucket)!.push(file);
      } else if (age > HOUR) {
        const bucket = `10min_${Math.floor(ts / (10 * 60_000))}`;
        if (!buckets.has(bucket)) buckets.set(bucket, []);
        buckets.get(bucket)!.push(file);
      }
      // <1 hour: keep all
    }

    // Within each bucket, keep newest, mark rest for deletion
    for (const [, bucketFiles] of buckets) {
      if (bucketFiles.length > 1) {
        bucketFiles.sort();
        toDelete.push(...bucketFiles.slice(0, -1));
      }
    }

    for (const file of toDelete) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, file));
      } catch { /* ignore */ }
    }
  }

  async deleteCanvasById(
    id: string,
    projectSlug: string | null
  ): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.canvasPath(id, projectSlug));
    } catch {
      // not found
    }
  }

  /**
   * One-time migration: convert old single canvas.json files to new
   * multi-canvas registry format. Safe to call multiple times.
   */
  async migrateOldCanvasFormat(): Promise<void> {
    const existing = await this.readCanvasRegistry();
    if (existing.length > 0) {
      return; // already migrated
    }

    const entries: CanvasRegistryEntry[] = [];
    const now = new Date().toISOString();

    // Migrate universal canvas
    const universalState = await this.readUniversalCanvas();
    if (universalState) {
      const id = "research_board";
      entries.push({
        id,
        name: universalState.name || "Research Board",
        projectSlug: null,
        createdAt: now,
      });
      await this.writeCanvasById(id, universalState, null);
      // Delete old file
      try {
        await vscode.workspace.fs.delete(
          this.uri(".jetro", "canvas.json")
        );
      } catch {
        // ignore
      }
    }

    // Migrate project canvases
    const projectSlugs = await this.listProjects();
    for (const slug of projectSlugs) {
      const projectCanvas = await this.readCanvas(slug);
      if (projectCanvas) {
        const id = `${slug}_canvas`;
        entries.push({
          id,
          name: projectCanvas.name || this.prettifySlug(slug),
          projectSlug: slug,
          createdAt: now,
        });
        await this.writeCanvasById(id, projectCanvas, slug);
        // Delete old file
        try {
          await vscode.workspace.fs.delete(
            this.uri("projects", slug, "canvas.json")
          );
        } catch {
          // ignore
        }
      }
    }

    if (entries.length > 0) {
      await this.writeCanvasRegistry(entries);
    }
  }

  private prettifySlug(slug: string): string {
    return slug
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  async writeThesis(projectSlug: string, markdown: string): Promise<void> {
    await this.writeText(
      this.uri("projects", projectSlug, "thesis.md"),
      markdown
    );
  }

  async readThesis(projectSlug: string): Promise<string | null> {
    try {
      const data = await vscode.workspace.fs.readFile(
        this.uri("projects", projectSlug, "thesis.md")
      );
      return new TextDecoder().decode(data);
    } catch {
      return null;
    }
  }

  // ── Project Sources & Notes I/O ──

  async addProjectSource(
    projectSlug: string,
    fileName: string,
    content: Uint8Array
  ): Promise<string> {
    const dir = this.uri("projects", projectSlug, "sources");
    await this.ensureDir(dir);
    const targetUri = this.uri("projects", projectSlug, "sources", fileName);
    await vscode.workspace.fs.writeFile(targetUri, content);
    return `projects/${projectSlug}/sources/${fileName}`;
  }

  async listProjectSources(projectSlug: string): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(
        this.uri("projects", projectSlug, "sources")
      );
      return entries
        .filter(([, type]) => type === vscode.FileType.File)
        .map(([name]) => name);
    } catch {
      return [];
    }
  }

  async listUniversalSources(): Promise<string[]> {
    return this.listFiles(this.uri(".jetro", "sources"));
  }

  async writeProjectNote(
    projectSlug: string,
    name: string,
    markdown: string
  ): Promise<string> {
    const dir = this.uri("projects", projectSlug, "notes");
    await this.ensureDir(dir);
    const fileName = name.endsWith(".md") ? name : `${name}.md`;
    await this.writeText(
      this.uri("projects", projectSlug, "notes", fileName),
      markdown
    );
    return `projects/${projectSlug}/notes/${fileName}`;
  }

  async readProjectNote(
    projectSlug: string,
    name: string
  ): Promise<string | null> {
    const fileName = name.endsWith(".md") ? name : `${name}.md`;
    try {
      const data = await vscode.workspace.fs.readFile(
        this.uri("projects", projectSlug, "notes", fileName)
      );
      return new TextDecoder().decode(data);
    } catch {
      return null;
    }
  }

  async listProjectNotes(projectSlug: string): Promise<string[]> {
    return this.listFiles(this.uri("projects", projectSlug, "notes"), ".md");
  }

  async listProjectFiles(
    projectSlug: string
  ): Promise<{ sources: string[]; notes: string[] }> {
    const [sources, notes] = await Promise.all([
      this.listProjectSources(projectSlug),
      this.listProjectNotes(projectSlug),
    ]);
    return { sources, notes };
  }

  /** List ALL files across all project subdirectories (sources, notes, output, etc.) and root. */
  async listAllProjectFiles(
    projectSlug: string
  ): Promise<{ path: string; dir: string; name: string }[]> {
    const subdirs = ["sources", "notes", "output"];
    const results: { path: string; dir: string; name: string }[] = [];
    for (const dir of subdirs) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(
          this.uri("projects", projectSlug, dir)
        );
        for (const [name, type] of entries) {
          if (type === vscode.FileType.File) {
            results.push({ path: `${dir}/${name}`, dir, name });
          }
        }
      } catch { /* dir may not exist */ }
    }
    // Also scan root-level files (agent scripts, configs, etc.)
    try {
      const rootEntries = await vscode.workspace.fs.readDirectory(
        this.uri("projects", projectSlug)
      );
      for (const [name, type] of rootEntries) {
        if (type === vscode.FileType.File && name !== "project.json") {
          results.push({ path: name, dir: ".", name });
        }
      }
    } catch { /* ignore */ }
    return results;
  }

  /** Write a note to universal .jetro/notes/ (no project). */
  async writeUniversalNote(name: string, markdown: string): Promise<string> {
    const dir = this.uri(".jetro", "notes");
    await this.ensureDir(dir);
    const fileName = name.endsWith(".md") ? name : `${name}.md`;
    await this.writeText(this.uri(".jetro", "notes", fileName), markdown);
    return `.jetro/notes/${fileName}`;
  }

  /** Copy a source file to universal .jetro/sources/ (no project). */
  async addUniversalSource(
    fileName: string,
    content: Uint8Array
  ): Promise<string> {
    const dir = this.uri(".jetro", "sources");
    await this.ensureDir(dir);
    await vscode.workspace.fs.writeFile(
      this.uri(".jetro", "sources", fileName),
      content
    );
    return `.jetro/sources/${fileName}`;
  }

  // ── Custom element definitions ──

  async writeElementDef(name: string, def: CustomElementDef): Promise<string> {
    const slug = this.slugify(name);
    def.slug = slug;
    await this.ensureDir(this.uri(".jetro", "elements"));
    await this.writeJson(
      this.uri(".jetro", "elements", `${slug}.json`),
      def
    );
    return slug;
  }

  async readElementDef(slug: string): Promise<CustomElementDef | null> {
    return this.readJson<CustomElementDef>(
      this.uri(".jetro", "elements", `${slug}.json`)
    );
  }

  async listElementDefs(): Promise<string[]> {
    const files = await this.listFiles(
      this.uri(".jetro", "elements"),
      ".json"
    );
    return files.map((f) => f.replace(".json", ""));
  }

  async deleteAllElementDefs(): Promise<void> {
    const elemDir = this.uri(".jetro", "elements");
    try {
      await vscode.workspace.fs.delete(elemDir, { recursive: true });
      await this.ensureDir(elemDir);
    } catch {
      // not found
    }
  }

  // ── Recipe I/O ──

  async writeRecipe(name: string, data: Recipe): Promise<string> {
    const slug = this.slugify(name);
    data.slug = slug;
    await this.ensureDir(this.uri(".jetro", "recipes"));
    await this.writeJson(this.uri(".jetro", "recipes", `${slug}.json`), data);
    await this.updateSkillsManifest();
    return slug;
  }

  async readRecipe(slug: string): Promise<Recipe | null> {
    return this.readJson<Recipe>(this.uri(".jetro", "recipes", `${slug}.json`));
  }

  async listRecipes(): Promise<string[]> {
    const files = await this.listFiles(this.uri(".jetro", "recipes"), ".json");
    return files.map((f) => f.replace(".json", ""));
  }

  async deleteRecipe(slug: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(".jetro", "recipes", `${slug}.json`));
    } catch {
      // not found
    }
    await this.updateSkillsManifest();
  }

  // ── Data Source I/O ──

  async writeDataSource(name: string, data: DataSourceConnector): Promise<string> {
    const slug = this.slugify(name);
    data.slug = slug;
    await this.ensureDir(this.uri(".jetro", "datasources"));
    await this.writeJson(this.uri(".jetro", "datasources", `${slug}.json`), data);
    await this.updateSkillsManifest();
    return slug;
  }

  async readDataSource(slug: string): Promise<DataSourceConnector | null> {
    return this.readJson<DataSourceConnector>(this.uri(".jetro", "datasources", `${slug}.json`));
  }

  async listDataSources(): Promise<string[]> {
    const files = await this.listFiles(this.uri(".jetro", "datasources"), ".json");
    return files.map((f) => f.replace(".json", ""));
  }

  async deleteDataSource(slug: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(".jetro", "datasources", `${slug}.json`));
    } catch {
      // not found
    }
    await this.updateSkillsManifest();
  }

  // ── Connector I/O (agent-built, directory-based) ──

  async writeConnector(
    slug: string,
    config: Connector,
    clientPy?: string,
    requirements?: string
  ): Promise<string> {
    const dir = this.uri(".jetro", "connectors", slug);
    await this.ensureDir(dir);
    await this.writeJson(
      this.uri(".jetro", "connectors", slug, "connector.json"),
      config
    );
    if (clientPy !== undefined) {
      await this.writeText(
        this.uri(".jetro", "connectors", slug, "client.py"),
        clientPy
      );
    }
    if (requirements !== undefined) {
      await this.writeText(
        this.uri(".jetro", "connectors", slug, "requirements.txt"),
        requirements
      );
    }
    return slug;
  }

  async readConnector(slug: string): Promise<Connector | null> {
    return this.readJson<Connector>(
      this.uri(".jetro", "connectors", slug, "connector.json")
    );
  }

  async readConnectorClient(slug: string): Promise<string | null> {
    try {
      const data = await vscode.workspace.fs.readFile(
        this.uri(".jetro", "connectors", slug, "client.py")
      );
      return new TextDecoder().decode(data);
    } catch {
      return null;
    }
  }

  async listConnectors(): Promise<string[]> {
    return this.listDirs(this.uri(".jetro", "connectors"));
  }

  async deleteConnector(slug: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(
        this.uri(".jetro", "connectors", slug),
        { recursive: true }
      );
    } catch {
      // not found
    }
  }

  // ── Portfolio I/O ──

  /**
   * Write a portfolio with merge semantics.
   * If the portfolio already exists, provided fields overwrite, missing fields are preserved.
   * If new, defaults are applied for any missing fields.
   */
  /**
   * Write a portfolio with merge semantics.
   * Portfolio data now lives inside the project directory: projects/{slug}/portfolio.json
   * Auto-creates project.json with mode: "portfolio" if missing.
   */
  async writePortfolio(name: string, data: Partial<Portfolio>): Promise<string> {
    const slug = this.slugify(name);

    // Ensure project directory and project.json exist with mode: "portfolio"
    const dir = this.uri("projects", slug);
    await this.ensureDir(dir);
    await this.ensureDir(this.uri("projects", slug, "notes"));
    await this.ensureDir(this.uri("projects", slug, "sources"));

    const existingProject = await this.readProject(slug);
    if (!existingProject) {
      const project: JETProject = {
        name, slug, status: "active", mode: "portfolio",
        securities: (data.holdings || []).map(h => h.ticker),
        sources: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.writeJson(this.uri("projects", slug, "project.json"), project);
    } else if (!existingProject.mode) {
      existingProject.mode = "portfolio";
      existingProject.updatedAt = new Date().toISOString();
      await this.writeJson(this.uri("projects", slug, "project.json"), existingProject);
    }

    // Merge portfolio data
    const existing = await this.readPortfolio(slug);
    let merged: Portfolio;
    if (existing) {
      merged = {
        ...existing,
        ...data,
        slug,
        updatedAt: new Date().toISOString(),
      };
      if (data.holdings) {
        merged.holdings = data.holdings;
      }
    } else {
      const capital = data.initialCapital || 0;
      merged = {
        name, slug,
        holdings: data.holdings || [],
        initialCapital: capital,
        cash: data.cash || 0,
        currency: data.currency || "INR",
        benchmark: data.benchmark ?? null,
        rebalance: data.rebalance || "none",
        rebalanceTargets: data.rebalanceTargets || [],
        inceptionDate: data.inceptionDate || new Date().toISOString().split("T")[0],
        units: data.units || (capital > 0 ? capital / 100 : 0),
        currentNAV: data.currentNAV,
        navPerUnit: data.navPerUnit,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    await this.writeJson(this.uri("projects", slug, "portfolio.json"), merged);
    return slug;
  }

  async readPortfolio(slug: string): Promise<Portfolio | null> {
    return this.readJson<Portfolio>(this.uri("projects", slug, "portfolio.json"));
  }

  async listPortfolioProjects(): Promise<string[]> {
    const allProjects = await this.listProjects();
    const results: string[] = [];
    for (const slug of allProjects) {
      const project = await this.readProject(slug);
      if (project?.mode === "portfolio") results.push(slug);
    }
    return results;
  }

  async deletePortfolioData(slug: string): Promise<void> {
    for (const file of ["portfolio.json", "nav_history.json", "transactions.json", "mutations.json"]) {
      try { await vscode.workspace.fs.delete(this.uri("projects", slug, file)); } catch { /* not found */ }
    }
  }

  async writeNAVHistory(slug: string, data: NAVPoint[]): Promise<void> {
    await this.writeJson(this.uri("projects", slug, "nav_history.json"), data);
  }

  async readNAVHistory(slug: string): Promise<NAVPoint[] | null> {
    return this.readJson<NAVPoint[]>(this.uri("projects", slug, "nav_history.json"));
  }

  async writeTransactions(slug: string, data: PortfolioTransaction[]): Promise<void> {
    await this.writeJson(this.uri("projects", slug, "transactions.json"), data);
  }

  async readTransactions(slug: string): Promise<PortfolioTransaction[] | null> {
    return this.readJson<PortfolioTransaction[]>(this.uri("projects", slug, "transactions.json"));
  }

  // ── Portfolio Mutation Log ──

  async appendMutation(slug: string, entry: PortfolioMutationLog): Promise<void> {
    const existing = await this.readMutations(slug);
    existing.push(entry);
    await this.writeJson(this.uri("projects", slug, "mutations.json"), existing);
  }

  async readMutations(slug: string): Promise<PortfolioMutationLog[]> {
    return (await this.readJson<PortfolioMutationLog[]>(
      this.uri("projects", slug, "mutations.json")
    )) ?? [];
  }

  // ── Portfolio Migration (one-time: data/portfolios/ → projects/) ──

  async migratePortfoliosToProjects(): Promise<number> {
    let migrated = 0;
    let oldSlugs: string[] = [];
    try {
      oldSlugs = await this.listDirs(this.uri("data", "portfolios"));
    } catch { return 0; }

    for (const slug of oldSlugs) {
      const oldPortfolio = await this.readJson<Portfolio>(
        this.uri("data", "portfolios", slug, "portfolio.json")
      );
      if (!oldPortfolio) continue;

      // Create project dir
      await this.ensureDir(this.uri("projects", slug));
      await this.ensureDir(this.uri("projects", slug, "notes"));
      await this.ensureDir(this.uri("projects", slug, "sources"));

      // Create/upgrade project.json
      const existingProject = await this.readProject(slug);
      const project: JETProject = existingProject
        ? { ...existingProject, mode: "portfolio", updatedAt: new Date().toISOString() }
        : {
            name: oldPortfolio.name, slug, status: "active", mode: "portfolio",
            securities: oldPortfolio.holdings.map(h => h.ticker),
            sources: [],
            createdAt: oldPortfolio.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
      await this.writeJson(this.uri("projects", slug, "project.json"), project);

      // Copy portfolio files
      for (const file of ["portfolio.json", "nav_history.json", "transactions.json", "mutations.json"]) {
        try {
          const data = await vscode.workspace.fs.readFile(this.uri("data", "portfolios", slug, file));
          await vscode.workspace.fs.writeFile(this.uri("projects", slug, file), data);
        } catch { /* file may not exist */ }
      }

      // Remove old directory
      try {
        await vscode.workspace.fs.delete(this.uri("data", "portfolios", slug), { recursive: true });
      } catch { /* ignore */ }

      migrated++;
    }

    // Clean up empty data/portfolios/ directory
    if (migrated > 0) {
      try {
        const remaining = await this.listDirs(this.uri("data", "portfolios"));
        if (remaining.length === 0) {
          await vscode.workspace.fs.delete(this.uri("data", "portfolios"), { recursive: true });
        }
      } catch { /* ignore */ }
    }

    return migrated;
  }

  // ── Report Template I/O ──

  async writeTemplate(name: string, html: string): Promise<string> {
    const slug = this.slugify(name);
    await this.ensureDir(this.uri(".jetro", "templates"));
    await this.writeText(this.uri(".jetro", "templates", `${slug}.html`), html);
    return slug;
  }

  async readTemplate(slug: string): Promise<string | null> {
    try {
      const data = await vscode.workspace.fs.readFile(
        this.uri(".jetro", "templates", `${slug}.html`)
      );
      return new TextDecoder().decode(data);
    } catch {
      return null;
    }
  }

  async listTemplates(): Promise<string[]> {
    const files = await this.listFiles(this.uri(".jetro", "templates"), ".html");
    return files.map((f) => f.replace(".html", ""));
  }

  async deleteTemplate(slug: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(".jetro", "templates", `${slug}.html`));
    } catch {
      // not found
    }
  }

  // ── Frame Files (scratchpad) ──

  /**
   * Read an HTML file for frame rendering.
   * Accepts paths relative to workspace root (e.g. ".jetro/frames/dashboard.html")
   * or absolute paths within the workspace.
   */
  async readFrameFile(filePath: string): Promise<string | null> {
    try {
      // Resolve relative to workspace root
      const targetUri = filePath.startsWith("/")
        ? vscode.Uri.file(filePath)
        : this.uri(filePath);

      // Security: ensure the resolved path is within the workspace
      const resolved = targetUri.fsPath;
      const rootPath = this.root.fsPath;
      if (!resolved.startsWith(rootPath)) {
        throw new Error(`Path traversal blocked: ${filePath} escapes workspace`);
      }

      const data = await vscode.workspace.fs.readFile(targetUri);
      return new TextDecoder().decode(data);
    } catch (err) {
      if (err instanceof Error && err.message.includes("traversal")) {
        throw err; // re-throw security errors
      }
      return null;
    }
  }

  /**
   * Write an HTML file to .jetro/frames/, auto-creating the directory.
   * Returns the workspace-relative path (e.g. ".jetro/frames/dashboard.html").
   */
  async writeFrameFile(name: string, html: string): Promise<string> {
    const framesDir = this.uri(".jetro", "frames");
    await vscode.workspace.fs.createDirectory(framesDir);
    const safeName = name.replace(/[^a-z0-9_-]/gi, "_").substring(0, 80);
    const fileName = safeName.endsWith(".html") ? safeName : `${safeName}.html`;
    const fileUri = vscode.Uri.joinPath(framesDir, fileName);
    await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(html));
    return `.jetro/frames/${fileName}`;
  }

  /**
   * Write a note as a .md file. If projectSlug is provided, saves to
   * projects/{slug}/notes/; otherwise to .jetro/notes/.
   * Returns the workspace-relative path.
   */
  async writeNoteFile(title: string, markdown: string, projectSlug?: string): Promise<string> {
    const safeName = title.replace(/[^a-z0-9_-]/gi, "_").substring(0, 80);
    const fileName = `${safeName}.md`;
    let notesDir: vscode.Uri;
    let relativePath: string;
    if (projectSlug) {
      notesDir = this.uri("projects", projectSlug, "notes");
      relativePath = `projects/${projectSlug}/notes/${fileName}`;
    } else {
      notesDir = this.uri(".jetro", "notes");
      relativePath = `.jetro/notes/${fileName}`;
    }
    await vscode.workspace.fs.createDirectory(notesDir);
    const fileUri = vscode.Uri.joinPath(notesDir, fileName);
    await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(markdown));
    return relativePath;
  }

  /** List HTML files in the frames scratchpad. */
  async listFrames(): Promise<string[]> {
    const files = await this.listFiles(this.uri(".jetro", "frames"), ".html");
    return files.map((f) => f.replace(".html", ""));
  }

  // ── Config + Manifests ──

  async readConfig(): Promise<Record<string, unknown> | null> {
    return this.readJson(this.uri(".jetro", "config.yaml"));
  }

  async writeConfig(data: Record<string, unknown>): Promise<void> {
    // Write as JSON for simplicity — config.yaml name kept for convention
    await this.writeJson(this.uri(".jetro", "config.yaml"), data);
  }

  async writeManifest(name: string, content: string): Promise<void> {
    await this.writeText(this.uri(".jetro", name), content);
  }

  /** Write a file to the workspace root (not inside .jetro/). */
  async writeToRoot(name: string, content: string): Promise<void> {
    await this.writeText(this.uri(name), content);
  }

  /** Write a file at an arbitrary path relative to workspace root, creating parent dirs. */
  async writeToPath(segments: string[], content: string): Promise<void> {
    if (segments.length > 1) {
      const parentSegments = segments.slice(0, -1);
      await this.ensureDir(this.uri(...parentSegments));
    }
    await this.writeText(this.uri(...segments), content);
  }

  async updateSkillsManifest(): Promise<void> {
    // Read existing skills.md and preserve the remote skills section
    let existing = "";
    try {
      const data = await vscode.workspace.fs.readFile(this.uri(".jetro", "skills.md"));
      existing = new TextDecoder().decode(data);
    } catch {
      // file doesn't exist yet
    }

    // Preserve everything before "## My Recipes" or "## My Data Sources"
    let baseContent = existing;
    const recipesIdx = existing.indexOf("## My Recipes");
    const dsIdx = existing.indexOf("## My Data Sources");
    const cutIdx = Math.min(
      recipesIdx >= 0 ? recipesIdx : Infinity,
      dsIdx >= 0 ? dsIdx : Infinity,
    );
    if (cutIdx !== Infinity) {
      baseContent = existing.substring(0, cutIdx).trimEnd();
    }

    // Build "## My Recipes" section
    const recipeSlugs = await this.listRecipes();
    let recipesSection = "";
    if (recipeSlugs.length > 0) {
      recipesSection = "\n\n## My Recipes\n";
      for (const slug of recipeSlugs) {
        const recipe = await this.readRecipe(slug);
        if (recipe) {
          const inputSummary = recipe.inputs
            .map((i) => `${i.name} (${i.type}${i.required ? ", required" : ""}${i.default !== undefined ? `, default: ${i.default}` : ""})`)
            .join(", ");
          recipesSection += `- **${recipe.name}** — ${recipe.description}\n`;
          if (inputSummary) {
            recipesSection += `  - Inputs: ${inputSummary}\n`;
          }
          if (recipe.outputHint) {
            recipesSection += `  - Output: ${recipe.outputHint}\n`;
          }
          recipesSection += `  - File: .jetro/recipes/${slug}.json\n`;
        }
      }
    }

    // Build "## My Data Sources" section
    const dsSlugs = await this.listDataSources();
    let dsSection = "";
    if (dsSlugs.length > 0) {
      dsSection = "\n\n## My Data Sources\n";
      for (const slug of dsSlugs) {
        const ds = await this.readDataSource(slug);
        if (ds) {
          const endpointNames = ds.endpoints.map((e) => e.name).join(", ");
          dsSection += `- **${ds.name}** — ${ds.baseUrl}\n`;
          dsSection += `  - Auth: ${ds.auth.type}\n`;
          if (endpointNames) {
            dsSection += `  - Endpoints: ${endpointNames}\n`;
          }
          dsSection += `  - File: .jetro/datasources/${slug}.json\n`;
        }
      }
    }

    const finalContent = baseContent + recipesSection + dsSection;
    await this.writeText(this.uri(".jetro", "skills.md"), finalContent.trimEnd() + "\n");
  }

  // ── Finance Toggle ──

  async isFinanceEnabled(): Promise<boolean> {
    const config = await this.readConfig();
    if (!config) return true; // default: finance on
    // Migration: old config had mode: "finance" | "general"
    if (config.mode !== undefined) {
      return config.mode !== "general";
    }
    return config.financeEnabled !== false;
  }

  async setFinanceEnabled(enabled: boolean): Promise<void> {
    const config = (await this.readConfig()) || {};
    config.financeEnabled = enabled;
    delete config.mode; // migrate away from old key
    await this.writeConfig(config);
  }

  // ── Dataset I/O ──

  async writeDataset(name: string, data: DatasetMetadata): Promise<string> {
    const slug = this.slugify(name);
    data.slug = slug;
    const dir = this.uri("data", "datasets", slug);
    await this.ensureDir(dir);
    await this.writeJson(this.uri("data", "datasets", slug, "metadata.json"), data);
    return slug;
  }

  async readDataset(slug: string): Promise<DatasetMetadata | null> {
    return this.readJson<DatasetMetadata>(
      this.uri("data", "datasets", slug, "metadata.json")
    );
  }

  async listDatasets(): Promise<string[]> {
    return this.listDirs(this.uri("data", "datasets"));
  }

  async deleteDataset(slug: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri("data", "datasets", slug), { recursive: true });
    } catch {
      // not found
    }
  }

  async getDatasetFilePath(slug: string, fileName: string): Promise<vscode.Uri> {
    return this.uri("data", "datasets", slug, fileName);
  }

  // ── Database Connection I/O ──

  async writeConnection(name: string, data: DatabaseConnection): Promise<string> {
    const slug = this.slugify(name);
    data.slug = slug;
    await this.ensureDir(this.uri(".jetro", "connections"));
    await this.writeJson(this.uri(".jetro", "connections", `${slug}.json`), data);
    return slug;
  }

  async readConnection(slug: string): Promise<DatabaseConnection | null> {
    return this.readJson<DatabaseConnection>(
      this.uri(".jetro", "connections", `${slug}.json`)
    );
  }

  async listConnections(): Promise<string[]> {
    const files = await this.listFiles(this.uri(".jetro", "connections"), ".json");
    return files.map((f) => f.replace(".json", ""));
  }

  async deleteConnection(slug: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(".jetro", "connections", `${slug}.json`));
    } catch {
      // not found
    }
  }

  // ── Web Credential I/O ──

  async writeCredential(domain: string, data: WebCredential): Promise<string> {
    const slug = this.slugify(domain.replace(/\./g, "_"));
    data.slug = slug;
    await this.ensureDir(this.uri(".jetro", "credentials"));
    await this.writeJson(this.uri(".jetro", "credentials", `${slug}.json`), data);
    return slug;
  }

  async readCredential(slug: string): Promise<WebCredential | null> {
    return this.readJson<WebCredential>(
      this.uri(".jetro", "credentials", `${slug}.json`)
    );
  }

  async listCredentials(): Promise<string[]> {
    const files = await this.listFiles(this.uri(".jetro", "credentials"), ".json");
    return files.map((f) => f.replace(".json", ""));
  }

  async deleteCredential(slug: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(".jetro", "credentials", `${slug}.json`));
    } catch { /* not found */ }
  }

  async findCredentialByDomain(domain: string): Promise<WebCredential | null> {
    const slugs = await this.listCredentials();
    for (const slug of slugs) {
      const cred = await this.readCredential(slug);
      if (cred && (cred.domain === domain || domain.endsWith(cred.domain))) {
        return cred;
      }
    }
    return null;
  }

  /**
   * Build JET_CREDENTIALS JSON for script env injection.
   * @param secrets VS Code SecretStorage
   * @param scopeDomain If provided, only return creds matching this domain
   */
  async buildCredentialsEnv(
    secrets: vscode.SecretStorage,
    scopeDomain?: string
  ): Promise<string> {
    const slugs = await this.listCredentials();
    const result: Record<string, { username: string; password: string; loginUrl?: string; loginSelectors?: object }> = {};

    for (const slug of slugs) {
      const cred = await this.readCredential(slug);
      if (!cred) continue;

      if (scopeDomain && cred.domain !== scopeDomain && !scopeDomain.endsWith(cred.domain)) {
        continue;
      }

      const password = await secrets.get(cred.secretRef);
      if (!password) continue;

      result[cred.domain] = {
        username: cred.username,
        password,
        ...(cred.loginUrl ? { loginUrl: cred.loginUrl } : {}),
        ...(cred.loginSelectors ? { loginSelectors: cred.loginSelectors } : {}),
      };
    }

    return JSON.stringify(result);
  }

  // ── Data Model I/O ──

  async writeModel(name: string, data: DataModel): Promise<string> {
    const slug = this.slugify(name);
    data.slug = slug;
    await this.ensureDir(this.uri(".jetro", "models"));
    await this.writeJson(this.uri(".jetro", "models", `${slug}.json`), data);
    return slug;
  }

  async readModel(slug: string): Promise<DataModel | null> {
    return this.readJson<DataModel>(this.uri(".jetro", "models", `${slug}.json`));
  }

  async listModels(): Promise<string[]> {
    const files = await this.listFiles(this.uri(".jetro", "models"), ".json");
    return files.map((f) => f.replace(".json", ""));
  }

  async deleteModel(slug: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(".jetro", "models", `${slug}.json`));
    } catch {
      // not found
    }
  }

  // ── Saved Query I/O ──

  async writeQuery(name: string, data: SavedQuery): Promise<string> {
    const slug = this.slugify(name);
    data.slug = slug;
    await this.ensureDir(this.uri(".jetro", "queries"));
    await this.writeJson(this.uri(".jetro", "queries", `${slug}.json`), data);
    return slug;
  }

  async readQuery(slug: string): Promise<SavedQuery | null> {
    return this.readJson<SavedQuery>(this.uri(".jetro", "queries", `${slug}.json`));
  }

  async listQueries(): Promise<string[]> {
    const files = await this.listFiles(this.uri(".jetro", "queries"), ".json");
    return files
      .filter((f) => f !== "_history.json")
      .map((f) => f.replace(".json", ""));
  }

  async deleteQuery(slug: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(".jetro", "queries", `${slug}.json`));
    } catch {
      // not found
    }
  }

  // ── Query History ──

  async appendQueryHistory(entry: QueryHistoryEntry): Promise<void> {
    const historyPath = this.uri(".jetro", "queries", "_history.json");
    const existing = (await this.readJson<QueryHistoryEntry[]>(historyPath)) ?? [];
    existing.push(entry);
    const trimmed = existing.slice(-100);
    await this.writeJson(historyPath, trimmed);
  }

  async readQueryHistory(): Promise<QueryHistoryEntry[]> {
    return (await this.readJson<QueryHistoryEntry[]>(
      this.uri(".jetro", "queries", "_history.json")
    )) ?? [];
  }

  // ── Dashboard Publishing ──

  async writeDashboard(canvasId: string, meta: DashboardMeta): Promise<void> {
    await this.ensureDir(this.uri(".jetro", "dashboards"));
    await this.writeJson(this.uri(".jetro", "dashboards", `${canvasId}.json`), meta);
  }

  async readDashboard(canvasId: string): Promise<DashboardMeta | null> {
    return this.readJson<DashboardMeta>(this.uri(".jetro", "dashboards", `${canvasId}.json`));
  }

  async listDashboards(): Promise<string[]> {
    const files = await this.listFiles(this.uri(".jetro", "dashboards"), ".json");
    return files.map((f) => f.replace(".json", ""));
  }

  async deleteDashboard(canvasId: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(".jetro", "dashboards", `${canvasId}.json`));
    } catch {
      // not found
    }
  }

  // ── Project-scoped BI data ──

  async initBIProject(slug: string): Promise<void> {
    await this.ensureDir(this.uri("projects", slug, "datasets"));
    await this.ensureDir(this.uri("projects", slug, "models"));
    await this.ensureDir(this.uri("projects", slug, "queries"));
    await this.ensureDir(this.uri("projects", slug, "canvases"));
  }

  async writeProjectDataset(projectSlug: string, name: string, data: DatasetMetadata): Promise<string> {
    const slug = this.slugify(name);
    data.slug = slug;
    const dir = this.uri("projects", projectSlug, "datasets", slug);
    await this.ensureDir(dir);
    await this.writeJson(this.uri("projects", projectSlug, "datasets", slug, "metadata.json"), data);
    return slug;
  }

  async readProjectDataset(projectSlug: string, slug: string): Promise<DatasetMetadata | null> {
    return this.readJson<DatasetMetadata>(
      this.uri("projects", projectSlug, "datasets", slug, "metadata.json")
    );
  }

  async listProjectDatasets(projectSlug: string): Promise<string[]> {
    return this.listDirs(this.uri("projects", projectSlug, "datasets"));
  }

  async getProjectDatasetFilePath(projectSlug: string, datasetSlug: string, fileName: string): Promise<vscode.Uri> {
    return this.uri("projects", projectSlug, "datasets", datasetSlug, fileName);
  }

  async writeProjectModel(projectSlug: string, name: string, data: DataModel): Promise<string> {
    const slug = this.slugify(name);
    data.slug = slug;
    await this.ensureDir(this.uri("projects", projectSlug, "models"));
    await this.writeJson(this.uri("projects", projectSlug, "models", `${slug}.json`), data);
    return slug;
  }

  async readProjectModel(projectSlug: string, slug: string): Promise<DataModel | null> {
    return this.readJson<DataModel>(this.uri("projects", projectSlug, "models", `${slug}.json`));
  }

  async listProjectModels(projectSlug: string): Promise<string[]> {
    const files = await this.listFiles(this.uri("projects", projectSlug, "models"), ".json");
    return files.map((f) => f.replace(".json", ""));
  }

  async writeProjectQuery(projectSlug: string, name: string, data: SavedQuery): Promise<string> {
    const slug = this.slugify(name);
    data.slug = slug;
    await this.ensureDir(this.uri("projects", projectSlug, "queries"));
    await this.writeJson(this.uri("projects", projectSlug, "queries", `${slug}.json`), data);
    return slug;
  }

  async readProjectQuery(projectSlug: string, slug: string): Promise<SavedQuery | null> {
    return this.readJson<SavedQuery>(this.uri("projects", projectSlug, "queries", `${slug}.json`));
  }

  async listProjectQueries(projectSlug: string): Promise<string[]> {
    const files = await this.listFiles(this.uri("projects", projectSlug, "queries"), ".json");
    return files.map((f) => f.replace(".json", ""));
  }

  // ── Workspace indexing ──

  async indexWorkspace(): Promise<WorkspaceIndex> {
    const [stocks, lists, projects, elements, recipes, datasources, templates, datasets, connections, connectors, models, queries, credentials] = await Promise.all([
      this.listStocks(),
      this.listLists(),
      this.listProjects(),
      this.listElementDefs(),
      this.listRecipes(),
      this.listDataSources(),
      this.listTemplates(),
      this.listDatasets(),
      this.listConnections(),
      this.listConnectors(),
      this.listModels(),
      this.listQueries(),
      this.listCredentials(),
    ]);
    return { stocks, lists, projects, elements, recipes, datasources, templates, datasets, connections, connectors, models, queries, credentials };
  }

  // ── Cancellation cleanup ──

  async runCancellationCleanup(): Promise<void> {
    // Delete extension capabilities
    await this.deleteAllElementDefs();

    const deleteIfExists = async (...segments: string[]) => {
      const path = this.uri(...segments);
      if (await this.exists(path)) {
        await vscode.workspace.fs.delete(path, { recursive: false });
      }
    };

    await deleteIfExists(".jetro", "skills.md");
    await deleteIfExists(".jetro", "claude.md");
    await deleteIfExists(".jetro", "cache.duckdb");

    // Delete projects/*/canvas.json (old format)
    const projectSlugs = await this.listProjects();
    for (const slug of projectSlugs) {
      await deleteIfExists("projects", slug, "canvas.json");
    }

    // Delete multi-canvas registry and files (new format)
    await deleteIfExists(".jetro", "canvas-registry.json");
    const deleteRecursive = async (...segments: string[]) => {
      const p = this.uri(...segments);
      try { await vscode.workspace.fs.delete(p, { recursive: true }); } catch { /* ignore */ }
    };
    await deleteRecursive(".jetro", "canvases");
    for (const slug of projectSlugs) {
      await deleteRecursive("projects", slug, "canvases");
    }

    // Delete data/stocks/*/score.json
    const tickers = await this.listStocks();
    for (const ticker of tickers) {
      await deleteIfExists("data", "stocks", ticker, "score.json");
    }

    // Delete portfolio derived data (nav_history, mutations) inside project dirs — can recompute
    // Keep: portfolio.json, transactions.json (user's work)
    const portfolioSlugs = await this.listPortfolioProjects();
    for (const slug of portfolioSlugs) {
      await deleteIfExists("projects", slug, "nav_history.json");
      await deleteIfExists("projects", slug, "mutations.json");
    }
  }
}
