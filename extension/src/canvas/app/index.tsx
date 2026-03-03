import React from "react";
import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import Plotly from "plotly.js-dist-min";
import * as Plot from "@observablehq/plot";
import * as d3 from "d3";
import App from "./App";

// Expose chart libraries globally for canvas nodes and child iframes (srcdoc)
const w = window as unknown as Record<string, unknown>;
w.Plotly = Plotly;
w.Plot = Plot;
w.d3 = d3;

// Error boundary — catches React render crashes and shows diagnostic info
class CanvasErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[JET-canvas] React render crash:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, color: "#F85149", fontFamily: "monospace", fontSize: 12 }}>
          <h3 style={{ color: "#DEBFCA" }}>Canvas render error</h3>
          <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById("canvas-root");
if (container) {
  const root = createRoot(container);
  root.render(
    <CanvasErrorBoundary>
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>
    </CanvasErrorBoundary>
  );
}
