import React, { useState, useCallback, useEffect } from "react";
import { useReactFlow, useOnViewportChange } from "@xyflow/react";

// Simple inline SVG icons (no external dependency)
const IconPointer = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
    <path d="M13 13l6 6" />
  </svg>
);
const IconHand = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 11V6a2 2 0 0 0-4 0v1" />
    <path d="M14 10V4a2 2 0 0 0-4 0v2" />
    <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
  </svg>
);
const IconMinus = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
);
const IconPlus = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
);
const IconMaximize = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);
const IconZoomOut = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" />
  </svg>
);
const IconC2 = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
    <line x1="12" y1="2" x2="12" y2="6" />
    <line x1="12" y1="18" x2="12" y2="22" />
    <line x1="2" y1="12" x2="6" y2="12" />
    <line x1="18" y1="12" x2="22" y2="12" />
  </svg>
);
const IconRefresh = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

export type CanvasTool = "pointer" | "hand";

function ToolbarBtn({
  icon: Icon,
  active,
  onClick,
  title,
  disabled,
}: {
  icon: React.FC;
  active?: boolean;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 30,
        height: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
        border: "none",
        background: active ? "rgba(222,191,202,0.12)" : hovered && !disabled ? "#2b2b2b" : "transparent",
        color: active ? "#DEBFCA" : disabled ? "#555" : hovered ? "#ccc" : "#8b8b8b",
        cursor: disabled ? "default" : "pointer",
        transition: "all 0.1s",
        opacity: disabled ? 0.5 : 1,
        padding: 0,
      }}
    >
      <Icon />
    </button>
  );
}

function Sep() {
  return <div style={{ width: 1, height: 16, background: "#2b2b2b", margin: "0 3px" }} />;
}

interface CanvasToolbarProps {
  c2Enabled?: boolean;
  c2WireCount?: number;
  isProjectCanvas?: boolean;
  onToggleC2?: () => void;
  onRefreshFrames?: () => void;
  tool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
}

export function CanvasToolbar({ c2Enabled = false, c2WireCount = 0, isProjectCanvas = false, onToggleC2, onRefreshFrames, tool, onToolChange }: CanvasToolbarProps) {
  const { zoomIn, zoomOut, fitView, getZoom, setViewport, getViewport } = useReactFlow();
  const [zoom, setZoom] = useState(100);

  // Sync zoom display on viewport changes
  useOnViewportChange({
    onChange: useCallback(() => {
      setZoom(Math.round(getZoom() * 100));
    }, [getZoom]),
  });

  const handleZoomIn = () => {
    zoomIn({ duration: 200 });
  };

  const handleZoomOut = () => {
    zoomOut({ duration: 200 });
  };

  const handleFit = () => {
    fitView({ padding: 0.2, duration: 300 });
  };

  const handleFullZoomOut = () => {
    const vp = getViewport();
    setViewport({ x: vp.x, y: vp.y, zoom: 0.25 }, { duration: 300 });
  };

  const handleResetZoom = () => {
    const vp = getViewport();
    setViewport({ x: vp.x, y: vp.y, zoom: 1 }, { duration: 200 });
  };

  const [zoomHover, setZoomHover] = useState(false);

  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 1,
        background: "#1e1e1e",
        border: "1px solid #2b2b2b",
        borderRadius: 8,
        padding: "3px 4px",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        zIndex: 100,
      }}
    >
      <ToolbarBtn icon={IconPointer} active={tool === "pointer"} onClick={() => onToolChange("pointer")} title="Select (V)" />
      <ToolbarBtn icon={IconHand} active={tool === "hand"} onClick={() => onToolChange("hand")} title="Pan (H)" />

      <Sep />

      <ToolbarBtn icon={IconMinus} onClick={handleZoomOut} title="Zoom out" disabled={zoom <= 10} />
      <button
        onClick={handleResetZoom}
        title="Reset zoom to 100%"
        onMouseEnter={() => setZoomHover(true)}
        onMouseLeave={() => setZoomHover(false)}
        style={{
          minWidth: 42,
          height: 28,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 4,
          border: "none",
          background: zoomHover ? "#2b2b2b" : "transparent",
          color: "#8b8b8b",
          cursor: "pointer",
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 500,
          transition: "background 0.1s",
          padding: 0,
        }}
      >
        {zoom}%
      </button>
      <ToolbarBtn icon={IconPlus} onClick={handleZoomIn} title="Zoom in" disabled={zoom >= 400} />

      <Sep />

      <ToolbarBtn icon={IconMaximize} onClick={handleFit} title="Fit to view" />
      <ToolbarBtn icon={IconZoomOut} onClick={handleFullZoomOut} title="Full zoom out" />
      <ToolbarBtn icon={IconRefresh} onClick={() => onRefreshFrames?.()} title="Refresh all frames" />

      {isProjectCanvas && (
        <>
          <Sep />
          <ToolbarBtn
            icon={IconC2}
            active={c2Enabled}
            onClick={() => onToggleC2?.()}
            title={c2Enabled ? "Disable C2 mode" : "Enable C2 mode"}
          />
        </>
      )}
    </div>
  );
}
