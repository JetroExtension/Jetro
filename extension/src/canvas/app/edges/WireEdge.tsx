import React from "react";
import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

export interface WireEdgeData {
  channel?: string;
  bidirectional?: boolean;
  label?: string;
  lastActivity?: number;
}

export function WireEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const wireData = (data || {}) as WireEdgeData;
  const isActive = wireData.lastActivity && Date.now() - wireData.lastActivity < 2000;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      {/* Invisible wider hit area for easier selection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        className="react-flow__edge-interaction"
      />
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected
            ? "#DEBFCA"
            : isActive
              ? "#DEBFCA"
              : "rgba(222,191,202,0.35)",
          strokeWidth: selected ? 2.5 : 2,
          strokeDasharray: isActive ? "4 16" : "none",
          animation: isActive ? "c2wire-flow 0.8s linear infinite" : "none",
        }}
      />
      {/* Channel label */}
      {wireData.channel && (
        <foreignObject
          x={labelX - 40}
          y={labelY - 10}
          width={80}
          height={20}
          className="react-flow__edge-label"
          style={{ pointerEvents: "none", overflow: "visible" }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              fontSize: 9,
              fontFamily: "'JetBrains Mono', monospace",
              color: "rgba(222,191,202,0.7)",
              background: "rgba(26,26,26,0.85)",
              borderRadius: 3,
              padding: "1px 6px",
              whiteSpace: "nowrap",
              width: "fit-content",
              margin: "0 auto",
            }}
          >
            {wireData.bidirectional && "↔ "}
            {wireData.channel}
          </div>
        </foreignObject>
      )}
    </>
  );
}
