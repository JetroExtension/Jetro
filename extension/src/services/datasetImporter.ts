import * as vscode from "vscode";
import * as path from "path";
import * as XLSX from "xlsx";
import { FileManager } from "./fileManager";
import { DuckDBService } from "./duckdb";
import { DatasetMetadata } from "../types";
import type { JetParseTool } from "../tools/jetParse";

const DOC_EXTENSIONS = ["pdf", "docx", "doc", "pptx", "ppt", "txt", "md"];

export class DatasetImporter {
  private parseTool: JetParseTool | null = null;

  constructor(
    private fileManager: FileManager,
    private duckdb: DuckDBService,
    private outputChannel: vscode.OutputChannel
  ) {}

  /** Inject the parse tool after construction (avoids circular deps). */
  setParseTool(tool: JetParseTool): void {
    this.parseTool = tool;
  }

  /**
   * Interactive file import: opens file picker, copies file to datasets dir,
   * registers in DuckDB, detects schema, writes metadata.
   */
  async importFromFile(projectSlug?: string): Promise<string | null> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: {
        "Data files": ["csv", "tsv", "parquet", "json", "jsonl", "ndjson", "xlsx", "xls"],
      },
      title: projectSlug ? `Import Data into Project` : "Import Dataset",
    });
    if (!uris || uris.length === 0) return null;

    const name = await vscode.window.showInputBox({
      prompt: "Dataset name",
      placeHolder: "e.g. Q4 Sales Data",
      validateInput: (v) => (v.trim() ? null : "Name is required"),
    });
    if (!name) return null;

    return projectSlug
      ? this.importFilesForProject(projectSlug, name, uris)
      : this.importFiles(name, uris);
  }

  /**
   * Import files into a project dataset directory.
   */
  async importToProject(projectSlug: string, uris?: vscode.Uri[]): Promise<string | null> {
    if (!uris) {
      uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: {
          "Data files": ["csv", "tsv", "parquet", "json", "jsonl", "ndjson", "xlsx", "xls"],
        },
        title: `Import Data into Project`,
      });
      if (!uris || uris.length === 0) return null;
    }

    const name = await vscode.window.showInputBox({
      prompt: "Dataset name",
      placeHolder: "e.g. Q4 Sales Data",
      validateInput: (v) => (v.trim() ? null : "Name is required"),
    });
    if (!name) return null;

    return this.importFilesForProject(projectSlug, name, uris);
  }

  /**
   * Import documents (PDF, DOCX, PPTX, EPUB, RTF, images, TXT, MD) — parsed to Markdown.
   */
  async importDocuments(projectSlug?: string): Promise<string | null> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: {
        "Documents": DOC_EXTENSIONS,
      },
      title: "Import Documents",
    });
    if (!uris || uris.length === 0) return null;

    let successCount = 0;
    for (const uri of uris) {
      const ext = path.extname(uri.fsPath).toLowerCase().replace(".", "");
      const baseName = path.parse(uri.fsPath).name;

      if (ext === "txt" || ext === "md") {
        // Plain text / markdown: copy directly to notes
        const content = await vscode.workspace.fs.readFile(uri);
        const outputName = `${baseName}.md`;
        const text = new TextDecoder().decode(content);
        if (projectSlug) {
          await this.fileManager.writeProjectNote(projectSlug, outputName, text);
        } else {
          await this.fileManager.writeUniversalNote(outputName, text);
        }
        successCount++;
        this.outputChannel.appendLine(`[datasetImporter] Copied ${ext} document "${baseName}"`);
      } else if (this.parseTool) {
        // Parse via pymupdf/markitdown/rapidocr
        try {
          const result = await this.parseTool.execute({
            file: uri.fsPath,
            projectSlug,
            outputName: baseName,
          });
          successCount++;
          this.outputChannel.appendLine(
            `[datasetImporter] Parsed "${baseName}" — ${result.pageCount ?? "?"} pages`
          );
        } catch (err) {
          this.outputChannel.appendLine(
            `[datasetImporter] Failed to parse "${baseName}": ${err}`
          );
          vscode.window.showWarningMessage(
            `Failed to parse "${baseName}": ${err instanceof Error ? err.message : err}`
          );
        }
      } else {
        vscode.window.showWarningMessage(
          `Cannot parse "${baseName}.${ext}" — parse tool not available`
        );
      }
    }

    if (successCount > 0) {
      vscode.window.showInformationMessage(
        `${successCount} document${successCount > 1 ? "s" : ""} imported and parsed.`
      );
    }
    return successCount > 0 ? "ok" : null;
  }

  /**
   * Import data from a URL. Supports both global and project-scoped.
   */
  async importFromUrl(url: string, projectSlug?: string): Promise<string> {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only http/https URLs are supported");
    }
    const safeUrl = url.replace(/'/g, "''");

    const urlPath = parsed.pathname;
    const fileName = path.basename(urlPath) || "download.csv";
    const baseName = path.parse(fileName).name;
    const slug = this.slugify(baseName);

    const parquetName = `${slug}.parquet`;
    let destFile: vscode.Uri;
    let tableName: string;

    if (projectSlug) {
      await this.fileManager.initBIProject(projectSlug);
      destFile = await this.fileManager.getProjectDatasetFilePath(projectSlug, slug, parquetName);
      tableName = `p_${projectSlug}_${slug}`;
    } else {
      destFile = await this.fileManager.getDatasetFilePath(slug, parquetName);
      tableName = `ds_${slug}`;
    }

    const safeDest = destFile.fsPath.replace(/'/g, "''");

    // Use DuckDB to download and save as Parquet
    // Need direct exec since COPY is blocked by read-only executeQuery
    await this.duckdb.materializeQuery(`SELECT * FROM '${safeUrl}'`, safeDest);

    const columns = await this.duckdb.registerDataset(tableName, destFile.fsPath);
    const rowCount = await this.duckdb.getTableRowCount(tableName);

    let sizeBytes = 0;
    try {
      const stat = await vscode.workspace.fs.stat(destFile);
      sizeBytes = stat.size;
    } catch { /* ignore */ }

    const metadata: DatasetMetadata = {
      name: baseName,
      slug,
      files: [parquetName],
      columns,
      rowCount,
      sizeBytes,
      duckdbTable: tableName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (projectSlug) {
      await this.fileManager.writeProjectDataset(projectSlug, baseName, metadata);
    } else {
      await this.fileManager.writeDataset(baseName, metadata);
    }

    this.outputChannel.appendLine(
      `[datasetImporter] Imported URL "${url}" — ${rowCount} rows`
    );
    vscode.window.showInformationMessage(
      `Dataset "${baseName}" imported from URL: ${rowCount.toLocaleString()} rows.`
    );
    return slug;
  }

  /**
   * Core import logic for global datasets.
   */
  private async importFiles(name: string, uris: vscode.Uri[]): Promise<string> {
    const slug = this.slugify(name);
    const files: string[] = [];

    for (const uri of uris) {
      const fileName = path.basename(uri.fsPath);
      const ext = fileName.split(".").pop()?.toLowerCase();

      if (ext === "xlsx" || ext === "xls") {
        const csvName = fileName.replace(/\.(xlsx|xls)$/, ".csv");
        const csvContent = await this.excelToCsv(uri);
        const target = await this.fileManager.getDatasetFilePath(slug, csvName);
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(csvContent));
        files.push(csvName);
      } else {
        const target = await this.fileManager.getDatasetFilePath(slug, fileName);
        const content = await vscode.workspace.fs.readFile(uri);
        await vscode.workspace.fs.writeFile(target, content);
        files.push(fileName);
      }
    }

    // Register primary file in DuckDB
    const primaryFile = files[0];
    const tableName = `ds_${slug}`;
    const primaryPath = (await this.fileManager.getDatasetFilePath(slug, primaryFile)).fsPath;
    const columns = await this.duckdb.registerDataset(tableName, primaryPath);
    const rowCount = await this.duckdb.getTableRowCount(tableName);

    // Compute size
    let sizeBytes = 0;
    for (const f of files) {
      const fUri = await this.fileManager.getDatasetFilePath(slug, f);
      try {
        const stat = await vscode.workspace.fs.stat(fUri);
        sizeBytes += stat.size;
      } catch { /* ignore */ }
    }

    const metadata: DatasetMetadata = {
      name,
      slug,
      files,
      columns,
      rowCount,
      sizeBytes,
      duckdbTable: tableName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.fileManager.writeDataset(name, metadata);

    this.outputChannel.appendLine(
      `[datasetImporter] Imported "${name}" — ${rowCount} rows, ${columns.length} columns`
    );
    vscode.window.showInformationMessage(
      `Dataset "${name}" imported: ${rowCount.toLocaleString()} rows, ${columns.length} columns.`
    );
    return slug;
  }

  /**
   * Core import logic for project-scoped datasets.
   */
  private async importFilesForProject(projectSlug: string, name: string, uris: vscode.Uri[]): Promise<string> {
    const slug = this.slugify(name);
    const files: string[] = [];

    await this.fileManager.initBIProject(projectSlug);

    for (const uri of uris) {
      const fileName = path.basename(uri.fsPath);
      const ext = fileName.split(".").pop()?.toLowerCase();

      if (ext === "xlsx" || ext === "xls") {
        const csvName = fileName.replace(/\.(xlsx|xls)$/, ".csv");
        const csvContent = await this.excelToCsv(uri);
        const target = await this.fileManager.getProjectDatasetFilePath(projectSlug, slug, csvName);
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(csvContent));
        files.push(csvName);
      } else {
        const target = await this.fileManager.getProjectDatasetFilePath(projectSlug, slug, fileName);
        const content = await vscode.workspace.fs.readFile(uri);
        await vscode.workspace.fs.writeFile(target, content);
        files.push(fileName);
      }
    }

    const primaryFile = files[0];
    const tableName = `p_${projectSlug}_${slug}`;
    const primaryPath = (await this.fileManager.getProjectDatasetFilePath(projectSlug, slug, primaryFile)).fsPath;
    const columns = await this.duckdb.registerDataset(tableName, primaryPath);
    const rowCount = await this.duckdb.getTableRowCount(tableName);

    let sizeBytes = 0;
    for (const f of files) {
      const fUri = await this.fileManager.getProjectDatasetFilePath(projectSlug, slug, f);
      try {
        const stat = await vscode.workspace.fs.stat(fUri);
        sizeBytes += stat.size;
      } catch { /* ignore */ }
    }

    const metadata: DatasetMetadata = {
      name,
      slug,
      files,
      columns,
      rowCount,
      sizeBytes,
      duckdbTable: tableName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.fileManager.writeProjectDataset(projectSlug, name, metadata);

    this.outputChannel.appendLine(
      `[datasetImporter] Imported "${name}" into project ${projectSlug} — ${rowCount} rows`
    );
    vscode.window.showInformationMessage(
      `Dataset "${name}" imported into project: ${rowCount.toLocaleString()} rows.`
    );
    return slug;
  }

  /**
   * Register an existing dataset's files in DuckDB (called on startup).
   */
  async registerExisting(slug: string): Promise<void> {
    const metadata = await this.fileManager.readDataset(slug);
    if (!metadata || metadata.files.length === 0) return;

    const primaryFile = metadata.files[0];
    const primaryPath = (await this.fileManager.getDatasetFilePath(slug, primaryFile)).fsPath;
    try {
      await this.duckdb.registerDataset(metadata.duckdbTable, primaryPath);
    } catch (err) {
      this.outputChannel.appendLine(`[datasetImporter] Failed to register ${slug}: ${err}`);
    }
  }

  private async excelToCsv(uri: vscode.Uri): Promise<string> {
    const data = await vscode.workspace.fs.readFile(uri);
    const workbook = XLSX.read(data, { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_csv(sheet);
  }

  private slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  }
}
