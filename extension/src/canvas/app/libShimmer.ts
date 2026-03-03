/**
 * LibShimmer — rewrites CDN library references in agent-generated HTML
 * to use locally bundled chart libraries for performance.
 *
 * Two modes:
 *   shimForCanvas(html)  → strips CDN scripts, injects parent window refs (srcdoc iframe)
 *   shimForBrowser(html)  → rewrites CDN URLs to relative ./libs/ paths
 */

/** CDN URL patterns and their corresponding local lib + window variable name */
const SHIM_MAP: { pattern: RegExp; localFile: string; windowVar: string }[] = [
  // Plotly — all CDN variants
  { pattern: /https?:\/\/cdn\.plot\.ly\/plotly[^"'\s]*/g, localFile: "plotly.min.js", windowVar: "Plotly" },
  { pattern: /https?:\/\/unpkg\.com\/plotly\.js[^"'\s]*/g, localFile: "plotly.min.js", windowVar: "Plotly" },
  { pattern: /https?:\/\/cdn\.jsdelivr\.net\/npm\/plotly\.js[^"'\s]*/g, localFile: "plotly.min.js", windowVar: "Plotly" },
  { pattern: /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/plotly\.js[^"'\s]*/g, localFile: "plotly.min.js", windowVar: "Plotly" },
  // Observable Plot
  { pattern: /https?:\/\/cdn\.jsdelivr\.net\/npm\/@observablehq\/plot[^"'\s]*/g, localFile: "observable-plot.min.js", windowVar: "Plot" },
  { pattern: /https?:\/\/unpkg\.com\/@observablehq\/plot[^"'\s]*/g, localFile: "observable-plot.min.js", windowVar: "Plot" },
  // D3
  { pattern: /https?:\/\/cdn\.jsdelivr\.net\/npm\/d3@[^"'\s]*/g, localFile: "d3.min.js", windowVar: "d3" },
  { pattern: /https?:\/\/d3js\.org\/d3[^"'\s]*/g, localFile: "d3.min.js", windowVar: "d3" },
  { pattern: /https?:\/\/unpkg\.com\/d3@[^"'\s]*/g, localFile: "d3.min.js", windowVar: "d3" },
  { pattern: /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/d3[^"'\s]*/g, localFile: "d3.min.js", windowVar: "d3" },
];

/** Regex to match full <script> tags that load a known CDN library */
const SCRIPT_TAG_RE = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi;

/**
 * Whether the HTML can be rendered via srcdoc (lightweight, same-origin).
 * CSP allows all HTTPS sources, so srcdoc always works for HTTPS CDNs.
 * Only fall back to blob: for http:// scripts (unlikely in practice).
 */
export function canUseSrcdoc(html: string): boolean {
  const srcRe = /<script[^>]*\bsrc\s*=\s*["'](http:\/\/[^"']+)["'][^>]*>/gi;
  return !srcRe.test(html);
}

/**
 * For canvas display (srcdoc iframe):
 * Strips CDN <script> tags for known libs and injects window.parent references
 * so the iframe shares the canvas webview's already-loaded libraries.
 */
export function shimForCanvas(html: string): string {
  const injectedVars = new Set<string>();

  // Strip <script src="CDN"> tags for known libraries
  let result = html.replace(SCRIPT_TAG_RE, (fullMatch, src: string) => {
    for (const entry of SHIM_MAP) {
      entry.pattern.lastIndex = 0; // reset regex state
      if (entry.pattern.test(src)) {
        injectedVars.add(entry.windowVar);
        return `<!-- shimmed: ${entry.windowVar} from parent -->`;
      }
    }
    return fullMatch; // unknown CDN — leave as-is (will load from CDN if CSP allows)
  });

  // Also strip <script type="module"> imports for known libs (ESM pattern)
  // e.g. import * as Plot from "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6/+esm"
  for (const entry of SHIM_MAP) {
    const esmImportRe = new RegExp(
      `import\\s+[^;]*from\\s*["']${entry.pattern.source.replace(/\\/g, "\\\\")}[^"']*["']\\s*;?`,
      "g"
    );
    const matched = result.match(esmImportRe);
    if (matched) {
      result = result.replace(esmImportRe, `/* shimmed: ${entry.windowVar} from parent */`);
      injectedVars.add(entry.windowVar);
    }
  }

  // Inject parent window variable references right after <head> or at the top
  if (injectedVars.size > 0) {
    const assignments = Array.from(injectedVars)
      .map((v) => `if(window.parent.${v})window.${v}=window.parent.${v};`)
      .join("");
    const shimScript = `<script>${assignments}</script>`;

    // Insert after <head> tag if present, otherwise prepend
    if (/<head[^>]*>/i.test(result)) {
      result = result.replace(/(<head[^>]*>)/i, `$1\n${shimScript}`);
    } else {
      result = shimScript + result;
    }
  }

  return result;
}

/**
 * For browser display:
 * Rewrites CDN URLs in <script src="..."> to relative ./libs/filename paths.
 * Also handles ESM imports.
 * Returns: { html, requiredLibs } — caller must copy the required lib files.
 */
export function shimForBrowser(html: string): { html: string; requiredLibs: string[] } {
  const libs = new Set<string>();

  let result = html.replace(SCRIPT_TAG_RE, (fullMatch, src: string) => {
    for (const entry of SHIM_MAP) {
      entry.pattern.lastIndex = 0;
      if (entry.pattern.test(src)) {
        libs.add(entry.localFile);
        return fullMatch.replace(src, `./libs/${entry.localFile}`);
      }
    }
    return fullMatch;
  });

  // Also handle ESM imports
  for (const entry of SHIM_MAP) {
    const esmRe = new RegExp(
      `(from\\s*["'])${entry.pattern.source.replace(/\\/g, "\\\\")}[^"']*["']`,
      "g"
    );
    if (esmRe.test(result)) {
      result = result.replace(esmRe, `$1./libs/${entry.localFile}'`);
      libs.add(entry.localFile);
    }
  }

  return { html: result, requiredLibs: Array.from(libs) };
}
