import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { FileManager } from "./fileManager";
import { AuthService } from "./authService";
import { JETApiClient } from "./apiClient";
import type { Skill, Template, ToolDefinition } from "../types";

/**
 * BootstrapService — loads skills, templates, and system prompt from local files.
 *
 * OSS version: reads from extensionPath/agent/ instead of a remote backend.
 * Skills and templates are JSON files, system prompt is a markdown file.
 *
 * The thin CLAUDE.md is generated on every activation with the skill/template catalog.
 * The system prompt is delivered to the agent via wrapResponse() on the first tool call.
 */
export class BootstrapService {
  private systemPrompt: string = "";
  private apiReference: string = "";
  private skills: Skill[] = [];
  private templates: Template[] = [];
  private toolDefinitions: Map<string, ToolDefinition> = new Map();
  private contextDelivered = false;
  private extensionPath: string = "";

  constructor(private outputChannel: vscode.OutputChannel) {}

  /**
   * Load skills, templates, and system prompt from local agent/ directory.
   * No backend required — everything runs from bundled files.
   */
  async bootstrap(
    _api: JETApiClient,
    _auth: AuthService,
    _fileManager?: FileManager,
    extensionPath?: string
  ): Promise<"ok" | "cancelled" | "error"> {
    if (extensionPath) this.extensionPath = extensionPath;

    try {
      // Load skills from agent/skills/*.json
      this.skills = await this.readLocalSkills();

      // Load templates from agent/templates/*.json
      this.templates = await this.readLocalTemplates();

      // Load system prompt from agent/system-prompts/prompt.md
      this.systemPrompt = await this.readLocalSystemPrompt();

      this.outputChannel.appendLine(
        `[bootstrap] OK (local) — ${this.skills.length} skills · ${this.templates.length} templates` +
        (this.systemPrompt ? " · system prompt loaded" : " · no system prompt")
      );
      return "ok";
    } catch (err) {
      this.outputChannel.appendLine(`[bootstrap] Error: ${err}`);
      return "error";
    }
  }

  /** Read all skill JSON files from agent/skills/ */
  private async readLocalSkills(): Promise<Skill[]> {
    const skillsDir = path.join(this.extensionPath, "agent", "skills");
    const skills: Skill[] = [];
    try {
      const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(skillsDir, file), "utf-8");
          const skill = JSON.parse(raw);
          if (skill.name) {
            skills.push({ name: skill.name, description: skill.description || "" });
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* no skills dir */ }
    return skills;
  }

  /** Read all template JSON files from agent/templates/ */
  private async readLocalTemplates(): Promise<Template[]> {
    const templatesDir = path.join(this.extensionPath, "agent", "templates");
    const templates: Template[] = [];
    try {
      const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(templatesDir, file), "utf-8");
          const tpl = JSON.parse(raw);
          if (tpl.name) {
            templates.push({ name: tpl.name, description: tpl.description || "" });
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* no templates dir */ }
    return templates;
  }

  /** Read system prompt from agent/system-prompts/prompt.md */
  private async readLocalSystemPrompt(): Promise<string> {
    const promptPath = path.join(this.extensionPath, "agent", "system-prompts", "prompt.md");
    try {
      return fs.readFileSync(promptPath, "utf-8");
    } catch {
      return ""; // no system prompt — extension works without it
    }
  }

  /**
   * Write thin CLAUDE.md — the "thin prompt" that agents read on every turn.
   *
   * This file tells the agent what tools are available, how to use them,
   * and lists available skills/templates. It's auto-generated on every
   * activation from local agent/ files.
   *
   * CUSTOMIZATION:
   * - Add your own behavioral doctrine by editing the `content` array below
   * - Add domain-specific instructions, working style, or methodology
   * - Skills and templates are auto-listed from agent/skills/ and agent/templates/
   * - The system prompt (agent/system-prompts/prompt.md) is delivered separately
   *   via wrapResponse() and never written to disk
   */
  /** Read bundled starter template metadata from agent/templates/*.json */
  private async readBundledTemplates(extensionPath: string): Promise<Template[]> {
    const bundled: Template[] = [];
    const bundledDir = path.join(extensionPath, "agent", "templates");
    try {
      const dirUri = vscode.Uri.file(bundledDir);
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      for (const [filename] of entries) {
        if (!filename.endsWith(".json")) continue;
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(bundledDir, filename)));
          const tpl = JSON.parse(new TextDecoder().decode(bytes));
          if (tpl.name) {
            bundled.push({ name: tpl.name, description: tpl.description || "" });
          }
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // No bundled templates dir
    }
    return bundled;
  }

  async injectAgentContext(fileManager: FileManager, extensionPath: string): Promise<void> {
    const financeEnabled = await fileManager.isFinanceEnabled();

    // Merge backend templates with bundled starter templates
    const bundled = await this.readBundledTemplates(extensionPath);
    const allTemplates = [...this.templates];
    for (const bt of bundled) {
      if (!allTemplates.some((t) => t.name === bt.name)) {
        allTemplates.push(bt);
      }
    }

    const content = [
      "# Jetro",
      "",
      "You are the Jetro assistant, working inside a VS Code extension that provides",
      "an infinite canvas workspace, data tools, code execution, and extensible skills.",
      "",
      "> Auto-generated on boot. Do not edit — overwritten on every session start.",
      "",
      "---",
      "",
      "## Canvas System",
      "",
      "You work on an **infinite canvas** — a visual workspace where every output",
      "(charts, tables, dashboards, notes, reports) is rendered as a canvas element.",
      "",
      "Element types via `jet_render`:",
      "- **frame** — Rich HTML (dashboards, tables, KPIs). Plotly/D3/Observable Plot are pre-bundled.",
      "- **chart** — Plotly.js traces (bar, scatter, pie, candlestick, etc.). Use this for simple charts.",
      "- **note** — Markdown text",
      "- **embed** — External URLs in sandboxed iframe",
      "",
      "Canvas operations via `jet_canvas`: list, read, move, resize, delete, arrange, bind, unbind, trigger.",
      "",
      "### Frame Rules",
      "",
      "- Write HTML to `.jetro/frames/{name}.html`, render with `data.file`",
      "- Inline: `data.html` for quick snippets",
      "- HTML must be a complete document: `<!DOCTYPE html><html><head>...</head><body>...</body></html>`",
      "- Chart libraries (Plotly, D3, Observable Plot) are pre-bundled. Use CDN `<script src>` tags — they are shimmed to local copies. Never inline library source.",
      "",
      "### Live Refresh (jet:refresh)",
      "",
      "Frame HTML MUST use the `jet:refresh` CustomEvent to receive live data.",
      "Data arrives in `e.detail` (NOT `e.data`).",
      "",
      "```js",
      'window.addEventListener("jet:refresh", function(e) {',
      "  var data = e.detail;",
      '  document.getElementById("value").textContent = data.value;',
      "});",
      "```",
      "",
      "Bind a refresh script: `refreshBinding: { scriptPath: \".jetro/scripts/foo.py\", intervalMs: 5000 }`",
      "Always render real initial data — never placeholders.",
      "",
      "### C2 Mode",
      "",
      "Project canvases can activate C2 mode — frames communicate via wires (named data channels).",
      "Inside frames: `__JET.send(channel, data)`, `__JET.on(channel, callback)`.",
      "",
      "## Tools",
      "",
      "| Tool | Purpose |",
      "|------|---------|",
      "| `jet_render` | Render elements to canvas (frame, chart, note, embed) |",
      "| `jet_canvas` | Canvas operations (read, move, resize, arrange, bind, etc.) |",
      "| `jet_data` | Fetch data from configured backend API |",
      "| `jet_query` | Query local DuckDB cache with SQL |",
      "| `jet_exec` | Execute Python/R code in sandboxed subprocess |",
      "| `jet_parse` | Parse documents (PDF, DOCX, images, etc.) to markdown |",
      "| `jet_save` | Save structured data (lists, projects, portfolios, etc.) |",
      "| `jet_skill` | Fetch a skill prompt by name |",
      "| `jet_template` | Fetch a template by name |",
      "| `jet_deploy` | Deploy project as Docker web app |",
      "| `jet_connector` | Create/manage data connectors |",
      "| `jet_search` | Search for stock/security symbols |",
      "",
      "### Python SDK (refresh scripts & jet_exec)",
      "",
      "```python",
      "from jet.api import jet_api       # Data API proxy (auth handled)",
      "from jet.market import Ticker     # Free market data (no API key)",
      "from jet.connectors import use    # Agent-built connectors",
      "```",
      "",
      "For large jet_exec output (>8KB), write to file and print the path.",
      "",
      "## Help",
      "",
      "Detailed reference at `.jetro/docs/reference.md`. Read it when user needs help.",
      "",
      "Quick fixes:",
      "- **MCP tools not loading** → \"Jetro: Reinitialize MCP Server\" from command palette",
      "- **Frame blank** → click refresh button in canvas toolbar",
      "- **Script errors** → check Output > Jetro for `[bindings]` logs",
      "",
      ...this.skills.length > 0 ? [
        "## Available Skills",
        "",
        ...this.skills.map((s) => `- **${s.name}** — ${s.description}`),
        "",
      ] : [],
      ...allTemplates.length > 0 ? [
        "## Available Templates",
        "",
        ...allTemplates.map((t) => `- **${t.name}** — ${t.description}`),
        "",
      ] : [],
      "## Workspace Layout",
      "",
      "```",
      "data/               — cached data",
      "projects/{slug}/    — research projects with scoped canvases",
      ".jetro/             — config, scripts, cache, canvas registry",
      ".jetro/frames/      — HTML files for frame elements",
      ".jetro/connectors/  — agent-built data connectors",
      ".jetro/templates/   — user-created templates",
      "```",
    ].join("\n");

    await fileManager.writeToRoot("CLAUDE.md", content);
    await this.writeEditorRules(fileManager, content);
    await this.writeReferenceDoc(fileManager, extensionPath);
    this.outputChannel.appendLine("[bootstrap] Wrote thin CLAUDE.md + editor rules + reference doc (IP in memory only)");
  }

  /**
   * Copy the bundled reference guide to the workspace so agents can read it.
   * Overwritten on every session start to ensure updates propagate.
   */
  private async writeReferenceDoc(fileManager: FileManager, extensionPath: string): Promise<void> {
    try {
      const refSource = vscode.Uri.file(path.join(extensionPath, "agent", "docs", "reference.md"));
      const refContent = await vscode.workspace.fs.readFile(refSource);
      await fileManager.writeToPath([".jetro", "docs", "reference.md"], new TextDecoder().decode(refContent));
    } catch (err) {
      // Non-critical — agent can still function without the reference doc
      this.outputChannel.appendLine(`[bootstrap] Failed to write reference doc: ${err}`);
    }
  }

  /**
   * Write the same agent instructions to Cursor, Antigravity, and GitHub Copilot
   * rule files so their agents also see the Jetro context.
   */
  private async writeEditorRules(fileManager: FileManager, markdownContent: string): Promise<void> {
    // Cursor: .cursor/rules/agent.mdc — YAML frontmatter with alwaysApply
    const cursorContent = [
      "---",
      "alwaysApply: true",
      "---",
      "",
      markdownContent,
    ].join("\n");
    await fileManager.writeToPath([".cursor", "rules", "agent.mdc"], cursorContent);

    // Antigravity: .agents/rules/agent.md — YAML frontmatter with trigger
    const antigravityContent = [
      "---",
      "trigger: always_on",
      "---",
      "",
      markdownContent,
    ].join("\n");
    await fileManager.writeToPath([".agents", "rules", "agent.md"], antigravityContent);

    // GitHub Copilot: .github/copilot-instructions.md — flat markdown
    await fileManager.writeToPath([".github", "copilot-instructions.md"], markdownContent);

    // Windsurf: .windsurfrules — flat markdown
    await fileManager.writeToRoot(".windsurfrules", markdownContent);

    // VS Code / generic: AGENT.md — flat markdown
    await fileManager.writeToRoot("AGENT.md", markdownContent);
  }

  /**
   * Wrap a tool response with operating context on the first call of the session.
   * System prompt + API reference are prepended once, then never again.
   */
  wrapResponse(result: unknown): unknown {
    if (this.contextDelivered || !this.systemPrompt) {
      return result;
    }
    this.contextDelivered = true;
    this.outputChannel.appendLine("[bootstrap] Delivered operating context via tool response");

    const preamble = [
      "[JETRO OPERATING CONTEXT — SESSION START]",
      "",
      this.systemPrompt,
      ...(this.apiReference ? ["", "---", "", this.apiReference] : []),
      "",
      "[END OPERATING CONTEXT]",
    ].join("\n");

    // For string results, prepend as text
    if (typeof result === "string") {
      return preamble + "\n\n" + result;
    }
    // For object results, wrap in an envelope
    return {
      _context: preamble,
      result,
    };
  }

  /**
   * Fallback: when bootstrap is unavailable (no auth), write a minimal
   * CLAUDE.md that tells the agent to authenticate. No proprietary
   * system prompts or doctrines are bundled — all IP stays server-side.
   */
  async injectFallbackContext(
    fileManager: FileManager,
    extensionUri: vscode.Uri
  ): Promise<void> {
    const financeEnabled = await fileManager.isFinanceEnabled();
    const bundled = await this.readBundledTemplates(extensionUri.fsPath);

    const content = [
      "# Jetro Agent Context",
      "",
      `> Finance features: **${financeEnabled ? "Enabled" : "Disabled"}**`,
      "> Offline — backend not connected. Sign in to unlock full capabilities.",
      "",
      "---",
      "",
      "You are an assistant for the Jetro research platform.",
      "",
      "## Getting Started",
      "",
      "The user is not authenticated. Core features (skills, data API) require sign-in.",
      "You can still:",
      "- Use `jet_render` to create canvas elements (charts, tables, frames, notes, KPI cards)",
      "- Use `jet_canvas` to manage canvas layout (move, resize, arrange, delete elements)",
      "- Use `jet_query` to query any local DuckDB data",
      "- Use `jet_exec` to run Python/R code",
      "- Use `jet_parse` to convert documents to markdown (PDF, DOCX, PPTX, XLSX, HTML, EPUB, RTF, EML, images with OCR)",
      "- Use `jet_template` to access report templates (available offline)",
      "",
      "To unlock all features, sign in via the Jetro sidebar.",
      "",
      "## Available Skills",
      "",
      "Sign in to access skills. Call `jet.skill({ name: \"Skill Name\" })` after authentication.",
      "",
      "## Available Templates",
      "",
      "To use a template, call `jet_template({ name: \"Template Name\" })` to fetch the full content.",
      "",
      ...bundled.map((t) => `- **${t.name}** — ${t.description}`),
    ].join("\n");

    await fileManager.writeToRoot("CLAUDE.md", content);
    await this.writeEditorRules(fileManager, content);
    this.outputChannel.appendLine("[bootstrap] Wrote minimal fallback CLAUDE.md + editor rules (no bundled prompts)");
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getSkills(): Skill[] {
    return this.skills;
  }

  getTemplates(): Template[] {
    return this.templates;
  }

  getSchema(): Record<string, unknown> {
    return this.schema;
  }

  getToolsConfig(): Record<string, unknown> {
    return this.toolsConfig;
  }

  /** Tool definitions parsed from KV tools_config. Empty map if bootstrap failed. */
  getToolDefinitions(): Map<string, ToolDefinition> {
    return this.toolDefinitions;
  }
}
