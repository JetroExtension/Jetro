/**
 * LibShimmer (server-side) — rewrites CDN library references in agent-generated HTML
 * to use locally bundled chart libraries for browser preview performance.
 */

/** CDN URL patterns → local lib filename */
const SHIM_MAP: { pattern: RegExp; localFile: string }[] = [
  // Plotly
  { pattern: /https?:\/\/cdn\.plot\.ly\/plotly[^"'\s]*/g, localFile: "plotly.min.js" },
  { pattern: /https?:\/\/unpkg\.com\/plotly\.js[^"'\s]*/g, localFile: "plotly.min.js" },
  { pattern: /https?:\/\/cdn\.jsdelivr\.net\/npm\/plotly\.js[^"'\s]*/g, localFile: "plotly.min.js" },
  { pattern: /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/plotly\.js[^"'\s]*/g, localFile: "plotly.min.js" },
  // Observable Plot
  { pattern: /https?:\/\/cdn\.jsdelivr\.net\/npm\/@observablehq\/plot[^"'\s]*/g, localFile: "observable-plot.min.js" },
  { pattern: /https?:\/\/unpkg\.com\/@observablehq\/plot[^"'\s]*/g, localFile: "observable-plot.min.js" },
  // D3
  { pattern: /https?:\/\/cdn\.jsdelivr\.net\/npm\/d3@[^"'\s]*/g, localFile: "d3.min.js" },
  { pattern: /https?:\/\/d3js\.org\/d3[^"'\s]*/g, localFile: "d3.min.js" },
  { pattern: /https?:\/\/unpkg\.com\/d3@[^"'\s]*/g, localFile: "d3.min.js" },
  { pattern: /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/d3[^"'\s]*/g, localFile: "d3.min.js" },
];

const SCRIPT_TAG_RE = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi;

/**
 * For browser preview:
 * Rewrites CDN <script src="..."> to relative ./libs/ paths.
 * Returns the shimmed HTML and a list of lib files the caller must copy.
 */
export function shimForBrowser(html: string): { html: string; requiredLibs: string[] } {
  const libs = new Set<string>();

  const result = html.replace(SCRIPT_TAG_RE, (fullMatch, src: string) => {
    for (const entry of SHIM_MAP) {
      entry.pattern.lastIndex = 0;
      if (entry.pattern.test(src)) {
        libs.add(entry.localFile);
        return fullMatch.replace(src, `./libs/${entry.localFile}`);
      }
    }
    return fullMatch;
  });

  return { html: result, requiredLibs: Array.from(libs) };
}
