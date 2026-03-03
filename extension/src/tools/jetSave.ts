import * as vscode from "vscode";
import { FileManager } from "../services/fileManager";
import { DuckDBService } from "../services/duckdb";
import { SidebarProvider } from "../sidebar/SidebarProvider";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import {
  JetSaveInput,
  JETList,
  ListColumn,
  JETProject,
  CustomElementDef,
  Recipe,
  RecipeInput,
  DataSourceConnector,
  DataSourceAuth,
  DataSourceEndpoint,
  PortfolioHolding,
  Portfolio,
  RebalanceTarget,
  PortfolioTransaction,
  NAVPoint,
  DatasetMetadata,
  DatabaseConnection,
  DataModel,
  SavedQuery,
  AgentMemoryEntry,
  WebCredential,
} from "../types";

export class JetSaveTool {
  constructor(
    private fileManager: FileManager,
    private duckdb: DuckDBService,
    private sidebar: SidebarProvider,
    private secrets: vscode.SecretStorage,
    private outputChannel: vscode.OutputChannel
  ) {}

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  }

  async execute(input: JetSaveInput): Promise<{ saved: boolean; path: string }> {
    const { type, name, payload } = input;
    this.outputChannel.appendLine(`[jet.save] type=${type} name="${name}"`);

    let path = "";

    switch (type) {
      case "list": {
        // Normalize: agents may send payload.stocks (array of objects with .ticker)
        // instead of payload.tickers (flat string array). Handle both.
        let tickers = (payload.tickers as string[]) || [];
        if (tickers.length === 0 && Array.isArray(payload.stocks)) {
          tickers = (payload.stocks as Array<{ ticker?: string } | string>)
            .map((s) => (typeof s === "string" ? s : s?.ticker || ""))
            .filter(Boolean);
        }

        // Read existing list to merge (preserves canvasElementId, columns, etc.)
        const existingSlug = this.slugify(name);
        const existing = await this.fileManager.readList(existingSlug);

        const listData: JETList = {
          name,
          tickers,
          criteria: payload.criteria as string | undefined,
          refreshable: !!(payload.criteria || payload.recipeSlug || payload.scriptPath || payload.columns),
          lastRefreshed: payload.criteria
            ? new Date().toISOString()
            : existing?.lastRefreshed,
          createdAt: existing?.createdAt || new Date().toISOString(),
          recipeSlug: payload.recipeSlug as string | undefined,
          scriptPath: payload.scriptPath as string | undefined,
          refreshInterval: (payload.refreshInterval as JETList["refreshInterval"]) || existing?.refreshInterval || (payload.criteria ? "manual" : undefined),
          canvasElementId: (payload.canvasElementId as string | undefined) || existing?.canvasElementId,
          // Context persistence
          thesis: (payload.thesis as string | undefined) || existing?.thesis,
          columns: (payload.columns as ListColumn[] | undefined) || existing?.columns,
        };
        const slug = await this.fileManager.writeList(name, listData);
        path = `data/lists/${slug}.json`;
        break;
      }
      case "project": {
        const projectData: JETProject = {
          name,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
          status: (payload.status as "active" | "draft" | "done") || "active",
          mode: (payload.mode as "portfolio" | undefined),
          securities: (payload.securities as string[]) || [],
          sources: (payload.sources as string[]) || [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const projectSlug = await this.fileManager.writeProject(
          name,
          projectData
        );
        path = `projects/${projectSlug}/project.json`;
        break;
      }
      case "preference": {
        const currentConfig =
          (await this.fileManager.readConfig()) || {};
        const merged = { ...currentConfig, ...payload };
        await this.fileManager.writeConfig(merged);
        path = ".jetro/config.yaml";
        break;
      }
      case "element": {
        const def: CustomElementDef = {
          name,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
          width: (payload.width as number) || 320,
          layout: (payload.layout as CustomElementDef["layout"]) || [],
        };
        const elemSlug = await this.fileManager.writeElementDef(name, def);
        path = `.jetro/elements/${elemSlug}.json`;
        break;
      }
      case "recipe": {
        const recipeData: Recipe = {
          name,
          slug: this.slugify(name),
          description: (payload.description as string) || "",
          inputs: (payload.inputs as RecipeInput[]) || [],
          steps: (payload.steps as string[]) || [],
          outputHint: payload.outputHint as string | undefined,
          createdAt: new Date().toISOString(),
        };
        const recipeSlug = await this.fileManager.writeRecipe(name, recipeData);
        path = `.jetro/recipes/${recipeSlug}.json`;
        break;
      }
      case "datasource": {
        const dsData: DataSourceConnector = {
          name,
          slug: this.slugify(name),
          baseUrl: (payload.baseUrl as string) || "",
          auth: (payload.auth as DataSourceAuth) || { type: "bearer", secretRef: this.slugify(name) + "_key" },
          docsUrl: payload.docsUrl as string | undefined,
          endpoints: (payload.endpoints as DataSourceEndpoint[]) || [],
          createdAt: new Date().toISOString(),
        };
        // Store API key in SecretStorage if provided
        if (payload.apiKey) {
          await this.secrets.store(dsData.auth.secretRef, payload.apiKey as string);
        }
        const dsSlug = await this.fileManager.writeDataSource(name, dsData);
        path = `.jetro/datasources/${dsSlug}.json`;
        break;
      }
      case "portfolio": {
        const pfSlugCheck = this.slugify(name);
        const isNew = !(await this.fileManager.readPortfolio(pfSlugCheck));

        // Build partial portfolio — only include fields that were actually provided
        const portfolioData: Partial<Portfolio> = { name };
        if (payload.holdings !== undefined) {
          portfolioData.holdings = payload.holdings as PortfolioHolding[];
        }
        if (payload.initialCapital !== undefined) {
          portfolioData.initialCapital = payload.initialCapital as number;
        }
        if (payload.cash !== undefined) {
          portfolioData.cash = payload.cash as number;
        }
        if (payload.currency !== undefined) {
          portfolioData.currency = payload.currency as string;
        }
        if (payload.benchmark !== undefined) {
          portfolioData.benchmark = payload.benchmark as string | null;
        }
        if (payload.rebalance !== undefined) {
          portfolioData.rebalance = payload.rebalance as Portfolio["rebalance"];
        }
        if (payload.rebalanceTargets !== undefined) {
          portfolioData.rebalanceTargets = payload.rebalanceTargets as RebalanceTarget[];
        }
        if (payload.inceptionDate !== undefined) {
          portfolioData.inceptionDate = payload.inceptionDate as string;
        }
        if (payload.currentNAV !== undefined) {
          portfolioData.currentNAV = payload.currentNAV as number;
        }
        if (payload.navPerUnit !== undefined) {
          portfolioData.navPerUnit = payload.navPerUnit as number;
        }
        if (payload.units !== undefined) {
          portfolioData.units = payload.units as number;
        }

        // Merge-write (preserves existing fields not in this payload)
        const pfSlug = await this.fileManager.writePortfolio(name, portfolioData);

        // Sync holdings to DuckDB (only if holdings were provided)
        if (portfolioData.holdings) {
          await this.duckdb.syncPortfolioHoldings(pfSlug, portfolioData.holdings);
        }

        // Log mutation
        await this.fileManager.appendMutation(pfSlug, {
          timestamp: new Date().toISOString(),
          action: isNew ? "create" : "update",
          summary: isNew
            ? `Portfolio "${name}" created with ${portfolioData.holdings?.length || 0} holdings`
            : `Portfolio "${name}" updated`,
        });

        // If transactions were included, append them
        if (payload.transactions) {
          const existingTxns = (await this.fileManager.readTransactions(pfSlug)) || [];
          const newTxns = payload.transactions as PortfolioTransaction[];
          await this.fileManager.writeTransactions(pfSlug, [...existingTxns, ...newTxns]);
        }

        // If NAV history points were included, merge them (dedup by date)
        if (payload.navHistory) {
          const existingNav = (await this.fileManager.readNAVHistory(pfSlug)) || [];
          const newPoints = payload.navHistory as NAVPoint[];
          const navMap = new Map<string, NAVPoint>();
          for (const p of existingNav) { navMap.set(p.date, p); }
          for (const p of newPoints) { navMap.set(p.date, p); }
          const merged = Array.from(navMap.values()).sort((a, b) => a.date.localeCompare(b.date));
          await this.fileManager.writeNAVHistory(pfSlug, merged);
        }

        path = `projects/${pfSlug}/portfolio.json`;
        break;
      }
      case "template": {
        const html = (payload.html as string) || "";
        const tplSlug = await this.fileManager.writeTemplate(name, html);
        path = `.jetro/templates/${tplSlug}.html`;
        break;
      }
      case "dataset": {
        const dsData: DatasetMetadata = {
          name,
          slug: this.slugify(name),
          files: (payload.files as string[]) || [],
          columns: (payload.columns as DatasetMetadata["columns"]) || [],
          rowCount: (payload.rowCount as number) || 0,
          sizeBytes: (payload.sizeBytes as number) || 0,
          duckdbTable: (payload.duckdbTable as string) || `ds_${this.slugify(name)}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const dsSlug = payload.projectSlug
          ? await this.fileManager.writeProjectDataset(payload.projectSlug as string, name, dsData)
          : await this.fileManager.writeDataset(name, dsData);
        path = payload.projectSlug
          ? `projects/${payload.projectSlug}/datasets/${dsSlug}/metadata.json`
          : `data/datasets/${dsSlug}/metadata.json`;
        break;
      }
      case "connection": {
        const connData: DatabaseConnection = {
          name,
          slug: this.slugify(name),
          engine: (payload.engine as DatabaseConnection["engine"]) || "postgres",
          host: payload.host as string | undefined,
          port: payload.port as number | undefined,
          database: payload.database as string | undefined,
          filePath: payload.filePath as string | undefined,
          secretRef: payload.secretRef as string | undefined,
          schema: payload.schema as string | undefined,
          attached: false,
          extensions: (payload.extensions as string[]) || [],
          createdAt: new Date().toISOString(),
        };
        // Store password in SecretStorage if provided
        if (payload.password) {
          const secretRef = `jet_conn_${connData.slug}`;
          await this.secrets.store(secretRef, payload.password as string);
          connData.secretRef = secretRef;
        }
        const connSlug = await this.fileManager.writeConnection(name, connData);
        path = `.jetro/connections/${connSlug}.json`;
        break;
      }
      case "model": {
        const modelData: DataModel = {
          name,
          slug: this.slugify(name),
          sql: (payload.sql as string) || "",
          description: payload.description as string | undefined,
          dependsOn: (payload.dependsOn as string[]) || [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const modelSlug = payload.projectSlug
          ? await this.fileManager.writeProjectModel(payload.projectSlug as string, name, modelData)
          : await this.fileManager.writeModel(name, modelData);
        // Also create the view in DuckDB
        if (modelData.sql) {
          try {
            await this.duckdb.loadModel(modelSlug, modelData.sql);
          } catch (err) {
            this.outputChannel.appendLine(`[jet.save] Model view creation failed: ${err}`);
          }
        }
        path = payload.projectSlug
          ? `projects/${payload.projectSlug}/models/${modelSlug}.json`
          : `.jetro/models/${modelSlug}.json`;
        break;
      }
      case "query": {
        const queryData: SavedQuery = {
          name,
          slug: this.slugify(name),
          sql: (payload.sql as string) || "",
          description: payload.description as string | undefined,
          parameters: payload.parameters as SavedQuery["parameters"],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const querySlug = payload.projectSlug
          ? await this.fileManager.writeProjectQuery(payload.projectSlug as string, name, queryData)
          : await this.fileManager.writeQuery(name, queryData);
        path = payload.projectSlug
          ? `projects/${payload.projectSlug}/queries/${querySlug}.json`
          : `.jetro/queries/${querySlug}.json`;
        break;
      }
      case "memory": {
        const entry: AgentMemoryEntry = {
          timestamp: new Date().toISOString(),
          agent: (payload.agent as string) || "unknown",
          summary: (payload.summary as string) || name,
          decisions: (payload.decisions as string[]) || [],
          openItems: (payload.openItems as string[]) || [],
        };

        const memoryDir = nodePath.join(this.fileManager.getRoot().fsPath, ".jetro");
        const memoryFile = nodePath.join(memoryDir, "agent-memory.md");

        // Read existing entries
        let entries: AgentMemoryEntry[] = [];
        try {
          if (fs.existsSync(memoryFile)) {
            const content = fs.readFileSync(memoryFile, "utf8");
            entries = this.parseMemoryEntries(content);
          }
        } catch { /* fresh file */ }

        // Append new entry
        entries.push(entry);

        // FIFO: keep only last 15
        if (entries.length > 15) {
          entries = entries.slice(entries.length - 15);
        }

        // Serialize and write
        if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
        fs.writeFileSync(memoryFile, this.serializeMemoryEntries(entries), "utf8");

        path = ".jetro/agent-memory.md";
        break;
      }
      case "credential": {
        const domain = (payload.domain as string) || name;
        const slug = this.slugify(domain.replace(/\./g, "_"));
        const existing = await this.fileManager.readCredential(slug);

        const credData: WebCredential = {
          domain,
          slug,
          username: (payload.username as string) || existing?.username || "",
          secretRef: `jet_cred_${slug}`,
          loginUrl: (payload.loginUrl as string) || existing?.loginUrl,
          loginSelectors: (payload.loginSelectors as WebCredential["loginSelectors"]) || existing?.loginSelectors,
          notes: (payload.notes as string) || existing?.notes,
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        // Store password in VS Code SecretStorage (encrypted, never on disk)
        if (payload.password) {
          await this.secrets.store(credData.secretRef, payload.password as string);
        }

        const credSlug = await this.fileManager.writeCredential(domain, credData);
        path = `.jetro/credentials/${credSlug}.json`;
        break;
      }
      default:
        this.outputChannel.appendLine(`[jet.save] Unknown type: ${type}`);
        return { saved: false, path: "" };
    }

    // Refresh sidebar
    await this.sidebar.refreshAll();

    this.outputChannel.appendLine(`[jet.save] ✓ → ${path}`);
    return { saved: true, path };
  }

  // ── Agent Memory helpers ──

  private parseMemoryEntries(md: string): AgentMemoryEntry[] {
    const blocks = md.split(/^## /gm).filter(Boolean);
    const entries: AgentMemoryEntry[] = [];

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 2) continue;

      const timestamp = lines[0].trim();
      // Validate it looks like a timestamp (starts with digit or ISO format)
      if (!timestamp.match(/^\d/)) continue;

      let agent = "unknown";
      let summary = "";
      const decisions: string[] = [];
      const openItems: string[] = [];
      let section: "body" | "decisions" | "open" = "body";

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("**Agent:**")) {
          agent = line.replace("**Agent:**", "").trim();
        } else if (line.startsWith("**Decisions:**")) {
          section = "decisions";
        } else if (line.startsWith("**Open items:**")) {
          section = "open";
        } else if (line.startsWith("---")) {
          break;
        } else if (line.startsWith("- ") && section === "decisions") {
          decisions.push(line.slice(2).trim());
        } else if (line.startsWith("- ") && section === "open") {
          openItems.push(line.slice(2).trim());
        } else if (section === "body" && line.trim().length > 0 && !line.startsWith("**")) {
          summary += (summary ? " " : "") + line.trim();
        }
      }

      if (summary || decisions.length > 0) {
        entries.push({ timestamp, agent, summary, decisions, openItems });
      }
    }

    return entries;
  }

  private serializeMemoryEntries(entries: AgentMemoryEntry[]): string {
    let md = "# Agent Memory\n\n";
    md += `_Last updated: ${new Date().toISOString()}_\n`;
    md += `_Max entries: 15 (FIFO)_\n\n---\n\n`;

    for (const entry of entries) {
      md += `## ${entry.timestamp}\n`;
      md += `**Agent:** ${entry.agent}\n\n`;
      md += `${entry.summary}\n\n`;
      if (entry.decisions.length > 0) {
        md += `**Decisions:**\n${entry.decisions.map((d) => `- ${d}`).join("\n")}\n\n`;
      }
      if (entry.openItems.length > 0) {
        md += `**Open items:**\n${entry.openItems.map((o) => `- ${o}`).join("\n")}\n\n`;
      }
      md += `---\n\n`;
    }

    return md;
  }
}
