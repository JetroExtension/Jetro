import type { ToolDefinition } from "../types";

/**
 * Minimal tool definitions — offline fallback when bootstrap fails.
 * Full descriptions + schemas are served from CF KV via bootstrap.
 * These provide enough structure for registerTool() to produce valid tool calls.
 *
 * SYNC CHECK: inputSchema properties must match the TypeScript types
 * used in the invoke handlers in extension.ts. When updating
 * tools_config.json, verify both match.
 */
export const TOOL_DEFAULTS: Record<string, ToolDefinition> = {
  jet_data: {
    id: "jet_data",
    displayName: "jet.data",
    description: "Fetch financial data from the Jetro Data API.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["fmp", "polygon"], description: "Data provider" },
        endpoint: { type: "string", description: "API endpoint path" },
        params: { type: "object", description: "Optional query parameters" },
      },
      required: ["provider", "endpoint"],
    },
  },
  jet_render: {
    id: "jet_render",
    displayName: "jet.render",
    description: "Render a visual element to the Research Board canvas. Use type='frame' for HTML, type='chart' for Plotly, type='note' for markdown.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["note", "pdf", "frame", "embed"], description: "Element type" },
        data: { type: "object", description: "Element data (title, html/markdown/traces/file)" },
        id: { type: "string", description: "Optional element ID for in-place updates" },
        config: { type: "object", description: "Optional render config" },
        projectSlug: { type: "string", description: "Target project canvas" },
        refreshBinding: {
          type: "object",
          description: "Optional refresh binding: { scriptPath, intervalMs?, sourceDomain?, timeoutMs?, bindingType?, refreshPrompt?, elementTitle? }",
          properties: {
            scriptPath: { type: "string" },
            intervalMs: { type: "number" },
            bindingType: { type: "string", enum: ["script", "prompt"] },
            refreshPrompt: { type: "string" },
            elementTitle: { type: "string" },
          },
        },
      },
      required: ["type", "data"],
    },
  },
  jet_save: {
    id: "jet_save",
    displayName: "jet.save",
    description: "Save structured data to the Jetro workspace (list, project, portfolio, credential, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["list", "project", "preference", "element", "recipe", "datasource", "portfolio", "template", "dataset", "connection", "model", "query", "memory", "credential"] },
        name: { type: "string" },
        payload: { type: "object" },
      },
      required: ["type", "name", "payload"],
    },
  },
  jet_query: {
    id: "jet_query",
    displayName: "jet.query",
    description: "Query the local DuckDB cache with read-only SQL.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL query" },
      },
      required: ["sql"],
    },
  },
  jet_skill: {
    id: "jet_skill",
    displayName: "jet.skill",
    description: "Fetch a skill prompt from the Jetro backend. Call this before executing any skill.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact skill name from the Available Skills list" },
      },
      required: ["name"],
    },
  },
  jet_template: {
    id: "jet_template",
    displayName: "jet.template",
    description: "Fetch a report/output template from the Jetro backend.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact template name from the Available Templates list" },
      },
      required: ["name"],
    },
  },
  jet_canvas: {
    id: "jet_canvas",
    displayName: "jet.canvas",
    description: "Manage visual canvas panels. Actions: list, read, move, resize, delete, arrange, bind, unbind, bindings, trigger.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "move", "resize", "delete", "arrange", "bind", "unbind", "bindings", "trigger"], description: "Canvas operation" },
        canvasId: { type: "string", description: "Target canvas ID. Omit to use the active canvas." },
        elementId: { type: "string", description: "Target element ID" },
        position: { type: "object", description: "{ x, y } for move" },
        size: { type: "object", description: "{ width, height? } for resize" },
        operations: { type: "array", description: "Batch ops for arrange: [{ elementId, position?, size? }]" },
        refreshBinding: { type: "object", description: "For 'bind': { scriptPath, intervalMs?, sourceDomain?, timeoutMs? }", properties: { scriptPath: { type: "string" }, intervalMs: { type: "number" }, sourceDomain: { type: "string" }, timeoutMs: { type: "number" } } },
        projectSlug: { type: "string", description: "Project slug (backward compat)" },
      },
      required: ["action"],
    },
  },
  jet_parse: {
    id: "jet_parse",
    displayName: "jet.parse",
    description: "Parse documents (PDF, DOCX, PPTX, XLSX, HTML, EPUB, RTF, EML, images) into structured markdown.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to document (relative to workspace)" },
        projectSlug: { type: "string", description: "Project to store output in" },
        outputName: { type: "string", description: "Name for output file (without .md)" },
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
  jet_exec: {
    id: "jet_exec",
    displayName: "jet.exec",
    description: "Execute Python or R code for data analysis, ML, scraping, or complex transformations.",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "r"], description: "Programming language" },
        code: { type: "string", description: "Code to execute" },
        timeout: { type: "number", description: "Timeout in ms (default 300000)" },
      },
      required: ["language", "code"],
    },
  },
};
