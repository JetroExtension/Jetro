import React, { useState, useEffect } from "react";
import { CONNECTORS, type ConnectorDef } from "./connectors";
import type { VsCodeApi } from "./types";

interface Props {
  engine: string;
  vscode: VsCodeApi;
  onBack: () => void;
  onSaved: (slug: string, name: string) => void;
}

function buildConfig(
  connector: ConnectorDef,
  name: string,
  values: Record<string, string | number>
) {
  return {
    name,
    engine: connector.engine,
    host: values.host as string | undefined,
    port: values.port as number | undefined,
    database: values.database as string | undefined,
    schema: values.schema as string | undefined,
    filePath: values.filePath as string | undefined,
    region: values.region as string | undefined,
    endpoint: values.endpoint as string | undefined,
    account: values.account as string | undefined,
    warehouse: values.warehouse as string | undefined,
    extensions: connector.extensions,
    attached: false,
  };
}

export function ConfigForm({ engine, vscode, onBack, onSaved }: Props) {
  const connector = CONNECTORS.find((c) => c.engine === engine);
  const [values, setValues] = useState<Record<string, string | number>>({});
  const [name, setName] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!connector) return;
    const defaults: Record<string, string | number> = {};
    connector.fields.forEach((f) => {
      if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
    });
    setValues(defaults);
  }, [engine]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "connector.testResult") {
        setTesting(false);
        setTestResult(msg.data);
      }
      if (msg.type === "connector.saved") {
        setSaving(false);
        onSaved(msg.data.slug, name);
      }
      if (msg.type === "connector.filePicked") {
        setValues((v) => ({ ...v, filePath: msg.data.path }));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [name, onSaved]);

  if (!connector) return <div>Unknown engine: {engine}</div>;

  const handleTest = () => {
    setTesting(true);
    setTestResult(null);
    const password = (values.password as string) || "";
    const config = buildConfig(connector, name, values);
    vscode.postMessage({ type: "connector.test", data: { config, password } });
  };

  const handleSave = () => {
    setSaving(true);
    const password = (values.password as string) || "";
    const config = buildConfig(connector, name, values);
    vscode.postMessage({ type: "connector.save", data: { config, password } });
  };

  const isValid = name.trim().length > 0;

  return (
    <div className="config-form">
      <button className="back-btn" onClick={onBack}>&larr; Back</button>
      <h2>{connector.icon} {connector.label}</h2>

      <div className="field-row">
        <label>Connection Name <span className="required">*</span></label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Database"
          autoFocus
        />
      </div>

      {connector.fields.map((field) => (
        <div key={field.key} className="field-row">
          <label>
            {field.label}
            {field.required && <span className="required">*</span>}
          </label>
          {field.type === "file" ? (
            <div className="file-input">
              <input
                value={(values[field.key] as string) || ""}
                readOnly
                placeholder={field.placeholder || "Select file..."}
              />
              <button onClick={() => vscode.postMessage({ type: "connector.browseFile" })}>
                Browse
              </button>
            </div>
          ) : field.type === "select" ? (
            <select
              value={(values[field.key] as string) || ""}
              onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
            >
              {field.options?.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <input
              type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
              value={values[field.key] ?? ""}
              onChange={(e) =>
                setValues({
                  ...values,
                  [field.key]: field.type === "number" ? Number(e.target.value) : e.target.value,
                })
              }
              placeholder={field.placeholder}
            />
          )}
          {field.helpText && <span className="help-text">{field.helpText}</span>}
        </div>
      ))}

      <div className="form-actions">
        <button className="test-btn" onClick={handleTest} disabled={testing || !isValid}>
          {testing ? "Testing..." : "Test Connection"}
        </button>
        <button
          className="save-btn"
          onClick={handleSave}
          disabled={saving || !isValid || !testResult?.ok}
        >
          {saving ? "Saving..." : "Save & Connect"}
        </button>
      </div>

      {testResult && (
        <div className={`test-result ${testResult.ok ? "success" : "error"}`}>
          {testResult.ok ? "\u2713 Connected successfully" : `\u2717 ${testResult.message}`}
        </div>
      )}
    </div>
  );
}
