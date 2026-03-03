import * as fs from "fs";
import * as path from "path";

export interface TroubleEntry {
  id: string;
  type: "deploy_crash" | "deploy_build_error" | "script_error" | "render_error" | "parse_error";
  projectSlug?: string;
  canvasId?: string;
  elementId?: string;
  message: string;
  detail?: string;
  hint?: string;
  timestamp: string;
}

const MAX_ENTRIES = 20;
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Append a diagnostic entry to .jetro/trouble.json.
 * Fire-and-forget — never throws, never blocks.
 */
export function logTrouble(workspacePath: string, entry: Omit<TroubleEntry, "id" | "timestamp">): void {
  try {
    const dir = path.join(workspacePath, ".jetro");
    const filePath = path.join(dir, "trouble.json");

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let entries: TroubleEntry[] = [];
    try {
      entries = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch { /* file doesn't exist or is malformed */ }

    // Prune expired entries
    const cutoff = Date.now() - MAX_AGE_MS;
    entries = entries.filter((e) => new Date(e.timestamp).getTime() > cutoff);

    // Append new entry
    entries.push({
      ...entry,
      id: `err_${Date.now()}`,
      timestamp: new Date().toISOString(),
    });

    // Cap at MAX_ENTRIES (FIFO)
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(entries.length - MAX_ENTRIES);
    }

    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2));
  } catch {
    // Diagnostic logging must never crash the extension
  }
}
