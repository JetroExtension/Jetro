# Jetro

**Give your AI coding agent an infinite visual workspace.**

Jetro adds a living canvas to your editor. A spatial, persistent surface where your AI agent can render charts, tables, dashboards, interactive frames, and rich data visualizations. Think of it as a whiteboard your agent can draw on while it works.

Your coding agent is powerful, but it's trapped in a text window. Jetro unlocks its full potential by giving it a visual layer to build on. Let your agent create dashboards, analyze data visually, wire up live monitoring panels, and present research, all without leaving your editor.

## What Jetro Does

- **Infinite Canvas** — A workspace where your agent places elements like cards, tables, charts, HTML frames, PDFs, notes, and custom components. Everything is draggable, resizable, and persistent.

- **MCP Integration** — Jetro exposes tools via the Model Context Protocol. Any MCP-compatible agent (Claude, Cursor, Windsurf, Antigravity) can render to the canvas, query data, parse documents, and manage projects through natural conversation.

- **Live Frames** — HTML iframe elements with refresh bindings. Attach a Python script to any frame, set a timer, and watch it update in real time. Build live dashboards, monitoring panels, and data feeds.

- **C2 Mode** — Command & Control mode transforms a canvas into an active cockpit. Wire frames together with named data channels. One frame publishes, another subscribes. Build interconnected operational dashboards.

- **Companion Web App** — Mirror your canvas in a browser. Same workspace, same data, accessible outside the editor. The companion also includes a built-in terminal, so you can use CLI-based coding agents like Claude Code right alongside your visual workspace.

- **Data Layer** — Import CSV, Excel, Parquet, and JSON files. Ask your agent to create custom data connectors to external databases and APIs. Query your data with SQL, all managed through conversation.

- **Document Parsing** — Drop in PDFs, Word docs, spreadsheets, and images.

- **Projects** — Organize your work into project workspaces with scoped canvases, notes, data sources, and structured research.

- **Publish and Share** — Deploy canvases as standalone web apps with a shareable URL. Share individual frames or entire dashboards with your team.

## How It Works

1. Install Jetro
2. Open a folder in your editor
3. The Jetro sidebar appears in the activity bar
4. Your AI agent gets access to Jetro's MCP tools automatically
5. Ask your agent to build something and it renders to the canvas

No special prompting required. Your agent knows what tools are available and how to use them.

## Requirements

- VS Code 1.85+ (or compatible editors: Cursor, Windsurf, Antigravity)
- An MCP-compatible AI agent
- Python 3 (optional, needed for document parsing and live refresh scripts)

**Note:** SQL query and dataset features require a compatible runtime. Some editors using newer Electron versions (e.g. Cursor) may not support these features yet. A fix is coming in a future update.

## Platform Support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon) | Fully supported |
| macOS (Intel) | Fully supported |
| Windows (x64) | Fully supported |
| Windows (ARM) | Fully supported |
| Linux | Partial (no terminal in companion app) |

## Getting Started

Once installed, open the command palette and search for `Jetro`:

- **Jetro: Open Research Board** — Opens a canvas
- **Jetro: Open in Companion (Browser)** — Opens the web companion
- **Jetro: Open Settings** — Configure the extension
- **Jetro: Import Dataset** — Import CSV, Excel, Parquet, or JSON data

## License

Proprietary. All rights reserved.
