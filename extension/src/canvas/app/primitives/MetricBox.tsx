import React from "react";

interface MetricBoxProps {
  label: string;
  value: string;
  change?: string;
  variant?: string;
}

const variantColors: Record<string, string> = {
  green: "#3FB950",
  red: "#F85149",
  gold: "#DEBFCA",
  blue: "#58A6FF",
};

export function MetricBox({ label, value, change, variant }: MetricBoxProps) {
  const color = variant ? variantColors[variant] || "#ccc" : "#ccc";

  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          fontSize: 9,
          textTransform: "uppercase",
          opacity: 0.4,
          letterSpacing: 0.3,
          fontFamily: "'JetBrains Mono', monospace",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          fontFamily: "'JetBrains Mono', monospace",
          color,
        }}
      >
        {value}
      </div>
      {change && (
        <div
          style={{
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            color: change.startsWith("-") ? "#F85149" : "#3FB950",
          }}
        >
          {change}
        </div>
      )}
    </div>
  );
}
