import React from "react";

interface BadgeProps {
  label: string;
  variant?: string;
}

const variantStyles: Record<string, { bg: string; color: string }> = {
  green: { bg: "rgba(63,185,80,0.15)", color: "#3FB950" },
  red: { bg: "rgba(248,81,73,0.15)", color: "#F85149" },
  gold: { bg: "rgba(222,191,202,0.12)", color: "#DEBFCA" },
  blue: { bg: "rgba(88,166,255,0.12)", color: "#58A6FF" },
  grey: { bg: "rgba(200,200,200,0.1)", color: "#8b8b8b" },
};

export function Badge({ label, variant = "grey" }: BadgeProps) {
  const style = variantStyles[variant] || variantStyles.grey;

  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 10,
        padding: "2px 8px",
        borderRadius: 3,
        background: style.bg,
        color: style.color,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.3,
      }}
    >
      {label}
    </span>
  );
}
