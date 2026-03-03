import React from "react";
import { CONNECTORS } from "./connectors";

export function CatalogView({ onSelect }: { onSelect: (engine: string) => void }) {
  return (
    <div className="connector-catalog">
      <h2>Connect a Data Source</h2>
      <p className="subtitle">Choose a connector to get started</p>
      <div className="connector-grid">
        {CONNECTORS.map((c) => (
          <div
            key={c.engine}
            className="connector-card"
            style={{ borderLeftColor: c.color }}
            onClick={() => onSelect(c.engine)}
          >
            <span className="connector-icon">{c.icon}</span>
            <div className="connector-info">
              <strong>{c.label}</strong>
              <span className="connector-desc">{c.description}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
