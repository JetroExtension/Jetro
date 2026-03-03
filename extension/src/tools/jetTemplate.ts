import * as vscode from "vscode";
import * as path from "path";
import { FileManager } from "../services/fileManager";

/**
 * jet.template — Returns a template by name.
 *
 * Searches bundled starter templates (agent/templates/*.json) first,
 * then falls back to local user templates (.jetro/templates/).
 * No network calls — fully offline.
 */
export class JetTemplateTool {
  constructor(
    private extensionPath: string,
    private fileManager: FileManager,
    private outputChannel: vscode.OutputChannel
  ) {}

  /**
   * List all available template metadata (name + description + source).
   * Used by sidebar, settings, and companion to show the template catalog.
   */
  async listAll(): Promise<Array<{ name: string; description: string; source: "starter" | "local" }>> {
    const results: Array<{ name: string; description: string; source: "starter" | "local" }> = [];

    // 1. Bundled starter templates
    const bundledDir = path.join(this.extensionPath, "agent", "templates");
    try {
      const dirUri = vscode.Uri.file(bundledDir);
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      for (const [filename] of entries) {
        if (!filename.endsWith(".json")) continue;
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(bundledDir, filename)));
          const tpl = JSON.parse(new TextDecoder().decode(bytes));
          if (tpl.name) {
            results.push({
              name: tpl.name,
              description: tpl.description || "",
              source: "starter",
            });
          }
        } catch {
          // Skip malformed template files
        }
      }
    } catch {
      this.outputChannel.appendLine("[jet.template] No bundled templates directory found");
    }

    // 2. Local user templates (.jetro/templates/)
    try {
      const localSlugs = await this.fileManager.listTemplates();
      for (const slug of localSlugs) {
        const displayName = slug.replace(/_/g, " ");
        if (!results.some((r) => r.name.toLowerCase() === displayName.toLowerCase())) {
          results.push({ name: displayName, description: "", source: "local" });
        }
      }
    } catch {
      // No local templates
    }

    return results;
  }

  async execute(input: { name: string }): Promise<{ content: string } | { error: string }> {
    const { name } = input;
    this.outputChannel.appendLine(`[jet.template] Looking up: ${name}`);

    // 1. Search bundled starter templates (agent/templates/*.json)
    const bundledDir = path.join(this.extensionPath, "agent", "templates");
    try {
      const dirUri = vscode.Uri.file(bundledDir);
      const entries = await vscode.workspace.fs.readDirectory(dirUri);
      for (const [filename] of entries) {
        if (!filename.endsWith(".json")) continue;
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(bundledDir, filename)));
          const tpl = JSON.parse(new TextDecoder().decode(bytes));
          if (tpl.name === name) {
            this.outputChannel.appendLine(`[jet.template] OK (bundled): ${name} (${tpl.content.length} chars)`);
            return { content: tpl.content };
          }
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Bundled dir not available
    }

    // 2. Search local user templates (.jetro/templates/)
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const local = await this.fileManager.readTemplate(slug);
    if (local) {
      this.outputChannel.appendLine(`[jet.template] OK (local): ${name} (${local.length} chars)`);
      return { content: local };
    }

    this.outputChannel.appendLine(`[jet.template] Not found: ${name}`);
    return { error: `Template not found: ${name}` };
  }
}
