import * as vscode from "vscode";
import { DuckDBService } from "../services/duckdb";
import { JetQueryInput } from "../types";

export class JetQueryTool {
  constructor(
    private duckdb: DuckDBService,
    private outputChannel: vscode.OutputChannel
  ) {}

  async execute(input: JetQueryInput): Promise<Record<string, unknown>[]> {
    const { sql } = input;
    this.outputChannel.appendLine(`[jet.query] ${sql}`);

    try {
      const results = await this.duckdb.executeQuery(sql);
      this.outputChannel.appendLine(
        `[jet.query] ✓ ${results.length} row(s)`
      );
      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`[jet.query] ✗ ${message}`);
      throw err;
    }
  }
}
