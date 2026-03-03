import React, { useCallback, useEffect, useRef, useState } from "react";

interface ChannelPickerProps {
  /** Position to show the picker at (typically near the midpoint of the new edge) */
  position: { x: number; y: number };
  /** Called with the chosen channel name, or null if cancelled */
  onSelect: (channel: string | null, bidirectional: boolean) => void;
}

const PRESETS = ["prices", "signals", "data", "events", "state", "control"];

export function ChannelPicker({ position, onSelect }: ChannelPickerProps) {
  const [value, setValue] = useState("");
  const [bidirectional, setBidirectional] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(() => {
    const ch = value.trim();
    if (ch) {
      onSelect(ch, bidirectional);
    }
  }, [value, bidirectional, onSelect]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape") {
        onSelect(null, false);
      }
    },
    [handleSubmit, onSelect]
  );

  return (
    <div
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        transform: "translate(-50%, -50%)",
        background: "#1e1e1e",
        border: "1px solid rgba(222,191,202,0.3)",
        borderRadius: 8,
        padding: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
        zIndex: 200,
        minWidth: 220,
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <div style={{ fontSize: 10, color: "#888", marginBottom: 6, letterSpacing: 0.3 }}>
        WIRE CHANNEL
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="channel name..."
        style={{
          width: "100%",
          padding: "6px 8px",
          background: "#151515",
          border: "1px solid #333",
          borderRadius: 4,
          color: "#ccc",
          fontSize: 12,
          fontFamily: "'JetBrains Mono', monospace",
          outline: "none",
        }}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => { setValue(p); }}
            style={{
              padding: "2px 8px",
              fontSize: 10,
              fontFamily: "'JetBrains Mono', monospace",
              background: value === p ? "rgba(222,191,202,0.15)" : "#252525",
              border: `1px solid ${value === p ? "rgba(222,191,202,0.4)" : "#333"}`,
              borderRadius: 4,
              color: value === p ? "#DEBFCA" : "#888",
              cursor: "pointer",
            }}
          >
            {p}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            color: "#888",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={bidirectional}
            onChange={(e) => setBidirectional(e.target.checked)}
            style={{ accentColor: "#DEBFCA" }}
          />
          Bidirectional
        </label>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => onSelect(null, false)}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            background: "transparent",
            border: "1px solid #333",
            borderRadius: 4,
            color: "#888",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!value.trim()}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            background: value.trim() ? "rgba(222,191,202,0.15)" : "transparent",
            border: `1px solid ${value.trim() ? "rgba(222,191,202,0.4)" : "#333"}`,
            borderRadius: 4,
            color: value.trim() ? "#DEBFCA" : "#555",
            cursor: value.trim() ? "pointer" : "default",
          }}
        >
          Connect
        </button>
      </div>
    </div>
  );
}
