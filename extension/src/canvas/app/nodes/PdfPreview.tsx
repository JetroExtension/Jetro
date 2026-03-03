import React, { memo, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

interface PdfPreviewData {
  src: string;
  title?: string;
  page?: number;
  pageCount?: number;
  format?: string;
  parsedPreview?: string;
  parsed?: boolean;
  projectSlug?: string;
}

const FORMAT_ICONS: Record<string, string> = {
  pdf: "PDF",
  docx: "DOC",
  pptx: "PPT",
  xlsx: "XLS",
  image: "IMG",
  html: "HTM",
};

declare function postMessage(msg: unknown): void;

export const PdfPreview = memo(({ data, selected, id }: NodeProps) => {
  const d = data as unknown as PdfPreviewData;
  const fmt = d.format || "pdf";
  const icon = FORMAT_ICONS[fmt] || "DOC";

  const handleOpen = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      postMessage({
        type: "canvas.openFile",
        data: { src: d.src, projectSlug: d.projectSlug },
      });
    },
    [d.src, d.projectSlug]
  );

  const handleParse = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      postMessage({
        type: "canvas.parseDocument",
        data: { src: d.src, projectSlug: d.projectSlug, nodeId: id },
      });
    },
    [d.src, d.projectSlug, id]
  );

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        minWidth: 300,
        minHeight: 200,
        display: "flex",
        flexDirection: "column" as const,
        background: "#1e1e1e",
        border: `1px solid ${selected ? "#DEBFCA" : "#2b2b2b"}`,
        borderRadius: 6,
        overflow: "hidden",
        color: "#ccc",
        boxShadow: selected ? "0 0 12px rgba(222,191,202,0.2)" : "none",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />

      {/* Header */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid #2b2b2b",
          fontSize: 12,
          fontWeight: 600,
          fontFamily: "'Inter', sans-serif",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            background: "#2a2a2a",
            padding: "2px 6px",
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 700,
            fontFamily: "'JetBrains Mono', monospace",
            color: "#DEBFCA",
            letterSpacing: "0.5px",
          }}
        >
          {icon}
        </span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {d.title || d.src}
        </span>
        {d.pageCount != null && (
          <span style={{ opacity: 0.4, fontSize: 11, flexShrink: 0 }}>
            {d.pageCount}p
          </span>
        )}
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          background: "#181818",
          padding: d.parsedPreview ? "10px 14px" : 0,
        }}
      >
        {d.parsedPreview ? (
          <div
            style={{
              fontSize: 11,
              lineHeight: 1.5,
              fontFamily: "'Inter', sans-serif",
              color: "#999",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 8,
              WebkitBoxOrient: "vertical" as const,
            }}
          >
            {d.parsedPreview}
          </div>
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#444",
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 36, marginBottom: 8, opacity: 0.2 }}>{icon}</div>
              <div style={{ opacity: 0.5, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {d.src}
              </div>
              {d.page != null && <div style={{ opacity: 0.3, marginTop: 4 }}>Page {d.page}</div>}
            </div>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div
        style={{
          padding: "6px 14px",
          borderTop: "1px solid #2b2b2b",
          display: "flex",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <button
          onClick={handleOpen}
          style={{
            background: "none",
            border: "1px solid #333",
            borderRadius: 3,
            color: "#888",
            fontSize: 11,
            cursor: "pointer",
            padding: "3px 8px",
            fontFamily: "'Inter', sans-serif",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#DEBFCA"; e.currentTarget.style.borderColor = "#DEBFCA"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "#888"; e.currentTarget.style.borderColor = "#333"; }}
        >
          Open
        </button>
        {!d.parsed && (
          <button
            onClick={handleParse}
            style={{
              background: "none",
              border: "1px solid #333",
              borderRadius: 3,
              color: "#888",
              fontSize: 11,
              cursor: "pointer",
              padding: "3px 8px",
              fontFamily: "'Inter', sans-serif",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#58A6FF"; e.currentTarget.style.borderColor = "#58A6FF"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "#888"; e.currentTarget.style.borderColor = "#333"; }}
          >
            Parse
          </button>
        )}
        {d.parsed && (
          <span
            style={{
              fontSize: 11,
              color: "#3FB950",
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontFamily: "'Inter', sans-serif",
            }}
          >
            &#10003; Parsed
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
});

PdfPreview.displayName = "PdfPreview";
