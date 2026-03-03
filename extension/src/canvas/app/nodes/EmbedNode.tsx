import React, { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

interface EmbedData {
  url: string;
  title?: string;
}

export const EmbedNode = memo(({ data, selected }: NodeProps) => {
  const d = data as unknown as EmbedData;
  const url = d.url || "";

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "#1e1e1e",
        border: `1px solid ${selected ? "#DEBFCA" : "#2b2b2b"}`,
        borderRadius: 6,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />

      {url ? (
        <iframe
          src={url}
          title={d.title || "Embed"}
          sandbox="allow-scripts allow-same-origin"
          style={{
            width: "100%",
            flex: 1,
            border: "none",
            background: "#fff",
          }}
        />
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#666",
            fontSize: 12,
            fontFamily: "'Inter', sans-serif",
          }}
        >
          No URL provided
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
});

EmbedNode.displayName = "EmbedNode";
