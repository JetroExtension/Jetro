import * as vscode from "vscode";
import { FileManager } from "../services/fileManager";
import { DuckDBService } from "../services/duckdb";
import { AuthService } from "../services/authService";
import { JETApiClient, ApiError } from "../services/apiClient";
import { JetDataInput } from "../types";

const CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

export class JetDataTool {
  constructor(
    private fileManager: FileManager,
    private duckdb: DuckDBService,
    private auth: AuthService,
    private api: JETApiClient,
    private outputChannel: vscode.OutputChannel
  ) {}

  async execute(input: JetDataInput): Promise<unknown> {
    const { provider, endpoint, params } = input;
    this.outputChannel.appendLine(
      `[jet.data] ${provider} ${endpoint} ${JSON.stringify(params || {})}`
    );

    // Extract ticker from endpoint
    const tickerMatch = endpoint.match(/\/([A-Z0-9]+\.NS)$/i);
    const ticker = tickerMatch ? tickerMatch[1].toUpperCase() : null;

    // 1. Cache-first: check DuckDB for fresh data
    if (ticker) {
      const cached = await this.duckdb.getCached(ticker, endpoint, CACHE_MAX_AGE_MS);
      if (cached) {
        this.outputChannel.appendLine(`[jet.data] Cache hit: ${endpoint}`);
        return cached;
      }
    }

    // 2. Get JWT
    const jwt = await this.auth.getToken();
    if (!jwt) {
      vscode.window.showWarningMessage("Jetro: Please sign in to fetch data.");
      return { error: "Not authenticated" };
    }

    // 3. Call backend
    let result: unknown;
    try {
      result = await this.api.data(jwt, provider, endpoint, params);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "auth_expired") {
          // Try refresh + retry once
          const freshJwt = await this.auth.getToken();
          if (freshJwt) {
            try {
              result = await this.api.data(freshJwt, provider, endpoint, params);
            } catch {
              return this.handleError(err);
            }
          } else {
            return this.handleError(err);
          }
        } else {
          return this.handleError(err);
        }
      } else {
        this.outputChannel.appendLine(`[jet.data] Error: ${err}`);
        return { error: String(err) };
      }
    }

    // 4. Write to file tree + cache
    if (ticker && result) {
      const type = this.inferDataType(endpoint);
      await this.fileManager.writeStockData(
        ticker,
        type as "profile" | "ratios" | "financials" | "score",
        result
      );
      await this.duckdb.cacheData(ticker, endpoint, result);
    }

    this.outputChannel.appendLine(`[jet.data] OK ${endpoint}`);
    return result;
  }

  private inferDataType(endpoint: string): string {
    if (endpoint.includes("profile")) return "profile";
    if (endpoint.includes("ratios") || endpoint.includes("key-metrics")) return "ratios";
    if (
      endpoint.includes("income-statement") ||
      endpoint.includes("balance-sheet") ||
      endpoint.includes("cash-flow") ||
      endpoint.includes("financial")
    ) return "financials";
    return "profile";
  }

  private handleError(err: ApiError): { error: string } {
    this.outputChannel.appendLine(`[jet.data] ${err.code}: ${err.message}`);

    if (err.code === "rate_limit") {
      vscode.window.showWarningMessage(
        `Jetro: Rate limit reached. Resets at midnight UTC.`
      );
    } else if (err.code === "forbidden") {
      vscode.window.showWarningMessage("Jetro: This endpoint is not available.");
    } else if (err.code === "auth_expired") {
      vscode.window.showWarningMessage("Jetro: Session expired. Please sign in again.");
    }

    return { error: err.message };
  }
}
