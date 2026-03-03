import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { AuthService } from "../services/authService";
import type { FileManager } from "../services/fileManager";
import type { JetExecInput } from "../types";

export class JetExecTool {
  constructor(
    private auth: AuthService,
    private workspacePath: string,
    private outputChannel: vscode.OutputChannel,
    private fileManager?: FileManager,
    private secrets?: vscode.SecretStorage,
  ) {}

  async execute(input: JetExecInput): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { language, code, timeout = 300_000 } = input;

    if (!code || !code.trim()) {
      return { stdout: "", stderr: "No code provided", exitCode: 1 };
    }

    // Resolve interpreter
    const ext = language === "r" ? "R" : "py";
    const interpreter = language === "r"
      ? "Rscript"
      : await this.resolvePython();

    // Write code to temp script file
    const scriptName = `_exec_${Date.now()}.${ext}`;
    const scriptsDir = path.resolve(this.workspacePath, ".jetro", "scripts");
    const scriptPath = path.resolve(scriptsDir, scriptName);

    try {
      await fs.promises.mkdir(scriptsDir, { recursive: true });
    } catch { /* already exists */ }
    await fs.promises.writeFile(scriptPath, code, "utf-8");

    // Build environment
    const jwt = await this.auth.getToken();
    const jetLibPath = path.resolve(this.workspacePath, ".jetro", "lib");
    const existingPythonPath = process.env.PYTHONPATH || "";
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      JET_WORKSPACE: this.workspacePath,
      JET_DUCKDB_PATH: path.resolve(this.workspacePath, ".jetro", "cache.duckdb"),
      JET_API_URL: vscode.workspace.getConfiguration("jetro").get<string>("apiUrl") || "http://localhost:8787",
      JET_JWT: jwt || "",
      JET_FRAMES_DIR: path.resolve(this.workspacePath, ".jetro", "frames"),
      PYTHONPATH: existingPythonPath ? `${jetLibPath}:${existingPythonPath}` : jetLibPath,
    };

    // Inject all credentials for ad-hoc execution
    if (this.fileManager && this.secrets) {
      try {
        const credsJson = await this.fileManager.buildCredentialsEnv(this.secrets);
        if (credsJson !== "{}") {
          env.JET_CREDENTIALS = credsJson;
        }
      } catch { /* credentials unavailable */ }
    }

    this.outputChannel.appendLine(`[jet.exec] ${language} (${code.length} chars, timeout ${timeout}ms)`);

    try {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        cp.exec(
          `${interpreter} "${scriptPath}"`,
          {
            cwd: this.workspacePath,
            timeout,
            maxBuffer: 10 * 1024 * 1024, // 10 MB
            env,
          },
          (err, stdout, stderr) => {
            resolve({
              stdout: stdout || "",
              stderr: stderr || "",
              exitCode: err ? ((err as NodeJS.ErrnoException).code ? 1 : 1) : 0,
            });
          }
        );
      });

      this.outputChannel.appendLine(
        `[jet.exec] exit=${result.exitCode} stdout=${result.stdout.length}B stderr=${result.stderr.length}B`
      );
      return result;
    } finally {
      // Clean up temp script
      try { await fs.promises.unlink(scriptPath); } catch { /* ignore */ }
    }
  }

  private async resolvePython(): Promise<string> {
    // Prefer managed venv if it exists
    const venvPython = path.resolve(this.workspacePath, ".jetro", "venv", "bin", "python3");
    try {
      await fs.promises.access(venvPython, fs.constants.X_OK);
      return venvPython;
    } catch {
      return "python3";
    }
  }
}
