# Jetro — Reference Guide

This guide covers features, workflows, troubleshooting, and FAQs for the Jetro extension.
Read this when a user asks for help, encounters an issue, or wants to learn how something works.

---

## Getting Started

### First Launch

1. Install Jetro from the extension marketplace
2. Open a folder in your editor (VS Code, Cursor, Antigravity, Windsurf)
3. Click the Jetro icon in the activity bar (sidebar)
4. Sign up or sign in — a verification email is sent on first sign-up
5. After email verification, sign in — the Research Board canvas opens automatically
6. Ask your AI agent to build something: *"Show me a stock chart for Apple Inc"*

### What Happens on Sign-In

- Jetro creates a `.jetro/` directory in your workspace (config, cache, scripts)
- MCP tool configs are written so your AI agent can discover Jetro's tools
- A `AGENT.md and/or CLAUDE.md` file is generated with tool documentation for your agent
- The Research Board (default canvas) opens — this is your visual workspace

### Requirements

- VS Code 1.85+ (or compatible editor: Cursor, Antigravity, Windsurf)
- An MCP-compatible AI agent (Claude Code, Cursor Agent, Copilot, Cline, etc.)
- Python 3 (optional — needed for document parsing and live refresh scripts)
- Docker (optional — needed for deploying projects as web apps)

---

## Features

### Infinite Canvas

The canvas is your visual workspace — an infinite, zoomable surface where every output (charts, tables, dashboards, notes) is rendered as a draggable, resizable element.

- **Multiple canvases**: universal canvases (global) and project canvases (scoped to a project)
- **Element types**: frames (rich HTML), charts (Plotly), notes (markdown), embeds (external URLs)
- **Toolbar**: select, pan, zoom, fit-to-view, refresh frames, C2 mode toggle
- **Auto-save**: canvas state saves automatically as you work

### Frame Elements

Frames are sandboxed iframes that render any HTML/CSS/JS. They're the most powerful element type.

- **File-based** (recommended): write HTML to `.jetro/frames/{name}.html`, render with `data.file`
- **Inline**: pass HTML directly via `data.html` for quick snippets
- **Chart libraries**: Plotly, D3, and Observable Plot are pre-bundled. Use standard CDN `<script src>` tags — they're automatically shimmed to local copies (zero network, instant load)
- **Open in Browser**: click the browser icon on any frame to open it in your default browser
- **Web App**: click the web app icon to open it in the companion app

### Live Refresh Bindings

Attach a Python script to any element for automatic live updates:

- **Script bindings**: Python script runs on a timer, outputs JSON → data pushed into the frame via `jet:refresh` event
- **Status indicator**: green "LIVE" badge appears on elements with active bindings

### Projects

Projects organize your research into focused workspaces:

- Each project gets its own canvas, notes directory, and sources directory
- Project canvases auto-scope tools — `jet_render`, `jet_canvas`, `jet_parse` target the project canvas
- Projects can have linked connectors, templates, and recipes
- Portfolio mode: enable via right-click on a project for NAV-based portfolio tracking

### Charts

Plotly.js is bundled in the canvas — no CDN or script tags needed for charts:

- Use `jet_render` with `type='chart'` and pass Plotly traces
- Supports all Plotly chart types: bar, scatter, pie, heatmap, waterfall, candlestick, treemap, sankey, etc.
- Dual-axis charts supported via `yaxis2` in plotlyLayout
- Default color palette: `#DEBFCA, #58A6FF, #3FB950, #F85149, #BC8CFF, #FF7B72`

### Data Connectors

Reusable Python modules that connect to external data sources (APIs, databases, spreadsheets):

- Agent writes a Python `Client` class — the platform manages auth and credentials securely via OS keychain
- Supported auth methods: `api_key`, `bearer`, `basic`, `connection_string`, `none`
- Use in scripts: `from jet.connectors import use; client = use('slug'); data = client.fetch()`
- Connectors persist at `.jetro/connectors/{slug}/` and survive restarts

### Document Parsing

Parse documents into structured markdown:

- Supported formats: PDF, DOCX, PPTX, XLSX, HTML, EPUB, RTF, EML, images (OCR), and plain text
- Output: markdown file saved to project notes (or `.jetro/notes/` if no project)
- Options: OCR for scanned documents, page range selection for PDFs
- Requires Python 3 — parsing libraries auto-install in a managed venv on first use (~30-60s)

### Code Execution

Run Python or R code in a sandboxed subprocess via `jet_exec`:

- Access to workspace files, DuckDB cache, and Jetro Data API
- Environment variables: `JET_WORKSPACE`, `JET_PROJECT`, `JET_DUCKDB_PATH`, `JET_API_URL`
- PYTHONPATH includes `.jetro/lib/` for the Jetro Python SDK
- Timeout: 5 minutes (configurable). Large output (>8 KB) should be written to file

### Sharing

Share canvas frame elements as interactive web pages:

- Create a share from any frame — get a public URL viewable in any browser
- Multi-element shares render as tabs
- Live elements auto-update on the share URL (polling-based, ~1-2 min latency)
- Pause, resume, or revoke shares at any time
- For real-time dashboards (sub-minute updates), use `jet_deploy` instead

### Deploying Apps

Deploy projects as containerized web apps with a public URL:

- Requires Docker installed on your machine
- Project needs `deploy/` directory with `server.py`, `requirements.txt`, `Dockerfile`
- The deploy skill (`jet_skill("Deploy App")`) teaches the full process
- The Jetro Python SDK (`jet.api`, `jet.market`, `jet.connectors`) is available inside deployed containers
- Actions: start, stop, redeploy, publish (public URL), remove, status

### C2 Mode (Command & Control)

Project canvases can activate C2 mode — transforms the canvas into a live cockpit:

- Frame elements communicate through **wires** (named data channels)
- Inside frame HTML: `__JET.send(channel, data)` and `__JET.on(channel, callback)`
- Use for multi-frame dashboards where components coordinate (e.g., ticker picker → chart → blotter)
- Fetch the C2 Dashboard skill before building: `jet_skill({ name: "C2 Dashboard" })`

### Companion Web App

A browser-based mirror of your canvas at `http://localhost:17710`:

- Same canvas, same data, accessible from any browser on your machine
- Built-in terminal for CLI-based agents
- Opens via the "Companion" button in the sidebar footer

### DuckDB SQL Cache

A local DuckDB database caches fetched financial data:

- Query with `jet_query`: `SELECT * FROM stock_data WHERE ticker = 'AAPL'`
- Tables: `stock_data` (cached API responses), `portfolio_holdings`, plus any imported datasets
- Import CSV, Excel, Parquet, JSON files via the "Import Dataset" command
- Read-only queries only (SELECT, WITH, DESCRIBE, SUMMARIZE)

---

## Common Workflows

### Build a Live Dashboard

1. Ask the agent to fetch data: *"Get Apple stock profile and quarterly financials"*
2. Ask for a visualization: *"Create a dashboard with price chart, key metrics, and recent quarters table"*
3. Add live data: *"Add a 10-second refresh binding that tracks the live price"*
4. The agent creates a Python refresh script in `.jetro/scripts/` and binds it to the frame

### Track a Stock

1. *"Show me AAPL stock profile with key ratios"*
2. *"Add it to a watchlist called 'Core Holdings'"*
3. *"Create a live price tracker that updates every 30 seconds"*

### Parse and Analyze a Report

1. Drop a PDF/DOCX into your workspace
2. *"Parse annual_report.pdf and create a project called 'Apple Research'"*
3. *"Extract revenue trends and create a chart"*
4. *"Write an investment thesis based on the findings"*

### Deploy a Web App

1. Create a project with a dashboard on the canvas
2. *"Deploy this as a web app"*
3. Agent creates `deploy/server.py`, `requirements.txt`, `Dockerfile`
4. Agent runs `jet_deploy({ action: "start", projectSlug: "my-project" })`
5. App is live at a local port — publish for a public URL

### Create a Data Connector

1. *"Create a Google Sheets connector for my portfolio spreadsheet"*
2. Agent writes the Python client code, you provide the API key
3. Credential stored securely in OS keychain
4. Use in refresh scripts: `from jet.connectors import use; sheets = use('google_sheets')`

### Compare Multiple Companies

1. *"Compare Apple, Microsoft, and Google — revenue, margins, P/E, and growth rates"*
2. Agent fetches data for all three, renders a comparison table
3. *"Add a bar chart comparing their operating margins over the last 5 years"*
4. *"Save this as a project called 'Big Tech Comparison'"*

### Build a Portfolio Tracker

1. *"Create a portfolio project called 'My Portfolio'"*
2. *"Add these holdings: 100 shares of AAPL at $150, 50 shares of MSFT at $380"*
3. *"Create a dashboard showing current value, P&L, allocation pie chart, and sector breakdown"*
4. *"Add a live refresh that updates prices every 30 seconds"*

### Morning Research Brief

1. *"Create a morning brief for my watchlist: AAPL, TSLA, NVDA, MSFT"*
2. Agent fetches overnight changes, news, key metrics for each stock
3. Renders a formatted brief on the canvas with charts and commentary
4. *"Set up a prompt binding to auto-refresh this every morning"*

### Scrape and Track External Data

1. *"I want to track gold futures prices from a public website"*
2. Agent uses the `web_source` skill to investigate the website and build a scraper
3. Creates a refresh script that fetches and parses the data
4. Renders a live-updating frame with price, change, and historical chart

### Import and Analyze a Dataset

1. Drag a CSV/Excel file into your workspace
2. *"Import sales_data.csv as a dataset"*
3. *"Query it: show total sales by region for the last quarter"*
4. *"Create a bar chart of the results"*
5. The dataset is now queryable via `jet_query` as a DuckDB table

### Build a Multi-Page Report

1. Create a project and add research to the canvas (charts, tables, notes)
2. *"Create a Company Report using the template"*
3. Agent fetches the report template and generates a structured analysis
4. *"Add a DCF valuation section"*
5. Export individual frames to browser for printing/PDF

### Create an Interactive Game or Tool

1. *"Build a simple stock trading simulator game"*
2. Agent creates an interactive HTML frame with game logic
3. Play it directly in the canvas preview or open in browser
4. *"Deploy it as a web app so I can share it with friends"*

### Track Live Sports or Event Data

1. *"Build a live F1 race tracker that shows driver positions, lap times, and tyre strategy"*
2. Agent finds a free API (e.g., OpenF1), builds the HTML dashboard
3. Refresh script polls the API every 10 seconds
4. *"Share it as a live URL for my friends to watch during the race"*

### Geospatial Visualization

1. *"Show a map of all semiconductor fabs worldwide with capacity data"*
2. Agent uses CesiumJS (pre-bundled) to create an interactive 3D globe
3. Data points plotted with tooltips showing fab details
4. *"Add a control panel to filter by country and technology node"*

---

## MCP Configuration by Editor

Jetro auto-configures MCP for most editors on sign-in. If your agent can't see Jetro's tools, check these locations:

### Claude Code / VS Code (auto-configured)

Config file: `{workspace}/.mcp.json`

```json
{
  "mcpServers": {
    "jetro": {
      "type": "stdio",
      "command": "/path/to/node",
      "args": ["/path/to/mcp-server/out/index.js"],
      "env": { "JET_WORKSPACE": "/path/to/workspace", "JET_JWT": "..." }
    }
  }
}
```

### Cursor (auto-configured)

Config file: `{workspace}/.cursor/mcp.json` (same format as above)

### Antigravity (auto-configured)

Config file: `~/.gemini/antigravity/mcp_config.json` (global, merged on each activation)

### Windsurf

Windsurf uses a global config file. You may need to manually add Jetro:

1. Open Windsurf settings → MCP Servers
2. Add a new server with the command and args from `.mcp.json`
3. Or copy the server entry from `.jetro/mcp-config.json`

### Codex (OpenAI)

Config file: `~/.codex/config.toml` (global) or `.codex/config.toml` (project-scoped). Format is TOML:

```toml
[mcp_servers.jetro]
command = "/path/to/node"
args = ["/path/to/mcp-server/out/index.js"]
env = { JET_WORKSPACE = "/path/to/workspace", JET_JWT = "..." }
```

Get the command, args, and env values from `.jetro/mcp-config.json`. Note: the key must be `mcp_servers` (with underscore).

### Qwen Code

Config file: `.qwen/settings.json` (project-scoped) or `~/.qwen/settings.json` (global). Format is JSON:

```json
{
  "mcpServers": {
    "jetro": {
      "command": "/path/to/node",
      "args": ["/path/to/mcp-server/out/index.js"],
      "env": { "JET_WORKSPACE": "/path/to/workspace", "JET_JWT": "..." }
    }
  }
}
```

Copy the server entry from `.jetro/mcp-config.json`.

### Cline

Config file (macOS): `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

Format: same `mcpServers` JSON structure as above. You can also configure via Cline's MCP settings UI within the extension.

### Continue

Config file: `~/.continue/config.yaml` (global) or drop a JSON file into `.continue/mcpServers/` in the workspace. MCP only works in Continue's agent mode.

### Kilo Code

Config file: `.kilo/kilo.jsonc` (project-scoped) or `~/.config/kilo/kilo.jsonc` (global). Format: JSONC (JSON with comments), same `mcpServers` structure.

### Roo Code

Config file: `.roo/mcp.json` (project-scoped) or global at VS Code's globalStorage path. Format: same `mcpServers` JSON structure.

### Other Extensions

Most MCP-compatible extensions read from `{workspace}/.mcp.json`, which Jetro auto-creates. If your extension uses a different config location, copy the server entry from `.jetro/mcp-config.json`.

### Manual MCP Troubleshooting

If your agent still can't see Jetro's tools:

1. Run **"Jetro: Reinitialize MCP Server"** from the command palette
2. Check that `.mcp.json` exists in your workspace root
3. Verify the `command` path in `.mcp.json` points to a valid Node.js binary
4. Check the `JET_JWT` value is not empty (sign out and back in if needed)
5. Restart your editor/agent after making changes

---

## Troubleshooting

### MCP Tools Not Loading

**Symptom**: Agent says it can't find Jetro tools, or tools list is empty.

**Fixes**:

1. Run **"Jetro: Reinitialize MCP Server"** from the command palette (Cmd/Ctrl+Shift+P)
2. Check Output panel → filter "Jetro" for errors
3. Verify `.mcp.json` exists in workspace root with valid paths
4. Sign out and back in (refreshes JWT in MCP config)
5. Restart your editor

### Frame Preview is Blank

**Symptom**: Frame element shows a blank white/dark rectangle instead of content.

**Fixes**:

1. Click the **refresh button** in the canvas toolbar (circular arrow icon)
2. Switch to another canvas tab and back
3. If the frame uses chart libraries, ensure you're using `<script src="CDN_URL">` tags (not inlining library code)
4. Check that the HTML is a complete document (`<!DOCTYPE html><html><head>...</head><body>...</body></html>`)

### Refresh Script Not Running

**Symptom**: Live binding shows "LIVE" badge but data doesn't update.

**Fixes**:

1. Check Output panel → filter "Jetro" for `[bindings]` error messages
2. Verify the script exists at the path shown in the binding config
3. Test the script manually: `python3 .jetro/scripts/your_script.py`
4. Ensure the script outputs valid JSON to stdout (no print statements besides the JSON)
5. Check that Python 3 is installed and accessible

### Refresh Script SSL Errors (macOS)

**Symptom**: Script fails with `ssl.SSLCertVerificationError` or similar SSL errors.

**Fix**: macOS Python often ships without a CA bundle. Add `certifi` to your script:

```python
import ssl, certifi
ctx = ssl.create_default_context(cafile=certifi.where())
# Use ctx in urllib requests
```

Or install certifi system-wide: `pip3 install certifi`

### Document Parsing Fails

**Symptom**: `jet_parse` returns an error about Python or missing libraries.

**Fixes**:

1. Ensure Python 3 is installed: `python3 --version`
2. First parse auto-installs libraries in `.jetro/venv/` — this needs internet and takes 30-60 seconds
3. If the venv is corrupted, delete `.jetro/venv/` and try again
4. For text files (md, txt, csv, json, yaml, xml), Python is not needed

### Deploy Fails

**Symptom**: `jet_deploy` returns an error.

**Fixes**:

1. Ensure Docker Desktop is installed and running: `docker info`
2. Check that `projects/{slug}/deploy/` contains `server.py`, `requirements.txt`, and `Dockerfile`
3. Check Output panel → filter "Jetro" for `[deploy]` error messages
4. Check Docker logs: `docker logs jet-app-{projectSlug}`
5. The `Deploy App` skill has detailed instructions: `jet_skill({ name: "Deploy App" })`

### Share URL Not Updating

**Symptom**: Shared URL shows "Live" but the displayed data is stale.

**Fixes**:

1. Revoke the old share and create a new one
2. Ensure the element has an active refresh binding (green "LIVE" badge on canvas)
3. Share updates have ~1-2 minute latency due to polling — for real-time updates, use `jet_deploy` instead
4. Check Output panel for `[share] Re-uploaded` messages — if absent, the re-upload isn't firing

### Workspace Pollution

**Symptom**: `.jetro/` files appearing in folders you didn't intend.

**Fix**: This was fixed in v0.1.2+. Update to the latest version. Jetro only creates files in workspaces where you've signed in or where `.jetro/` already exists.

### Extension Not Activating

**Symptom**: Jetro icon doesn't appear in the sidebar.

**Fixes**:

1. Ensure you have a folder open (Jetro requires a workspace folder)
2. Check the Extensions panel — Jetro should show as installed and enabled
3. Try disabling and re-enabling the extension
4. Check Output panel → filter "Jetro" for activation errors

---

## Python SDK

The Jetro Python SDK is available in refresh scripts, `jet_exec` code, and deployed apps.
Modules are located at `.jetro/lib/jet/` and auto-loaded via `PYTHONPATH`.

### jet.api — Data API Proxy

```python
from jet.api import jet_api

# Fetch stock data (auth handled automatically)
profile = jet_api("/profile/ALKEM.NS")
ratios = jet_api("/ratios/CIPLA.NS", params={"period": "annual"})
quote = jet_api("/quote/RELIANCE.NS")
```

### jet.market — Free Market Data

```python
from jet.market import Ticker

# No API key needed, no quota limits
t = Ticker("INFY.NS")
price = t.fast_info.last_price
hist = t.history(period="1mo")
```

**Use `jet.market` for high-frequency refresh scripts** (interval < 5 min) to avoid API quota consumption.

### jet.connectors — Data Connectors

```python
from jet.connectors import use

# Load a connector by slug
sheets = use("google_sheets", spreadsheetId="1abc...")
data = sheets.fetch(sheet="Revenue")
```

### jet.mf — Mutual Fund Data

```python
from jet.mf import MutualFund

mf = MutualFund()
nav = mf.get_scheme_quote("119551")
```

---

## FAQ

### What editors does Jetro support?

Jetro works with any editor that supports VS Code extensions: VS Code, Cursor, Antigravity, Windsurf, and other VS Code forks. MCP tools work with any MCP-compatible agent.

### What AI agents work with Jetro?

Any agent that supports MCP (Model Context Protocol): Claude Code, Cursor Agent, Copilot (with MCP enabled), Cline, Kilo Code, Continue, Qwen Code, and others. CLI agents like Claude Code CLI and Codex CLI work via the companion app terminal.

### Where is my data stored?

All data stays on your local machine in the workspace folder. Stock data, projects, canvases, scripts — everything is in `data/`, `projects/`, and `.jetro/` within your workspace. API credentials are stored in your OS keychain via VS Code's SecretStorage.

### Does Jetro send my data to any server?

Jetro calls its data API to fetch financial data (proxied for auth). Your workspace files, projects, and analysis are never uploaded — they stay local. Shared elements are uploaded only when you explicitly create a share.

### Can I use my own API keys?

Jetro provides data access through its built-in data API. For additional data sources, create a connector (`jet_connector`) with your own API key — it's stored securely in your OS keychain.

### What about offline use?

Canvas, projects, and cached data work fully offline. Live refresh bindings that call external APIs need internet. Skills and templates are fetched online on each session start — without internet, a basic fallback context is used.

### How do I reset everything?

To start fresh in a workspace:

1. Delete the `.jetro/` directory
2. Delete `CLAUDE.md`, `AGENT.md`, `.windsurfrules`
3. Sign out and back in
4. Jetro will re-initialize on next activation

### How do I uninstall cleanly?

1. Uninstall the Jetro extension from your editor
2. Delete `.jetro/`, `.mcp.json`, `CLAUDE.md`, `AGENT.md`, `.windsurfrules` from your workspaces
3. Remove `~/.jetro/` (global runtime and auth cache)
4. Remove the Jetro entry from `~/.gemini/antigravity/mcp_config.json` if using Antigravity

### Can I use Jetro for non-finance work?

Yes. While Jetro has built-in finance data tools, the canvas, frames, refresh bindings, connectors, deploy, and code execution features are fully general-purpose. You can build dashboards for any domain — sports tracking, IoT monitoring, project management, data science, educational tools, games, and more.

### How do I add a chart library that isn't bundled?

Plotly, D3, and Observable Plot are pre-bundled. For other libraries (Chart.js, ECharts, Highcharts, etc.), add a standard `<script src="CDN_URL">` tag in your frame HTML. The frame is a sandboxed iframe with full internet access for CDN scripts.

### Can I have multiple canvases in one project?

Yes. Each project can have multiple canvases. Use `jet_canvas({ action: "list" })` to see all canvases. Create new ones via the sidebar or by asking the agent. Universal canvases exist outside projects for general-purpose work.

### How do I move elements between canvases?

Currently there's no direct move. The workflow is: read the element data from one canvas, render it on the target canvas, then delete from the original. The agent can do this for you: *"Move the price tracker from the Research Board to my Portfolio project canvas."*

### What data formats can I import?

CSV, Excel (.xlsx), Parquet, and JSON files can be imported as DuckDB datasets via the "Import Dataset" command. PDF, DOCX, PPTX, XLSX, HTML, EPUB, RTF, EML, and images can be parsed into markdown via `jet_parse`.

### Can I use Jetro with a local LLM?

Yes — if your local LLM agent supports MCP (e.g., Ollama via Continue, or a local model via Cline), it can use Jetro's tools. The agent quality depends on the model — larger models handle complex tool use better.

### How do I back up my workspace?

Your entire workspace is just files on disk. Back up the workspace folder (including `.jetro/`, `data/`, `projects/`) using any method — git, Time Machine, cloud sync, zip. Canvas state, scripts, and cached data are all in these directories.

### Can multiple people work on the same project?

Not yet — Jetro currently runs locally per user. Shared projects and real-time collaboration are planned for a future release. For now, you can share canvas elements via `jet_share` for others to view (read-only).

### What happens if my refresh script crashes?

The binding manager catches errors gracefully. The element keeps its last-known data. Error details are logged in the Output panel (filter "Jetro"). The binding retries on the next interval. After repeated failures, check the `[bindings]` log for the error message and fix the script.

### Can I customize the canvas theme or colors?

The canvas uses a dark theme by default. Individual frame elements can have any styling — the agent can apply custom colors, fonts, and layouts to each frame's HTML. For consistent theming across frames, ask the agent to use CSS variables or a shared stylesheet.

### How do refresh bindings survive editor restarts?

Bindings are saved in the canvas JSON file. When you reopen a canvas, the extension reads the bindings from disk and restarts the timers automatically. Scripts persist at `.jetro/scripts/`. No manual re-setup needed.

### What's the difference between `jet_data` and `jet.market`?

`jet_data` is an MCP tool that the agent calls — it fetches data through Jetro's backend API. `jet.market` is a Python module for use inside scripts and deployed apps — it fetches free market data directly without going through the backend. Use `jet.market` for high-frequency refresh scripts to avoid API quota consumption.

### Can I export my canvas as an image or PDF?

There's no direct canvas-to-image export. But individual frame elements can be opened in the browser (click the browser icon), where you can use the browser's print/save-as-PDF functionality. For reports, ask the agent to generate a formatted output and open it in browser.

### How do I debug a frame that's not rendering correctly?

1. Open the frame in browser (click the browser icon) — the browser's DevTools give full console/network access
2. Check for JavaScript errors in the frame's code
3. Ensure the HTML is a complete document with `<!DOCTYPE html>` and proper `<head>`/`<body>` tags
4. If using chart libraries, ensure the CDN `<script>` tags load before your code that uses them
5. Test with a minimal frame first to isolate the issue
