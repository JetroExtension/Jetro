import React from "react";

interface ProgressBarProps {
  value: number;
  max?: number;
  color?: string;
  label?: string;
}

export function ProgressBar({ value, max = 100, color, label }: ProgressBarProps) {
  const pct = Math.min(100, (value / max) * 100);
  const barColor =
    color || (pct >= 70 ? "#3FB950" : pct >= 40 ? "#DEBFCA" : "#F85149");

  return (
    <div>
      {label && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 3,
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <span style={{ opacity: 0.5, textTransform: "uppercase", fontSize: 9 }}>
            {label}
          </span>
          <span style={{ color: barColor, fontWeight: 600 }}>{value}</span>
        </div>
      )}
      <div style={{ height: 4, background: "#2b2b2b", borderRadius: 2 }}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: barColor,
            borderRadius: 2,
            transition: "width 0.3s",
          }}
        />
      </div>
    </div>
  );
}
