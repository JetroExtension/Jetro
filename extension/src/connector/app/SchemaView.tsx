import React, { useState, useEffect } from "react";
import type { VsCodeApi, SchemaTree } from "./types";

interface Props {
  connectionSlug: string;
  connectionName: string;
  vscode: VsCodeApi;
  onBack: () => void;
}

export function SchemaView({ connectionSlug, connectionName, vscode, onBack }: Props) {
  const [tree, setTree] = useState<SchemaTree | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState<string | null>(null);

  useEffect(() => {
    vscode.postMessage({ type: "connector.schema", data: { slug: connectionSlug } });
    const handler = (event: MessageEvent) => {
      if (event.data.type === "connector.schemaTree") {
        setTree(event.data.data.tree);
      }
      if (event.data.type === "connector.imported") {
        setImporting(null);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [connectionSlug]);

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const importTable = (schemaName: string, tableName: string) => {
    const fqn = `${schemaName}.${tableName}`;
    const alias = `${connectionSlug}_${tableName}`.replace(/[^a-z0-9_]/gi, "_");
    setImporting(fqn);
    vscode.postMessage({
      type: "connector.importTable",
      data: { connectionSlug, tableName: fqn, alias },
    });
  };

  return (
    <div className="schema-browser">
      <button className="back-btn" onClick={onBack}>&larr; Back</button>
      <h2>{connectionName}</h2>
      <p className="subtitle">Browse schema and import tables as datasets</p>

      {!tree ? (
        <div className="loading">Loading schema...</div>
      ) : tree.schemas.length === 0 ? (
        <div className="empty">No schemas found</div>
      ) : (
        <div className="schema-tree">
          {tree.schemas.map((schema) => (
            <div key={schema.name} className="schema-node">
              <div className="tree-row" onClick={() => toggleExpand(schema.name)}>
                <span className="arrow">{expanded.has(schema.name) ? "\u25BE" : "\u25B8"}</span>
                <span className="schema-label">{schema.name}</span>
                <span className="count">{schema.tables.length} tables</span>
              </div>

              {expanded.has(schema.name) && (
                <div className="schema-children">
                  {schema.tables.map((table) => {
                    const tableKey = `${schema.name}.${table.name}`;
                    return (
                      <div key={tableKey}>
                        <div
                          className="tree-row table-row"
                          onClick={() => toggleExpand(tableKey)}
                        >
                          <span className="arrow">
                            {expanded.has(tableKey) ? "\u25BE" : "\u25B8"}
                          </span>
                          <span className="table-label">{table.name}</span>
                          {table.rowCount != null && (
                            <span className="row-count">
                              {table.rowCount.toLocaleString()} rows
                            </span>
                          )}
                          <button
                            className="import-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              importTable(schema.name, table.name);
                            }}
                            disabled={importing === tableKey}
                          >
                            {importing === tableKey ? "..." : "Import"}
                          </button>
                        </div>

                        {expanded.has(tableKey) && (
                          <div className="column-list">
                            {table.columns.map((col) => (
                              <div key={col.name} className="column-row">
                                <span className="col-key">
                                  {col.isPrimaryKey ? "\u{1F511}" : "\u00B7"}
                                </span>
                                <span className="col-name">{col.name}</span>
                                <span className="col-type">{col.type}</span>
                                {col.nullable && <span className="nullable">NULL</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
