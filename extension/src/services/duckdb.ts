import type { DuckDBConnection } from "@duckdb/node-api";
import * as path from "path";
import { PortfolioHolding, DatasetColumn, DatabaseEngine } from "../types";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stock_data (
  ticker VARCHAR,
  endpoint VARCHAR,
  data JSON,
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticker, endpoint)
);

CREATE TABLE IF NOT EXISTS portfolio_holdings (
  portfolio VARCHAR,
  ticker VARCHAR,
  name VARCHAR,
  weight REAL,
  shares REAL,
  avg_cost REAL,
  sector VARCHAR,
  current_price REAL,
  current_value REAL,
  pnl REAL,
  pnl_pct REAL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (portfolio, ticker)
);
`;

interface TrackedAttachment {
  engine: DatabaseEngine;
  connectionString: string;
}

export class DuckDBService {
  private dbPath: string;
  private mutex: Promise<void> = Promise.resolve();
  private trackedAttachments = new Map<string, TrackedAttachment>();
  private trackedS3: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint?: string;
  } | null = null;

  constructor(workspaceRoot: string) {
    this.dbPath = path.join(workspaceRoot, ".jetro", "cache.duckdb");
  }

  /** Health-check: verifies the database can be opened and schema is ready. */
  async init(): Promise<void> {
    await this.withDB(async () => {});
  }

  /**
   * Open DuckDB, run fn, close. Serialized via mutex to prevent concurrent
   * open attempts within this process.
   */
  private async withDB<T>(
    fn: (conn: DuckDBConnection) => Promise<T>,
    opts?: { reattach?: boolean }
  ): Promise<T> {
    // Serialize: wait for any in-flight operation to finish
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const prev = this.mutex;
    this.mutex = gate;
    await prev;

    const { DuckDBInstance } = await import("@duckdb/node-api");
    const instance = await DuckDBInstance.create(this.dbPath);
    const conn = await instance.connect();
    try {
      await conn.run(SCHEMA_SQL);
      if (opts?.reattach) {
        await this.reapplyAttachments(conn);
      }
      return await fn(conn);
    } finally {
      conn.closeSync();
      release();
    }
  }

  /** Helper: execute a query and return rows as plain JS objects. */
  private async query(conn: DuckDBConnection, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const reader = await conn.runAndReadAll(sql, params as import("@duckdb/node-api").DuckDBValue[] | undefined);
    const rows = reader.getRowObjectsJS() as Record<string, unknown>[];
    // Convert BigInt to Number for JSON compatibility
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = typeof v === "bigint" ? Number(v) : v;
      }
      return out;
    });
  }

  private async reapplyAttachments(conn: DuckDBConnection): Promise<void> {
    for (const [slug, { engine, connectionString }] of this.trackedAttachments) {
      try {
        for (const ext of this.extensionsForEngine(engine)) {
          await conn.run(`INSTALL '${ext}'`);
          await conn.run(`LOAD '${ext}'`);
        }
        switch (engine) {
          case "postgres":
            await conn.run(`ATTACH '${connectionString}' AS "${slug}" (TYPE postgres, READ_ONLY)`);
            break;
          case "mysql":
            await conn.run(`ATTACH '${connectionString}' AS "${slug}" (TYPE mysql, READ_ONLY)`);
            break;
          case "sqlite":
            await conn.run(`ATTACH '${connectionString}' AS "${slug}" (TYPE sqlite, READ_ONLY)`);
            break;
          case "duckdb_file":
            await conn.run(`ATTACH '${connectionString}' AS "${slug}" (READ_ONLY)`);
            break;
          case "motherduck":
            await conn.run(`ATTACH '${connectionString}' AS "${slug}"`);
            break;
        }
      } catch {
        // Skip failed re-attachments
      }
    }
    if (this.trackedS3) {
      try {
        await conn.run(`INSTALL 'httpfs'`);
        await conn.run(`LOAD 'httpfs'`);
        await conn.run(`SET s3_region = '${this.trackedS3.region}'`);
        await conn.run(`SET s3_access_key_id = '${this.trackedS3.accessKeyId}'`);
        await conn.run(`SET s3_secret_access_key = '${this.trackedS3.secretAccessKey}'`);
        if (this.trackedS3.endpoint) {
          await conn.run(`SET s3_endpoint = '${this.trackedS3.endpoint}'`);
          await conn.run(`SET s3_url_style = 'path'`);
        }
      } catch {
        // S3 config failure is non-fatal
      }
    }
  }

  private extensionsForEngine(engine: DatabaseEngine): string[] {
    switch (engine) {
      case "postgres": return ["postgres_scanner"];
      case "mysql": return ["mysql_scanner"];
      case "sqlite": return ["sqlite_scanner"];
      default: return [];
    }
  }

  // ── Cache operations ──

  async cacheData(
    ticker: string,
    endpoint: string,
    data: unknown
  ): Promise<void> {
    const json = JSON.stringify(data);
    await this.withDB(async (conn) => {
      await conn.run(
        `INSERT OR REPLACE INTO stock_data (ticker, endpoint, data, fetched_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        [ticker, endpoint, json]
      );
    });
  }

  async getCached(
    ticker: string,
    endpoint: string,
    maxAgeHours: number = 4
  ): Promise<unknown | null> {
    const safeHours = Math.max(0, Math.min(Math.floor(Number(maxAgeHours) || 4), 8760));
    return this.withDB(async (conn) => {
      const rows = await this.query(
        conn,
        `SELECT data FROM stock_data
         WHERE ticker = ? AND endpoint = ?
         AND fetched_at > CURRENT_TIMESTAMP - INTERVAL '${safeHours} hours'`,
        [ticker, endpoint]
      );
      if (rows.length > 0) {
        try {
          return JSON.parse(rows[0].data as string);
        } catch {
          return null;
        }
      }
      return null;
    });
  }

  // ── Query execution ──

  async executeQuery(sql: string): Promise<Record<string, unknown>[]> {
    // Strip comments and normalize
    const stripped = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const normalized = stripped.toUpperCase();

    // Only allow SELECT and WITH (CTE) statements, plus DESCRIBE/SUMMARIZE
    if (
      !normalized.startsWith("SELECT") &&
      !normalized.startsWith("WITH") &&
      !normalized.startsWith("DESCRIBE") &&
      !normalized.startsWith("SUMMARIZE")
    ) {
      throw new Error("Only SELECT, WITH (CTE), DESCRIBE, and SUMMARIZE queries are allowed");
    }

    // Block multiple statements
    const statementCount = stripped.split(";").filter((s) => s.trim().length > 0).length;
    if (statementCount > 1) {
      throw new Error("Multiple SQL statements are not allowed");
    }

    // Block dangerous keywords
    const dangerous = [
      "COPY", "EXPORT", "IMPORT", "ATTACH", "DETACH",
      "INSTALL", "LOAD", "CALL", "PRAGMA", "CREATE",
      "DROP", "ALTER", "DELETE", "INSERT", "UPDATE",
      "TRUNCATE", "GRANT", "REVOKE",
    ];
    for (const kw of dangerous) {
      const pattern = new RegExp(`\\b${kw}\\b`, "i");
      if (pattern.test(stripped)) {
        throw new Error(`SQL keyword "${kw}" is not allowed in read-only queries`);
      }
    }

    return this.withDB(async (conn) => {
      return await this.query(conn, stripped);
    }, { reattach: true });
  }

  // ── Portfolio ──

  async syncPortfolioHoldings(slug: string, holdings: PortfolioHolding[]): Promise<void> {
    await this.withDB(async (conn) => {
      await conn.run("DELETE FROM portfolio_holdings WHERE portfolio = ?", [slug]);
      for (const h of holdings) {
        await conn.run(
          `INSERT INTO portfolio_holdings (portfolio, ticker, name, weight, shares, avg_cost, sector, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [slug, h.ticker, h.name ?? null, h.weight, h.shares, h.avgCost, h.sector ?? null]
        );
      }
    });
  }

  async updatePortfolioPrice(slug: string, ticker: string, price: number): Promise<void> {
    await this.withDB(async (conn) => {
      await conn.run(
        `UPDATE portfolio_holdings
         SET current_price = ?,
             current_value = shares * ?,
             pnl = (? - avg_cost) * shares,
             pnl_pct = CASE WHEN avg_cost > 0 THEN ((? - avg_cost) / avg_cost) * 100 ELSE 0 END,
             updated_at = CURRENT_TIMESTAMP
         WHERE portfolio = ? AND ticker = ?`,
        [price, price, price, price, slug, ticker]
      );
    });
  }

  // ── Dataset registration ──

  async registerDataset(tableName: string, filePath: string): Promise<DatasetColumn[]> {
    const ext = filePath.split(".").pop()?.toLowerCase();
    let createSql: string;

    switch (ext) {
      case "csv":
      case "tsv":
        createSql = `CREATE OR REPLACE TABLE "${tableName}" AS SELECT * FROM read_csv_auto('${filePath}')`;
        break;
      case "parquet":
        createSql = `CREATE OR REPLACE TABLE "${tableName}" AS SELECT * FROM read_parquet('${filePath}')`;
        break;
      case "json":
      case "jsonl":
      case "ndjson":
        createSql = `CREATE OR REPLACE TABLE "${tableName}" AS SELECT * FROM read_json_auto('${filePath}')`;
        break;
      default:
        throw new Error(`Unsupported file format: ${ext}`);
    }

    return this.withDB(async (conn) => {
      await conn.run(createSql);
      const columns = await this.query(conn, `DESCRIBE "${tableName}"`);
      return columns.map((col) => ({
        name: col.column_name as string,
        type: col.column_type as DatasetColumn["type"],
        nullable: col.null !== "NO",
      }));
    });
  }

  async unregisterDataset(tableName: string): Promise<void> {
    await this.withDB(async (conn) => {
      await conn.run(`DROP TABLE IF EXISTS "${tableName}"`);
    });
  }

  async getTableRowCount(tableName: string): Promise<number> {
    return this.withDB(async (conn) => {
      const rows = await this.query(conn, `SELECT COUNT(*) as cnt FROM "${tableName}"`);
      return (rows[0]?.cnt as number) || 0;
    });
  }

  async listTables(): Promise<string[]> {
    return this.withDB(async (conn) => {
      const rows = await this.query(conn, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'");
      return rows.map((r) => r.table_name as string);
    });
  }

  async describeTable(tableName: string): Promise<DatasetColumn[]> {
    return this.withDB(async (conn) => {
      const columns = await this.query(conn, `DESCRIBE "${tableName}"`);
      return columns.map((col) => ({
        name: col.column_name as string,
        type: col.column_type as DatasetColumn["type"],
        nullable: col.null !== "NO",
      }));
    });
  }

  // ── External database connections ──

  async installExtension(extensionName: string): Promise<void> {
    await this.withDB(async (conn) => {
      await conn.run(`INSTALL '${extensionName}'`);
      await conn.run(`LOAD '${extensionName}'`);
    });
  }

  async attachDatabase(slug: string, engine: DatabaseEngine, connectionString: string): Promise<string[]> {
    const tables = await this.withDB(async (conn) => {
      for (const ext of this.extensionsForEngine(engine)) {
        await conn.run(`INSTALL '${ext}'`);
        await conn.run(`LOAD '${ext}'`);
      }

      switch (engine) {
        case "postgres":
          await conn.run(`ATTACH '${connectionString}' AS "${slug}" (TYPE postgres, READ_ONLY)`);
          break;
        case "mysql":
          await conn.run(`ATTACH '${connectionString}' AS "${slug}" (TYPE mysql, READ_ONLY)`);
          break;
        case "sqlite":
          await conn.run(`ATTACH '${connectionString}' AS "${slug}" (TYPE sqlite, READ_ONLY)`);
          break;
        case "duckdb_file":
          await conn.run(`ATTACH '${connectionString}' AS "${slug}" (READ_ONLY)`);
          break;
        case "motherduck":
          await conn.run(`ATTACH '${connectionString}' AS "${slug}"`);
          break;
        case "s3":
        case "snowflake":
          return [];
        default:
          throw new Error(`Unsupported engine: ${engine}`);
      }

      const rows = await this.query(
        conn,
        `SELECT table_name FROM information_schema.tables WHERE table_catalog = '${slug}'`
      );
      return rows.map((r) => r.table_name as string);
    });

    if (engine !== "s3" && engine !== "snowflake") {
      this.trackedAttachments.set(slug, { engine, connectionString });
    }

    return tables;
  }

  async configureS3(credentials: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint?: string;
  }): Promise<void> {
    await this.withDB(async (conn) => {
      await conn.run(`INSTALL 'httpfs'`);
      await conn.run(`LOAD 'httpfs'`);
      await conn.run(`SET s3_region = '${credentials.region}'`);
      await conn.run(`SET s3_access_key_id = '${credentials.accessKeyId}'`);
      await conn.run(`SET s3_secret_access_key = '${credentials.secretAccessKey}'`);
      if (credentials.endpoint) {
        await conn.run(`SET s3_endpoint = '${credentials.endpoint}'`);
        await conn.run(`SET s3_url_style = 'path'`);
      }
    });
    this.trackedS3 = { ...credentials };
  }

  async detachDatabase(slug: string): Promise<void> {
    this.trackedAttachments.delete(slug);
  }

  // ── Data models / views ──

  async loadModel(slug: string, sql: string): Promise<void> {
    const normalized = sql.trim().toUpperCase();
    if (!normalized.startsWith("CREATE") || !normalized.includes("VIEW")) {
      throw new Error("Model SQL must be a CREATE VIEW statement");
    }
    const safeSql = sql.replace(/^CREATE\s+VIEW/i, "CREATE OR REPLACE VIEW");
    await this.withDB(async (conn) => {
      await conn.run(safeSql);
    });
  }

  async dropModel(viewName: string): Promise<void> {
    await this.withDB(async (conn) => {
      await conn.run(`DROP VIEW IF EXISTS "${viewName}"`);
    });
  }

  // ── Materialization ──

  async materializeQuery(sql: string, outputPath: string): Promise<number> {
    return this.withDB(async (conn) => {
      await conn.run(`COPY (${sql}) TO '${outputPath}' (FORMAT PARQUET)`);
      const rows = await this.query(conn, `SELECT COUNT(*) as cnt FROM read_parquet('${outputPath}')`);
      return (rows[0]?.cnt as number) || 0;
    }, { reattach: true });
  }

  // ── Project-level dataset registration ──

  async registerProjectDatasets(projectSlug: string, fileManager: import("./fileManager").FileManager): Promise<number> {
    const slugs = await fileManager.listProjectDatasets(projectSlug);
    let registered = 0;
    for (const slug of slugs) {
      const meta = await fileManager.readProjectDataset(projectSlug, slug);
      if (!meta || !meta.files.length) continue;
      const tableName = `p_${projectSlug}_${slug}`;
      const filePath = (await fileManager.getProjectDatasetFilePath(projectSlug, slug, meta.files[0])).fsPath;
      try {
        await this.registerDataset(tableName, filePath);
        registered++;
      } catch { /* skip failed registrations */ }
    }
    return registered;
  }

  async loadProjectModels(projectSlug: string, fileManager: import("./fileManager").FileManager): Promise<number> {
    const slugs = await fileManager.listProjectModels(projectSlug);
    let loaded = 0;
    for (const slug of slugs) {
      const model = await fileManager.readProjectModel(projectSlug, slug);
      if (model?.sql) {
        try {
          await this.loadModel(`p_${projectSlug}_${slug}`, model.sql);
          loaded++;
        } catch { /* skip failed models */ }
      }
    }
    return loaded;
  }

  async unregisterProjectDatasets(projectSlug: string): Promise<void> {
    await this.withDB(async (conn) => {
      const tables = await this.query(conn, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'");
      const prefix = `p_${projectSlug}_`;
      for (const t of tables) {
        const name = t.table_name as string;
        if (name.startsWith(prefix)) {
          try { await conn.run(`DROP VIEW IF EXISTS "${name}"`); } catch { /* ignore */ }
          try { await conn.run(`DROP TABLE IF EXISTS "${name}"`); } catch { /* ignore */ }
        }
      }
    });
  }

  // ── Schema introspection ──

  async getAttachedSchema(slug: string): Promise<{
    schemas: {
      name: string;
      tables: {
        name: string;
        rowCount?: number;
        columns: {
          name: string;
          type: string;
          nullable: boolean;
          isPrimaryKey: boolean;
        }[];
      }[];
    }[];
  }> {
    return this.withDB(async (conn) => {
      const tablesResult = await this.query(
        conn,
        `SELECT table_schema, table_name
         FROM information_schema.tables
         WHERE table_catalog = ?
         ORDER BY table_schema, table_name`,
        [slug]
      );

      const schemaMap = new Map<string, {
        name: string;
        tables: {
          name: string;
          rowCount?: number;
          columns: { name: string; type: string; nullable: boolean; isPrimaryKey: boolean }[];
        }[];
      }>();

      for (const row of tablesResult) {
        const schemaName = row.table_schema as string;
        const tableName = row.table_name as string;

        if (!schemaMap.has(schemaName)) {
          schemaMap.set(schemaName, { name: schemaName, tables: [] });
        }

        const columnsResult = await this.query(
          conn,
          `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
           WHERE table_catalog = ? AND table_schema = ? AND table_name = ?
           ORDER BY ordinal_position`,
          [slug, schemaName, tableName]
        );

        const columns = columnsResult.map((c) => ({
          name: c.column_name as string,
          type: c.data_type as string,
          nullable: c.is_nullable === "YES",
          isPrimaryKey: false,
        }));

        let rowCount: number | undefined;
        try {
          const countResult = await this.query(
            conn,
            `SELECT COUNT(*) as cnt FROM "${slug}"."${schemaName}"."${tableName}"`
          );
          rowCount = (countResult[0]?.cnt as number) || undefined;
        } catch { /* skip count for inaccessible tables */ }

        schemaMap.get(schemaName)!.tables.push({ name: tableName, rowCount, columns });
      }

      return { schemas: Array.from(schemaMap.values()) };
    }, { reattach: true });
  }

  /** Execute a DDL statement — for controlled internal use only. */
  async executeDDL(sql: string): Promise<void> {
    await this.withDB(async (conn) => {
      await conn.run(sql);
    });
  }

  /** Clears tracked state. */
  async close(): Promise<void> {
    this.trackedAttachments.clear();
    this.trackedS3 = null;
  }
}
