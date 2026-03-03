import React, { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

interface ThesisNoteData {
  title: string;
  markdown: string;
}

export const ThesisNote = memo(({ data, selected }: NodeProps) => {
  const d = data as unknown as ThesisNoteData;

  // Simple markdown-to-text: handle **bold**, *italic*, and newlines
  const renderText = (text: string) => {
    return text
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>")
      .replace(/\n/g, "<br/>");
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        minWidth: 240,
        minHeight: 120,
        display: "flex",
        flexDirection: "column" as const,
        background: "#1e1e1e",
        border: `1px solid ${selected ? "#DEBFCA" : "#2b2b2b"}`,
        borderRadius: 6,
        padding: 16,
        color: "#ccc",
        boxShadow: selected ? "0 0 12px rgba(222,191,202,0.2)" : "none",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />

      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "#DEBFCA",
          marginBottom: 10,
          fontFamily: "'Inter', sans-serif",
          flexShrink: 0,
        }}
      >
        {d.title}
      </div>

      <div
        style={{
          fontFamily: "'Georgia', serif",
          fontSize: 12,
          fontStyle: "italic",
          lineHeight: 1.6,
          color: "#aaa",
          flex: 1,
          minHeight: 0,
          overflow: "auto",
        }}
        dangerouslySetInnerHTML={{ __html: renderText(d.markdown || "") }}
      />

      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
});

ThesisNote.displayName = "ThesisNote";
