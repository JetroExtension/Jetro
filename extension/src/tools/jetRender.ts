import * as vscode from "vscode";
import { v4 as uuid } from "uuid";
import { CanvasProvider } from "../canvas/CanvasProvider";
import { FileManager } from "../services/fileManager";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import { JetRenderInput, CanvasElement, ListColumn } from "../types";

// Default widths per element type
const DEFAULT_WIDTHS: Record<string, number> = {
  note: 320,
  pdf: 400,
  frame: 500,
  embed: 500,
};

export class JetRenderTool {
  private nextY = 40;

  constructor(
    private canvas: CanvasProvider,
    private fileManager: FileManager,
    private outputChannel: vscode.OutputChannel,
    private sidebar?: SidebarProvider
  ) {}

  /** Extract a file path from frame data — agents may put it in different fields. */
  private extractFilePath(data: Record<string, unknown>): string | null {
    if (typeof data.file === "string" && data.file) return data.file;
    if (typeof data.filePath === "string" && data.filePath) return data.filePath;
    if (typeof data.src === "string" && data.src && !data.src.startsWith("http")) {
      if (data.src.includes("/") || data.src.includes(".")) return data.src;
    }
    return null;
  }

  async execute(input: JetRenderInput & { id?: string; projectSlug?: string; canvasId?: string }): Promise<{ elementId: string; position: { x: number; y: number } }> {
    const { type, config, projectSlug, canvasId: inputCanvasId } = input;
    let data = input.data;

    // Resolve canvas target: explicit canvasId > projectSlug > active canvas
    let canvasId = inputCanvasId;
    if (!canvasId && projectSlug) {
      canvasId = await this.canvas.resolveProjectCanvas(projectSlug);
    }
    if (!canvasId) {
      const activeId = this.canvas.getActiveCanvasId();
      canvasId = activeId || await this.canvas.resolveUniversalCanvas();
    }

    this.outputChannel.appendLine(`[jet.render] type=${type} canvas=${canvasId}`);

    // Frame handling: file-based OR inline HTML (auto-persisted to disk)
    if (type === "frame") {
      const filePath = this.extractFilePath(data);
      if (filePath) {
        // Agent provided a file path — read HTML from disk
        this.outputChannel.appendLine(`[jet.render] Reading frame file: ${filePath}`);
        try {
          const html = await this.fileManager.readFrameFile(filePath);
          if (!html) {
            throw new Error(`Frame file not found: ${filePath}`);
          }
          data = { ...data, html, _sourceFile: filePath, file: undefined, filePath: undefined };
          if (typeof data.src === "string" && !data.src.startsWith("http")) {
            data = { ...data, src: undefined };
          }
          this.outputChannel.appendLine(`[jet.render] Loaded ${html.length} chars from ${filePath}`);
        } catch (err) {
          this.outputChannel.appendLine(`[jet.render] Error reading frame file: ${err}`);
          throw err;
        }
      } else if (typeof data.html === "string" && data.html.length > 200) {
        // Inline HTML — auto-persist to .jetro/frames/ so refresh scripts can find it
        const title = typeof data.title === "string" ? data.title : "frame";
        try {
          const htmlStr = data.html as string;
          const savedPath = await this.fileManager.writeFrameFile(title, htmlStr);
          data = { ...data, _sourceFile: savedPath };
          this.outputChannel.appendLine(`[jet.render] Auto-saved ${htmlStr.length} chars → ${savedPath}`);
        } catch (err) {
          // Non-critical: rendering still works with inline HTML
          this.outputChannel.appendLine(`[jet.render] Auto-save failed (non-critical): ${err}`);
        }
      }
    }

    // Note handling: auto-persist markdown as .md file in project notes
    // Check multiple field names — agents may use content/text instead of markdown
    if (type === "note") {
      const md = typeof data.markdown === "string" ? data.markdown
        : typeof data.content === "string" ? data.content
        : typeof data.text === "string" ? data.text
        : "";
      if (md.length > 0) {
        // Normalize to canonical field name
        if (!data.markdown) data = { ...data, markdown: md };
        const title = typeof data.title === "string" ? data.title : "note";
        try {
          const savedPath = await this.fileManager.writeNoteFile(title, md, projectSlug);
          data = { ...data, _filePath: savedPath };
          this.outputChannel.appendLine(`[jet.render] Auto-saved note → ${savedPath}`);
          // Refresh sidebar so Files & Docs section picks up the new .md file
          this.sidebar?.refreshAll();
        } catch (err) {
          this.outputChannel.appendLine(`[jet.render] Note auto-save failed (non-critical): ${err}`);
        }
      }
    }

    // Auto-detect updates: if agent didn't pass id, check if an existing element
    // on this canvas already uses the same _sourceFile. This avoids duplicating
    // frames when the agent edits a file and re-renders without passing the id.
    let isUpdate = !!input.id;
    let id = input.id || "";
    if (!isUpdate && typeof data._sourceFile === "string") {
      try {
        const state = await this.canvas.getState(canvasId);
        const existing = state?.elements?.find(
          (el: { data: Record<string, unknown> }) =>
            el.data._sourceFile === data._sourceFile
        );
        if (existing) {
          id = existing.id;
          isUpdate = true;
          this.outputChannel.appendLine(`[jet.render] Auto-matched existing element ${id} by _sourceFile`);
        }
      } catch {
        // Non-critical — fall through to create new element
      }
    }
    if (!id) id = uuid();
    const baseType = type;
    const width = (config?.width as number) || DEFAULT_WIDTHS[baseType] || 320;
    const defaultHeights: Record<string, number> = { frame: 400, embed: 350 };

    // Auto-position: stack elements vertically with some horizontal spread
    const position = {
      x: 40 + (Math.random() * 60 - 30),
      y: this.nextY,
    };
    if (!isUpdate) this.nextY += 280;

    const element: CanvasElement = {
      id,
      type,
      position,
      size: { width, height: defaultHeights[baseType] || 200 },
      data: data as Record<string, unknown>,
      connections: [],
    };

    // Open the correct canvas and add/update element
    await this.canvas.open(canvasId);
    if (isUpdate) {
      // In-place update: update data only, preserve position/size
      await this.canvas.updateElement(id, data as Record<string, unknown>, canvasId);
    } else {
      await this.canvas.addElement(element, canvasId);
    }

    // Auto-link: if this is a frame with a listSlug, store the elementId on the list
    // Also auto-capture column schema from headers for deterministic refresh
    if (type === "frame" && typeof data.listSlug === "string" && data.listSlug) {
      try {
        const list = await this.fileManager.readList(data.listSlug as string);
        if (list) {
          let updated = false;

          // Link canvas element + canvas ID to list
          if (!list.canvasElementId) {
            list.canvasElementId = id;
            updated = true;
          }
          if (!list.canvasId) {
            list.canvasId = canvasId;
            updated = true;
          }

          // Auto-capture column schema from headers (if not already set)
          if (!list.columns && Array.isArray(data.headers)) {
            const headers = data.headers as string[];
            const columns: ListColumn[] = headers.map((label) => ({
              key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
              label,
              source: "manual" as const,
            }));
            list.columns = columns;
            updated = true;
            this.outputChannel.appendLine(
              `[jet.render] Auto-captured ${columns.length} column defs for list ${data.listSlug}`
            );
          }

          // Persist thesis from table data if list doesn't have one yet
          if (!list.thesis && typeof data.thesis === "string" && data.thesis) {
            list.thesis = data.thesis as string;
            updated = true;
          }

          if (updated) {
            await this.fileManager.writeList(data.listSlug as string, list);
            this.outputChannel.appendLine(`[jet.render] Linked table ${id} → list ${data.listSlug}`);
          }
        }
      } catch {
        // Non-critical — don't break rendering if list linking fails
      }
    }

    this.outputChannel.appendLine(`[jet.render] ✓ ${type} → ${id}`);
    return { elementId: id, position };
  }
}
