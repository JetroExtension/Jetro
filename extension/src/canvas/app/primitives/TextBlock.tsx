import React from "react";

interface TextBlockProps {
  content: string;
  style?: string;
}

export function TextBlock({ content, style: variant }: TextBlockProps) {
  if (variant === "header" || content.startsWith("##")) {
    const text = content.replace(/^#+\s*/, "");
    return (
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "#DEBFCA",
          marginBottom: 4,
          fontFamily: "'Inter', sans-serif",
        }}
      >
        {text}
      </div>
    );
  }

  if (variant === "muted") {
    return (
      <div style={{ fontSize: 11, opacity: 0.5, fontFamily: "'Inter', sans-serif" }}>
        {content}
      </div>
    );
  }

  return (
    <div style={{ fontSize: 12, lineHeight: 1.5, fontFamily: "'Inter', sans-serif", color: "#bbb" }}>
      {content}
    </div>
  );
}
