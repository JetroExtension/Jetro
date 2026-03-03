# Jetro

**Give your AI coding agent an infinite visual workspace.**

Jetro is an open-source VS Code extension that adds a living canvas to your editor. Your AI agent can render charts, tables, dashboards, interactive frames, and rich data visualizations — all on a spatial, persistent surface.

Your coding agent is powerful, but it's trapped in a text window. Jetro unlocks its full potential by giving it a visual layer to build on.

## Features

- **Infinite Canvas** — draggable, resizable elements: frames, charts, notes, embeds
- **MCP Integration** — works with any MCP-compatible agent (Claude Code, Cursor, Copilot, Cline, Windsurf, Qwen, etc.)
- **Live Frames** — HTML iframes with Python refresh bindings for real-time dashboards
- **Charts** — Plotly.js bundled for instant chart rendering (bar, scatter, pie, candlestick, and more)
- **C2 Mode** — wire frames together with named data channels for interconnected dashboards
- **Data Layer** — import CSV, Excel, Parquet, JSON; query with SQL via DuckDB
- **Document Parsing** — PDF, DOCX, PPTX, XLSX, HTML, images (OCR)
- **Code Execution** — run Python/R scripts in sandboxed subprocesses
- **Data Connectors** — reusable Python modules for external APIs, databases, spreadsheets
- **Deploy** — containerize projects as web apps with Docker
- **Share** — publish canvas elements as interactive web pages (requires backend)
- **Projects** — organize work into scoped workspaces with their own canvases

## Platform Support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon) | Fully supported |
| macOS (Intel) | Fully supported |
| Windows (x64) | Fully supported |
| Linux (x64) | Supported |

---

## Getting Started

### Prerequisites

- **Node.js 18+** — required for building and running the MCP server
- **VS Code 1.85+** (or compatible: Cursor, Windsurf, Antigravity, or any VS Code fork)
- **Python 3** (optional) — for document parsing, live refresh scripts, and code execution
- **Docker** (optional) — for deploying projects as web apps

### Clone and Install

```bash
git clone https://github.com/JetroExtension/Jetro.git
cd Jetro

# Install extension dependencies
cd extension
npm install

# Install MCP server dependencies
cd ../mcp-server
npm install

cd ..
```

### Build Everything

The extension has four build targets that must all be built:

```bash
cd extension

# 1. Extension backend (TypeScript → single JS bundle)
npm run build:ext

# 2. Canvas webview (React app → bundled HTML/JS/CSS)
npm run build:webview

# 3. Daemon (headless background worker for refresh bindings)
npm run build:daemon

# 4. MCP server (TypeScript → bundled JS, copied into extension)
npm run build:mcp
```

Or build all four at once:

```bash
npm run package
```

### Run in Development (F5)

1. Open the `extension/` folder in VS Code
2. Press **F5** — this launches a new Extension Development Host window
3. The Jetro sidebar appears in the activity bar
4. Open a folder in the dev host → Jetro initializes
5. You're automatically logged in as `jetro@jetro.ai` (dev mode)
6. Ask your AI agent to build something — it renders to the canvas

### Package as .vsix

To build an installable `.vsix` package:

```bash
cd extension
bash scripts/build-vsix.sh
```

This runs all build steps, creates a minimal `node_modules` (native deps only), and packages everything into `jetro-0.0.5.vsix`.

Install it:

```bash
code --install-extension jetro-0.0.5.vsix
```

### What Each Build Target Does

| Command | What it builds | Output |
|---------|---------------|--------|
| `npm run build:ext` | Extension backend (activation, tools, services) | `out/extension.js` |
| `npm run build:webview` | Canvas React app + connector UI | `webview/canvas.js`, `webview/connector.js` |
| `npm run build:daemon` | Headless daemon for background refresh bindings | `dist/daemon.js` |
| `npm run build:mcp` | MCP server (tool handlers for agents) | `mcp-server/out/index.js` |
| `npm run package` | All of the above | All outputs |

---

## Dev Mode

Out of the box, Jetro runs in **dev mode** — no Firebase, no backend, no sign-up required.

You're automatically logged in as `jetro@jetro.ai`. All core features work immediately:
- Canvas rendering and layout
- MCP tools (jet_render, jet_canvas, jet_exec, jet_query, jet_parse, etc.)
- Code execution (Python/R)
- DuckDB SQL queries and dataset import
- Document parsing
- Live refresh bindings (script-based)
- Data connectors
- Deploy (Docker, local)

**What requires a backend (optional):**
- `jet_data` — financial data API proxy (configure your own data provider)
- `jet_share` — publishing canvas elements to shareable URLs
- Deploy publishing — public URLs for deployed apps

---

## Adding Your Own Content

### Skills

Skills are analysis prompts your agent fetches via `jet_skill({ name: "Skill Name" })`.

Create JSON files in `extension/agent/skills/`:

```json
{
  "name": "Company Analysis",
  "description": "Deep-dive analysis of a public company",
  "prompt": "You are analyzing a company. Follow these steps:\n1. Fetch the company profile using jet_data\n2. Review the financial statements\n3. Render your findings to the canvas using jet_render\n..."
}
```

Skills are loaded on extension activation and listed in `CLAUDE.md` automatically. The agent sees the name and description; the full prompt is fetched on demand when the agent calls `jet_skill`.

### Templates

Templates are output formats your agent fetches via `jet_template({ name: "Template Name" })`.

Create JSON files in `extension/agent/templates/`:

```json
{
  "name": "Investment Report",
  "description": "Structured equity research report format",
  "content": "# {Company Name} — Investment Report\n\n## Executive Summary\n...\n\n## Financial Analysis\n...\n\n## Valuation\n..."
}
```

### System Prompt

The system prompt is your agent's operating doctrine — methodology, priorities, behavioral guidelines.

Create `extension/agent/system-prompts/prompt.md`:

```markdown
# My Agent Doctrine

You are a research assistant specializing in...

## Methodology
- Always verify data from multiple sources
- Present findings with supporting evidence
- ...

## Priorities
- Accuracy over speed
- ...
```

The system prompt is delivered to the agent on the first MCP tool call of each session. It's held in memory only — never written to the user's workspace.

---

## Configuration

### Data API (optional)

The `jet_data` tool proxies data requests through a backend API. By default, it points to `http://localhost:8787`.

To use your own backend:
1. Open VS Code settings (Cmd/Ctrl + ,)
2. Search for `jetro.apiUrl`
3. Set it to your backend URL

Without a backend, `jet_data` won't work. But you can still use:
- **`jet.market`** — free market data (yfinance wrapper) available in Python scripts
- **`jet_exec`** — run any Python/R code that fetches data directly
- All other tools work fully locally

### Authentication (optional)

Dev mode works without any auth. To add real user authentication:

1. Create a Firebase project at https://console.firebase.google.com
2. Enable Email/Password authentication
3. Get your Web API Key from Project Settings → General
4. Edit `extension/src/services/firebaseConfig.ts`:

```typescript
export const FIREBASE_API_KEY = "your-api-key-here";
export const FIREBASE_PROJECT_ID = "your-project-id";
```

5. Rebuild: `npm run build:ext`

When a real Firebase key is configured, dev mode automatically disables and the sign-in/sign-up flow activates.

### Deploy Relay (optional)

To publish deployed apps with public URLs:
1. Set up your own backend with relay support
2. In VS Code settings, set `jetro.relayDomain` to your domain

---

## Project Structure

```
Jetro/
├── extension/                # VS Code extension
│   ├── src/                  # TypeScript source
│   │   ├── extension.ts      # Activation, command registration
│   │   ├── canvas/           # Canvas webview (React + xyflow)
│   │   │   └── app/          # React app: nodes, toolbar, edges
│   │   ├── sidebar/          # Sidebar webview (auth, library, projects)
│   │   ├── services/         # Core services
│   │   │   ├── authService.ts        # Auth (Firebase or dev mode)
│   │   │   ├── bootstrapService.ts   # Loads skills/templates, generates CLAUDE.md
│   │   │   ├── fileManager.ts        # Workspace file operations
│   │   │   ├── nativeManager.ts      # Node.js detection, MCP server deployment
│   │   │   ├── refreshBindingManager.ts  # Live refresh timer management
│   │   │   ├── shareManager.ts       # Share lifecycle (requires backend)
│   │   │   ├── deployManager.ts      # Docker deploy lifecycle
│   │   │   └── duckdb.ts            # DuckDB cache (NAPI)
│   │   ├── tools/            # MCP tool handlers (extension side)
│   │   ├── daemon/           # Headless background worker
│   │   └── types/            # TypeScript type definitions
│   ├── agent/                # Bundled agent content
│   │   ├── skills/           # Your skill JSON files
│   │   ├── templates/        # Your template JSON files
│   │   ├── system-prompts/   # Your system prompt (prompt.md)
│   │   └── docs/             # Reference guide for agent help
│   ├── scripts/              # Build scripts
│   │   ├── build-vsix.sh     # Full VSIX build pipeline
│   │   ├── prepare-modules.sh  # Strip node_modules for packaging
│   │   └── restore-modules.sh # Restore full node_modules after packaging
│   ├── assets/               # Icons, images
│   ├── esbuild.extension.mjs # Extension bundler config
│   ├── esbuild.webview.mjs   # Webview bundler config
│   ├── package.json          # Extension manifest
│   └── tsconfig.json         # TypeScript config
├── mcp-server/               # MCP server (stdio)
│   ├── src/index.ts          # All MCP tool definitions and handlers
│   └── esbuild.mcp.mjs      # MCP server bundler config
├── agent/                    # Agent content (source of truth)
│   ├── skills/               # Skill definitions (add yours here)
│   ├── templates/            # Template definitions (add yours here)
│   ├── system-prompts/       # System prompt (add yours here)
│   └── docs/                 # Reference documentation
├── LICENSE                   # MIT
└── README.md                 # This file
```

## How It Works

1. **Activation** — extension starts, detects system Node.js, deploys MCP server to `~/.jetro/mcp-server/`
2. **Bootstrap** — reads skills/templates from `extension/agent/`, generates `CLAUDE.md` (thin prompt) listing available tools and skills
3. **MCP Config** — writes `.mcp.json` to workspace so agents discover Jetro's tools automatically
4. **Agent interaction** — agent calls MCP tools (`jet_render`, `jet_data`, `jet_canvas`, etc.) → results render on canvas
5. **System prompt** — delivered on first tool call via `wrapResponse()` (held in memory, never on disk)
6. **Refresh bindings** — Python scripts run on timers, output JSON → pushed into frame iframes via `jet:refresh` CustomEvent

### MCP Tools

| Tool | Purpose |
|------|---------|
| `jet_render` | Render elements to canvas (frame, chart, note, embed) |
| `jet_canvas` | Canvas operations (read, move, resize, arrange, bind, delete) |
| `jet_data` | Fetch data from configured API (requires backend) |
| `jet_query` | Query local DuckDB cache with SQL |
| `jet_exec` | Execute Python/R code |
| `jet_parse` | Parse documents (PDF, DOCX, images, etc.) to markdown |
| `jet_save` | Save structured data (lists, projects, portfolios) |
| `jet_skill` | Fetch a skill prompt by name |
| `jet_template` | Fetch a template by name |
| `jet_search` | Search for stock/security symbols |
| `jet_deploy` | Deploy project as Docker web app |
| `jet_share` | Share canvas elements as web pages (requires backend) |
| `jet_connector` | Create/manage data connectors |

---

## MCP Configuration by Editor

Jetro auto-writes MCP config for most editors. If your agent can't see tools:

| Editor | Config Location | Auto-configured? |
|--------|----------------|-----------------|
| Claude Code / VS Code | `{workspace}/.mcp.json` | Yes |
| Cursor | `{workspace}/.cursor/mcp.json` | Yes |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` | Yes |
| Windsurf | Global settings | Manual |
| Codex (OpenAI) | `~/.codex/config.toml` (TOML format) | Manual |
| Qwen Code | `{workspace}/.qwen/settings.json` | Manual |
| Cline | VS Code globalStorage | Manual |
| Continue | `~/.continue/config.yaml` | Manual |

For manual setup, copy the server entry from `.jetro/mcp-config.json` in your workspace.

---

## Troubleshooting

### MCP Tools Not Loading

1. Run **"Jetro: Reinitialize MCP Server"** from the command palette
2. Check Output panel → filter "Jetro" for errors
3. Verify `.mcp.json` exists in workspace root
4. Ensure Node.js 18+ is installed: `node --version`
5. Restart your editor

### Frame Preview is Blank

1. Click the **refresh button** (circular arrow) in the canvas toolbar
2. Switch to another canvas tab and back
3. Ensure HTML is a complete document (`<!DOCTYPE html><html>...</html>`)

### Refresh Script Not Running

1. Check Output panel → filter "Jetro" for `[bindings]` errors
2. Test manually: `python3 .jetro/scripts/your_script.py`
3. Script must output valid JSON to stdout
4. Ensure Python 3 is installed

### DuckDB Not Working

1. DuckDB uses NAPI bindings — works across all Node/Electron versions
2. If it fails on first run, sign out and back in (re-initializes after workspace creation)
3. Check Output panel for `DuckDB init` messages

### Deploy Fails

1. Ensure Docker Desktop is installed and running
2. Check `projects/{slug}/deploy/` has `server.py`, `requirements.txt`, `Dockerfile`
3. Check Output panel → filter "Jetro" for `[deploy]` errors

---

## Customization

### Thin Prompt (CLAUDE.md)

The thin prompt is the auto-generated `CLAUDE.md` that agents read on every turn. It tells the agent what tools exist and how to use them.

To customize it (add behavioral doctrine, domain-specific instructions, language preferences), edit the `content` array in `extension/src/services/bootstrapService.ts → injectAgentContext()`.

See **`agent/docs/thin-prompt-reference.md`** for a full guide on customization, including how to add working style, language support, and domain guidelines.

### Custom MCP Tools

Tools are defined in `mcp-server/src/index.ts` in the `TOOLS` array. Each tool has a name, description, and JSON Schema for its input parameters. To add a custom tool:

1. Add the tool definition to the `TOOLS` array:
```typescript
{
  name: "my_tool",
  description: "What this tool does",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The input" }
    },
    required: ["query"]
  }
}
```

2. Add a handler function:
```typescript
async function handleMyTool(args: { query: string }): Promise<string> {
  // Your logic here
  return JSON.stringify({ result: "..." });
}
```

3. Wire it in the tool dispatcher's `switch` statement

4. Rebuild: `npm run build:mcp`

The agent discovers tools automatically via MCP — no thin prompt changes needed for tool discovery (though you can add a one-liner to the tools table for clarity).

---

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test locally (F5 in VS Code)
5. Submit a pull request

### Development Workflow

```bash
# Terminal 1: Watch extension
cd extension && npm run build:ext -- --watch

# Terminal 2: Watch webview
cd extension && npm run build:webview -- --watch

# Terminal 3: Watch MCP server
cd mcp-server && npm run build -- --watch

# VS Code: Press F5 to launch Extension Development Host
```

### Setting Up a Test Workspace

When you press F5, VS Code opens an Extension Development Host. To pre-configure a test folder, create `extension/.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}", "/path/to/your/test/folder"]
    }
  ]
}
```

Replace `/path/to/your/test/folder` with any folder on your machine. The Extension Development Host will open that folder with Jetro active.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
