import React, { useState, useEffect } from "react";
import { CatalogView } from "./CatalogView";
import { ConfigForm } from "./ConfigForm";
import { SchemaView } from "./SchemaView";
import type { VsCodeApi } from "./types";

declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

type View = "catalog" | "config" | "schema";

export default function App() {
  const [view, setView] = useState<View>("catalog");
  const [engine, setEngine] = useState<string | null>(null);
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [projectSlug, setProjectSlug] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "connector.init") {
        setProjectSlug(msg.data?.projectSlug || null);
        // If init specifies a slug to browse, jump to schema view
        if (msg.data?.browseSlug) {
          setSavedSlug(msg.data.browseSlug);
          setSavedName(msg.data.browseName || msg.data.browseSlug);
          setView("schema");
        } else if (msg.data?.preselectedEngine) {
          // Jump directly to config form for the chosen engine
          setEngine(msg.data.preselectedEngine);
          setView("config");
        } else {
          setView("catalog");
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  return (
    <div className="connector-app">
      {projectSlug && (
        <div className="scope-badge">Project: {projectSlug}</div>
      )}

      {view === "catalog" && (
        <CatalogView
          onSelect={(eng) => {
            setEngine(eng);
            setView("config");
          }}
        />
      )}

      {view === "config" && engine && (
        <ConfigForm
          engine={engine}
          vscode={vscode}
          onBack={() => setView("catalog")}
          onSaved={(slug, name) => {
            setSavedSlug(slug);
            setSavedName(name);
            setView("schema");
          }}
        />
      )}

      {view === "schema" && savedSlug && (
        <SchemaView
          connectionSlug={savedSlug}
          connectionName={savedName || savedSlug}
          vscode={vscode}
          onBack={() => setView("catalog")}
        />
      )}
    </div>
  );
}
