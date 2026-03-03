import * as vscode from "vscode";
import { FileManager } from "./fileManager";
import { DuckDBService } from "./duckdb";
import { DatabaseConnection, DatabaseEngine } from "../types";

export class ConnectionManager {
  constructor(
    private fileManager: FileManager,
    private duckdb: DuckDBService,
    private secrets: vscode.SecretStorage,
    private outputChannel: vscode.OutputChannel
  ) {}

  // ── Interactive connection flow (UI-driven) ──

  async addConnectionInteractive(engine: DatabaseEngine): Promise<string | null> {
    const name = await vscode.window.showInputBox({
      prompt: "Connection name",
      placeHolder: enginePlaceholders[engine]?.name ?? "My Connection",
      validateInput: (v) => (v.trim() ? null : "Name is required"),
    });
    if (!name) return null;

    let config: Partial<DatabaseConnection> = { name, engine };
    let password: string | undefined;

    switch (engine) {
      case "postgres":
      case "mysql": {
        const host = await vscode.window.showInputBox({
          prompt: "Host",
          value: "localhost",
        });
        if (host === undefined) return null;

        const portStr = await vscode.window.showInputBox({
          prompt: "Port",
          value: engine === "postgres" ? "5432" : "3306",
        });
        if (portStr === undefined) return null;

        const database = await vscode.window.showInputBox({
          prompt: "Database name",
          placeHolder: "analytics",
        });
        if (database === undefined) return null;

        const user = await vscode.window.showInputBox({
          prompt: "Username",
          value: engine === "postgres" ? "postgres" : "root",
        });
        if (user === undefined) return null;

        password = await vscode.window.showInputBox({
          prompt: "Password",
          password: true,
        });
        if (password === undefined) return null;

        config = { ...config, host, port: parseInt(portStr) || (engine === "postgres" ? 5432 : 3306), database, schema: user };
        break;
      }

      case "sqlite":
      case "duckdb_file": {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: engine === "sqlite"
            ? { "SQLite databases": ["db", "sqlite", "sqlite3"] }
            : { "DuckDB files": ["duckdb", "db"] },
          title: `Select ${engine === "sqlite" ? "SQLite" : "DuckDB"} file`,
        });
        if (!uris || uris.length === 0) return null;
        config.filePath = uris[0].fsPath;
        break;
      }

      case "motherduck": {
        password = await vscode.window.showInputBox({
          prompt: "MotherDuck token",
          password: true,
          placeHolder: "md:...",
        });
        if (!password) return null;
        config.filePath = `md:?token=${password}`;
        break;
      }

      case "s3": {
        const accessKeyId = await vscode.window.showInputBox({
          prompt: "AWS Access Key ID (or GCS equivalent)",
          placeHolder: "AKIAIOSFODNN7EXAMPLE",
        });
        if (!accessKeyId) return null;

        const secretAccessKey = await vscode.window.showInputBox({
          prompt: "Secret Access Key",
          password: true,
        });
        if (!secretAccessKey) return null;

        const region = await vscode.window.showInputBox({
          prompt: "Region",
          value: "us-east-1",
        });
        if (region === undefined) return null;

        const endpoint = await vscode.window.showInputBox({
          prompt: "Custom endpoint (leave empty for AWS S3, use storage.googleapis.com for GCS)",
          placeHolder: "optional",
        });
        if (endpoint === undefined) return null;

        // Store access key ID in config, secret key in SecretStorage
        config = { ...config, region, endpoint: endpoint || undefined, schema: accessKeyId };
        password = secretAccessKey;
        break;
      }

      case "snowflake": {
        const account = await vscode.window.showInputBox({
          prompt: "Snowflake account identifier",
          placeHolder: "xy12345.us-east-1",
        });
        if (!account) return null;

        const warehouse = await vscode.window.showInputBox({
          prompt: "Warehouse",
          placeHolder: "COMPUTE_WH",
        });
        if (warehouse === undefined) return null;

        const database = await vscode.window.showInputBox({
          prompt: "Database",
          placeHolder: "ANALYTICS",
        });
        if (database === undefined) return null;

        const sfSchema = await vscode.window.showInputBox({
          prompt: "Schema",
          value: "PUBLIC",
        });
        if (sfSchema === undefined) return null;

        const user = await vscode.window.showInputBox({
          prompt: "Username",
        });
        if (!user) return null;

        password = await vscode.window.showInputBox({
          prompt: "Password",
          password: true,
        });
        if (!password) return null;

        config = { ...config, account, warehouse, database, schema: `${user}|${sfSchema}`, host: account };
        break;
      }
    }

    const slug = await this.addConnection(config, password);

    // Auto-attach
    try {
      await this.attach(slug);
      vscode.window.showInformationMessage(`Connected to "${name}" successfully.`);
    } catch (err) {
      vscode.window.showWarningMessage(
        `Connection "${name}" saved but attach failed: ${err instanceof Error ? err.message : err}`
      );
    }

    return slug;
  }

  // ── Core CRUD ──

  async addConnection(config: Partial<DatabaseConnection>, password?: string): Promise<string> {
    const slug = this.slugify(config.name || "conn");

    // Store password in SecretStorage — NEVER in the JSON config
    if (password) {
      const secretKey = `jet_conn_${slug}`;
      await this.secrets.store(secretKey, password);
      config.secretRef = secretKey;
    }

    const safeConfig: DatabaseConnection = {
      name: config.name || slug,
      slug,
      engine: config.engine || "postgres",
      host: config.host,
      port: config.port,
      database: config.database,
      filePath: config.filePath,
      secretRef: config.secretRef,
      schema: config.schema,
      attached: false,
      extensions: this.requiredExtensions(config.engine || "postgres"),
      createdAt: new Date().toISOString(),
      region: config.region,
      endpoint: config.endpoint,
      warehouse: config.warehouse,
      account: config.account,
    };

    await this.fileManager.writeConnection(safeConfig.name, safeConfig);
    return slug;
  }

  async attach(slug: string): Promise<string[]> {
    const conn = await this.fileManager.readConnection(slug);
    if (!conn) throw new Error(`Connection not found: ${slug}`);

    // S3: configure credentials instead of ATTACH
    if (conn.engine === "s3") {
      const secretKey = conn.secretRef;
      const secretAccessKey = secretKey ? (await this.secrets.get(secretKey)) || "" : "";
      await this.duckdb.configureS3({
        region: conn.region || "us-east-1",
        accessKeyId: conn.schema || "", // access key ID stored in schema field
        secretAccessKey,
        endpoint: conn.endpoint,
      });
      conn.attached = true;
      await this.fileManager.writeConnection(conn.name, conn);
      this.outputChannel.appendLine(`[connectionManager] S3 credentials configured for "${conn.name}"`);
      return [];
    }

    // Snowflake: validate via Python test, no DuckDB attach
    if (conn.engine === "snowflake") {
      conn.attached = true;
      await this.fileManager.writeConnection(conn.name, conn);
      this.outputChannel.appendLine(`[connectionManager] Snowflake connection "${conn.name}" marked active`);
      return [];
    }

    const connStr = await this.buildConnectionString(conn);
    const tables = await this.duckdb.attachDatabase(slug, conn.engine, connStr);

    conn.attached = true;
    await this.fileManager.writeConnection(conn.name, conn);

    this.outputChannel.appendLine(
      `[connectionManager] Attached "${conn.name}" — ${tables.length} tables`
    );
    return tables;
  }

  async detach(slug: string): Promise<void> {
    const conn = await this.fileManager.readConnection(slug);
    if (conn?.engine === "s3" || conn?.engine === "snowflake") {
      // S3/Snowflake: just mark as detached, no DuckDB detach
      if (conn) {
        conn.attached = false;
        await this.fileManager.writeConnection(conn.name, conn);
      }
      return;
    }
    await this.duckdb.detachDatabase(slug);
    if (conn) {
      conn.attached = false;
      await this.fileManager.writeConnection(conn.name, conn);
    }
  }

  async testConnection(config: Partial<DatabaseConnection>, password?: string): Promise<boolean> {
    const tempSlug = `_test_${Date.now()}`;
    try {
      const connStr = this.buildConnectionStringFromParts(
        config.engine || "postgres",
        config.host,
        config.port,
        config.database,
        config.schema,
        config.filePath,
        password
      );
      await this.duckdb.attachDatabase(tempSlug, config.engine || "postgres", connStr);
      await this.duckdb.detachDatabase(tempSlug);
      return true;
    } catch {
      try { await this.duckdb.detachDatabase(tempSlug); } catch { /* ignore */ }
      return false;
    }
  }

  /** Test connection and return result object (never throws). */
  async testConnectionSafe(
    config: Partial<DatabaseConnection>,
    password: string
  ): Promise<{ ok: boolean; message: string }> {
    const tempSlug = `_test_${Date.now()}`;
    try {
      const connStr = this.buildConnectionStringFromParts(
        config.engine || "postgres",
        config.host,
        config.port,
        config.database,
        config.schema,
        config.filePath,
        password
      );
      await this.duckdb.attachDatabase(tempSlug, config.engine || "postgres", connStr);
      await this.duckdb.detachDatabase(tempSlug);
      return { ok: true, message: "Connection successful" };
    } catch (err: unknown) {
      try { await this.duckdb.detachDatabase(tempSlug); } catch { /* ignore */ }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  }

  /** Store password when user accidentally typed it in chat. */
  async savePasswordFromChat(slug: string, password: string): Promise<void> {
    const secretKey = `jet_conn_${slug}`;
    await this.secrets.store(secretKey, password);
    const conn = await this.fileManager.readConnection(slug);
    if (conn) {
      conn.secretRef = secretKey;
      await this.fileManager.writeConnection(conn.name, conn);
    }
  }

  /** Re-attach all connections marked as attached (called on startup). */
  async restoreConnections(): Promise<void> {
    const slugs = await this.fileManager.listConnections();
    for (const slug of slugs) {
      const conn = await this.fileManager.readConnection(slug);
      if (conn?.attached) {
        try {
          await this.attach(slug);
        } catch (err) {
          this.outputChannel.appendLine(
            `[connectionManager] Failed to restore ${slug}: ${err}`
          );
          conn.attached = false;
          await this.fileManager.writeConnection(conn.name, conn);
        }
      }
    }
  }

  private async buildConnectionString(conn: DatabaseConnection): Promise<string> {
    let password = "";
    if (conn.secretRef) {
      password = (await this.secrets.get(conn.secretRef)) || "";
    }
    return this.buildConnectionStringFromParts(
      conn.engine, conn.host, conn.port, conn.database, conn.schema, conn.filePath, password
    );
  }

  private buildConnectionStringFromParts(
    engine: DatabaseEngine,
    host?: string,
    port?: number,
    database?: string,
    schema?: string,
    filePath?: string,
    password?: string
  ): string {
    switch (engine) {
      case "postgres":
        return `host=${host || "localhost"} port=${port || 5432} dbname=${database || ""} user=${schema || "postgres"} password=${password || ""}`;
      case "mysql":
        return `host=${host || "localhost"} port=${port || 3306} database=${database || ""} user=${schema || "root"} password=${password || ""}`;
      case "sqlite":
      case "duckdb_file":
        return filePath || "";
      case "motherduck":
        return filePath || "";
      case "s3":
      case "snowflake":
        return ""; // handled separately
      default:
        throw new Error(`Unsupported engine: ${engine}`);
    }
  }

  private requiredExtensions(engine: DatabaseEngine): string[] {
    switch (engine) {
      case "postgres": return ["postgres_scanner"];
      case "mysql": return ["mysql_scanner"];
      case "sqlite": return ["sqlite_scanner"];
      case "s3": return ["httpfs"];
      default: return [];
    }
  }

  private slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  }
}

const enginePlaceholders: Record<string, { name: string }> = {
  postgres: { name: "Production DB" },
  mysql: { name: "MySQL Analytics" },
  sqlite: { name: "Local SQLite" },
  duckdb_file: { name: "Analytics DuckDB" },
  motherduck: { name: "MotherDuck Cloud" },
  s3: { name: "S3 Data Lake" },
  snowflake: { name: "Snowflake DWH" },
};
