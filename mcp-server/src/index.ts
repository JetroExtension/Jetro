#!/usr/bin/env node
/**
 * Jetro MCP Server
 *
 * Exposes Jetro tools to AI agents via the Model Context Protocol (stdio).
 * Reads skills/templates locally, proxies data requests to configured backend,
 * and handles local file operations.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

// ── Config ──

const API_BASE = process.env.JET_API_URL ?? "http://localhost:8787";
const INITIAL_WORKSPACE = process.env.JET_WORKSPACE ?? process.cwd();
const INITIAL_JWT = process.env.JET_JWT || "";

/** Global auth file — extension writes here on every token refresh and workspace switch. */
const GLOBAL_AUTH_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".jetro",
  "auth.json"
);

interface GlobalAuth {
  jwt?: string;
  email?: string;
  workspace?: string;
  updatedAt?: string;
}

/** Read the global auth file (written by the extension). */
function readGlobalAuth(): GlobalAuth {
  try {
    return JSON.parse(fsSync.readFileSync(GLOBAL_AUTH_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Get a fresh JWT. Priority:
 * 1. Global auth file (~/.jetro/auth.json) — freshest, updated by extension on every token refresh
 * 2. Workspace .mcp.json — per-workspace, updated on init
 * 3. JET_JWT env var — set at MCP spawn time, can go stale
 */
function getJWT(): string {
  // 1. Global auth file
  const global = readGlobalAuth();
  if (global.jwt) return global.jwt;
  // 2. Workspace .mcp.json
  try {
    const ws = WORKSPACE;
    const mcpConfig = JSON.parse(fsSync.readFileSync(path.join(ws, ".mcp.json"), "utf-8"));
    const jwt = mcpConfig?.mcpServers?.jetro?.env?.JET_JWT;
    if (jwt && typeof jwt === "string") return jwt;
  } catch { /* fall through */ }
  // 3. Env var
  return INITIAL_JWT;
}

/**
 * Workspace is FIXED per-process. Set at MCP spawn time via JET_WORKSPACE env var.
 * NEVER read from global auth file — that causes cross-workspace contamination
 * when multiple editor windows are open.
 */
const WORKSPACE = INITIAL_WORKSPACE;
const TIMEOUT_MS = 15_000;

/** Called before each tool call. JWT refreshes automatically via getJWT(). */
function refreshConfig(): void {
  // No-op. WORKSPACE is fixed. JWT is read fresh from auth.json on every getJWT() call.
}

// Log startup
console.error(`[jetro-mcp] started at ${new Date().toISOString()} | WORKSPACE=${WORKSPACE}`);

// ── Helpers ──

async function apiCall(
  endpoint: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getJWT()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${text || res.statusText}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Sanitize a ticker or filename segment — allow alphanumeric, dots, hyphens, underscores only */
function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "");
}

/** Ensure a resolved path is still inside the allowed root directory */
function assertContained(filePath: string, root: string): void {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    throw new Error(`Path traversal blocked: ${filePath} escapes ${root}`);
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// ── Tool Definitions ──

const TOOLS = [
  {
    name: "jet_data",
    description:
      "Fetch financial data from the Jetro Data API. Use this to get company profiles, ratios, income statements, balance sheets, cash flows, key metrics, quotes, and historical prices.",
    inputSchema: {
      type: "object" as const,
      properties: {
        provider: {
          type: "string",
          enum: ["fmp", "polygon"],
          description: "Data provider to query",
        },
        endpoint: {
          type: "string",
          description:
            "API endpoint path, e.g. /profile/ALKEM.NS, /ratios/CIPLA.NS, /income-statement/SUNPHARMA.NS",
        },
        params: {
          type: "object",
          description: "Optional query parameters (e.g. { period: 'annual', limit: '5' })",
        },
      },
      required: ["provider", "endpoint"],
    },
  },
  {
    name: "jet_skill",
    description:
      "Fetch a skill prompt from the Jetro backend. Call this to get the full analysis instructions before executing any skill. Returns the complete prompt text. Includes web_source (source data from any website, generates scraping script + live frame) and web_source_recon (investigate a website's data architecture).",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Exact skill name from the Available Skills list in CLAUDE.md",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "jet_template",
    description:
      "Fetch a report/output template (bundled starter or user-created). Call this to get the full template content before formatting your output.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Exact template name from the Available Templates list in CLAUDE.md",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "jet_save",
    description:
      `Save structured data to the Jetro workspace.

═══ LIST (type='list') ═══
payload MUST include: tickers (string array, e.g. ["LUPIN.NS", "ALKEM.NS"])
payload MAY include: criteria (string), scriptPath (string), refreshInterval ("on_open"|"hourly"|"daily"|"manual")
payload SHOULD include for custom-metric lists:
  - thesis: string — investment thesis (persists across restarts)
  - columns: ListColumn[] — locked column definitions for deterministic refresh
    Each: { key, label, source: "fmp"|"computed"|"manual", endpoint?, field?, format?: "number"|"percent"|"currency" }

With columns defined, refresh is DETERMINISTIC — no LLM needed on restart.

Workflow: build frame with jet:refresh listener (see CLAUDE.md) → render to canvas with binding → save list → create refresh script.

═══ project ═══
payload: { name, status: "active"|"draft"|"done", securities, sources, linkedConnections?, linkedTemplates?, linkedRecipes? }

═══ Other types: stock, preference, element, recipe, datasource, portfolio, template ═══`,
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: [
            "stock",
            "list",
            "project",
            "preference",
            "element",
            "recipe",
            "datasource",
            "portfolio",
            "template",
          ],
          description: "Type of data to save",
        },
        name: {
          type: "string",
          description: "Name/identifier for the saved item",
        },
        payload: {
          type: "object",
          description: "The data to save. For type='list': { tickers: string[], criteria?: string, recipeSlug?: string, scriptPath?: string, refreshInterval?: string }",
        },
      },
      required: ["type", "name", "payload"],
    },
  },
  {
    name: "jet_render",
    description:
      `Render a visual element to the Jetro canvas. See CLAUDE.md for frame HTML rules, jet:refresh listener format, and refresh binding details.

═══ CHART (type='chart') — Use for ALL charts/graphs ═══
Plotly.js is BUNDLED. NEVER use type='frame' for charts.
Data: { title, traces: PlotlyTrace[], plotlyLayout?: object }
Example: { title: "Revenue", traces: [{ x: ["FY21","FY22"], y: [100,120], type: "bar", name: "Rev" }] }
Dual axis: add yaxis: "y2" on second trace + plotlyLayout: { yaxis2: { overlaying: "y", side: "right" } }

═══ FRAME (type='frame') — Rich HTML dashboards ═══
File-based (recommended): write to .jetro/frames/{name}.html, render with data.file.
Inline: data.html for quick snippets.
Chart libs (Plotly, D3, Observable Plot) pre-bundled — use CDN <script src> tags (shimmed locally).

Live refresh: frames receive data via jet:refresh CustomEvent on e.detail. See CLAUDE.md.
Refresh bindings: script (Python timer) or prompt (AI agent timer, min 5 min). Always render real initial data.

═══ OTHER TYPES ═══
note: { title, markdown }
embed: { title?, url }`,
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["note", "pdf", "frame", "embed"],
          description:
            "Use 'frame' for ALL visual content: charts, tables, dashboards, KPIs, reports, images (full HTML freedom, Plotly traces, or file reference). Use 'note' for markdown text. Use 'embed' for external URLs. Use 'pdf' only for parsed PDF previews.",
        },
        data: {
          type: "object",
          description:
            "Frames: { title, html: '...', traces?, plotlyLayout?, file?: '.jetro/frames/name.html' }. Notes: { title, markdown }. Embed: { url, title? }.",
        },
        position: {
          type: "object",
          description: "Optional { x, y } position on canvas. Auto-positioned if omitted.",
        },
        width: {
          type: "number",
          description: "Optional width in pixels (default: 340)",
        },
        projectSlug: {
          type: "string",
          description: "Project slug. Auto-filled from active project canvas if omitted — pass explicitly to override.",
        },
        id: {
          type: "string",
          description: "Optional element ID. When provided, updates an existing element in-place instead of creating a new one. Use this for re-rendering the same element with fresh data.",
        },
        refreshBinding: {
          type: "object",
          properties: {
            scriptPath: { type: "string", description: "Workspace-relative path to .py refresh script" },
            intervalMs: { type: "number", description: "Refresh interval in ms (default 120000 = 2 min)" },
            bindingType: { type: "string", enum: ["script", "prompt"], description: "Binding type: 'script' (Python script) or 'prompt' (AI agent prompt). Default: 'script'" },
            refreshPrompt: { type: "string", description: "For prompt bindings: the natural language prompt the AI agent will execute on each refresh cycle" },
            elementTitle: { type: "string", description: "For prompt bindings: human-readable element title for agent context wrapping" },
          },
          description: "Optional: auto-bind a refresh source to this element for live updates. Script bindings run .py on a timer. Prompt bindings use a headless AI agent.",
        },
      },
      required: ["type", "data"],
    },
  },
  {
    name: "jet_search",
    description:
      "Search for stock/security symbols on NSE/BSE. Returns matching symbols with company names and exchange info. Use this to find the correct ticker symbol before fetching data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search query — company name or partial ticker (e.g. 'alkem', 'cipla', 'reliance')",
        },
        exchange: {
          type: "string",
          description: "Exchange filter (default: NSE). Use 'BSE' for Bombay Stock Exchange.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "jet_canvas",
    description:
      `Manage canvas panels — layout, refresh bindings, versioning, multi-canvas.

Actions: list, read, move, resize, delete, arrange, bind, unbind, bindings, trigger, history, restore.

list — All canvases (universal + project). read — All elements with IDs, positions, sizes, bindings.
move — { elementId, position: { x, y } }. resize — { elementId, size: { width, height? } }.
delete — Remove element. arrange — Batch move/resize: operations[{ elementId, position?, size? }].
bind — Attach refresh binding (see CLAUDE.md for script vs prompt types). Required: elementId, refreshBinding.
unbind — Remove binding. bindings — List all. trigger — Run one binding manually.
history — Version history (auto-snapshots). restore — Revert to timestamp (or most recent).

Layout: origin top-left (0,0), Y downward, 20px gaps. Widths: note=320, frame=500. Use 'read' then 'arrange' for layout.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "move", "resize", "delete", "arrange", "bind", "unbind", "bindings", "trigger", "history", "restore"],
          description: "Canvas operation to perform",
        },
        canvasId: {
          type: "string",
          description: "Target canvas ID. Omit to use the active/default canvas.",
        },
        elementId: {
          type: "string",
          description: "Target element ID (required for move, resize, delete, bind, unbind, trigger)",
        },
        position: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
          },
          description: "New position { x, y } for move action",
        },
        size: {
          type: "object",
          properties: {
            width: { type: "number" },
            height: { type: "number" },
          },
          description: "New size { width, height? } for resize action",
        },
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              elementId: { type: "string" },
              position: {
                type: "object",
                properties: { x: { type: "number" }, y: { type: "number" } },
              },
              size: {
                type: "object",
                properties: { width: { type: "number" }, height: { type: "number" } },
              },
            },
            required: ["elementId"],
          },
          description: "Batch move/resize operations for arrange action",
        },
        refreshBinding: {
          type: "object",
          properties: {
            scriptPath: { type: "string", description: "Workspace-relative path to .py refresh script (required for script bindings)" },
            intervalMs: { type: "number", description: "Refresh interval in ms (default 120000 for scripts, 300000 for prompts)" },
            sourceDomain: { type: "string", description: "Domain this binding scrapes (e.g. 'trackinsight.com'). Enables pattern graduation for community reuse." },
            bindingType: { type: "string", enum: ["script", "prompt"], description: "Binding type: 'script' (Python) or 'prompt' (AI agent). Default: 'script'" },
            refreshPrompt: { type: "string", description: "For prompt bindings: the natural language prompt the AI agent will execute on each refresh" },
            elementTitle: { type: "string", description: "For prompt bindings: human-readable element title for agent context" },
          },
          description: "For 'bind' action: script path or prompt, refresh interval, and optional metadata. Script bindings run .py on timer. Prompt bindings use headless AI agent (min 5-min interval).",
        },
        projectSlug: {
          type: "string",
          description: "Project slug — auto-filled from active project canvas if omitted. Pass explicitly to override. Not used for 'list' action.",
        },
        timestamp: {
          type: "number",
          description: "Version timestamp (epoch ms) for restore action. Omit to restore most recent version.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "jet_parse",
    description:
      `Parse documents into structured markdown.

Supports: PDF, DOCX, PPTX, XLSX, HTML, EPUB, RTF, EML, images (OCR), and text passthrough (md, txt, csv, json, yaml, xml).
Output: Markdown file saved to project notes (or .jetro/notes/ if no project).
Original file copied to project sources directory.

Options:
  - ocr: true — force OCR for scanned PDFs or parse images
  - pages: "1-5" — extract specific page range (PDF only)

Requires Python 3 on the user's machine. Parsing libraries (pymupdf4llm, markitdown, rapidocr) are auto-installed in a managed venv (.jetro/venv/) on first use — this takes 30-60 seconds and needs internet. Subsequent parses are instant. Text passthrough formats (md, txt, csv, json, yaml, xml) need no Python — they're read directly.

If the first parse fails with a Python error, tell the user: "jet_parse needs Python 3 installed. Install it from python.org or via your package manager, then try again."

Example:
  jet_parse({ file: "annual_report.pdf", projectSlug: "cns_pharma", outputName: "alkem_ar_2025" })
  → Parses PDF, saves to projects/cns_pharma/notes/alkem_ar_2025.md

After parsing, read the output markdown to analyze content, extract data, and render findings.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        file: {
          type: "string",
          description: "Path to document (relative to workspace)",
        },
        projectSlug: {
          type: "string",
          description: "Project to store output in. Auto-filled from active project canvas if omitted — pass explicitly to override.",
        },
        outputName: {
          type: "string",
          description: "Name for output file (without .md). Defaults to input filename.",
        },
        options: {
          type: "object",
          properties: {
            ocr: { type: "boolean", description: "Enable OCR for scanned documents" },
            pages: { type: "string", description: "Page range: '1-5', '3', or 'all'" },
          },
        },
      },
      required: ["file"],
    },
  },
  {
    name: "jet_share",
    description:
      `Share canvas frame elements as interactive web pages viewable in any browser.

═══ ACTIONS ═══
"create" → Create a new share from one or more frame elements. Returns { shareId, url }.
"list" → List all active shares for the current user.
"addElement" → Add a frame element to an existing share (new tab).
"removeElement" → Remove an element from a share.
"pause" → Pause a share (viewers see last data, no live updates).
"resume" → Resume a paused share (re-uploads all live elements).
"revoke" → Permanently delete a share (URL stops working).

═══ USAGE ═══
After creating elements with jet_render, share them:
  jet_share({ action: "create", title: "Q3 Portfolio Review", elementIds: ["elem-123"] })
  → Returns URL that anyone can open in a browser

Share multiple elements as tabs in one URL:
  jet_share({ action: "create", title: "Daily Report", elementIds: ["risk-1", "holdings-2", "perf-3"] })

Manage shares:
  jet_share({ action: "list" }) → All active shares
  jet_share({ action: "pause", shareId: "abc123" }) → Pause live updates
  jet_share({ action: "revoke", shareId: "abc123" }) → Delete share permanently`,
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "addElement", "removeElement", "pause", "resume", "revoke"],
          description: "Share operation to perform",
        },
        title: {
          type: "string",
          description: "Share title (required for create action)",
        },
        elementIds: {
          type: "array",
          items: { type: "string" },
          description: "Element IDs to share (required for create action)",
        },
        shareId: {
          type: "string",
          description: "Share ID (required for addElement, removeElement, pause, resume, revoke)",
        },
        elementId: {
          type: "string",
          description: "Element ID (required for addElement, removeElement)",
        },
        canvasId: {
          type: "string",
          description: "Target canvas ID. Omit to use the active/default canvas.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "jet_query",
    description:
      `Query the local DuckDB cache with read-only SQL.

The cache stores fetched financial data (stock_data table) and portfolio holdings (portfolio_holdings table).
Datasets registered via jet_save(type='datasource') are also queryable as tables.

═══ TABLES ═══
stock_data: ticker VARCHAR, endpoint VARCHAR, data JSON, fetched_at TIMESTAMP
portfolio_holdings: portfolio VARCHAR, ticker VARCHAR, name VARCHAR, weight REAL, shares REAL, avg_cost REAL, sector VARCHAR, current_price REAL, current_value REAL, pnl REAL, pnl_pct REAL
+ any registered dataset tables (CSV, Parquet, JSON files)

═══ EXAMPLES ═══
List all tables: jet_query({ sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'" })
Cached tickers: jet_query({ sql: "SELECT DISTINCT ticker FROM stock_data" })
Portfolio: jet_query({ sql: "SELECT ticker, weight, pnl_pct FROM portfolio_holdings WHERE portfolio = 'my-portfolio' ORDER BY weight DESC" })
JSON extraction: jet_query({ sql: "SELECT ticker, data->>'revenue' as revenue FROM stock_data WHERE endpoint = '/income-statement'" })

═══ RULES ═══
Only SELECT, WITH (CTE), DESCRIBE, SUMMARIZE allowed. No writes, no multiple statements.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: {
          type: "string",
          description: "Read-only SQL query (SELECT, WITH, DESCRIBE, SUMMARIZE only)",
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "jet_exec",
    description:
      `Execute Python or R code in a sandboxed subprocess. Large output (>8 KB) is auto-truncated — write to file instead (see CLAUDE.md).

Env vars: JET_WORKSPACE, JET_PROJECT, JET_DUCKDB_PATH, JET_API_URL, JET_JWT, JET_FRAMES_DIR, PYTHONPATH (.jetro/lib/).

Use for: data transforms, stats, backtesting, chart HTML generation, DuckDB queries, refresh script prototyping.
stdout is captured as the result. stderr returned separately. Timeout: 5 min (configurable). Max buffer: 10 MB.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        language: {
          type: "string",
          enum: ["python", "r"],
          description: "Script language",
        },
        code: {
          type: "string",
          description: "Source code to execute",
        },
        timeout: {
          type: "number",
          description: "Execution timeout in milliseconds (default 300000 = 5 minutes). Increase for long-running scripts.",
        },
      },
      required: ["language", "code"],
    },
  },
  {
    name: "jet_deploy",
    description:
      `Deploy a project as a containerized web app with a public URL.

Actions:
- start: Build Docker image and run container. Requires projects/{slug}/deploy/ with server.py, requirements.txt, Dockerfile.
- stop: Stop the running container.
- redeploy: Rebuild image and restart container (picks up code changes).
- publish: Register a public URL and enable the relay (requires configured relay domain).
- remove: Stop container, remove image, deregister public URL.
- status: Check if the app is running.

The deploy skill (jet_skill("Deploy App")) teaches you how to write server.py, requirements.txt, and Dockerfile.
Docker must be installed on the user's machine.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "redeploy", "publish", "remove", "status"],
          description: "Deploy action to perform",
        },
        projectSlug: {
          type: "string",
          description: "Project slug to deploy",
        },
      },
      required: ["action", "projectSlug"],
    },
  },
  {
    name: "jet_connector",
    description:
      `Create, manage, and use data connectors — reusable Python modules for external data sources.

═══ ACTIONS ═══
create — Required: name, description, type, auth, clientCode. Optional: params, methods, requirements, credential.
list — List all connectors (no client code returned).
read — Read config + client code. Required: slug.
test — Test a connector. Required: slug.
delete — Delete connector + credential. Required: slug.

clientCode must define a Client class with __init__(self, config, params, credential) and fetch(self, **kwargs).
Auth methods: "api_key", "bearer", "basic", "connection_string", "none".

Usage in scripts: from jet.connectors import use; client = use("slug", param="val"); data = client.fetch()
Connectors persist at .jetro/connectors/{slug}/.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "test", "delete", "read"],
          description: "Action to perform",
        },
        name: {
          type: "string",
          description: "Connector name (for create)",
        },
        slug: {
          type: "string",
          description: "Connector slug (for test/delete/read)",
        },
        description: {
          type: "string",
          description: "What this connector does (for create)",
        },
        type: {
          type: "string",
          description: "Connector type: api, spreadsheet, database, crm, mcp, custom",
        },
        auth: {
          type: "object",
          description: "Auth config: { method: 'api_key'|'bearer'|'basic'|'connection_string'|'none', inject?: 'header'|'query', headerName?: string, queryParam?: string }",
        },
        credential: {
          type: "string",
          description: "The secret value (API key, token, connection string). Stored securely in OS keychain, never logged or persisted in plain text.",
        },
        params: {
          type: "object",
          description: "Connector parameter schema: { paramName: { type, description, required, default? } }",
        },
        methods: {
          type: "object",
          description: "Available methods: { methodName: { description, params?, returns } }",
        },
        clientCode: {
          type: "string",
          description: "Python source code for client.py — must define a Client class",
        },
        requirements: {
          type: "string",
          description: "Python dependencies (pip format, one per line, e.g. 'requests>=2.31.0')",
        },
      },
      required: ["action"],
    },
  },
];

// ── Tool Handlers ──

async function handleJetData(args: {
  provider: string;
  endpoint: string;
  params?: Record<string, unknown>;
}): Promise<string> {
  const result = await apiCall("/api/data", {
    provider: args.provider,
    endpoint: args.endpoint,
    params: args.params,
  });

  // Also cache to workspace
  const cacheDir = path.join(WORKSPACE, ".jetro", "cache");
  await ensureDir(cacheDir);
  const cacheKey = `${args.provider}_${slugify(args.endpoint)}`;
  await fs.writeFile(
    path.join(cacheDir, `${cacheKey}.json`),
    JSON.stringify(result, null, 2)
  );

  return JSON.stringify(result, null, 2);
}

async function handleJetSkill(args: { name: string }): Promise<string> {
  // OSS: read skill from local agent/skills/ directory
  const skillsDir = path.join(path.dirname(path.dirname(__dirname)), "agent", "skills");
  try {
    const files = await fs.readdir(skillsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(skillsDir, file), "utf-8");
        const skill = JSON.parse(raw);
        if (skill.name === args.name && skill.prompt) return skill.prompt;
      } catch { /* skip malformed */ }
    }
  } catch { /* no skills dir */ }

  // Fallback: try API if configured
  try {
    const result = (await apiCall("/api/skill", { name: args.name })) as { name: string; prompt: string };
    return result.prompt;
  } catch {
    return `Skill "${args.name}" not found. Add it to agent/skills/ as a JSON file with { "name", "description", "prompt" }.`;
  }
}

async function handleJetTemplate(args: { name: string }): Promise<string> {
  const { name } = args;

  // 1. Search bundled starter templates (agent/templates/*.json)
  const bundledDir = path.join(path.dirname(path.dirname(__dirname)), "agent", "templates");
  try {
    const files = await fs.readdir(bundledDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(bundledDir, file), "utf-8");
        const tpl = JSON.parse(raw);
        if (tpl.name === name) return tpl.content;
      } catch { /* skip malformed */ }
    }
  } catch { /* bundled dir not available */ }

  // 2. Search local user templates (.jetro/templates/)
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const jetDir = path.join(WORKSPACE, ".jetro");
  const tplPath = path.join(jetDir, "templates", `${slug}.html`);
  try {
    return await fs.readFile(tplPath, "utf-8");
  } catch { /* not found */ }

  throw new Error(`Template not found: ${name}`);
}

/**
 * Extract a file path from frame data — agents may put it in different fields.
 * Returns the path string if found, or null if no file reference is present.
 */
function extractFilePath(data: Record<string, unknown>): string | null {
  // Explicit file field (preferred)
  if (typeof data.file === "string" && data.file) return data.file;
  // filePath variant
  if (typeof data.filePath === "string" && data.filePath) return data.filePath;
  // src field used as a file path (not a URL)
  if (typeof data.src === "string" && data.src && !data.src.startsWith("http")) {
    // Must look like a path (has extension or directory separator)
    if (data.src.includes("/") || data.src.includes(".")) return data.src;
  }
  return null;
}

/** Read active project slug from context.json (written by extension on canvas focus). */
function getActiveProjectSlug(): string | null {
  try {
    const ctx = JSON.parse(
      fsSync.readFileSync(path.join(WORKSPACE, ".jetro", "context.json"), "utf-8")
    );
    return ctx.activeProjectSlug || null;
  } catch {
    return null;
  }
}

let renderCounter = 0;

async function handleJetRender(args: {
  type: string;
  data: Record<string, unknown>;
  position?: { x: number; y: number };
  width?: number;
  id?: string;
  projectSlug?: string;
  refreshBinding?: { scriptPath: string; intervalMs?: number; sourceDomain?: string; bindingType?: string; refreshPrompt?: string; elementTitle?: string };
}): Promise<string> {
  renderCounter++;
  const id = args.id || `mcp-${Date.now()}-${renderCounter}`;

  // Normalize data — agents sometimes pass a JSON string instead of an object
  let data: Record<string, unknown> = typeof args.data === "string"
    ? (() => { try { return JSON.parse(args.data); } catch { return { html: args.data }; } })()
    : args.data;

  // File-based frame: read HTML from workspace file
  // Agents may use data.file, data.src (non-URL path), or data.filePath — normalize all
  if (args.type === "frame") {
    const filePath = extractFilePath(data);
    if (filePath) {
      const resolvedPath = path.resolve(WORKSPACE, filePath);
      assertContained(resolvedPath, WORKSPACE);

      try {
        const html = await fs.readFile(resolvedPath, "utf-8");
        // Replace file reference with actual HTML content, clean up path fields
        data = { ...data, html, file: undefined, filePath: undefined };
        // Keep src only if it was a URL, remove if it was used as a file path
        if (typeof data.src === "string" && !data.src.startsWith("http")) {
          data = { ...data, src: undefined };
        }
      } catch (err) {
        throw new Error(`Frame file not found: ${filePath}`);
      }
    }
  }

  const defaultWidths: Record<string, number> = { frame: 500, embed: 500 };
  const defaultHeights: Record<string, number> = { frame: 400, embed: 350 };
  const defaultWidth = defaultWidths[args.type] || 340;
  const defaultHeight = defaultHeights[args.type] || 200;
  // Log a warning if frame has no HTML content (helps debug blank frames)
  if (args.type === "frame" && !data.html) {
    console.error(`[jet_render] WARNING: Frame "${data.title || id}" has no HTML content. Keys in data: ${Object.keys(data).join(", ")}`);
  }

  // Auto-scale frame height for long content
  let autoHeight = defaultHeight;
  if (args.type === "frame" && typeof data.html === "string") {
    const lineCount = data.html.split("\n").length;
    if (lineCount > 200) autoHeight = Math.min(lineCount * 2, 2000);
  }

  const element: Record<string, unknown> = {
    id,
    type: args.type,
    data,
    position: args.position || { x: 40 + (renderCounter % 3) * 360, y: 40 + Math.floor(renderCounter / 3) * 300 },
    size: { width: args.width || defaultWidth, height: autoHeight },
    config: { width: args.width || defaultWidth, projectSlug: args.projectSlug },
  };

  // Include refreshBinding in element if provided (extension picks this up)
  if (args.refreshBinding?.scriptPath || args.refreshBinding?.refreshPrompt) {
    const rb: Record<string, unknown> = {
      bindingType: args.refreshBinding.bindingType || (args.refreshBinding.refreshPrompt ? "prompt" : "script"),
      intervalMs: args.refreshBinding.intervalMs || (args.refreshBinding.refreshPrompt ? 300000 : 120000), // 5min default for prompts
    };
    if (args.refreshBinding.scriptPath) rb.scriptPath = args.refreshBinding.scriptPath;
    if (args.refreshBinding.refreshPrompt) rb.refreshPrompt = args.refreshBinding.refreshPrompt;
    if (args.refreshBinding.elementTitle) rb.elementTitle = args.refreshBinding.elementTitle;
    if (args.refreshBinding.sourceDomain) rb.sourceDomain = args.refreshBinding.sourceDomain;
    element.refreshBinding = rb;
  }

  // Write to render_queue/ — the extension file watcher picks this up and renders it
  const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
  await ensureDir(renderDir);
  await fs.writeFile(
    path.join(renderDir, `${id}.json`),
    JSON.stringify(element, null, 2)
  );

  // If project specified, try to write canvas.json for persistence.
  // Best-effort only — render queue is the primary delivery path.
  if (args.projectSlug) {
    try {
      const safeSlug = sanitizeSegment(args.projectSlug);
      if (safeSlug) {
        const canvasPath = path.join(WORKSPACE, ".jetro", "projects", safeSlug, "canvas.json");
        assertContained(canvasPath, WORKSPACE);
        let canvasState: { elements: unknown[]; edges: unknown[]; viewport: { x: number; y: number; zoom: number }; name: string; refreshBindings?: unknown[] };
        try {
          const existing = await fs.readFile(canvasPath, "utf-8");
          canvasState = JSON.parse(existing);
        } catch {
          canvasState = { name: "Research Board", elements: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
        }
        canvasState.elements.push({
          ...element,
          connections: [],
        });

        if (args.refreshBinding?.scriptPath || args.refreshBinding?.refreshPrompt) {
          if (!canvasState.refreshBindings) canvasState.refreshBindings = [];
          const canvasBinding: Record<string, unknown> = {
            elementId: id,
            bindingType: args.refreshBinding.bindingType || (args.refreshBinding.refreshPrompt ? "prompt" : "script"),
            intervalMs: args.refreshBinding.intervalMs || (args.refreshBinding.refreshPrompt ? 300000 : 120000),
            enabled: true,
            createdAt: new Date().toISOString(),
          };
          if (args.refreshBinding.scriptPath) canvasBinding.scriptPath = args.refreshBinding.scriptPath;
          if (args.refreshBinding.refreshPrompt) canvasBinding.refreshPrompt = args.refreshBinding.refreshPrompt;
          if (args.refreshBinding.elementTitle) canvasBinding.elementTitle = args.refreshBinding.elementTitle;
          canvasState.refreshBindings.push(canvasBinding);
        }

        await ensureDir(path.dirname(canvasPath));
        await fs.writeFile(canvasPath, JSON.stringify(canvasState, null, 2));
      }
    } catch (err) {
      console.error(`[jet_render] Project canvas write failed (non-critical): ${err}`);
    }
  }

  const bindingType = args.refreshBinding?.bindingType || (args.refreshBinding?.refreshPrompt ? "prompt" : "script");
  const bindingMsg = (args.refreshBinding?.scriptPath || args.refreshBinding?.refreshPrompt)
    ? ` [${bindingType === "prompt" ? "AI LIVE" : "LIVE"}: ${args.refreshBinding.scriptPath || "prompt"} every ${((args.refreshBinding.intervalMs || (bindingType === "prompt" ? 300000 : 120000)) / 1000)}s]`
    : "";
  const updateMsg = args.id ? " (in-place update)" : "";
  return `Rendered ${args.type} "${args.data.title || id}" to canvas (id: ${id})${updateMsg}${bindingMsg}`;
}

async function handleJetSearch(args: {
  query: string;
  exchange?: string;
  limit?: number;
}): Promise<string> {
  const result = await apiCall("/api/data", {
    provider: "fmp",
    endpoint: "/search",
    params: {
      query: args.query,
      limit: String(args.limit ?? 10),
      ...(args.exchange ? { exchange: args.exchange } : {}),
    },
  });

  return JSON.stringify(result, null, 2);
}

async function handleJetCanvas(args: {
  action: string;
  canvasId?: string;
  elementId?: string;
  position?: { x: number; y: number };
  size?: { width?: number; height?: number };
  operations?: Array<{ elementId: string; position?: { x: number; y: number }; size?: { width?: number; height?: number } }>;
  refreshBinding?: { scriptPath?: string; intervalMs?: number; sourceDomain?: string; bindingType?: string; refreshPrompt?: string; elementTitle?: string };
  projectSlug?: string;
  timestamp?: number;
  sourceId?: string;
  targetId?: string;
  channel?: string;
  bidirectional?: boolean;
  wireId?: string;
}): Promise<string> {
  const { action, projectSlug } = args;

  console.error(`[jet_canvas] action=${action} canvasId=${args.canvasId ?? "(none)"} projectSlug=${projectSlug ?? "(none)"} elementId=${args.elementId ?? "(none)"} WORKSPACE=${WORKSPACE}`);

  // Helper to parse canvas registry (handles both flat array and { canvases: [...] } formats)
  function readRegistry(): Array<{ id: string; name?: string; projectSlug?: string | null }> {
    const registryPath = path.join(WORKSPACE, ".jetro", "canvas-registry.json");
    console.error(`[jet_canvas] readRegistry path=${registryPath}`);
    try {
      const raw = fsSync.readFileSync(registryPath, "utf-8");
      const registry = JSON.parse(raw);
      const entries = Array.isArray(registry) ? registry : (registry.canvases || []);
      console.error(`[jet_canvas] readRegistry found ${entries.length} entries: ${entries.map((e: { id: string }) => e.id).join(", ")}`);
      return entries;
    } catch (err) {
      console.error(`[jet_canvas] readRegistry FAILED: ${err}`);
      return [];
    }
  }

  // Helper to compute canvas file path from a registry entry
  function canvasPathFromEntry(entry: { id: string; projectSlug?: string | null }): string {
    if (entry.projectSlug) {
      return path.join(WORKSPACE, "projects", sanitizeSegment(entry.projectSlug), "canvases", `${entry.id}.json`);
    }
    return path.join(WORKSPACE, ".jetro", "canvases", `${entry.id}.json`);
  }

  // Helper to resolve canvas path
  function resolveCanvasPath(): string {
    let resolved: string;
    if (args.canvasId) {
      const entries = readRegistry();
      const entry = entries.find((c) => c.id === args.canvasId);
      if (entry) { resolved = canvasPathFromEntry(entry); }
      else { resolved = path.join(WORKSPACE, ".jetro", "canvases", `${args.canvasId}.json`); }
    } else if (projectSlug) {
      const entries = readRegistry();
      const entry = entries.find((c) => c.projectSlug === projectSlug);
      if (entry) { resolved = canvasPathFromEntry(entry); }
      else { resolved = path.join(WORKSPACE, "projects", sanitizeSegment(projectSlug), "canvases", `${projectSlug}.json`); }
    } else {
      // No canvasId, no projectSlug — find the first canvas from registry
      const entries = readRegistry();
      if (entries.length > 0) { resolved = canvasPathFromEntry(entries[0]); }
      else { resolved = path.join(WORKSPACE, ".jetro", "canvas.json"); }
    }
    const exists = fsSync.existsSync(resolved);
    console.error(`[jet_canvas] resolveCanvasPath → ${resolved} (exists=${exists})`);
    return resolved;
  }

  switch (action) {
    case "list": {
      // List all canvases from registry
      const entries = readRegistry();

      // Read active canvas context (written by extension on focus change)
      let activeCanvasId: string | null = null;
      try {
        const ctx = JSON.parse(fsSync.readFileSync(path.join(WORKSPACE, ".jetro", "context.json"), "utf-8"));
        activeCanvasId = ctx.activeCanvasId || null;
      } catch { /* no context file yet */ }

      if (entries.length > 0) {
        return JSON.stringify({
          canvases: entries.map((c) => ({
            id: c.id,
            name: c.name || c.id,
            projectSlug: c.projectSlug,
            isActive: c.id === activeCanvasId,
          })),
        }, null, 2);
      }
      // No registry — check for legacy default canvas
      const defaultPath = path.join(WORKSPACE, ".jetro", "canvas.json");
      try {
        await fs.access(defaultPath);
        return JSON.stringify({ canvases: [{ id: "default", name: "Research Board", isActive: "default" === activeCanvasId }] }, null, 2);
      } catch {
        return JSON.stringify({ canvases: [] }, null, 2);
      }
    }

    case "read": {
      const canvasPath = resolveCanvasPath();
      if (projectSlug) assertContained(canvasPath, WORKSPACE);

      try {
        const raw = await fs.readFile(canvasPath, "utf-8");
        console.error(`[jet_canvas] read: file size=${raw.length} bytes`);
        const state = JSON.parse(raw);
        const bindings = state.refreshBindings || [];
        console.error(`[jet_canvas] read: elements=${(state.elements || []).length} bindings=${bindings.length} keys=${Object.keys(state).join(",")}`);

        const elements = (state.elements || []).map((el: Record<string, unknown>) => {
          const data = (el.data || {}) as Record<string, unknown>;
          const binding = bindings.find((b: { elementId: string }) => b.elementId === el.id);
          return {
            id: el.id,
            type: el.type,
            position: el.position,
            size: el.size,
            title: data.title || data.name || data.ticker || el.type,
            refreshBinding: binding
              ? { scriptPath: binding.scriptPath, intervalMs: binding.intervalMs, enabled: binding.enabled, lastRun: binding.lastRun }
              : undefined,
          };
        });

        const c2 = state.c2 as Record<string, unknown> | undefined;
        return JSON.stringify({
          name: state.name || "Research Board",
          elementCount: elements.length,
          elements,
          edges: state.edges || [],
          c2: c2 ? { enabled: !!c2.enabled, wireCount: ((c2.wires as unknown[]) || []).length } : undefined,
        }, null, 2);
      } catch {
        return JSON.stringify({ name: "Research Board", elementCount: 0, elements: [], edges: [] });
      }
    }

    case "move": {
      if (!args.elementId) throw new Error("elementId is required for move");
      if (!args.position) throw new Error("position { x, y } is required for move");

      const cmdId = `cmd-${Date.now()}-${++renderCounter}`;
      const command = {
        command: "move",
        elementId: args.elementId,
        position: args.position,
        projectSlug,
      };

      const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
      await ensureDir(renderDir);
      await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify(command));

      return `Moved element ${args.elementId} to (${args.position.x}, ${args.position.y})`;
    }

    case "resize": {
      if (!args.elementId) throw new Error("elementId is required for resize");
      if (!args.size) throw new Error("size { width, height? } is required for resize");

      const cmdId = `cmd-${Date.now()}-${++renderCounter}`;
      const command = {
        command: "resize",
        elementId: args.elementId,
        size: args.size,
        projectSlug,
      };

      const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
      await ensureDir(renderDir);
      await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify(command));

      return `Resized element ${args.elementId} to ${args.size.width}${args.size.height ? `×${args.size.height}` : ""}`;
    }

    case "delete": {
      if (!args.elementId) throw new Error("elementId is required for delete");

      const cmdId = `cmd-${Date.now()}-${++renderCounter}`;
      const command = {
        command: "delete",
        elementId: args.elementId,
        projectSlug,
      };

      const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
      await ensureDir(renderDir);
      await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify(command));

      return `Deleted element ${args.elementId} from canvas`;
    }

    case "arrange": {
      if (!args.operations || args.operations.length === 0) {
        throw new Error("operations array is required for arrange");
      }

      const cmdId = `cmd-${Date.now()}-${++renderCounter}`;
      const command = {
        command: "arrange",
        operations: args.operations,
        projectSlug,
      };

      const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
      await ensureDir(renderDir);
      await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify(command));

      return `Arranged ${args.operations.length} elements on canvas`;
    }

    case "bind": {
      if (!args.elementId) throw new Error("bind requires elementId");
      const isPromptBinding = args.refreshBinding?.bindingType === "prompt" || !!args.refreshBinding?.refreshPrompt;
      if (!isPromptBinding && !args.refreshBinding?.scriptPath) throw new Error("bind requires refreshBinding.scriptPath (for script bindings) or refreshBinding.refreshPrompt (for prompt bindings)");

      const canvasPath = resolveCanvasPath();
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(await fs.readFile(canvasPath, "utf-8"));
      } catch {
        throw new Error("Canvas not found — render elements first");
      }

      const bindType = isPromptBinding ? "prompt" : "script";
      const binding: Record<string, unknown> = {
        elementId: args.elementId,
        bindingType: bindType,
        intervalMs: args.refreshBinding!.intervalMs || (isPromptBinding ? 300000 : 120000),
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      if (args.refreshBinding!.scriptPath) binding.scriptPath = args.refreshBinding!.scriptPath;
      if (args.refreshBinding!.refreshPrompt) binding.refreshPrompt = args.refreshBinding!.refreshPrompt;
      if (args.refreshBinding!.elementTitle) binding.elementTitle = args.refreshBinding!.elementTitle;
      if (args.refreshBinding!.sourceDomain) {
        binding.sourceDomain = args.refreshBinding!.sourceDomain;
        binding.consecutiveSuccesses = 0;
        binding.patternSubmitted = false;
      }

      // Composite key: elementId:bindingType — allows script+prompt on same element
      const bindings = (state.refreshBindings || []) as Array<Record<string, unknown>>;
      const idx = bindings.findIndex(b => b.elementId === args.elementId && (b.bindingType || "script") === bindType);
      if (idx >= 0) bindings[idx] = binding;
      else bindings.push(binding);
      state.refreshBindings = bindings;

      await fs.writeFile(canvasPath, JSON.stringify(state, null, 2));

      // Auto-detect if script needs scraping venv (only for script bindings)
      let needsVenv = false;
      if (binding.scriptPath) {
        const scriptFullPath = path.join(WORKSPACE, binding.scriptPath as string);
        try {
          const scriptContent = await fs.readFile(scriptFullPath, "utf-8");
          needsVenv = /import\s+(playwright|bs4|beautifulsoup4|lxml|selenium)|from\s+(playwright|bs4|beautifulsoup4|lxml)/.test(scriptContent);
        } catch { /* script not yet written — that's ok */ }
      }

      const venvPython = path.join(WORKSPACE, ".jetro", "venv", "bin", "python3");
      const venvExists = await fs.access(venvPython).then(() => true).catch(() => false);

      // Write bind command so the extension picks it up
      const cmdId = `cmd-${Date.now()}-${++renderCounter}`;
      const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
      await ensureDir(renderDir);
      await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify({
        command: "bind",
        elementId: args.elementId,
        refreshBinding: binding,
        projectSlug,
      }));

      // If script needs venv and it doesn't exist, signal setup
      if (needsVenv && !venvExists) {
        const setupCmdId = `cmd-${Date.now()}-${++renderCounter}`;
        await fs.writeFile(path.join(renderDir, `${setupCmdId}.json`), JSON.stringify({
          command: "setupVenv",
        }));
      }

      return JSON.stringify({ bound: args.elementId, bindingType: binding.bindingType, scriptPath: binding.scriptPath, refreshPrompt: binding.refreshPrompt, intervalMs: binding.intervalMs, needsVenv: needsVenv && !venvExists });
    }

    case "unbind": {
      if (!args.elementId) throw new Error("unbind requires elementId");

      const canvasPath = resolveCanvasPath();
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(await fs.readFile(canvasPath, "utf-8"));
      } catch {
        throw new Error("Canvas not found");
      }

      const bindings = (state.refreshBindings || []) as Array<{ elementId: string }>;
      state.refreshBindings = bindings.filter(b => b.elementId !== args.elementId);
      await fs.writeFile(canvasPath, JSON.stringify(state, null, 2));

      // Notify extension
      const cmdId = `cmd-${Date.now()}-${++renderCounter}`;
      const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
      await ensureDir(renderDir);
      await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify({
        command: "unbind",
        elementId: args.elementId,
        projectSlug,
      }));

      return JSON.stringify({ unbound: args.elementId });
    }

    case "bindings": {
      const canvasPath = resolveCanvasPath();
      try {
        const state = JSON.parse(await fs.readFile(canvasPath, "utf-8"));
        return JSON.stringify({ bindings: state.refreshBindings || [] }, null, 2);
      } catch {
        return JSON.stringify({ bindings: [] });
      }
    }

    case "trigger": {
      if (!args.elementId) throw new Error("trigger requires elementId");

      // Write a trigger command for the extension to pick up
      const cmdId = `cmd-${Date.now()}-${++renderCounter}`;
      const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
      await ensureDir(renderDir);
      await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify({
        command: "trigger",
        elementId: args.elementId,
        projectSlug,
      }));

      return JSON.stringify({ triggered: args.elementId });
    }

    case "history": {
      // List version history for a canvas
      const entries = readRegistry();
      let canvasEntry: { id: string; projectSlug?: string | null } | undefined;
      if (args.canvasId) {
        canvasEntry = entries.find((c) => c.id === args.canvasId);
      } else if (projectSlug) {
        canvasEntry = entries.find((c) => c.projectSlug === projectSlug);
      } else {
        canvasEntry = entries[0];
      }
      if (!canvasEntry) return JSON.stringify({ versions: [], error: "Canvas not found" });

      const histDir = canvasEntry.projectSlug
        ? path.join(WORKSPACE, "projects", sanitizeSegment(canvasEntry.projectSlug as string), "canvases", `${canvasEntry.id}.history`)
        : path.join(WORKSPACE, ".jetro", "canvases", `${canvasEntry.id}.history`);

      try {
        const files = (await fs.readdir(histDir))
          .filter((f: string) => f.startsWith("v_") && f.endsWith(".json"))
          .sort()
          .reverse(); // newest first

        const versions = [];
        for (const f of files.slice(0, 20)) {
          const match = f.match(/v_(\d+)\.json/);
          if (!match) continue;
          const ts = parseInt(match[1], 10);
          try {
            const raw = await fs.readFile(path.join(histDir, f), "utf-8");
            const state = JSON.parse(raw);
            versions.push({
              timestamp: ts,
              date: new Date(ts).toISOString(),
              elementCount: (state.elements || []).length,
              edgeCount: (state.edges || []).length,
            });
          } catch {
            versions.push({ timestamp: ts, date: new Date(ts).toISOString(), elementCount: "?", edgeCount: "?" });
          }
        }
        return JSON.stringify({ canvasId: canvasEntry.id, versions }, null, 2);
      } catch {
        return JSON.stringify({ canvasId: canvasEntry.id, versions: [] });
      }
    }

    case "restore": {
      // Restore a specific version by timestamp
      const entries = readRegistry();
      let canvasEntry: { id: string; projectSlug?: string | null } | undefined;
      if (args.canvasId) {
        canvasEntry = entries.find((c) => c.id === args.canvasId);
      } else if (projectSlug) {
        canvasEntry = entries.find((c) => c.projectSlug === projectSlug);
      } else {
        canvasEntry = entries[0];
      }
      if (!canvasEntry) throw new Error("Canvas not found");

      const restoreHistDir = canvasEntry.projectSlug
        ? path.join(WORKSPACE, "projects", sanitizeSegment(canvasEntry.projectSlug as string), "canvases", `${canvasEntry.id}.history`)
        : path.join(WORKSPACE, ".jetro", "canvases", `${canvasEntry.id}.history`);

      if (args.timestamp) {
        const versionFile = path.join(restoreHistDir, `v_${args.timestamp}.json`);
        try {
          const versionData = await fs.readFile(versionFile, "utf-8");
          const versionState = JSON.parse(versionData);

          // Snapshot current before overwriting
          const currentPath = canvasPathFromEntry(canvasEntry);
          try {
            const currentData = await fs.readFile(currentPath, "utf-8");
            const currentState = JSON.parse(currentData);
            if (currentState.elements && currentState.elements.length > 0) {
              await ensureDir(restoreHistDir);
              await fs.writeFile(path.join(restoreHistDir, `v_${Date.now()}.json`), currentData);
            }
          } catch { /* no current state */ }

          // Write restored version
          await fs.writeFile(currentPath, JSON.stringify(versionState, null, 2));

          // Notify extension via render queue
          const cmdId = `cmd-${Date.now()}-${++renderCounter}`;
          const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
          await ensureDir(renderDir);
          await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify({
            command: "restore",
            canvasId: canvasEntry.id,
            projectSlug: canvasEntry.projectSlug || undefined,
          }));

          return JSON.stringify({
            restored: true,
            canvasId: canvasEntry.id,
            timestamp: args.timestamp,
            elementCount: (versionState.elements || []).length,
          });
        } catch {
          throw new Error(`Version v_${args.timestamp} not found`);
        }
      } else {
        // No timestamp — find most recent version with elements
        try {
          const files = (await fs.readdir(restoreHistDir))
            .filter((f: string) => f.startsWith("v_") && f.endsWith(".json"))
            .sort()
            .reverse();
          for (const f of files) {
            const raw = await fs.readFile(path.join(restoreHistDir, f), "utf-8");
            const state = JSON.parse(raw);
            if (state.elements && state.elements.length > 0) {
              const match = f.match(/v_(\d+)\.json/);
              const ts = match ? parseInt(match[1], 10) : 0;
              // Recurse with timestamp
              args.timestamp = ts;
              return handleJetCanvas(args);
            }
          }
        } catch { /* no history dir */ }
        throw new Error("No version with elements found in history");
      }
    }

    case "enableC2":
    case "disableC2": {
      // C2 mode toggle — project canvases only
      const canvasPath = resolveCanvasPath();
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(await fs.readFile(canvasPath, "utf-8"));
      } catch {
        throw new Error("Canvas not found — create it first");
      }

      // Check this is a project canvas
      const entries = readRegistry();
      const entry = entries.find((c) => {
        if (args.canvasId) return c.id === args.canvasId;
        if (projectSlug) return c.projectSlug === projectSlug;
        return false;
      });
      if (!entry?.projectSlug) {
        throw new Error("C2 mode is only available on project canvases");
      }

      const enabling = action === "enableC2";
      const c2 = (state.c2 || {}) as Record<string, unknown>;
      c2.enabled = enabling;
      if (enabling && !c2.wires) c2.wires = [];
      state.c2 = c2;
      await fs.writeFile(canvasPath, JSON.stringify(state, null, 2));

      // Notify extension via render queue
      const cmdId = `cmd-${Date.now()}-${++renderCounter}`;
      const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
      await ensureDir(renderDir);
      await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify({
        command: "c2Toggle",
        canvasId: entry.id,
        enabled: enabling,
        projectSlug: entry.projectSlug,
      }));

      return JSON.stringify({ c2Enabled: enabling, canvasId: entry.id });
    }

    case "addWire": {
      if (!args.sourceId) throw new Error("addWire requires sourceId");
      if (!args.targetId) throw new Error("addWire requires targetId");
      if (!args.channel) throw new Error("addWire requires channel");

      const canvasPath = resolveCanvasPath();
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(await fs.readFile(canvasPath, "utf-8"));
      } catch {
        throw new Error("Canvas not found");
      }

      const c2 = (state.c2 || {}) as Record<string, unknown>;
      if (!c2.enabled) throw new Error("C2 mode is not enabled on this canvas — call enableC2 first");

      const wires = (c2.wires || []) as Array<Record<string, unknown>>;
      const wireId = `wire-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const wire = {
        id: wireId,
        sourceId: args.sourceId,
        targetId: args.targetId,
        channel: args.channel,
        bidirectional: args.bidirectional || false,
      };
      wires.push(wire);
      c2.wires = wires;
      state.c2 = c2;

      // Also add as a ReactFlow edge
      const edges = (state.edges || []) as Array<Record<string, unknown>>;
      edges.push({
        id: wireId,
        source: args.sourceId,
        target: args.targetId,
        type: "wire",
        data: { channel: args.channel, bidirectional: args.bidirectional || false },
      });
      state.edges = edges;

      await fs.writeFile(canvasPath, JSON.stringify(state, null, 2));

      // Notify extension
      const cmdId = `cmd-${Date.now()}-${++renderCounter}`;
      const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
      await ensureDir(renderDir);
      await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify({
        command: "addWire",
        canvasId: args.canvasId,
        wire,
        projectSlug,
      }));

      return JSON.stringify({ wireId, channel: args.channel, sourceId: args.sourceId, targetId: args.targetId });
    }

    case "removeWire": {
      if (!args.wireId) throw new Error("removeWire requires wireId");

      const canvasPath = resolveCanvasPath();
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(await fs.readFile(canvasPath, "utf-8"));
      } catch {
        throw new Error("Canvas not found");
      }

      const c2 = (state.c2 || {}) as Record<string, unknown>;
      const wires = (c2.wires || []) as Array<Record<string, unknown>>;
      c2.wires = wires.filter((w) => w.id !== args.wireId);
      state.c2 = c2;

      // Also remove the ReactFlow edge
      const edges = (state.edges || []) as Array<Record<string, unknown>>;
      state.edges = edges.filter((e) => e.id !== args.wireId);

      await fs.writeFile(canvasPath, JSON.stringify(state, null, 2));

      // Notify extension
      const cmdId = `cmd-${Date.now()}-${++renderCounter}`;
      const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
      await ensureDir(renderDir);
      await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify({
        command: "removeWire",
        canvasId: args.canvasId,
        wireId: args.wireId,
        projectSlug,
      }));

      return JSON.stringify({ removed: args.wireId });
    }

    case "listWires": {
      const canvasPath = resolveCanvasPath();
      try {
        const state = JSON.parse(await fs.readFile(canvasPath, "utf-8"));
        const c2 = state.c2 || {};
        return JSON.stringify({
          c2Enabled: !!c2.enabled,
          wires: c2.wires || [],
          framePorts: c2.framePorts || {},
        }, null, 2);
      } catch {
        return JSON.stringify({ c2Enabled: false, wires: [], framePorts: {} });
      }
    }

    default:
      throw new Error(`Unknown canvas action: ${action}`);
  }
}

async function handleJetSave(args: {
  type: string;
  name: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  // File tree layout must match the extension's FileManager:
  //   data/stocks/{ticker}/{dataType}.json
  //   data/lists/{slug}.json
  //   projects/{slug}/portfolio.json  (portfolio-mode projects)
  //   projects/{slug}/project.json, canvas.json, thesis.md, notes/
  //   .jetro/recipes/{slug}.json
  //   .jetro/elements/{slug}.json
  //   .jetro/datasources/{slug}.json
  //   .jetro/config.yaml, templates/

  const jetDir = path.join(WORKSPACE, ".jetro");
  const slug = slugify(args.name);

  let filePath: string;

  switch (args.type) {
    case "stock": {
      const ticker = sanitizeSegment(args.name);
      const dataType = sanitizeSegment((args.payload.dataType as string) ?? "profile");
      if (!ticker || !dataType) {
        throw new Error("Invalid ticker or dataType");
      }
      const stockDir = path.join(WORKSPACE, "data", "stocks", ticker);
      await ensureDir(stockDir);
      filePath = path.join(stockDir, `${dataType}.json`);
      assertContained(filePath, WORKSPACE);
      break;
    }
    case "list": {
      const listDir = path.join(WORKSPACE, "data", "lists");
      await ensureDir(listDir);
      filePath = path.join(listDir, `${slug}.json`);

      // Normalize: agents may send payload.stocks (array of objects with .ticker)
      // instead of payload.tickers (flat string array). Handle both.
      if (!args.payload.tickers && Array.isArray(args.payload.stocks)) {
        const stocks = args.payload.stocks as Array<{ ticker?: string } | string>;
        args.payload.tickers = stocks
          .map((s: { ticker?: string } | string) => (typeof s === "string" ? s : s?.ticker || ""))
          .filter(Boolean);
      }
      // Ensure required JETList fields exist
      if (!args.payload.name) args.payload.name = args.name;
      if (!args.payload.createdAt) args.payload.createdAt = new Date().toISOString();
      if (args.payload.refreshable === undefined) {
        args.payload.refreshable = !!(args.payload.criteria || args.payload.recipeSlug || args.payload.scriptPath);
      }
      if (!args.payload.refreshInterval && args.payload.refreshable) {
        args.payload.refreshInterval = "manual";
      }
      // Mark refreshable if columns are provided (enables deterministic refresh)
      if (args.payload.columns && !args.payload.refreshable) {
        args.payload.refreshable = true;
        if (!args.payload.refreshInterval) args.payload.refreshInterval = "manual";
      }
      // Merge with existing list to preserve canvasElementId, columns, thesis, etc.
      try {
        const existingRaw = await fs.readFile(path.join(WORKSPACE, "data", "lists", `${slug}.json`), "utf-8");
        const existing = JSON.parse(existingRaw);
        if (!args.payload.canvasElementId && existing.canvasElementId) {
          args.payload.canvasElementId = existing.canvasElementId;
        }
        if (!args.payload.thesis && existing.thesis) {
          args.payload.thesis = existing.thesis;
        }
        if (!args.payload.columns && existing.columns) {
          args.payload.columns = existing.columns;
        }
        if (!args.payload.lastRefreshed && existing.lastRefreshed) {
          args.payload.lastRefreshed = existing.lastRefreshed;
        }
      } catch {
        // No existing list — that's fine
      }
      break;
    }
    case "project": {
      const projDir = path.join(WORKSPACE, "projects", slug);
      await ensureDir(projDir);
      await ensureDir(path.join(projDir, "notes"));
      await ensureDir(path.join(projDir, "sources"));
      filePath = path.join(projDir, "project.json");
      // Merge with existing project to preserve linkedConnections, linkedTemplates, linkedRecipes, etc.
      try {
        const existingRaw = await fs.readFile(filePath, "utf-8");
        const existing = JSON.parse(existingRaw);
        for (const key of ["linkedConnections", "linkedTemplates", "linkedRecipes", "securities", "sources"]) {
          if (!args.payload[key] && existing[key]) {
            args.payload[key] = existing[key];
          }
        }
      } catch { /* No existing project */ }
      break;
    }
    case "preference": {
      await ensureDir(jetDir);
      filePath = path.join(jetDir, "config.yaml");
      break;
    }
    case "element": {
      const elemDir = path.join(jetDir, "elements");
      await ensureDir(elemDir);
      filePath = path.join(elemDir, `${slug}.json`);
      break;
    }
    case "recipe": {
      const recipeDir = path.join(jetDir, "recipes");
      await ensureDir(recipeDir);
      filePath = path.join(recipeDir, `${slug}.json`);
      break;
    }
    case "datasource": {
      const dsDir = path.join(jetDir, "datasources");
      await ensureDir(dsDir);
      filePath = path.join(dsDir, `${slug}.json`);
      break;
    }
    case "portfolio": {
      const portDir = path.join(WORKSPACE, "projects", slug);
      await ensureDir(portDir);
      filePath = path.join(portDir, "portfolio.json");
      // Auto-create project.json with portfolio mode if missing
      const projJsonPath = path.join(portDir, "project.json");
      try {
        await fs.access(projJsonPath);
      } catch {
        const project = {
          name: args.name, slug, status: "active", mode: "portfolio",
          securities: [], sources: [],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        await fs.writeFile(projJsonPath, JSON.stringify(project, null, 2));
      }
      break;
    }
    case "template": {
      const tplDir = path.join(jetDir, "templates");
      await ensureDir(tplDir);
      filePath = path.join(tplDir, `${slug}.html`);
      break;
    }
    default: {
      const safeType = sanitizeSegment(args.type);
      if (!safeType) {
        throw new Error("Invalid save type");
      }
      const defaultDir = path.join(jetDir, safeType);
      await ensureDir(defaultDir);
      filePath = path.join(defaultDir, `${slug}.json`);
    }
  }

  assertContained(filePath, WORKSPACE);
  await fs.writeFile(filePath, JSON.stringify(args.payload, null, 2));
  return `Saved ${args.type} "${args.name}" → ${path.relative(WORKSPACE, filePath)}`;
}

// ── jet_parse handler ──

const PARSEABLE_EXTENSIONS = new Set([
  ".pdf",
  ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
  ".html", ".htm",
  ".epub", ".rtf",
  ".eml", ".msg",
  ".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp",
  ".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".xml",
]);

const TEXT_PASSTHROUGH = new Set([
  ".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".xml",
]);

const FORMAT_MAP: Record<string, string> = {
  ".pdf": "pdf",
  ".docx": "docx", ".doc": "docx",
  ".pptx": "pptx", ".ppt": "pptx",
  ".xlsx": "xlsx", ".xls": "xlsx",
  ".html": "html", ".htm": "html",
  ".epub": "epub", ".rtf": "rtf",
  ".eml": "email", ".msg": "email",
  ".png": "image", ".jpg": "image", ".jpeg": "image",
  ".tiff": "image", ".bmp": "image", ".webp": "image",
  ".md": "text", ".txt": "text", ".csv": "text",
  ".json": "text", ".yaml": "text", ".yml": "text", ".xml": "text",
};

const PARSE_SCRIPT = `
import sys, json, os

def parse_page_range(spec, total):
    if not spec or spec == "all":
        return list(range(total))
    pages = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            start, end = part.split("-", 1)
            start = max(1, int(start))
            end = min(total, int(end))
            pages.update(range(start - 1, end))
        else:
            p = int(part)
            if 1 <= p <= total:
                pages.add(p - 1)
    return sorted(pages)

def parse_pdf(file_path, options):
    import pymupdf
    import pymupdf4llm

    doc = pymupdf.open(file_path)
    page_count = len(doc)

    pages = None
    if options.get("pages"):
        pages = parse_page_range(options["pages"], page_count)

    md = pymupdf4llm.to_markdown(file_path, pages=pages)

    table_count = 0
    for page in doc:
        try:
            tables = page.find_tables()
            table_count += len(tables.tables)
        except Exception:
            pass
    doc.close()

    title = os.path.splitext(os.path.basename(file_path))[0]
    return md, {"title": title, "pages": page_count, "tables": table_count}

def parse_pdf_ocr(file_path, options):
    import pymupdf
    from rapidocr_onnxruntime import RapidOCR

    ocr = RapidOCR()
    doc = pymupdf.open(file_path)
    page_count = len(doc)
    pages = parse_page_range(options.get("pages"), page_count) if options.get("pages") else range(page_count)

    text_parts = []
    for page_num in pages:
        page = doc[page_num]
        text = page.get_text().strip()
        if len(text) > 50:
            text_parts.append(text)
        else:
            pix = page.get_pixmap(dpi=300)
            img_bytes = pix.tobytes("png")
            result, _ = ocr(img_bytes)
            if result:
                text_parts.append("\\n".join([line[1] for line in result]))

    doc.close()
    md = "\\n\\n---\\n\\n".join(text_parts)
    title = os.path.splitext(os.path.basename(file_path))[0]
    return md, {"title": title, "pages": page_count, "tables": 0}

def parse_office(file_path, options):
    from markitdown import MarkItDown

    mid = MarkItDown()
    result = mid.convert(file_path)
    md = result.text_content
    title = getattr(result, "title", "") or os.path.splitext(os.path.basename(file_path))[0]
    return md, {"title": title, "pages": None, "tables": 0}

def parse_image_ocr(file_path, options):
    from rapidocr_onnxruntime import RapidOCR

    ocr = RapidOCR()
    result, _ = ocr(file_path)
    if result:
        md = "\\n".join([line[1] for line in result])
    else:
        md = "(No text detected in image)"
    title = os.path.splitext(os.path.basename(file_path))[0]
    return md, {"title": title, "pages": None, "tables": 0}

def main():
    file_path = sys.argv[1]
    options = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    ext = os.path.splitext(file_path)[1].lower()
    file_size = os.path.getsize(file_path)

    PDF_EXTS = {".pdf"}
    OFFICE_EXTS = {".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".html", ".htm", ".epub", ".rtf", ".eml", ".msg"}
    IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp"}

    try:
        if ext in PDF_EXTS:
            if options.get("ocr"):
                md, meta = parse_pdf_ocr(file_path, options)
            else:
                md, meta = parse_pdf(file_path, options)
        elif ext in OFFICE_EXTS:
            md, meta = parse_office(file_path, options)
        elif ext in IMAGE_EXTS:
            md, meta = parse_image_ocr(file_path, options)
        else:
            print(json.dumps({"error": "Unsupported format: " + ext}))
            sys.exit(1)
    except ImportError as e:
        module = str(e).split("'")[1] if "'" in str(e) else str(e)
        pkg_map = {
            "pymupdf4llm": "pymupdf4llm", "fitz": "pymupdf", "pymupdf": "pymupdf",
            "markitdown": "markitdown[docx,pptx,xlsx]",
            "rapidocr_onnxruntime": "rapidocr-onnxruntime",
        }
        pkg = pkg_map.get(module, module)
        print(json.dumps({"error": "Missing library: " + module + ". Install with: pip install " + pkg}))
        sys.exit(1)

    word_count = len(md.split()) if md else 0
    meta["wordCount"] = word_count
    meta["fileSize"] = file_size
    meta.setdefault("title", "")
    meta.setdefault("pages", None)
    meta.setdefault("tables", 0)

    print(json.dumps({"markdown": md, "meta": meta}))

if __name__ == "__main__":
    main()
`.trim();

async function handleJetDeploy(args: {
  action: string;
  projectSlug: string;
}): Promise<string> {
  const { action, projectSlug } = args;
  if (!projectSlug) throw new Error("projectSlug is required");

  // Write deploy command to render_queue — extension's file watcher picks it up
  const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
  await ensureDir(renderDir);
  const cmdId = `deploy-${Date.now()}`;
  const command = {
    command: "deploy",
    action,
    projectSlug,
    id: cmdId,
  };
  await fs.writeFile(
    path.join(renderDir, `${cmdId}.json`),
    JSON.stringify(command, null, 2)
  );

  // Wait for result (extension writes result file)
  const resultPath = path.join(renderDir, `result-${cmdId}.json`);
  const maxWait = action === "start" || action === "redeploy" ? 300_000 : 30_000;
  const pollInterval = 500;
  let waited = 0;
  while (waited < maxWait) {
    await new Promise((r) => setTimeout(r, pollInterval));
    waited += pollInterval;
    try {
      const result = await fs.readFile(resultPath, "utf-8");
      try { await fs.unlink(resultPath); } catch { /* ignore */ }
      return result;
    } catch {
      // Not ready yet
    }
  }

  return JSON.stringify({ error: "Deploy command timed out" });
}

async function handleJetShare(args: {
  action: string;
  title?: string;
  elementIds?: string[];
  shareId?: string;
  elementId?: string;
  canvasId?: string;
}): Promise<string> {
  const cmdId = `share-${Date.now()}-${++renderCounter}`;

  // Resolve canvas ID
  let canvasId = args.canvasId;
  if (!canvasId) {
    try {
      const registryPath = path.join(WORKSPACE, ".jetro", "canvas-registry.json");
      const raw = fsSync.readFileSync(registryPath, "utf-8");
      const registry = JSON.parse(raw);
      const entries = Array.isArray(registry) ? registry : (registry.canvases || []);
      if (entries.length > 0) {
        canvasId = entries[0].id;
      }
    } catch { /* no registry */ }
  }

  // Build the command for the extension's render queue handler
  const command: Record<string, unknown> = {
    command: "share",
    action: args.action,
    cmdId,
    canvasId,
  };

  if (args.title) command.title = args.title;
  if (args.elementIds) command.elementIds = args.elementIds;
  if (args.shareId) command.shareId = args.shareId;
  if (args.elementId) command.elementId = args.elementId;

  // Write command to render queue
  const renderDir = path.join(WORKSPACE, ".jetro", "render_queue");
  await ensureDir(renderDir);
  await fs.writeFile(path.join(renderDir, `${cmdId}.json`), JSON.stringify(command));

  // Poll for result (extension writes result-{cmdId}.json after handling)
  const resultPath = path.join(renderDir, `result-${cmdId}.json`);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const result = await fs.readFile(resultPath, "utf-8");
      await fs.unlink(resultPath).catch(() => {});
      return result;
    } catch {
      // Not ready yet
    }
  }

  return JSON.stringify({ error: "Share command timed out — is the extension running?" });
}

async function handleJetParse(args: {
  file: string;
  projectSlug?: string;
  outputName?: string;
  options?: { ocr?: boolean; pages?: string };
}): Promise<string> {
  const { file, projectSlug, outputName, options } = args;

  // 1. Resolve absolute file path
  const absolutePath = path.isAbsolute(file)
    ? file
    : path.resolve(WORKSPACE, file);
  assertContained(absolutePath, WORKSPACE);

  // Validate extension
  const ext = path.extname(absolutePath).toLowerCase();
  if (!PARSEABLE_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported format: ${ext}. Supported: ${[...PARSEABLE_EXTENSIONS].join(", ")}`
    );
  }

  // Check file exists
  try {
    await fs.access(absolutePath);
  } catch {
    throw new Error(`File not found: ${file}`);
  }

  const format = FORMAT_MAP[ext] || "unknown";
  const baseName = outputName || path.basename(absolutePath, ext);
  const sourceFileName = path.basename(absolutePath);

  // 2. Copy original to sources directory
  let sourcesDir: string;
  if (projectSlug) {
    const safeSlug = sanitizeSegment(projectSlug);
    sourcesDir = path.join(WORKSPACE, "projects", safeSlug, "sources");
  } else {
    sourcesDir = path.join(WORKSPACE, ".jetro", "sources");
  }
  await ensureDir(sourcesDir);
  const sourcePath = path.join(sourcesDir, sourceFileName);
  assertContained(sourcePath, WORKSPACE);
  await fs.copyFile(absolutePath, sourcePath);

  // 3. Text passthrough — no Python needed
  if (TEXT_PASSTHROUGH.has(ext)) {
    const markdown = await fs.readFile(absolutePath, "utf-8");
    const wordCount = markdown.split(/\s+/).filter(Boolean).length;
    const stat = await fs.stat(absolutePath);

    let notesDir: string;
    if (projectSlug) {
      const safeSlug = sanitizeSegment(projectSlug);
      notesDir = path.join(WORKSPACE, "projects", safeSlug, "notes");
    } else {
      notesDir = path.join(WORKSPACE, ".jetro", "notes");
    }
    await ensureDir(notesDir);
    const outputPath = path.join(notesDir, `${baseName}.md`);
    assertContained(outputPath, WORKSPACE);
    await fs.writeFile(outputPath, markdown);

    if (projectSlug) {
      const safeSlug = sanitizeSegment(projectSlug);
      const projPath = path.join(WORKSPACE, "projects", safeSlug, "project.json");
      try {
        const projRaw = await fs.readFile(projPath, "utf-8");
        const project = JSON.parse(projRaw);
        if (project.sources && !project.sources.includes(sourceFileName)) {
          project.sources.push(sourceFileName);
          project.updatedAt = new Date().toISOString();
          await fs.writeFile(projPath, JSON.stringify(project, null, 2));
        }
      } catch { /* non-critical */ }
    }

    return JSON.stringify({
      outputPath: path.relative(WORKSPACE, outputPath),
      sourcePath: path.relative(WORKSPACE, sourcePath),
      title: baseName,
      format,
      wordCount,
      fileSize: stat.size,
    }, null, 2);
  }

  // 4. Resolve Python interpreter — prefer managed venv
  const { exec } = await import("node:child_process");
  const venvPython = path.join(WORKSPACE, ".jetro", "venv", "bin", "python3");
  let pythonBin = "python3";
  try {
    await fs.access(venvPython);
    pythonBin = venvPython;
  } catch { /* fall back to system python3 */ }

  // Ensure parse deps are installed
  try {
    await new Promise<void>((resolve, reject) => {
      exec(`"${pythonBin}" -c "import pymupdf"`, { timeout: 5000 }, (err) => err ? reject(err) : resolve());
    });
  } catch {
    const venvPip = path.join(WORKSPACE, ".jetro", "venv", "bin", "pip");
    try {
      await fs.access(venvPip);
      await new Promise<void>((resolve, reject) => {
        exec(
          `"${venvPip}" install pymupdf pymupdf4llm "markitdown[docx,pptx,xlsx]" rapidocr-onnxruntime`,
          { timeout: 120000, cwd: WORKSPACE },
          (err) => err ? reject(err) : resolve()
        );
      });
    } catch {
      // No venv pip available — deps must be installed manually
    }
  }

  // 5. Write parse script to temp file
  const scriptsDir = path.join(WORKSPACE, ".jetro", "scripts");
  await ensureDir(scriptsDir);
  const scriptPath = path.join(scriptsDir, "_jet_parse_runner.py");
  await fs.writeFile(scriptPath, PARSE_SCRIPT);

  // 6. Execute parse script
  const optionsJson = JSON.stringify(options || {});

  const stdout = await new Promise<string>((resolve, reject) => {
    exec(
      `"${pythonBin}" "${scriptPath}" "${absolutePath}" '${optionsJson}'`,
      {
        cwd: WORKSPACE,
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      },
      (err, out, stderr) => {
        if (err) {
          reject(new Error(`Parse failed: ${stderr || err.message}`));
        } else {
          resolve(out);
        }
      }
    );
  });

  // 7. Parse output
  let parsed: { markdown?: string; error?: string; meta?: { title?: string; pages?: number; tables?: number; wordCount?: number; fileSize?: number } };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      "Parse script returned invalid JSON. Raw output:\n" + stdout.substring(0, 500)
    );
  }

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  if (!parsed.markdown) {
    throw new Error("Parse script returned empty markdown");
  }

  // 8. Write parsed markdown to notes directory
  let notesDir: string;
  if (projectSlug) {
    const safeSlug = sanitizeSegment(projectSlug);
    notesDir = path.join(WORKSPACE, "projects", safeSlug, "notes");
  } else {
    notesDir = path.join(WORKSPACE, ".jetro", "notes");
  }
  await ensureDir(notesDir);
  const outputPath = path.join(notesDir, `${baseName}.md`);
  assertContained(outputPath, WORKSPACE);
  await fs.writeFile(outputPath, parsed.markdown);

  // 9. Update project.sources[] if applicable
  if (projectSlug) {
    const safeSlug = sanitizeSegment(projectSlug);
    const projPath = path.join(WORKSPACE, "projects", safeSlug, "project.json");
    try {
      const projRaw = await fs.readFile(projPath, "utf-8");
      const project = JSON.parse(projRaw);
      if (project.sources && !project.sources.includes(sourceFileName)) {
        project.sources.push(sourceFileName);
        project.updatedAt = new Date().toISOString();
        await fs.writeFile(projPath, JSON.stringify(project, null, 2));
      }
    } catch {
      // Non-critical
    }
  }

  // 10. Clean up temp script
  try {
    await fs.unlink(scriptPath);
  } catch {
    // Non-critical
  }

  const meta = parsed.meta || {};
  const result = {
    outputPath: path.relative(WORKSPACE, outputPath),
    sourcePath: path.relative(WORKSPACE, sourcePath),
    pageCount: meta.pages ?? undefined,
    title: meta.title || baseName,
    tables: meta.tables ?? undefined,
    format,
    wordCount: meta.wordCount ?? undefined,
    fileSize: meta.fileSize ?? undefined,
  };

  return JSON.stringify(result, null, 2);
}

// ── jet_query Handler ──

/**
 * Open DuckDB for the duration of fn, then close.
 * No persistent connection — prevents lock conflicts with extension and Python scripts.
 */
async function withDuckDB<T>(fn: (conn: import("@duckdb/node-api").DuckDBConnection) => Promise<T>): Promise<T> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const dbPath = path.join(WORKSPACE, ".jetro", "cache.duckdb");
  await ensureDir(path.dirname(dbPath));
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  try {
    // Ensure base tables (no-op after first creation, <1ms)
    await conn.run(`
      CREATE TABLE IF NOT EXISTS stock_data (
        ticker VARCHAR,
        endpoint VARCHAR,
        data JSON,
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (ticker, endpoint)
      );
      CREATE TABLE IF NOT EXISTS portfolio_holdings (
        portfolio VARCHAR,
        ticker VARCHAR,
        name VARCHAR,
        weight REAL,
        shares REAL,
        avg_cost REAL,
        sector VARCHAR,
        current_price REAL,
        current_value REAL,
        pnl REAL,
        pnl_pct REAL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (portfolio, ticker)
      );
    `);

    // Auto-register dataset views
    try {
      const datasetsDir = path.join(WORKSPACE, ".jetro", "datasets");
      const metaFiles = (await fs.readdir(datasetsDir)).filter(f => f.endsWith(".json"));
      for (const metaFile of metaFiles) {
        try {
          const raw = await fs.readFile(path.join(datasetsDir, metaFile), "utf-8");
          const meta = JSON.parse(raw) as { slug?: string; duckdbTable?: string; files?: string[] };
          const tableName = meta.duckdbTable || meta.slug;
          if (!tableName || !meta.files?.length) continue;

          for (const file of meta.files) {
            const filePath = path.resolve(WORKSPACE, file);
            assertContained(filePath, WORKSPACE);
            const ext = path.extname(filePath).toLowerCase();
            const viewName = `ds_${slugify(tableName)}`;

            if (ext === ".csv" || ext === ".tsv") {
              await conn.run(`CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_csv_auto('${filePath.replace(/'/g, "''")}');`);
            } else if (ext === ".parquet") {
              await conn.run(`CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_parquet('${filePath.replace(/'/g, "''")}');`);
            } else if (ext === ".json" || ext === ".jsonl" || ext === ".ndjson") {
              await conn.run(`CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_json_auto('${filePath.replace(/'/g, "''")}');`);
            }
          }
        } catch (err) {
          console.error(`[duckdb] Failed to register dataset ${metaFile}: ${err}`);
        }
      }
    } catch {
      // No datasets directory — fine
    }

    return await fn(conn);
  } finally {
    conn.closeSync();
  }
}

function validateReadOnlySQL(sql: string): void {
  // Strip comments and normalize
  const stripped = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const normalized = stripped.toUpperCase();

  // Only allow SELECT, WITH (CTE), DESCRIBE, SUMMARIZE
  if (
    !normalized.startsWith("SELECT") &&
    !normalized.startsWith("WITH") &&
    !normalized.startsWith("DESCRIBE") &&
    !normalized.startsWith("SUMMARIZE")
  ) {
    throw new Error("Only SELECT, WITH (CTE), DESCRIBE, and SUMMARIZE queries are allowed");
  }

  // Block multiple statements
  const statementCount = stripped.split(";").filter((s) => s.trim().length > 0).length;
  if (statementCount > 1) {
    throw new Error("Multiple SQL statements are not allowed");
  }

  // Block dangerous keywords
  const dangerous = [
    "COPY", "EXPORT", "IMPORT", "ATTACH", "DETACH",
    "INSTALL", "LOAD", "CALL", "PRAGMA", "CREATE",
    "DROP", "ALTER", "DELETE", "INSERT", "UPDATE",
    "TRUNCATE", "GRANT", "REVOKE",
  ];
  for (const kw of dangerous) {
    const pattern = new RegExp(`\\b${kw}\\b`, "i");
    if (pattern.test(stripped)) {
      throw new Error(`SQL keyword "${kw}" is not allowed in read-only queries`);
    }
  }
}

async function handleJetQuery(args: { sql: string }): Promise<string> {
  const { sql } = args;
  if (!sql || !sql.trim()) {
    throw new Error("No SQL query provided");
  }

  validateReadOnlySQL(sql);

  const stripped = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();

  return withDuckDB(async (conn) => {
    const reader = await conn.runAndReadAll(stripped);
    const rows = reader.getRowObjectsJS() as Record<string, unknown>[];
    // Convert BigInt to Number for JSON serialization
    const safeRows = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = typeof v === "bigint" ? Number(v) : v;
      }
      return out;
    });
    console.error(`[jet_query] ${safeRows.length} row(s) returned`);
    return JSON.stringify(safeRows, null, 2);
  });
}

// ── jet_exec Handler ──

async function handleJetExec(args: {
  language: string;
  code: string;
  timeout?: number;
}): Promise<string> {
  const { language, code, timeout = 300_000 } = args;

  if (!code || !code.trim()) {
    throw new Error("No code provided");
  }

  const safeTimeout = Math.max(timeout, 1000);
  const ext = language === "r" ? "R" : "py";

  // Resolve Python interpreter — prefer managed venv
  let interpreter: string;
  if (language === "r") {
    interpreter = "Rscript";
  } else {
    const venvPython = path.join(WORKSPACE, ".jetro", "venv", "bin", "python3");
    try {
      await fs.access(venvPython, fsSync.constants.X_OK);
      interpreter = venvPython;
    } catch {
      interpreter = "python3";
    }
  }

  // Write code to temp script
  const scriptsDir = path.join(WORKSPACE, ".jetro", "scripts");
  await ensureDir(scriptsDir);
  const scriptName = `_exec_${Date.now()}.${ext}`;
  const scriptPath = path.join(scriptsDir, scriptName);
  await fs.writeFile(scriptPath, code, "utf-8");

  // Build environment with Jetro context vars
  const jetLibPath = path.join(WORKSPACE, ".jetro", "lib");
  const existingPythonPath = process.env.PYTHONPATH || "";
  const activeProject = getActiveProjectSlug();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    JET_WORKSPACE: WORKSPACE,
    JET_DUCKDB_PATH: path.join(WORKSPACE, ".jetro", "cache.duckdb"),
    JET_API_URL: API_BASE,
    JET_JWT: getJWT(),
    JET_FRAMES_DIR: path.join(WORKSPACE, ".jetro", "frames"),
    PYTHONPATH: existingPythonPath ? `${jetLibPath}:${existingPythonPath}` : jetLibPath,
    ...(activeProject ? { JET_PROJECT: activeProject } : {}),
  };

  console.error(`[jet_exec] ${language} (${code.length} chars, timeout ${safeTimeout}ms)`);

  try {
    const { exec } = await import("node:child_process");

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      exec(
        `${interpreter} "${scriptPath}"`,
        {
          cwd: WORKSPACE,
          timeout: safeTimeout,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          env,
        },
        (err, stdout, stderr) => {
          resolve({
            stdout: stdout || "",
            stderr: stderr || "",
            exitCode: err ? 1 : 0,
          });
        }
      );
    });

    console.error(`[jet_exec] exit=${result.exitCode} stdout=${result.stdout.length}B stderr=${result.stderr.length}B`);

    // Auto-truncate large stdout: save full output to file, return preview
    const MAX_STDOUT = 8 * 1024; // 8 KB
    let stdout = result.stdout;
    let outputFile: string | undefined;
    if (stdout.length > MAX_STDOUT) {
      const outputDir = path.join(WORKSPACE, ".jetro", "output");
      await ensureDir(outputDir);
      const ts = Date.now();
      outputFile = path.join(outputDir, `exec_${ts}.txt`);
      await fs.writeFile(outputFile, stdout, "utf-8");
      const preview = stdout.slice(0, MAX_STDOUT);
      stdout = preview + `\n\n--- OUTPUT TRUNCATED (${result.stdout.length} bytes) ---\nFull output saved to: .jetro/output/exec_${ts}.txt\nRead this file to see complete results.`;
    }

    return JSON.stringify({
      exitCode: result.exitCode,
      stdout,
      stderr: result.stderr,
      ...(outputFile ? { outputFile: `.jetro/output/${path.basename(outputFile)}` } : {}),
    }, null, 2);
  } finally {
    // Clean up temp script
    try { await fs.unlink(scriptPath); } catch { /* ignore */ }
  }
}

// ── Server Setup ──

const server = new Server(
  { name: "jetro", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Refresh workspace + JWT from global auth file on every tool call
  refreshConfig();

  try {
    let result: string;

    switch (name) {
      case "jet_data":
        result = await handleJetData(
          args as { provider: string; endpoint: string; params?: Record<string, unknown> }
        );
        break;
      case "jet_skill":
        result = await handleJetSkill(args as { name: string });
        break;
      case "jet_template":
        result = await handleJetTemplate(args as { name: string });
        break;
      case "jet_render": {
        const renderArgs = args as { type: string; data: Record<string, unknown>; position?: { x: number; y: number }; width?: number; id?: string; projectSlug?: string; refreshBinding?: { scriptPath: string; intervalMs?: number; sourceDomain?: string; bindingType?: string; refreshPrompt?: string; elementTitle?: string } };
        if (!renderArgs.projectSlug) renderArgs.projectSlug = getActiveProjectSlug() ?? undefined;
        result = await handleJetRender(renderArgs);
        break;
      }
      case "jet_search":
        result = await handleJetSearch(
          args as { query: string; exchange?: string; limit?: number }
        );
        break;
      case "jet_save":
        result = await handleJetSave(
          args as { type: string; name: string; payload: Record<string, unknown> }
        );
        break;
      case "jet_canvas": {
        const canvasArgs = args as {
            action: string;
            canvasId?: string;
            elementId?: string;
            position?: { x: number; y: number };
            size?: { width?: number; height?: number };
            operations?: Array<{ elementId: string; position?: { x: number; y: number }; size?: { width?: number; height?: number } }>;
            refreshBinding?: { scriptPath?: string; intervalMs?: number; sourceDomain?: string; bindingType?: string; refreshPrompt?: string; elementTitle?: string };
            projectSlug?: string;
            timestamp?: number;
            sourceId?: string;
            targetId?: string;
            channel?: string;
            bidirectional?: boolean;
            wireId?: string;
          };
        // Auto-inject active project when no explicit canvas or project target given
        if (!canvasArgs.canvasId && !canvasArgs.projectSlug && canvasArgs.action !== "list") {
          canvasArgs.projectSlug = getActiveProjectSlug() ?? undefined;
        }
        result = await handleJetCanvas(canvasArgs);
        break;
      }
      case "jet_parse": {
        const parseArgs = args as {
            file: string;
            projectSlug?: string;
            outputName?: string;
            options?: { ocr?: boolean; pages?: string };
          };
        if (!parseArgs.projectSlug) parseArgs.projectSlug = getActiveProjectSlug() ?? undefined;
        result = await handleJetParse(parseArgs);
        break;
      }
      case "jet_share":
        result = await handleJetShare(
          args as {
            action: string;
            title?: string;
            elementIds?: string[];
            shareId?: string;
            elementId?: string;
            canvasId?: string;
          }
        );
        break;
      case "jet_deploy":
        result = await handleJetDeploy(
          args as { action: string; projectSlug: string }
        );
        break;
      case "jet_query":
        result = await handleJetQuery(args as { sql: string });
        break;
      case "jet_exec":
        result = await handleJetExec(
          args as { language: string; code: string; timeout?: number }
        );
        break;
      case "jet_connector":
        result = await handleJetConnector(
          args as {
            action: string;
            name?: string;
            slug?: string;
            description?: string;
            type?: string;
            auth?: Record<string, unknown>;
            credential?: string;
            params?: Record<string, unknown>;
            methods?: Record<string, unknown>;
            clientCode?: string;
            requirements?: string;
          }
        );
        break;
      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: "text" as const, text: result }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── jet_connector handler ──

async function handleJetConnector(args: {
  action: string;
  name?: string;
  slug?: string;
  description?: string;
  type?: string;
  auth?: Record<string, unknown>;
  credential?: string;
  params?: Record<string, unknown>;
  methods?: Record<string, unknown>;
  clientCode?: string;
  requirements?: string;
}): Promise<string> {
  const connectorsDir = path.join(WORKSPACE, ".jetro", "connectors");
  await ensureDir(connectorsDir);

  switch (args.action) {
    case "create": {
      if (!args.name) throw new Error("name is required for create");
      if (!args.clientCode) throw new Error("clientCode is required for create");
      if (!args.auth) throw new Error("auth is required for create");

      const slug = slugify(args.name);
      const connDir = path.join(connectorsDir, slug);
      await ensureDir(connDir);

      const config = {
        slug,
        name: args.name,
        description: args.description || "",
        type: args.type || "custom",
        origin: "agent" as const,
        auth: {
          method: (args.auth as Record<string, unknown>).method || "none",
          ...(args.auth as Record<string, unknown>),
          credentialKey: (args.auth as Record<string, unknown>).method !== "none"
            ? `jet_connector_${slug}`
            : undefined,
        },
        params: args.params || {},
        methods: args.methods || {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(
        path.join(connDir, "connector.json"),
        JSON.stringify(config, null, 2),
        "utf-8"
      );
      await fs.writeFile(
        path.join(connDir, "client.py"),
        args.clientCode,
        "utf-8"
      );
      if (args.requirements) {
        await fs.writeFile(
          path.join(connDir, "requirements.txt"),
          args.requirements,
          "utf-8"
        );
      }

      // Credential handoff: write to queue for extension to pick up and store in SecretStorage
      if (args.credential && config.auth.credentialKey) {
        const queueDir = path.join(WORKSPACE, ".jetro", "connector_queue");
        await ensureDir(queueDir);
        await fs.writeFile(
          path.join(queueDir, `${slug}.json`),
          JSON.stringify({
            action: "store",
            slug,
            credentialKey: config.auth.credentialKey,
            credential: args.credential,
          }),
          "utf-8"
        );
      }

      console.error(`[jet_connector] Created connector: ${slug}`);
      return JSON.stringify({
        status: "created",
        slug,
        name: args.name,
        type: config.type,
        auth: config.auth.method,
        path: `.jetro/connectors/${slug}/`,
        usage: `from jet.connectors import use; client = use("${slug}"); data = client.fetch()`,
      });
    }

    case "list": {
      const dirs = await fs.readdir(connectorsDir).catch(() => [] as string[]);
      const connectors = [];

      for (const dir of dirs) {
        const configPath = path.join(connectorsDir, dir, "connector.json");
        try {
          const raw = await fs.readFile(configPath, "utf-8");
          connectors.push(JSON.parse(raw));
        } catch {
          // skip invalid entries
        }
      }

      return JSON.stringify({
        count: connectors.length,
        connectors,
      });
    }

    case "read": {
      if (!args.slug) throw new Error("slug is required for read");
      const connDir = path.join(connectorsDir, args.slug);
      assertContained(connDir, WORKSPACE);

      const configPath = path.join(connDir, "connector.json");
      const clientPath = path.join(connDir, "client.py");

      const configRaw = await fs.readFile(configPath, "utf-8").catch(() => null);
      if (!configRaw) throw new Error(`Connector not found: ${args.slug}`);

      const clientCode = await fs.readFile(clientPath, "utf-8").catch(() => "");

      return JSON.stringify({
        config: JSON.parse(configRaw),
        clientCode,
      });
    }

    case "test": {
      if (!args.slug) throw new Error("slug is required for test");
      const connDir = path.join(connectorsDir, args.slug);
      assertContained(connDir, WORKSPACE);

      const configPath = path.join(connDir, "connector.json");
      const configRaw = await fs.readFile(configPath, "utf-8").catch(() => null);
      if (!configRaw) throw new Error(`Connector not found: ${args.slug}`);

      const config = JSON.parse(configRaw);

      // Resolve Python interpreter
      const venvPython = path.join(WORKSPACE, ".jetro", "venv", "bin", "python3");
      let interpreter: string;
      try {
        await fs.access(venvPython, fsSync.constants.X_OK);
        interpreter = venvPython;
      } catch {
        interpreter = "python3";
      }

      // Build test script
      const testCode = [
        "import json, os, sys",
        `os.environ['JET_WORKSPACE'] = ${JSON.stringify(WORKSPACE)}`,
        "sys.path.insert(0, os.path.join(os.environ['JET_WORKSPACE'], '.jetro', 'lib'))",
        "from jet.connectors import use",
        `client = use(${JSON.stringify(args.slug)})`,
        "# Try calling fetch() or the first available method",
        "result = None",
        "if hasattr(client, 'fetch'):",
        "    result = client.fetch()",
        "elif hasattr(client, 'test'):",
        "    result = client.test()",
        "else:",
        "    result = {'status': 'ok', 'message': 'Client instantiated successfully (no fetch/test method)'}",
        "print(json.dumps(result, default=str))",
      ].join("\n");

      // Build environment
      const jetLibPath = path.join(WORKSPACE, ".jetro", "lib");
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        JET_WORKSPACE: WORKSPACE,
        PYTHONPATH: jetLibPath,
      };

      // Inject credential from queue file (if exists) or environment
      const credKey = config.auth?.credentialKey;
      if (credKey) {
        // Try reading credential from queue file (extension may not have consumed it yet)
        const queuePath = path.join(WORKSPACE, ".jetro", "connector_queue", `${args.slug}.json`);
        try {
          const qRaw = await fs.readFile(queuePath, "utf-8");
          const qData = JSON.parse(qRaw);
          if (qData.credential) {
            env[`JET_CRED_${credKey.toUpperCase().replace(/-/g, "_")}`] = qData.credential;
          }
        } catch {
          // Credential already consumed by extension — not available for MCP-side test
          // Extension-side test should be used instead
        }
      }

      const { exec } = await import("node:child_process");
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        exec(
          `${interpreter} -c ${JSON.stringify(testCode)}`,
          {
            cwd: WORKSPACE,
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
            env,
          },
          (error, stdout, stderr) => {
            resolve({
              stdout: (stdout || "").toString().trim(),
              stderr: (stderr || "").toString().trim(),
              exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code || 1 : 0,
            });
          }
        );
      });

      if (result.exitCode !== 0) {
        return JSON.stringify({
          status: "error",
          slug: args.slug,
          error: result.stderr || result.stdout || "Test failed",
        });
      }

      return JSON.stringify({
        status: "ok",
        slug: args.slug,
        output: result.stdout,
      });
    }

    case "delete": {
      if (!args.slug) throw new Error("slug is required for delete");
      const connDir = path.join(connectorsDir, args.slug);
      assertContained(connDir, WORKSPACE);

      // Read config to get credential key before deleting
      const configPath = path.join(connDir, "connector.json");
      let credKey: string | undefined;
      try {
        const raw = await fs.readFile(configPath, "utf-8");
        const config = JSON.parse(raw);
        credKey = config.auth?.credentialKey;
      } catch {
        // no config
      }

      // Delete directory
      await fs.rm(connDir, { recursive: true, force: true });

      // Write delete command to queue so extension clears the credential from SecretStorage
      if (credKey) {
        const queueDir = path.join(WORKSPACE, ".jetro", "connector_queue");
        await ensureDir(queueDir);
        await fs.writeFile(
          path.join(queueDir, `${args.slug}.json`),
          JSON.stringify({
            action: "delete",
            slug: args.slug,
            credentialKey: credKey,
          }),
          "utf-8"
        );
      }

      console.error(`[jet_connector] Deleted connector: ${args.slug}`);
      return JSON.stringify({ status: "deleted", slug: args.slug });
    }

    default:
      throw new Error(`Unknown jet_connector action: ${args.action}`);
  }
}

// ── Start ──

const transport = new StdioServerTransport();
await server.connect(transport);
