import React, { memo, useCallback, useEffect, useRef, useMemo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useCanvasApi } from "../CanvasContext";
import { shimForCanvas, canUseSrcdoc } from "../libShimmer";

// Access the bundled Plotly from window (exposed in index.tsx)
const Plotly = (window as unknown as Record<string, unknown>).Plotly as {
  newPlot: (
    el: HTMLElement,
    traces: Record<string, unknown>[],
    layout?: Record<string, unknown>,
    config?: Record<string, unknown>
  ) => void;
  Plots: { resize: (el: HTMLElement) => void };
} | undefined;

interface HtmlFrameData {
  src?: string;
  html?: string;
  content?: string;
  title?: string;
  markdown?: string;
  // Plotly spec — if agent sends traces/layout directly
  traces?: Record<string, unknown>[];
  plotlyLayout?: Record<string, unknown>;
}

/**
 * Inject the __JET SDK into an HTML document. Provides:
 * - __JET.query(sql) — run read-only SQL against DuckDB, returns Promise<row[]>
 * - __JET.assetUrl(path) — get HTTP URL for a workspace file
 * - __JET.fetchFile(path) — fetch a workspace file, returns Promise<Response>
 * - __JET.vendorUrl(path) — get HTTP URL for a bundled vendor library file
 * - __JET.loadCesium() — dynamically load CesiumJS, returns Promise<Cesium>
 * - __JET.loadThree() — dynamically load Three.js, returns Promise<THREE>
 * - __JET.loadModel(path) — get HTTP URL for a workspace 3D model file
 * - window "jet:refresh" CustomEvent — fired when live refresh data arrives
 */
function injectJetSdk(html: string, elementId: string, fileUrlBase?: string): string {
  const baseStr = fileUrlBase ? `"${fileUrlBase}"` : "null";
  const sdk = `<script>
window.__JET={elementId:"${elementId}",_fileBase:${baseStr},_p:{},_c:0,_listeners:{},query:function(sql){var self=this;return new Promise(function(ok,fail){var id="fq_"+ ++self._c+"_"+Date.now();self._p[id]={ok:ok,fail:fail};window.parent.postMessage({type:"jet:query",requestId:id,sql:sql},"*");setTimeout(function(){if(self._p[id]){delete self._p[id];fail(new Error("Query timeout (30s)"))}},30000)})},assetUrl:function(p){if(!this._fileBase)return p;return this._fileBase+"/"+encodeURIComponent(p)},fetchFile:function(p){return fetch(this.assetUrl(p)).then(function(r){if(!r.ok)throw new Error("File not found: "+p);return r})},send:function(ch,data){window.parent.postMessage({type:"jet:send",channel:ch,payload:data},"*")},on:function(ch,cb){if(!this._listeners[ch])this._listeners[ch]=[];this._listeners[ch].push(cb);return function(){var arr=window.__JET._listeners[ch];if(arr){var i=arr.indexOf(cb);if(i>=0)arr.splice(i,1)}}},once:function(ch,cb){var off=this.on(ch,function(d){off();cb(d)});return off},off:function(ch,cb){var arr=this._listeners[ch];if(!arr)return;if(!cb){delete this._listeners[ch]}else{var i=arr.indexOf(cb);if(i>=0)arr.splice(i,1)}},declarePorts:function(manifest){window.parent.postMessage({type:"jet:declarePorts",manifest:manifest},"*")},vendorUrl:function(p){if(!this._fileBase)return"/vendor/"+p;var base=this._fileBase.replace(/\\/files\\/?$/,"/vendor/");return base+p},loadCesium:function(){var self=this;return new Promise(function(ok,fail){if(window.Cesium){ok(window.Cesium);return}var lk=document.createElement("link");lk.rel="stylesheet";lk.href=self.vendorUrl("cesium/Widgets/widgets.css");document.head.appendChild(lk);var sc=document.createElement("script");sc.src=self.vendorUrl("cesium/Cesium.js");sc.onload=function(){window.CESIUM_BASE_URL=self.vendorUrl("cesium/");ok(window.Cesium)};sc.onerror=function(){fail(new Error("Failed to load CesiumJS"))};document.head.appendChild(sc)})},loadThree:function(){var self=this;return new Promise(function(ok,fail){if(window.THREE){ok(window.THREE);return}var sc=document.createElement("script");sc.src=self.vendorUrl("three/three.module.min.js");sc.onload=function(){ok(window.THREE)};sc.onerror=function(){fail(new Error("Failed to load Three.js"))};document.head.appendChild(sc)})},loadModel:function(p){return this.assetUrl(p)}};
window.__JET.store={get:function(k){var b=(window.__JET._fileBase||"").replace(/\\/files\\/?$/,"");return fetch(b+"/api/store/"+k).then(function(r){return r.json()})},set:function(k,v){var b=(window.__JET._fileBase||"").replace(/\\/files\\/?$/,"");return fetch(b+"/api/store/"+k,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(v)}).then(function(r){return r.json()})}};
window.__JET.db={query:function(sql){var b=(window.__JET._fileBase||"").replace(/\\/files\\/?$/,"");return fetch(b+"/api/query",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sql:sql})}).then(function(r){return r.json()})}};
window.addEventListener("message",function(e){var d=e.data;if(!d)return;if(d.type==="jet:queryResult"&&__JET._p[d.requestId]){var h=__JET._p[d.requestId];delete __JET._p[d.requestId];d.error?h.fail(new Error(d.error)):h.ok(d.rows)}if(d.type==="jet:refresh")window.dispatchEvent(new CustomEvent("jet:refresh",{detail:d.payload}));if(d.type==="jet:fileServerReady"&&d.fileUrlBase){__JET._fileBase=d.fileUrlBase}if(d.type==="jet:message"){var cbs=__JET._listeners[d.channel];if(cbs)cbs.slice().forEach(function(fn){try{fn(d.payload)}catch(err){console.error("[JET] listener error:",err)}})}});
<\/script>`;
  // Inject after <head> tag if present
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, "$&\n" + sdk);
  }
  // Otherwise prepend
  return sdk + "\n" + html;
}

/**
 * Wraps raw HTML in a full document with dark theme base styles.
 * Rendered inside a blob: URL iframe so scripts and CDN libraries
 * execute without being blocked by the parent webview's CSP.
 */
function wrapInDocument(html: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%;
    background: #181818;
    color: #cccccc;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 12px;
    line-height: 1.6;
    overflow: auto;
  }
  h1, h2, h3 { color: #DEBFCA; margin: 12px 0 6px 0; }
  h1 { font-size: 18px; } h2 { font-size: 15px; } h3 { font-size: 13px; }
  p { margin: 4px 0; color: #aaa; }
  a { color: #58A6FF; }
  table { width: 100%; border-collapse: collapse; font-family: 'JetBrains Mono', monospace; font-size: 11px; }
  th, td { padding: 5px 8px; border-bottom: 1px solid #2b2b2b; text-align: left; }
  th { font-size: 9px; text-transform: uppercase; opacity: 0.5; font-weight: 600; }
  ul, ol { padding-left: 16px; color: #aaa; }
  code { background: #252525; padding: 1px 4px; border-radius: 3px; font-family: 'JetBrains Mono', monospace; font-size: 11px; }
  pre { background: #252525; padding: 10px; border-radius: 4px; overflow-x: auto; font-family: 'JetBrains Mono', monospace; font-size: 11px; }
  .metric-card { background: #1e1e1e; border: 1px solid #2b2b2b; border-radius: 6px; padding: 14px; }
  .metric-value { font-size: 24px; font-weight: 700; color: #fff; font-family: 'JetBrains Mono', monospace; }
  .metric-label { font-size: 9px; text-transform: uppercase; opacity: 0.5; letter-spacing: 0.3px; }
  .green { color: #3FB950; } .red { color: #F85149; } .amber { color: #DEBFCA; } .blue { color: #58A6FF; }
</style>
</head>
<body>${html}</body>
</html>`;
}

export const HtmlFrame = memo(({ id, data, selected }: NodeProps) => {
  const d = data as unknown as HtmlFrameData;
  const plotRef = useRef<HTMLDivElement>(null);
  const { postMessage, fileUrlBase } = useCanvasApi();

  // Force repaint when iframe loads — fixes blank iframes in webview panels.
  const handleIframeLoad = useCallback((e: React.SyntheticEvent<HTMLIFrameElement>) => {
    const iframe = e.currentTarget;
    iframe.style.opacity = "0.99";
    requestAnimationFrame(() => { iframe.style.opacity = "1"; });
  }, []);

  // Resolve the HTML content from various possible data shapes
  const htmlContent = d.html || d.content || d.markdown || "";

  // src field could be a URL, raw HTML, or a file path (which we can't render client-side)
  const srcIsUrl =
    typeof d.src === "string" &&
    (d.src.startsWith("http://") || d.src.startsWith("https://"));
  const srcIsFilePath =
    typeof d.src === "string" &&
    !srcIsUrl &&
    !d.src.startsWith("<") &&
    (d.src.includes("/") || d.src.endsWith(".html") || d.src.endsWith(".htm"));
  // Only use src as raw HTML if it actually looks like HTML (starts with < or contains tags)
  const srcContent =
    typeof d.src === "string" && !srcIsUrl && !srcIsFilePath ? d.src : "";
  const srcUrl = srcIsUrl ? d.src : null;

  const finalHtml = htmlContent || srcContent;

  // Detect if this has Plotly trace data (structured data mode)
  const hasPlotly = Plotly && d.traces && d.traces.length > 0;

  // Whether we have renderable content (for showing Open in Browser button)
  const hasContent = !!finalHtml || !!hasPlotly;

  // Decide rendering strategy: srcdoc (shimmed, fast) vs blob: (full CDN freedom)
  // Use srcdoc when all script sources are from our CSP-allowed CDN domains.
  // Fall back to blob: for unknown CDN domains that CSP would block.
  const { srcdocHtml, blobUrl } = useMemo(() => {
    if (hasPlotly || !finalHtml) return { srcdocHtml: null, blobUrl: null };
    const isFullDocument = /^\s*<!doctype\s/i.test(finalHtml) || /^\s*<html[\s>]/i.test(finalHtml);
    // Wrap snippet if needed, then inject __JET SDK for frame query support
    const doc = injectJetSdk(
      isFullDocument ? finalHtml : wrapInDocument(finalHtml),
      id,
      fileUrlBase || undefined
    );

    // WebGL frames (_webgl: true) always use blob: for full CSP freedom
    // (CesiumJS needs unsafe-eval for new Function(), blob workers for tile decoding)
    if (d._webgl || canUseSrcdoc(doc) === false) {
      const blob = new Blob([doc], { type: "text/html" });
      return { srcdocHtml: null, blobUrl: URL.createObjectURL(blob) };
    } else {
      // All scripts from allowed CDN domains → use srcdoc with lib shimming
      return { srcdocHtml: shimForCanvas(doc), blobUrl: null };
    }
  }, [finalHtml, hasPlotly, id, fileUrlBase, d._webgl]);

  // Content fingerprint — forces iframe remount when HTML changes.
  // Browsers ignore srcDoc prop changes on existing iframes, so React must
  // unmount/remount via a new key to pick up updated content.
  // Uses djb2 hash over the full string to avoid collisions from sampling.
  const contentKey = useMemo(() => {
    const s = finalHtml || "";
    if (s.length === 0) return "empty";
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
    }
    // Include _repaintKey so the iframe remounts when the extension forces a repaint
    const repaint = d._repaintKey ? `-${d._repaintKey}` : "";
    return `${(h >>> 0).toString(36)}-${s.length}${repaint}`;
  }, [finalHtml, d._repaintKey]);

  // Clean up blob URL on unmount or content change
  useEffect(() => {
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [blobUrl]);

  // Plotly trace rendering (structured data mode)
  useEffect(() => {
    if (!plotRef.current || !hasPlotly || !Plotly) return;

    const userLayout = d.plotlyLayout || {};
    const axisDefaults = {
      gridcolor: "#2b2b2b",
      zerolinecolor: "#333",
      tickfont: { size: 10, color: "#666" },
    };

    const darkLayout: Record<string, unknown> = {
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: "#aaa", family: "Inter, sans-serif", size: 11 },
      margin: { t: 8, r: 16, b: 36, l: 48 },
      xaxis: { ...axisDefaults, ...((userLayout.xaxis as object) || {}) },
      yaxis: { ...axisDefaults, ...((userLayout.yaxis as object) || {}) },
      legend: { font: { size: 10, color: "#888" }, bgcolor: "transparent", orientation: "h", y: -0.15, ...((userLayout.legend as object) || {}) },
      colorway: ["#DEBFCA", "#58A6FF", "#3FB950", "#F85149", "#BC8CFF", "#FF7B72"],
      ...userLayout,
    };

    // Merge additional axes (yaxis2, yaxis3, etc.)
    for (const key of Object.keys(userLayout)) {
      if (/^[xy]axis\d+$/.test(key)) {
        darkLayout[key] = { ...axisDefaults, ...((userLayout[key] as object) || {}) };
      }
    }

    Plotly.newPlot(plotRef.current, d.traces!, darkLayout, {
      displayModeBar: false,
      responsive: true,
      scrollZoom: true,
    });

    return () => {
      if (plotRef.current) plotRef.current.innerHTML = "";
    };
  }, [d, hasPlotly]);

  useEffect(() => {
    if (!plotRef.current || !hasPlotly) return;
    const observer = new ResizeObserver(() => {
      if (plotRef.current && Plotly) Plotly.Plots.resize(plotRef.current);
    });
    observer.observe(plotRef.current);
    return () => observer.disconnect();
  }, [hasPlotly]);

  const handleOpenInBrowser = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Build the full HTML to send to the extension host
    let html = finalHtml;
    if (!html && hasPlotly) {
      // For Plotly traces, generate a standalone HTML doc
      html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<script src="https://cdn.plot.ly/plotly-2.27.0.min.js"><\/script>
<style>body{margin:0;background:#181818;font-family:Inter,sans-serif;}</style>
</head><body><div id="chart" style="width:100%;height:100vh;"></div>
<script>Plotly.newPlot("chart",${JSON.stringify(d.traces)},${JSON.stringify(d.plotlyLayout || {})},{responsive:true});<\/script>
</body></html>`;
    }
    if (html) {
      const isFullDocument = /^\s*<!doctype\s/i.test(html) || /^\s*<html[\s>]/i.test(html);
      postMessage({
        type: "canvas.openInBrowser",
        data: {
          nodeId: id,
          html: isFullDocument ? html : wrapInDocument(html),
          title: d.title || "HTML Frame",
        },
      });
    }
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        minWidth: 280,
        minHeight: 150,
        background: "#1e1e1e",
        border: `1px solid ${selected ? "#DEBFCA" : "#2b2b2b"}`,
        borderRadius: 6,
        overflow: "hidden",
        color: "#ccc",
        boxShadow: selected ? "0 0 12px rgba(222,191,202,0.2)" : "0 1px 4px rgba(0,0,0,0.3)",
        transition: "box-shadow 0.2s ease, border-color 0.2s ease",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />

      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid #2b2b2b",
          background: "#1a1a1a",
          fontSize: 12,
          fontWeight: 600,
          fontFamily: "'Inter', sans-serif",
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
        }}
      >
        <span style={{ opacity: 0.35 }}>&#9638;</span>
        <span style={{ flex: 1 }}>{d.title || "HTML Frame"}</span>
        {hasContent && (
          <>
            <button
              onClick={() => postMessage({ type: "canvas.openInCompanion" })}
              title="Open in web app"
              style={{
                background: "transparent",
                border: "none",
                borderRadius: 4,
                color: "#888",
                fontSize: 11,
                cursor: "pointer",
                padding: "2px 6px",
                lineHeight: 1,
                display: "flex",
                alignItems: "center",
                gap: 3,
                transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#DEBFCA"; e.currentTarget.style.background = "rgba(222,191,202,0.12)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#888"; e.currentTarget.style.background = "transparent"; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              <span>Web App</span>
            </button>
            <button
              onClick={handleOpenInBrowser}
              title="Open in browser"
              style={{
                background: "transparent",
                border: "none",
                borderRadius: 4,
                color: "#888",
                fontSize: 11,
                cursor: "pointer",
                padding: "2px 6px",
                lineHeight: 1,
                display: "flex",
                alignItems: "center",
                gap: 3,
                transition: "all 0.15s ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#DEBFCA"; e.currentTarget.style.background = "rgba(222,191,202,0.12)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#888"; e.currentTarget.style.background = "transparent"; }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              <span>Browser</span>
            </button>
          </>
        )}
      </div>

      {hasPlotly ? (
        <div ref={plotRef} style={{ flex: 1, minHeight: 0, width: "100%", padding: "0 4px 4px" }} />
      ) : srcdocHtml ? (
        <div style={{ flex: 1, minHeight: 0, width: "100%", position: "relative" }}>
          <iframe
            key={contentKey}
            data-element-id={id}
            srcDoc={srcdocHtml}
            sandbox="allow-scripts allow-same-origin"
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "#181818",
              display: "block",
            }}
            title={d.title || "HTML Frame"}
            onLoad={handleIframeLoad}
          />
          {!selected && (
            <div style={{ position: "absolute", inset: 0, cursor: "grab" }} />
          )}
        </div>
      ) : blobUrl ? (
        <div style={{ flex: 1, minHeight: 0, width: "100%", position: "relative" }}>
          <iframe
            key={contentKey}
            data-element-id={id}
            src={blobUrl}
            sandbox="allow-scripts allow-same-origin"
            {...(d._webgl ? { allow: "autoplay; fullscreen; xr-spatial-tracking" } : {})}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              background: "#181818",
              display: "block",
            }}
            title={d.title || "HTML Frame"}
            onLoad={handleIframeLoad}
          />
          {!selected && (
            <div style={{ position: "absolute", inset: 0, cursor: "grab" }} />
          )}
        </div>
      ) : srcUrl ? (
        <div
          style={{
            padding: 14,
            background: "#181818",
            fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <div style={{ color: "#666", marginBottom: 6 }}>External URL:</div>
          <div style={{ color: "#58A6FF", wordBreak: "break-all" }}>{srcUrl}</div>
        </div>
      ) : srcIsFilePath ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "#181818",
            color: "#666",
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            gap: 6,
            padding: 14,
          }}
        >
          <span style={{ color: "#DEBFCA" }}>File reference not resolved</span>
          <span style={{ color: "#555", wordBreak: "break-all" }}>{d.src}</span>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#181818",
            color: "#444",
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          No content
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
});

HtmlFrame.displayName = "HtmlFrame";
