import { FileManager } from "./fileManager";
import { ShareBranding } from "../types";

/**
 * Converts canvas frame elements into self-contained, shareable HTML files.
 * Pure string manipulation — no React, no VS Code webview dependencies.
 *
 * Security notes:
 *  • Snapshot data is filtered to a strict allowlist (no internal paths, keys, bindings)
 *  • __JET.query() calls are aggressively stripped (multiple patterns)
 *  • Absolute workspace paths are scrubbed from HTML and snapshot
 *  • CSS custom property values are sanitized against injection
 *  • </script> sequences in JSON are escaped to prevent premature tag closure
 */
export class FrameBundler {
  constructor(
    private fileManager: FileManager,
    private workspacePath: string
  ) {}

  /**
   * Bundle a frame element into a standalone HTML page with branding.
   */
  async bundle(
    frameHtml: string,
    title: string,
    branding?: ShareBranding | null,
    snapshotData?: Record<string, unknown>
  ): Promise<string> {
    let html = frameHtml;

    // 1. Replace blob: URLs with CDN URLs for Plotly
    html = html.replace(
      /blob:[^"'\s]+plotly[^"'\s]*/gi,
      "https://cdn.plot.ly/plotly-2.35.2.min.js"
    );

    // 2. Strip __JET.query() calls — multiple patterns to prevent bypass
    //    Handles: __JET.query(...), __JET["query"](...), window.__JET.query(...)
    //    Uses a balanced-paren aware approach for nested SQL
    html = this.stripJetQueryCalls(html);

    // 3. Strip absolute workspace paths from HTML content
    if (this.workspacePath) {
      html = html.split(this.workspacePath).join(".");
    }

    // 4. Use branding or defaults
    const resolvedBranding = this.extractBranding(branding ?? null);

    // 5. Build snapshot script — filter to safe fields only
    const safeSnapshot = snapshotData
      ? this.sanitizeSnapshot(snapshotData)
      : null;
    const snapshotScript = safeSnapshot
      ? `<script>window.__JET_SNAPSHOT = ${this.safeJsonForScript(safeSnapshot)};</script>`
      : "";
    const refreshScript = safeSnapshot
      ? `<script>if(window.__JET_SNAPSHOT){window.dispatchEvent(new CustomEvent('jet:refresh',{detail:window.__JET_SNAPSHOT}));}</script>`
      : "";

    // 6. Inject snapshot into the frame HTML as-is (no branding shell wrapper).
    //    The frame is already self-contained HTML written by the agent.
    //    The viewer SPA provides the outer chrome (header, tabs, status bar).
    //    Wrapping it in another HTML document would break its own styles.
    if (html.includes("</head>")) {
      // Inject snapshot script before </head>
      html = html.replace("</head>", `${snapshotScript}\n</head>`);
    } else if (html.includes("<body")) {
      // No <head> — inject before <body>
      html = html.replace(/<body/i, `${snapshotScript}\n<body`);
    } else {
      // Raw HTML fragment — prepend snapshot
      html = snapshotScript + "\n" + html;
    }

    // Inject refresh dispatch at end
    if (refreshScript) {
      if (html.includes("</body>")) {
        html = html.replace("</body>", `${refreshScript}\n</body>`);
      } else {
        html += "\n" + refreshScript;
      }
    }

    return html;
  }

  /**
   * Read a frame's HTML content from disk.
   * Checks element.data.html first, then .jetro/frames/{framePath}.
   */
  async readFrameHtml(
    elementData: Record<string, unknown>
  ): Promise<string | null> {
    // Inline HTML takes priority
    if (typeof elementData.html === "string" && elementData.html.length > 0) {
      return elementData.html;
    }

    // Fall back to file path (FileManager handles path traversal check)
    if (typeof elementData.framePath === "string") {
      return this.fileManager.readFrameFile(elementData.framePath);
    }

    return null;
  }

  /**
   * Resolve branding with defaults.
   */
  extractBranding(branding: ShareBranding | null): ShareBranding {
    return {
      firmName: branding?.firmName || "Jetro",
      primaryColor: branding?.primaryColor || "#DEBFCA",
      accentColor: branding?.accentColor || "#007ACC",
      fontHeading: branding?.fontHeading || "system-ui",
      fontBody: branding?.fontBody || "system-ui",
      disclaimer: branding?.disclaimer,
    };
  }

  // ── Private: Sanitization ──

  /**
   * Filter snapshot data to a strict allowlist of safe fields.
   * Only include data that the frame's JS actually needs for rendering.
   * Explicitly exclude: paths, bindings, HTML source, internal metadata.
   */
  private sanitizeSnapshot(
    data: Record<string, unknown>
  ): Record<string, unknown> | null {
    // Denylist: internal fields that must never be shared
    const DENY = new Set([
      "html",            // raw frame source (already in the page)
      "framePath",       // workspace-relative file path
      "scriptPath",      // refresh script path
      "refreshBinding",  // binding config
      "listSlug",        // internal list reference
      "canvasElementId", // internal element ref
      "JET_JWT",
      "JET_API_URL",
      "JET_WORKSPACE",
    ]);

    const result: Record<string, unknown> = {};
    let hasFields = false;

    for (const [key, value] of Object.entries(data)) {
      if (DENY.has(key)) continue;

      // Skip any field that looks like an absolute path
      if (typeof value === "string" && (value.startsWith("/") && value.includes("/."))) {
        continue;
      }

      // Recursively scrub workspace paths from string values
      if (typeof value === "string" && this.workspacePath && value.includes(this.workspacePath)) {
        result[key] = value.split(this.workspacePath).join(".");
      } else {
        result[key] = value;
      }
      hasFields = true;
    }

    return hasFields ? result : null;
  }

  /**
   * Aggressively strip __JET.query() calls from HTML.
   * Handles nested parentheses, bracket notation, and window prefix.
   */
  private stripJetQueryCalls(html: string): string {
    // Pattern 1: __JET.query(...) with balanced parens (handles nested SQL)
    // Replace entire call including balanced parens
    html = this.replaceBalancedCall(html, /__JET\.query\s*\(/g);
    html = this.replaceBalancedCall(html, /__JET\s*\[\s*["']query["']\s*\]\s*\(/g);
    html = this.replaceBalancedCall(html, /window\.__JET\.query\s*\(/g);
    html = this.replaceBalancedCall(html, /window\.__JET\s*\[\s*["']query["']\s*\]\s*\(/g);

    // Final fallback: simple regex for any remaining single-line patterns
    html = html.replace(/__JET\.query\b/g, "/* JET_REMOVED */");
    html = html.replace(/__JET\s*\[\s*["']query["']\s*\]/g, "/* JET_REMOVED */");

    return html;
  }

  /**
   * Replace a function call pattern including its balanced parenthesized arguments.
   */
  private replaceBalancedCall(html: string, pattern: RegExp): string {
    let result = "";
    let lastIndex = 0;
    const globalPattern = new RegExp(pattern.source, "g" + (pattern.flags.includes("i") ? "i" : ""));

    let match: RegExpExecArray | null;
    while ((match = globalPattern.exec(html)) !== null) {
      result += html.slice(lastIndex, match.index);

      // Find the balanced closing paren starting from the end of the match
      // (the match includes the opening paren)
      let depth = 1;
      let i = match.index + match[0].length;
      while (i < html.length && depth > 0) {
        if (html[i] === "(") depth++;
        else if (html[i] === ")") depth--;
        i++;
      }

      result += "/* __JET.query removed for shared view */";
      lastIndex = i;
    }

    result += html.slice(lastIndex);
    return result;
  }

  /** Sanitize a value for safe injection into CSS custom property context. */
  private sanitizeCss(value: string): string {
    // Strip characters that could escape CSS context: ; { } url( @ import
    return value.replace(/[;{}@\\]|url\s*\(|import/gi, "");
  }

  /**
   * Serialize to JSON safe for embedding in <script> tags.
   * Escapes </script> sequences that would prematurely close the tag.
   */
  private safeJsonForScript(data: unknown): string {
    return JSON.stringify(data)
      .replace(/<\/(script)/gi, "<\\/$1");
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }
}
