import * as vscode from "vscode";
import { AuthService } from "./authService";
import { JETApiClient } from "./apiClient";
import { FileManager } from "./fileManager";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 50; // tickers per API batch

/**
 * RefreshService — periodically refreshes quote data for portfolio holdings.
 *
 * Only portfolios are refreshed in the background (NAV tracking needs current prices).
 * Lists are NOT refreshed here — they refresh on-canvas via yfinance-based bindings.
 */
export class RefreshService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private onUpdate: () => Promise<void>;

  constructor(
    private auth: AuthService,
    private api: JETApiClient,
    private fileManager: FileManager,
    private outputChannel: vscode.OutputChannel,
    onUpdate: () => Promise<void>,
    intervalMs?: number
  ) {
    this.intervalMs = intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onUpdate = onUpdate;
  }

  start(): void {
    if (this.timer) return;
    // Initial refresh after 5s, then on interval
    setTimeout(() => this.refresh(), 5_000);
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    this.outputChannel.appendLine(
      `[refresh] Started — interval ${Math.round(this.intervalMs / 1000)}s (portfolio holdings only)`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.outputChannel.appendLine("[refresh] Stopped");
    }
  }

  /** Manually trigger a refresh. */
  async refresh(): Promise<void> {
    const jwt = await this.auth.getToken();
    if (!jwt) return;

    try {
      const allTickers = new Set<string>();

      // Only collect tickers from portfolio-mode project holdings
      const portfolioSlugs = await this.fileManager.listPortfolioProjects();
      for (const slug of portfolioSlugs) {
        const pf = await this.fileManager.readPortfolio(slug);
        if (pf?.holdings) {
          for (const h of pf.holdings) {
            if (h.ticker) allTickers.add(h.ticker);
          }
        }
      }

      if (allTickers.size === 0) {
        return;
      }

      // Batch-fetch quotes via backend proxy
      const tickerArr = Array.from(allTickers);
      let refreshed = 0;

      for (let i = 0; i < tickerArr.length; i += BATCH_SIZE) {
        const batch = tickerArr.slice(i, i + BATCH_SIZE);
        const tickerStr = batch.join(",");

        try {
          const data = await this.api.data(jwt, "fmp", `/quote/${tickerStr}`);
          if (Array.isArray(data)) {
            for (const quote of data as Record<string, unknown>[]) {
              const symbol = quote.symbol as string;
              if (symbol) {
                await this.fileManager.writeStockData(symbol, "quote", quote);
                refreshed++;
              }
            }
          }
        } catch (err) {
          this.outputChannel.appendLine(
            `[refresh] Batch error (${batch[0]}...): ${err}`
          );
        }
      }

      if (refreshed > 0) {
        this.outputChannel.appendLine(
          `[refresh] Updated ${refreshed} portfolio quotes`
        );
        await this.onUpdate();
      }
    } catch (err) {
      this.outputChannel.appendLine(`[refresh] Error: ${err}`);
    }
  }
}
