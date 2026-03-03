import React, { memo, useState, type ReactNode } from "react";
import { NodeResizer, Handle, Position } from "@xyflow/react";

interface BindingInfo {
  enabled: boolean;
  lastRun?: string;
  lastError?: string;
  bindingType?: "script" | "prompt";
  hasScript?: boolean;
  hasPrompt?: boolean;
}

interface NodeWrapperProps {
  id: string;
  label: string;
  selected: boolean;
  onDelete: (id: string) => void;
  onShare?: (id: string) => void;
  onToggleBinding?: (id: string) => void;
  onOpenInBrowser?: (id: string) => void;
  onOpenInCompanion?: (id: string) => void;
  onOpenInEditor?: (id: string) => void;
  children: ReactNode;
  minWidth?: number;
  minHeight?: number;
  binding?: BindingInfo;
  c2?: boolean;
}

/**
 * Determine the LIVE label based on binding types present.
 * - Script only → "LIVE"
 * - Prompt only → "AI LIVE"
 * - Both → "LIVE + AI"
 */
function getLiveLabel(binding: BindingInfo): string {
  const hasScript = binding.hasScript || binding.bindingType === "script";
  const hasPrompt = binding.hasPrompt || binding.bindingType === "prompt";
  if (hasScript && hasPrompt) return "LIVE + AI";
  if (hasPrompt) return "AI LIVE";
  return "LIVE";
}

function actionBtnStyle(_hovered: boolean): React.CSSProperties {
  return {
    width: 18,
    height: 18,
    background: "transparent",
    border: "none",
    borderRadius: 4,
    color: "#888",
    fontSize: 10,
    lineHeight: "16px",
    textAlign: "center",
    cursor: "pointer",
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "all 0.15s ease",
  };
}

/**
 * Wraps every canvas node with:
 * - Figma-style title label above the node
 * - Delete (×) button on hover
 * - Hybrid binding indicators (LIVE / AI LIVE / LIVE + AI)
 * - Resize handles when selected (both horizontal and vertical)
 */
export const NodeWrapper = memo(
  ({
    id,
    label,
    selected,
    onDelete,
    onShare,
    onToggleBinding,
    onOpenInBrowser,
    onOpenInCompanion,
    onOpenInEditor,
    children,
    minWidth = 240,
    minHeight = 120,
    binding,
    c2,
  }: NodeWrapperProps) => {
    const [hovered, setHovered] = useState(false);

    const hasBinding = !!binding;
    const isEnabled = !!binding?.enabled;
    const hasError = isEnabled && !!binding?.lastError;
    const isPaused = hasBinding && !isEnabled;
    const liveLabel = isEnabled ? getLiveLabel(binding!) : null;

    return (
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <NodeResizer
          isVisible={selected}
          minWidth={minWidth}
          minHeight={minHeight}
          lineStyle={{ borderColor: "#DEBFCA", borderWidth: 1 }}
          handleStyle={{
            width: 8,
            height: 8,
            background: "#DEBFCA",
            border: "none",
            borderRadius: 2,
          }}
        />

        {/* Top bar: label left, LIVE + actions right */}
        <div
          style={{
            position: "absolute",
            top: -20,
            left: 0,
            right: 0,
            display: "flex",
            alignItems: "center",
            gap: 4,
            height: 16,
          }}
        >
          {/* Label */}
          <div
            style={{
              fontSize: 10,
              fontFamily: "'Inter', sans-serif",
              color: selected ? "#DEBFCA" : "#666",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: 1,
              minWidth: 0,
              userSelect: "none",
              letterSpacing: 0.2,
              transition: "color 0.15s ease",
            }}
          >
            {label}
          </div>

          {/* Binding status indicator: green=live, amber=paused, red=error */}
          {hasBinding && (
            <div
              title={
                hasError
                  ? `Refresh error: ${binding!.lastError}`
                  : isPaused
                    ? `Paused${binding!.lastRun ? ` · Last: ${new Date(binding!.lastRun).toLocaleTimeString()}` : ""}`
                    : binding!.lastRun
                      ? `${liveLabel} · Last: ${new Date(binding!.lastRun).toLocaleTimeString()}`
                      : `${liveLabel} refresh bound`
              }
              style={{
                fontSize: 10,
                color: hasError ? "#F85149" : isPaused ? "#E09C3A" : "#3FB950",
                display: "flex",
                alignItems: "center",
                gap: 3,
                pointerEvents: "auto",
                cursor: "help",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: hasError ? "#F85149" : isPaused ? "#E09C3A" : "#3FB950",
                  display: "inline-block",
                  animation: hasError ? "none" : isPaused ? "pulse 3s ease-in-out infinite" : "pulse 2s ease-in-out infinite",
                }}
              />
              <span style={{ fontFamily: "'Inter', sans-serif", letterSpacing: 0.2 }}>
                {hasError ? "ERROR" : isPaused ? "PAUSED" : liveLabel}
              </span>
            </div>
          )}

          {/* Action buttons — visible on hover */}
          {(hovered || selected) && (
            <div
              style={{
                display: "flex",
                gap: 2,
                pointerEvents: "auto",
                flexShrink: 0,
              }}
            >
              {/* Pause/Resume binding */}
              {binding && onToggleBinding && (
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleBinding(id); }}
                  style={actionBtnStyle(hovered)}
                  title={binding.enabled ? "Pause refresh" : "Resume refresh"}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(222,191,202,0.12)"; e.currentTarget.style.color = "#DEBFCA"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#888"; }}
                >
                  {binding.enabled
                    ? <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="3" width="4" height="18" rx="1"/><rect x="15" y="3" width="4" height="18" rx="1"/></svg>
                    : <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M6 3l15 9-15 9V3z"/></svg>
                  }
                </button>
              )}
              {/* Open in editor */}
              {onOpenInEditor && (
                <button
                  onClick={(e) => { e.stopPropagation(); onOpenInEditor(id); }}
                  style={actionBtnStyle(hovered)}
                  title="Open in editor"
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(222,191,202,0.12)"; e.currentTarget.style.color = "#DEBFCA"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#888"; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                </button>
              )}
              {/* Open in browser */}
              {onOpenInBrowser && (
                <button
                  onClick={(e) => { e.stopPropagation(); onOpenInBrowser(id); }}
                  style={actionBtnStyle(hovered)}
                  title="Open in browser"
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(222,191,202,0.12)"; e.currentTarget.style.color = "#DEBFCA"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#888"; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </button>
              )}
              {/* Open in companion web app */}
              {onOpenInCompanion && (
                <button
                  onClick={(e) => { e.stopPropagation(); onOpenInCompanion(id); }}
                  style={actionBtnStyle(hovered)}
                  title="Open in web app"
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(222,191,202,0.12)"; e.currentTarget.style.color = "#DEBFCA"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#888"; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                </button>
              )}
              {/* Share */}
              {onShare && (
                <button
                  onClick={(e) => { e.stopPropagation(); onShare(id); }}
                  style={actionBtnStyle(hovered)}
                  title="Share element"
                  onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(222,191,202,0.12)"; e.currentTarget.style.color = "#DEBFCA"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#888"; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                </button>
              )}
              {/* Delete */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(id);
                }}
                style={actionBtnStyle(hovered)}
                title="Delete"
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(248,81,73,0.12)"; e.currentTarget.style.color = "#F85149"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#888"; }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          )}
        </div>


        {/* Child fills remaining space */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {children}
        </div>

        {/* C2 port handles — left (input), right (output) */}
        {c2 && (
          <>
            <Handle type="target" position={Position.Left} id="c2-in" />
            <Handle type="source" position={Position.Right} id="c2-out" />
          </>
        )}
      </div>
    );
  }
);

NodeWrapper.displayName = "NodeWrapper";
