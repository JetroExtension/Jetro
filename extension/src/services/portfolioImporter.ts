import * as vscode from "vscode";
import * as XLSX from "xlsx";
import { v4 as uuid } from "uuid";
import { FileManager } from "./fileManager";
import { DuckDBService } from "./duckdb";
import { Portfolio, PortfolioHolding, PortfolioTransaction } from "../types";

const BENCHMARK_OPTIONS = [
  { label: "None", value: null },
  { label: "Nifty 50", value: "^NSEI" },
  { label: "Nifty Pharma", value: "NIFTY_PHARMA.NS" },
  { label: "Nifty Bank", value: "NIFTY_BANK.NS" },
  { label: "Nifty IT", value: "NIFTY_IT.NS" },
  { label: "Nifty FMCG", value: "NIFTY_FMCG.NS" },
  { label: "Sensex", value: "^BSESN" },
];

export class PortfolioImporter {
  constructor(
    private fileManager: FileManager,
    private duckdb: DuckDBService,
    private outputChannel: vscode.OutputChannel
  ) {}

  async importFromFile(): Promise<void> {
    // 1. Open file picker
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "Spreadsheets": ["csv", "xlsx", "xls"] },
      title: "Import Portfolio",
    });

    if (!uris || uris.length === 0) {
      return;
    }

    const fileUri = uris[0];

    try {
      // 2. Read and parse file
      const fileData = await vscode.workspace.fs.readFile(fileUri);
      const workbook = XLSX.read(fileData, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

      if (rows.length === 0) {
        vscode.window.showWarningMessage("Portfolio file is empty.");
        return;
      }

      // 3. Detect format and parse
      const hasDateCol = this.hasColumn(rows[0], ["date", "trade_date", "tradedate", "txn_date"]);
      const hasTypeCol = this.hasColumn(rows[0], ["type", "trade_type", "tradetype", "side", "buy_sell", "buysell"]);

      let holdings: PortfolioHolding[];
      let transactions: PortfolioTransaction[] | undefined;

      if (hasDateCol && hasTypeCol) {
        // Transaction format — replay trades to compute current holdings
        const parsed = this.parseTransactions(rows);
        transactions = parsed.transactions;
        holdings = parsed.holdings;
        this.outputChannel.appendLine(
          `[portfolioImporter] Parsed ${transactions.length} transactions → ${holdings.length} holdings`
        );
      } else {
        // Simple format — direct holdings (weights or shares)
        holdings = this.parseHoldings(rows);
      }

      if (holdings.length === 0) {
        vscode.window.showWarningMessage(
          "Could not parse holdings. Expected columns: ticker + (weight or shares), or transaction format (date, ticker, shares, price, type)."
        );
        return;
      }

      // 4. Prompt for portfolio name
      const name = await vscode.window.showInputBox({
        prompt: "Portfolio name",
        placeHolder: "e.g. Pharma Core",
        validateInput: (v) => (v.trim() ? null : "Name is required"),
      });
      if (!name) { return; }

      // 5. Prompt for starting capital
      const capitalStr = await vscode.window.showInputBox({
        prompt: "Starting capital (optional)",
        placeHolder: "e.g. 1000000",
        value: this.computeDefaultCapital(holdings).toString(),
      });
      const initialCapital = capitalStr ? Number(capitalStr) || 0 : 0;

      // 6. Prompt for benchmark
      const benchmarkPick = await vscode.window.showQuickPick(
        BENCHMARK_OPTIONS.map((b) => ({ label: b.label, description: b.value || "" })),
        { placeHolder: "Select benchmark (optional)", title: "Benchmark Index" }
      );
      const benchmark = benchmarkPick
        ? (BENCHMARK_OPTIONS.find((b) => b.label === benchmarkPick.label)?.value ?? null)
        : null;

      // 7. Prompt for rebalance schedule
      const rebalancePick = await vscode.window.showQuickPick(
        ["None", "Monthly", "Quarterly", "Annually"],
        { placeHolder: "Rebalance schedule", title: "Rebalance Frequency" }
      );
      const rebalance = (rebalancePick?.toLowerCase() || "none") as Portfolio["rebalance"];

      // 8. Build and save portfolio
      const now = new Date().toISOString();
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");

      const investedValue = holdings.reduce((sum, h) => sum + h.shares * h.avgCost, 0);
      const cash = Math.max(0, initialCapital - investedValue);

      // Build rebalance targets from initial weights
      const rebalanceTargets = holdings.map((h) => ({
        ticker: h.ticker,
        weight: h.weight,
      }));

      const portfolio: Partial<Portfolio> = {
        name,
        holdings,
        initialCapital,
        cash,
        currency: "INR",
        benchmark,
        rebalance,
        rebalanceTargets,
        inceptionDate: this.inferInceptionDate(transactions) || now.split("T")[0],
        units: initialCapital > 0 ? initialCapital / 100 : 0, // unitisation: 1 unit = 100 at inception
      };

      const savedSlug = await this.fileManager.writePortfolio(name, portfolio);
      await this.duckdb.syncPortfolioHoldings(savedSlug, holdings);

      // Save transactions if we parsed them
      if (transactions && transactions.length > 0) {
        await this.fileManager.writeTransactions(savedSlug, transactions);
      }

      // Log mutation
      await this.fileManager.appendMutation(savedSlug, {
        timestamp: now,
        action: "create",
        summary: `Portfolio "${name}" imported from ${fileUri.fsPath.split("/").pop()} with ${holdings.length} holdings`,
      });

      this.outputChannel.appendLine(
        `[portfolioImporter] Imported "${name}" with ${holdings.length} holdings from ${fileUri.fsPath}`
      );

      vscode.window.showInformationMessage(
        `Portfolio "${name}" imported with ${holdings.length} holdings.`
      );
    } catch (err) {
      this.outputChannel.appendLine(
        `[portfolioImporter] Import failed: ${err}`
      );
      vscode.window.showErrorMessage(`Failed to import portfolio: ${err}`);
    }
  }

  // ── Simple format parsing (weights or shares) ──

  private parseHoldings(rows: Record<string, unknown>[]): PortfolioHolding[] {
    const holdings: PortfolioHolding[] = [];

    for (const row of rows) {
      const ticker = this.findValue(row, ["ticker", "symbol", "stock", "scrip"]);
      if (!ticker || typeof ticker !== "string") {
        continue;
      }

      const weight = this.findNumber(row, ["weight", "wt", "allocation", "alloc"]);
      const shares = this.findNumber(row, ["shares", "qty", "quantity", "trade_qty", "tradeqty"]);
      const avgCost = this.findNumber(row, ["avg_cost", "avgcost", "cost", "price", "trade_price", "tradeprice"]);
      const name = this.findValue(row, ["name", "security", "security_name", "securityname", "company"]);

      const holding: PortfolioHolding = {
        ticker: ticker.trim(),
        weight: weight ?? 0,
        shares: shares ?? 0,
        avgCost: avgCost ?? 0,
        ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
      };

      holdings.push(holding);
    }

    // If no weights were provided but shares exist, compute weights from value
    const hasWeights = holdings.some((h) => h.weight > 0);
    if (!hasWeights && holdings.length > 0) {
      const totalValue = holdings.reduce((sum, h) => sum + h.shares * h.avgCost, 0);
      if (totalValue > 0) {
        for (const h of holdings) {
          h.weight = (h.shares * h.avgCost) / totalValue;
        }
      } else {
        // Fall back to equal weights
        const equalWeight = 1 / holdings.length;
        for (const h of holdings) {
          h.weight = equalWeight;
        }
      }
    }

    return holdings;
  }

  // ── Transaction format parsing ──

  private parseTransactions(rows: Record<string, unknown>[]): {
    transactions: PortfolioTransaction[];
    holdings: PortfolioHolding[];
  } {
    const now = new Date().toISOString();
    const transactions: PortfolioTransaction[] = [];

    for (const row of rows) {
      const ticker = this.findValue(row, ["ticker", "symbol", "stock", "scrip"]);
      if (!ticker || typeof ticker !== "string") { continue; }

      const dateRaw = this.findValue(row, ["date", "trade_date", "tradedate", "txn_date"]);
      const typeRaw = this.findValue(row, ["type", "trade_type", "tradetype", "side", "buy_sell", "buysell"]);
      const shares = this.findNumber(row, ["shares", "qty", "quantity", "trade_qty", "tradeqty"]);
      const price = this.findNumber(row, ["price", "trade_price", "tradeprice", "avg_cost", "avgcost", "cost"]);
      const name = this.findValue(row, ["name", "security", "security_name", "securityname", "company"]);

      const tradeType = this.parseTradeType(typeRaw);
      const date = this.parseDate(dateRaw);

      if (!date || shares === null || price === null) { continue; }

      const actualShares = tradeType === "sell" ? -Math.abs(shares) : Math.abs(shares);

      transactions.push({
        id: uuid(),
        date,
        type: tradeType,
        ticker: ticker.trim(),
        shares: actualShares,
        price,
        notes: typeof name === "string" ? name.trim() : undefined,
        createdAt: now,
      });
    }

    // Sort by date
    transactions.sort((a, b) => a.date.localeCompare(b.date));

    // Replay transactions to compute current holdings
    const holdings = this.computeHoldingsFromTransactions(transactions);

    return { transactions, holdings };
  }

  private computeHoldingsFromTransactions(txns: PortfolioTransaction[]): PortfolioHolding[] {
    const positions = new Map<string, { shares: number; totalCost: number; name?: string }>();

    for (const txn of txns) {
      if (txn.type !== "buy" && txn.type !== "sell") { continue; }

      const existing = positions.get(txn.ticker) || { shares: 0, totalCost: 0 };

      if (txn.shares > 0) {
        // Buy: add shares and cost
        existing.totalCost += txn.shares * txn.price;
        existing.shares += txn.shares;
      } else {
        // Sell: reduce shares (proportional cost reduction)
        const sellShares = Math.abs(txn.shares);
        if (existing.shares > 0) {
          const costPerShare = existing.totalCost / existing.shares;
          existing.shares -= sellShares;
          existing.totalCost = Math.max(0, existing.shares * costPerShare);
        }
      }

      if (txn.notes && !existing.name) {
        existing.name = txn.notes;
      }

      positions.set(txn.ticker, existing);
    }

    // Filter out fully sold positions
    const active = Array.from(positions.entries()).filter(([, pos]) => pos.shares > 0);

    // Compute weights from cost basis
    const totalValue = active.reduce((sum, [, pos]) => sum + pos.totalCost, 0);

    return active.map(([ticker, pos]) => ({
      ticker,
      name: pos.name,
      weight: totalValue > 0 ? pos.totalCost / totalValue : 1 / active.length,
      shares: pos.shares,
      avgCost: pos.shares > 0 ? pos.totalCost / pos.shares : 0,
    }));
  }

  // ── Helpers ──

  private hasColumn(row: Record<string, unknown>, candidates: string[]): boolean {
    for (const key of Object.keys(row)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
      if (candidates.some((c) => c.replace(/[^a-z]/g, "") === normalized)) {
        return true;
      }
    }
    return false;
  }

  private findValue(
    row: Record<string, unknown>,
    candidates: string[]
  ): unknown {
    for (const key of Object.keys(row)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
      if (candidates.some((c) => c.replace(/[^a-z]/g, "") === normalized)) {
        return row[key];
      }
    }
    return undefined;
  }

  private findNumber(
    row: Record<string, unknown>,
    candidates: string[]
  ): number | null {
    const val = this.findValue(row, candidates);
    if (val === undefined || val === null || val === "") {
      return null;
    }
    const num = Number(val);
    return isNaN(num) ? null : num;
  }

  private parseTradeType(raw: unknown): "buy" | "sell" {
    if (!raw || typeof raw !== "string") { return "buy"; }
    const lower = raw.toLowerCase().trim();
    if (lower === "sell" || lower === "s" || lower === "sold") { return "sell"; }
    return "buy";
  }

  private parseDate(raw: unknown): string | null {
    if (!raw) { return null; }
    if (typeof raw === "number") {
      // Excel serial date
      const d = XLSX.SSF.parse_date_code(raw);
      if (d) {
        return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
      }
      return null;
    }
    if (typeof raw === "string") {
      // Try ISO format first
      const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (iso) { return iso[0]; }
      // Try DD/MM/YYYY or DD-MM-YYYY
      const dmy = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
      if (dmy) {
        return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
      }
    }
    return null;
  }

  private inferInceptionDate(txns?: PortfolioTransaction[]): string | null {
    if (!txns || txns.length === 0) { return null; }
    return txns[0].date; // transactions are sorted by date
  }

  private computeDefaultCapital(holdings: PortfolioHolding[]): number {
    const totalValue = holdings.reduce((sum, h) => sum + h.shares * h.avgCost, 0);
    return totalValue > 0 ? Math.round(totalValue) : 0;
  }
}
