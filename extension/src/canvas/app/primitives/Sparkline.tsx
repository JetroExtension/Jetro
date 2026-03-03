import React from "react";

interface SparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
}

export function Sparkline({
  data,
  color = "#DEBFCA",
  width = 100,
  height = 24,
  fill = false,
}: SparklineProps) {
  if (!data || data.length < 2) {
    return null;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 1;

  const points = data
    .map((v, i) => {
      const x = pad + (i / (data.length - 1)) * (width - 2 * pad);
      const y = pad + (1 - (v - min) / range) * (height - 2 * pad);
      return `${x},${y}`;
    })
    .join(" ");

  const fillPoints = fill
    ? `${pad},${height - pad} ${points} ${width - pad},${height - pad}`
    : "";

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {fill && (
        <polygon points={fillPoints} fill={color} opacity={0.12} />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
