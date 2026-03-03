import * as vscode from "vscode";
import * as path from "path";
import { FileManager } from "../services/fileManager";
import { JetParseInput, ParseResult } from "../types";

/**
 * Embedded Python script for document parsing.
 * Routes by file extension to the right library:
 *   PDF         → pymupdf4llm (text) or pymupdf + RapidOCR (scanned)
 *   Office/HTML → markitdown
 *   Images      → RapidOCR
 */
const PARSE_SCRIPT = `
import sys, json, os

def parse_page_range(spec, total):
    """Parse '1-5', '3', '1,3,5-7' into 0-based page indices."""
    if not spec or spec == "all":
        return list(range(total))
    pages = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            start, end = part.split("-", 1)
            start = max(1, int(start))
            end = min(total, int(end))
            pages.update(range(start - 1, end))
        else:
            p = int(part)
            if 1 <= p <= total:
                pages.add(p - 1)
    return sorted(pages)

def parse_pdf(file_path, options):
    import pymupdf
    import pymupdf4llm

    doc = pymupdf.open(file_path)
    page_count = len(doc)

    pages = None
    if options.get("pages"):
        pages = parse_page_range(options["pages"], page_count)

    md = pymupdf4llm.to_markdown(file_path, pages=pages)

    table_count = 0
    for page in doc:
        try:
            tables = page.find_tables()
            table_count += len(tables.tables)
        except Exception:
            pass
    doc.close()

    title = os.path.splitext(os.path.basename(file_path))[0]
    return md, {"title": title, "pages": page_count, "tables": table_count}

def parse_pdf_ocr(file_path, options):
    import pymupdf
    from rapidocr_onnxruntime import RapidOCR

    ocr = RapidOCR()
    doc = pymupdf.open(file_path)
    page_count = len(doc)
    pages = parse_page_range(options.get("pages"), page_count) if options.get("pages") else range(page_count)

    text_parts = []
    for page_num in pages:
        page = doc[page_num]
        text = page.get_text().strip()
        if len(text) > 50:
            text_parts.append(text)
        else:
            pix = page.get_pixmap(dpi=300)
            img_bytes = pix.tobytes("png")
            result, _ = ocr(img_bytes)
            if result:
                text_parts.append("\\n".join([line[1] for line in result]))

    doc.close()
    md = "\\n\\n---\\n\\n".join(text_parts)
    title = os.path.splitext(os.path.basename(file_path))[0]
    return md, {"title": title, "pages": page_count, "tables": 0}

def parse_office(file_path, options):
    from markitdown import MarkItDown

    mid = MarkItDown()
    result = mid.convert(file_path)
    md = result.text_content
    title = getattr(result, "title", "") or os.path.splitext(os.path.basename(file_path))[0]
    return md, {"title": title, "pages": None, "tables": 0}

def parse_image_ocr(file_path, options):
    from rapidocr_onnxruntime import RapidOCR

    ocr = RapidOCR()
    result, _ = ocr(file_path)
    if result:
        md = "\\n".join([line[1] for line in result])
    else:
        md = "(No text detected in image)"
    title = os.path.splitext(os.path.basename(file_path))[0]
    return md, {"title": title, "pages": None, "tables": 0}

def main():
    file_path = sys.argv[1]
    options = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    ext = os.path.splitext(file_path)[1].lower()
    file_size = os.path.getsize(file_path)

    PDF_EXTS = {".pdf"}
    OFFICE_EXTS = {".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".html", ".htm", ".epub", ".rtf", ".eml", ".msg"}
    IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp"}

    try:
        if ext in PDF_EXTS:
            if options.get("ocr"):
                md, meta = parse_pdf_ocr(file_path, options)
            else:
                md, meta = parse_pdf(file_path, options)
        elif ext in OFFICE_EXTS:
            md, meta = parse_office(file_path, options)
        elif ext in IMAGE_EXTS:
            md, meta = parse_image_ocr(file_path, options)
        else:
            print(json.dumps({"error": "Unsupported format: " + ext}))
            sys.exit(1)
    except ImportError as e:
        module = str(e).split("'")[1] if "'" in str(e) else str(e)
        pkg_map = {
            "pymupdf4llm": "pymupdf4llm", "fitz": "pymupdf", "pymupdf": "pymupdf",
            "markitdown": "markitdown[docx,pptx,xlsx]",
            "rapidocr_onnxruntime": "rapidocr-onnxruntime",
        }
        pkg = pkg_map.get(module, module)
        print(json.dumps({"error": "Missing library: " + module + ". Install with: pip install " + pkg}))
        sys.exit(1)

    word_count = len(md.split()) if md else 0
    meta["wordCount"] = word_count
    meta["fileSize"] = file_size
    meta.setdefault("title", "")
    meta.setdefault("pages", None)
    meta.setdefault("tables", 0)

    print(json.dumps({"markdown": md, "meta": meta}))

if __name__ == "__main__":
    main()
`.trim();

/** Supported document formats for parsing. */
const PARSEABLE_EXTENSIONS = new Set([
  // PDF
  ".pdf",
  // Office
  ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
  // Web
  ".html", ".htm",
  // Ebook
  ".epub",
  // Rich text
  ".rtf",
  // Email
  ".eml", ".msg",
  // Images (OCR)
  ".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".webp",
  // Text passthrough (no Python needed)
  ".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".xml",
]);

/** Text formats that can be read directly — no Python subprocess needed. */
const TEXT_PASSTHROUGH = new Set([
  ".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".xml",
]);

const FORMAT_MAP: Record<string, string> = {
  ".pdf": "pdf",
  ".docx": "docx", ".doc": "docx",
  ".pptx": "pptx", ".ppt": "pptx",
  ".xlsx": "xlsx", ".xls": "xlsx",
  ".html": "html", ".htm": "html",
  ".epub": "epub",
  ".rtf": "rtf",
  ".eml": "email", ".msg": "email",
  ".png": "image", ".jpg": "image", ".jpeg": "image",
  ".tiff": "image", ".bmp": "image", ".webp": "image",
  ".md": "text", ".txt": "text", ".csv": "text",
  ".json": "text", ".yaml": "text", ".yml": "text", ".xml": "text",
};

export class JetParseTool {
  constructor(
    private fileManager: FileManager,
    private outputChannel: vscode.OutputChannel
  ) {}

  private getFormat(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return FORMAT_MAP[ext] || "unknown";
  }

  async execute(input: JetParseInput): Promise<ParseResult> {
    const { file, projectSlug, outputName, options } = input;
    this.outputChannel.appendLine(
      `[jet.parse] file="${file}" project=${projectSlug || "universal"}`
    );

    // 1. Resolve absolute file path
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error("No workspace folder open");
    }
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const absolutePath = path.isAbsolute(file)
      ? file
      : path.resolve(workspacePath, file);

    // Security: ensure file is within workspace
    if (!absolutePath.startsWith(workspacePath)) {
      throw new Error(`Path traversal blocked: ${file} escapes workspace`);
    }

    // Validate file extension
    const ext = path.extname(absolutePath).toLowerCase();
    if (!PARSEABLE_EXTENSIONS.has(ext)) {
      throw new Error(
        `Unsupported format: ${ext}. Supported: ${[...PARSEABLE_EXTENSIONS].join(", ")}`
      );
    }

    // Check file exists
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
    } catch {
      throw new Error(`File not found: ${file}`);
    }

    const format = this.getFormat(absolutePath);
    const baseName = outputName || path.basename(absolutePath, ext);
    const sourceFileName = path.basename(absolutePath);

    // 2. Copy original to sources directory
    let sourcePath: string;
    const fileContent = await vscode.workspace.fs.readFile(
      vscode.Uri.file(absolutePath)
    );
    if (projectSlug) {
      sourcePath = await this.fileManager.addProjectSource(
        projectSlug,
        sourceFileName,
        fileContent
      );
    } else {
      sourcePath = await this.fileManager.addUniversalSource(
        sourceFileName,
        fileContent
      );
    }
    this.outputChannel.appendLine(`[jet.parse] Source copied → ${sourcePath}`);

    // 3. Text passthrough — no Python needed
    if (TEXT_PASSTHROUGH.has(ext)) {
      const markdown = new TextDecoder().decode(fileContent);
      const wordCount = markdown.split(/\s+/).filter(Boolean).length;
      const fileStat = await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));

      let outputPath: string;
      if (projectSlug) {
        outputPath = await this.fileManager.writeProjectNote(projectSlug, baseName, markdown);
      } else {
        outputPath = await this.fileManager.writeUniversalNote(baseName, markdown);
      }

      if (projectSlug) {
        try {
          const project = await this.fileManager.readProject(projectSlug);
          if (project && !project.sources.includes(sourceFileName)) {
            project.sources.push(sourceFileName);
            project.updatedAt = new Date().toISOString();
            await this.fileManager.writeProject(projectSlug, project);
          }
        } catch { /* non-critical */ }
      }

      this.outputChannel.appendLine(`[jet.parse] ✓ ${format} "${baseName}" → ${outputPath} (passthrough)`);
      return {
        outputPath,
        sourcePath,
        title: baseName,
        format,
        wordCount,
        fileSize: fileStat.size,
      };
    }

    // 4. Ensure parse dependencies in managed venv
    const venvPath = await this.fileManager.ensureParseDeps(this.outputChannel);
    const pythonBin = path.join(venvPath, "bin", "python3");

    // 5. Write parse script to temp file
    const tmpDir = path.join(workspacePath, ".jetro", "scripts");
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(tmpDir));
    const scriptPath = path.join(tmpDir, "_jet_parse_runner.py");
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(scriptPath),
      new TextEncoder().encode(PARSE_SCRIPT)
    );

    // 6. Execute parse script
    const optionsJson = JSON.stringify(options || {});
    this.outputChannel.appendLine(
      `[jet.parse] Parsing ${sourceFileName} (${format})...`
    );

    const cp = await import("child_process");
    const stdout = await new Promise<string>((resolve, reject) => {
      cp.exec(
        `"${pythonBin}" "${scriptPath}" "${absolutePath}" '${optionsJson}'`,
        {
          cwd: workspacePath,
          timeout: 120000, // 2 minutes for large documents
          maxBuffer: 10 * 1024 * 1024, // 10MB for large documents
          env: { ...process.env },
        },
        (err, out, stderr) => {
          if (err) {
            const msg = stderr || err.message;
            reject(new Error(`Parse failed: ${msg}`));
          } else {
            resolve(out);
          }
        }
      );
    });

    // 7. Parse output
    let parsed: { markdown?: string; error?: string; meta?: { title?: string; pages?: number; tables?: number; wordCount?: number; fileSize?: number } };
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      throw new Error(
        "Parse script returned invalid JSON. Raw output:\n" +
        stdout.substring(0, 500)
      );
    }

    if (parsed.error) {
      throw new Error(parsed.error);
    }

    if (!parsed.markdown) {
      throw new Error("Parse script returned empty markdown");
    }

    // 8. Write parsed markdown to notes directory
    let outputPath: string;
    if (projectSlug) {
      outputPath = await this.fileManager.writeProjectNote(
        projectSlug,
        baseName,
        parsed.markdown
      );
    } else {
      outputPath = await this.fileManager.writeUniversalNote(
        baseName,
        parsed.markdown
      );
    }
    this.outputChannel.appendLine(
      `[jet.parse] Parsed → ${outputPath} (${parsed.markdown.length} chars)`
    );

    // 9. Update project.sources[] if applicable
    if (projectSlug) {
      try {
        const project = await this.fileManager.readProject(projectSlug);
        if (project && !project.sources.includes(sourceFileName)) {
          project.sources.push(sourceFileName);
          project.updatedAt = new Date().toISOString();
          await this.fileManager.writeProject(projectSlug, project);
        }
      } catch {
        // Non-critical — don't fail parse if project update fails
      }
    }

    // 10. Clean up temp script
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(scriptPath));
    } catch {
      // Non-critical
    }

    const meta = parsed.meta || {};
    const result: ParseResult = {
      outputPath,
      sourcePath,
      pageCount: meta.pages ?? undefined,
      title: meta.title || baseName,
      tables: meta.tables ?? undefined,
      format,
      wordCount: meta.wordCount ?? undefined,
      fileSize: meta.fileSize ?? undefined,
    };

    this.outputChannel.appendLine(
      `[jet.parse] ✓ ${format} "${result.title}" → ${outputPath}` +
      (result.pageCount ? ` (${result.pageCount} pages)` : "") +
      (result.tables ? ` (${result.tables} tables)` : "")
    );

    return result;
  }
}
