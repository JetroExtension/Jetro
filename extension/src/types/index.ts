// ── Stock data (one folder per ticker under data/stocks/) ──

export interface StockProfile {
  ticker: string;
  name: string;
  sector: string;
  industry: string;
  mcap: number;
  price: number;
  change: number;
  changePct: number;
  exchange: string;
}

export interface StockRatios {
  pe: number;
  roce: number;
  debtToEquity: number;
  npm: number;
  ebitdaMargin: number;
  roe: number;
  currentRatio: number;
}

export interface StockScore {
  jetroScore: number;
  grade: string;
  verdict: string;
  breakdown: Record<string, number>;
}

// ── List Column Definition (persistent column metadata) ──

export interface ListColumn {
  key: string;                    // unique key, e.g. "pe_ratio", "roce", "rev_cagr_5y"
  label: string;                  // display header, e.g. "P/E (TTM)", "ROCE %", "Rev CAGR 5Y"
  source: "fmp" | "computed" | "manual";
  endpoint?: string;              // for fmp: API path e.g. "/ratios/{ticker}"
  field?: string;                 // for fmp: JSON field e.g. "peRatioTTM"
  format?: string;                // "number", "percent", "currency"
  formula?: string;               // for computed: natural language or expression
}

// ── List (one file per list under data/lists/) ──

export interface JETList {
  name: string;
  tickers: string[];
  criteria?: string;
  refreshable: boolean;
  lastRefreshed?: string;
  createdAt: string;
  // Refresh infrastructure
  recipeSlug?: string;       // links to .jetro/recipes/{slug}.json for agent-driven refresh
  scriptPath?: string;       // optional .py script for fast refresh (fallback to recipe)
  refreshInterval?: "on_open" | "hourly" | "daily" | "manual";
  canvasElementId?: string;  // links to the canvas frame element for in-place updates
  canvasId?: string;          // canvas ID where the linked element lives
  // Context persistence — survives restarts
  thesis?: string;           // investment thesis behind this list
  columns?: ListColumn[];    // locked column definitions for deterministic refresh
}

// ── Project (one folder per project under projects/) ──

export interface JETProject {
  name: string;
  slug: string;
  status: "active" | "draft" | "done";
  mode?: "portfolio";             // undefined = research project, "portfolio" = portfolio tracking enabled
  securities: string[];
  sources: string[];
  linkedConnections?: string[];   // global connection slugs linked to this project (legacy)
  linkedConnectors?: string[];    // global connector slugs linked to this project
  linkedTemplates?: string[];     // global template slugs linked to this project
  linkedRecipes?: string[];       // global recipe slugs linked to this project
  deployment?: ProjectDeployment;
  createdAt: string;
  updatedAt: string;
}

// ── Deployment ──

export type DeployAuthMode = "token" | "app" | "none";
export type DeployTarget = "local" | "cloud";

export interface ProjectDeployment {
  status: "live" | "stopped" | "not_deployed";
  target: DeployTarget;
  port: number | null;
  containerId: string | null;
  url: string | null;
  slug: string | null;
  customDomain: string | null;
  entryFrame: string | null;
  authMode: DeployAuthMode;
  accessToken: string | null;
  lastDeployed: string | null;
  version: number;
}

// ── Canvas ──

export type CanvasElementType =
  | "note"
  | "pdf"
  | "frame"
  | "embed";

export interface CanvasElement {
  id: string;
  type: CanvasElementType;
  position: { x: number; y: number };
  size: { width: number; height: number };
  data: Record<string, unknown>;
  connections: string[];
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  type?: string;                   // "wire" for C2 functional edges, undefined for cosmetic
  data?: Record<string, unknown>;  // wire metadata (channel, bidirectional, label)
}

// ── C2 Mode (Command & Control Canvas) ──

export interface Wire {
  id: string;                    // matches ReactFlow edge id
  sourceId: string;              // source element id
  targetId: string;              // target element id
  channel: string;               // event channel name (e.g. "selection", "filter", "command")
  bidirectional?: boolean;       // default false (one-way source→target)
  label?: string;                // optional human-readable label
}

export interface FramePortManifest {
  outputs?: PortDeclaration[];   // events this frame sends
  inputs?: PortDeclaration[];    // events this frame accepts
}

export interface PortDeclaration {
  channel: string;               // channel name
  label?: string;                // human-readable (e.g. "Selected Ticker")
  schema?: Record<string, string>;  // optional: { ticker: "string", price: "number" }
}

export interface WireEdgeData {
  channel: string;
  bidirectional?: boolean;
  label?: string;
  lastActivity?: number;         // epoch ms, for visual pulse
}

export interface C2State {
  enabled: boolean;
  layout?: "freeform" | "grid" | "radial";
  theme?: "dark" | "light" | "tactical";
  framePorts?: Record<string, FramePortManifest>;
  wires?: Wire[];
}

export interface RefreshBinding {
  elementId: string;               // canvas element this binding targets
  scriptPath?: string;             // workspace-relative path to .py script (required for script bindings)
  intervalMs: number;              // refresh interval in ms (e.g. 120000 = 2 min, 300000 = 5 min for prompts)
  enabled: boolean;                // toggle without deleting
  lastRun?: string;                // ISO timestamp of last successful run
  lastError?: string;              // last error message (cleared on success)
  createdAt: string;               // ISO timestamp
  // Binding type — dual binding support (script + prompt on same element)
  bindingType?: "script" | "prompt";   // defaults to "script"
  refreshPrompt?: string;              // required for prompt bindings
  elementTitle?: string;               // for prompt context wrapping
  // Web-source pattern graduation tracking
  consecutiveSuccesses?: number;   // reset to 0 on error, triggers graduation at 10
  patternSubmitted?: boolean;      // true after graduation upload to backend
  sourceDomain?: string;           // domain this binding scrapes (e.g. "trackinsight.com")
  timeoutMs?: number;              // per-binding timeout (default 30000, up to 60000 for Playwright)
}

export interface CanvasState {
  name: string;
  elements: CanvasElement[];
  edges: CanvasEdge[];
  viewport: { x: number; y: number; zoom: number };
  refreshBindings?: RefreshBinding[];
  c2?: C2State;
}

export interface CanvasRegistryEntry {
  id: string;
  name: string;
  projectSlug: string | null;  // null = universal
  createdAt: string;
}

// ── Custom element definitions (.jetro/elements/{slug}.json) ──

export type PrimitiveType =
  | "metric-box"
  | "text-block"
  | "sparkline"
  | "table"
  | "badge"
  | "progress-bar"
  | "chart-area"
  | "image"
  | "divider"
  | "iframe";

export interface LayoutPrimitive {
  type: PrimitiveType;
  bind?: string;
  content?: string;
  style?: string;
  variant?: string;
}

export interface CustomElementDef {
  name: string;
  slug: string;
  width: number;
  layout: LayoutPrimitive[];
}

// ── Tool definitions (from KV via bootstrap, for dynamic tool registration) ──

export interface ToolDefinition {
  id: string;
  displayName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── Bootstrap response (from backend, held in memory) ──

export interface BootstrapResponse {
  status?: "cancelled";
  system_prompt: string;
  api_reference: string;
  skills: Skill[];
  schema: Record<string, unknown>;
  tools_config: Record<string, unknown>;
  templates: Template[];
  limits: {
    data_calls_remaining: number;
    data_calls_max: number;
    lists_max: number;
    projects_max: number;
    recipes_max: number;
    datasources_max: number;
    portfolios_max: number;
    cache_max_mb: number;
  };
}

/** Skill catalog entry — prompt is NOT included (fetched on-demand via jet.skill). */
export interface Skill {
  name: string;
  description: string;
  type: string;
  version: string;
  inputs: string[];
  output_schema: Record<string, unknown>;
}

/** Template catalog entry — content is NOT included (fetched on-demand via jet.template). */
export interface Template {
  name: string;
  description: string;
  format?: string;
}

// ── Workspace index (returned by fileManager.indexWorkspace) ──

export interface WorkspaceIndex {
  stocks: string[];
  lists: string[];
  projects: string[];
  elements: string[];
  recipes: string[];
  datasources: string[];
  templates: string[];
  datasets: string[];
  credentials: string[];
  connections: string[];
  connectors: string[];
  models: string[];
  queries: string[];
}

// ── Recipes ──

export interface RecipeInput {
  name: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
}

export interface Recipe {
  name: string;
  slug: string;
  description: string;
  inputs: RecipeInput[];
  steps: string[];         // natural language steps, not code
  outputHint?: string;     // "table" | "chart" | "card" | "report"
  createdAt: string;
}

// ── Custom Data Sources ──

export interface DataSourceAuth {
  type: "header" | "query" | "bearer";
  headerName?: string;     // for type: "header"
  queryParam?: string;     // for type: "query"
  secretRef: string;       // key name in VS Code SecretStorage
}

export interface DataSourceEndpoint {
  name: string;
  path: string;
  method: "GET" | "POST";
  params?: string[];
}

export interface DataSourceConnector {
  name: string;
  slug: string;
  baseUrl: string;
  auth: DataSourceAuth;
  docsUrl?: string;
  endpoints: DataSourceEndpoint[];
  createdAt: string;
}

// ── Agent-Built Connectors ──

export type ConnectorAuthMethod = "api_key" | "bearer" | "basic" | "connection_string" | "none";

export interface ConnectorAuth {
  method: ConnectorAuthMethod;
  credentialKey?: string;        // key in SecretStorage: "jet_connector_{slug}"
  inject?: "header" | "query";   // where to place API key
  headerName?: string;           // e.g. "X-API-Key"
  queryParam?: string;           // e.g. "api_key"
}

export interface ConnectorParam {
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
  default?: string | number | boolean;
}

export interface ConnectorMethod {
  description: string;
  params?: Record<string, ConnectorParam>;
  returns: string;
}

export interface Connector {
  slug: string;
  name: string;
  description: string;
  type: string;                  // "api" | "spreadsheet" | "database" | "crm" | "mcp" | "custom"
  origin: "agent" | "user";
  auth: ConnectorAuth;
  params: Record<string, ConnectorParam>;
  methods: Record<string, ConnectorMethod>;
  createdAt: string;
  updatedAt: string;
}

// ── Portfolios ──

export interface PortfolioHolding {
  ticker: string;
  name?: string;               // human-readable security name
  weight: number;               // 0-1 decimal (current weight)
  shares: number;               // actual share count
  avgCost: number;              // average cost per share
  sector?: string;              // for sector exposure analysis
}

export interface RebalanceTarget {
  ticker: string;
  weight: number;               // 0-1 decimal (target weight)
}

export interface Portfolio {
  name: string;
  slug: string;
  holdings: PortfolioHolding[];
  initialCapital: number;       // starting capital (e.g., 1000000)
  cash: number;                 // current uninvested cash
  currency: string;             // "INR" (default) | "USD" | etc.
  benchmark: string | null;     // e.g., "NIFTY_PHARMA.NS" or null
  rebalance: "monthly" | "quarterly" | "annually" | "none";
  rebalanceTargets: RebalanceTarget[];  // target allocation for rebalancing
  inceptionDate: string;        // ISO date "YYYY-MM-DD"
  units: number;                // total units outstanding (unitisation: initialCapital / 100 at inception)
  currentNAV?: number;          // last computed total portfolio value
  navPerUnit?: number;          // last computed NAV per unit (true performance measure)
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioTransaction {
  id: string;                   // uuid
  date: string;                 // ISO date
  type: "buy" | "sell" | "split" | "bonus" | "dividend" | "rebalance";
  ticker: string;
  shares: number;               // positive for buy/bonus/split, negative for sell
  price: number;                // per-share price at transaction time
  amount?: number;              // total amount (for dividends: cash received)
  notes?: string;               // agent or user notes
  createdAt: string;            // when this record was created
}

export interface NAVPoint {
  date: string;                 // ISO date "YYYY-MM-DD"
  nav: number;                  // total portfolio value at end of day
  navPerUnit: number;           // NAV per unit (unitised, true performance measure)
  units: number;                // units outstanding as of this date
  benchmark?: number;           // benchmark value (normalised to 100 at inception)
}

export interface PortfolioMutationLog {
  timestamp: string;            // ISO timestamp
  action: string;               // "create" | "add_holding" | "remove_holding" | "update_weight" | "record_transaction" | "corporate_action" | "rebalance" | "update_cash"
  summary: string;              // human-readable description
  before?: Record<string, unknown>;  // snapshot of changed fields (optional)
  after?: Record<string, unknown>;
}

// ── Datasets ──

export interface DatasetColumn {
  name: string;
  type: "VARCHAR" | "INTEGER" | "BIGINT" | "REAL" | "DOUBLE" | "BOOLEAN" | "DATE" | "TIMESTAMP" | "JSON";
  nullable: boolean;
}

export interface DatasetMetadata {
  name: string;
  slug: string;
  files: string[];
  columns: DatasetColumn[];
  rowCount: number;
  sizeBytes: number;
  duckdbTable: string;
  createdAt: string;
  updatedAt: string;
}

// ── BI Mode: Database Connections ──

export type DatabaseEngine = "postgres" | "mysql" | "sqlite" | "duckdb_file" | "motherduck" | "s3" | "snowflake";

export interface DatabaseConnection {
  name: string;
  slug: string;
  engine: DatabaseEngine;
  host?: string;
  port?: number;
  database?: string;
  filePath?: string;
  secretRef?: string;
  schema?: string;
  attached: boolean;
  extensions: string[];
  createdAt: string;
  region?: string;
  endpoint?: string;
  warehouse?: string;
  account?: string;
}

// ── Web Credentials (for authenticated web scraping) ──

export interface WebCredential {
  domain: string;           // e.g. "economictimes.com"
  slug: string;             // slugified domain: "economictimes_com"
  username: string;         // stored in plaintext metadata (not secret)
  secretRef: string;        // key in VS Code SecretStorage: "jet_cred_{slug}"
  loginUrl?: string;        // login page URL for Playwright auto-login
  loginSelectors?: {
    usernameField?: string;
    passwordField?: string;
    submitButton?: string;
  };
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// ── BI Mode: Data Models (DuckDB views) ──

export interface DataModel {
  name: string;
  slug: string;
  sql: string;
  description?: string;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

// ── BI Mode: Saved Queries ──

export interface SavedQuery {
  name: string;
  slug: string;
  sql: string;
  description?: string;
  lastRun?: string;
  lastRowCount?: number;
  parameters?: QueryParameter[];
  createdAt: string;
  updatedAt: string;
}

export interface QueryParameter {
  name: string;
  type: "string" | "number" | "date";
  defaultValue?: string;
}

// ── BI Mode: Query History Entry ──

export interface QueryHistoryEntry {
  sql: string;
  ranAt: string;
  rowCount: number;
  durationMs: number;
  error?: string;
}

// ── Canvas: KPI Element Data ──

export interface KPIData {
  title: string;
  value: number | string;
  format?: "number" | "currency" | "percent" | "compact";
  prefix?: string;
  suffix?: string;
  change?: number;
  changePct?: number;
  changeDirection?: "up" | "down" | "neutral";
  sparkline?: number[];
  query?: string;
  color?: string;
}

// ── Dashboard Publishing ──

export interface DashboardMeta {
  canvasId: string;
  projectSlug: string;
  name: string;
  description?: string;
  publishedAt: string;
  updatedAt?: string;
  thumbnail?: string;
  refreshInterval?: number;
}

// ── MCP tool input schemas ──

export interface JetDataInput {
  provider: "fmp" | "polygon";
  endpoint: string;
  params?: Record<string, unknown>;
}

export interface JetRenderInput {
  type: CanvasElementType;
  data: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface JetSaveInput {
  type: "list" | "project" | "preference" | "element" | "recipe" | "datasource" | "portfolio" | "template" | "dataset" | "connection" | "model" | "query" | "memory" | "credential";
  name: string;
  payload: Record<string, unknown>;
}

export interface AgentMemoryEntry {
  timestamp: string;
  agent: string;
  summary: string;
  decisions: string[];
  openItems: string[];
}

export interface JetQueryInput {
  sql: string;
}

export interface JetParseInput {
  file: string;
  projectSlug?: string;
  outputName?: string;
  options?: { ocr?: boolean; pages?: string };
}

export interface ParseResult {
  outputPath: string;             // relative path to parsed markdown
  sourcePath: string;             // relative path to original in sources/
  pageCount?: number;
  title?: string;
  tables?: number;                // number of tables extracted
  format: string;                 // "pdf", "docx", "pptx", "xlsx", "html", "epub", "rtf", "email", "image", "text"
  wordCount?: number;             // word count of extracted text
  fileSize?: number;              // original file size in bytes
}

// ── Compute Execution ──

export interface JetExecInput {
  language: "python" | "r";
  code: string;
  timeout?: number;               // ms, default 60000
}

// ── Sharing ──

export interface Share {
  id: string;                     // 8-char alphanumeric slug
  ownerId: string;                // Firebase UID from JWT
  title: string;
  status: "active" | "paused";

  elements: ShareElement[];

  branding: ShareBranding;

  hmacToken: string;              // HMAC-SHA256(id, SHARE_SECRET)

  createdAt: string;              // ISO timestamp
  updatedAt: string;              // ISO timestamp
}

export interface ShareBranding {
  firmName: string;
  primaryColor: string;
  accentColor: string;
  logo?: string;                  // base64 data URL
  disclaimer?: string;
  fontHeading: string;
  fontBody: string;
}

export interface ShareElement {
  id: string;                     // element ID from canvas (UUID)
  canvasId: string;               // source canvas ID
  title: string;                  // tab label
  kvKey: string;                  // KV key: "share:{shareId}:elem:{elemId}"
  status: "active" | "paused";   // per-element pause
  isLive: boolean;                // true if element has active refresh binding
  lastUploaded: string;           // ISO timestamp
}

export interface ShareIndexEntry {
  id: string;
  title: string;
  status: "active" | "paused";
  elementCount: number;
  liveElementCount: number;
  url: string;                    // full share URL
  createdAt: string;
  updatedAt: string;
}
