import * as vscode from "vscode";
import { AuthService } from "../services/authService";
import { JETApiClient, ApiError } from "../services/apiClient";

/**
 * jet.skill — Fetches a skill prompt on-demand from the backend.
 *
 * The agent calls this tool with a skill name when it needs the
 * actual execution prompt. The prompt is fetched from the backend,
 * returned directly into the agent's context, and never stored
 * locally. This protects Jetro's IP (proprietary skill logic).
 */
export class JetSkillTool {
  constructor(
    private auth: AuthService,
    private api: JETApiClient,
    private outputChannel: vscode.OutputChannel
  ) {}

  async execute(input: { name: string }): Promise<{ prompt: string } | { error: string }> {
    const { name } = input;
    this.outputChannel.appendLine(`[jet.skill] Fetching: ${name}`);

    const jwt = await this.auth.getToken();
    if (!jwt) {
      return { error: "Not authenticated. Please sign in." };
    }

    try {
      const result = await this.api.skill(jwt, name);
      this.outputChannel.appendLine(`[jet.skill] OK: ${name} (${result.prompt.length} chars)`);
      return { prompt: result.prompt };
    } catch (err) {
      if (err instanceof ApiError) {
        this.outputChannel.appendLine(`[jet.skill] ${err.code}: ${err.message}`);
        if (err.code === "auth_expired") {
          const freshJwt = await this.auth.getToken();
          if (freshJwt) {
            try {
              const result = await this.api.skill(freshJwt, name);
              this.outputChannel.appendLine(`[jet.skill] OK (retry): ${name}`);
              return { prompt: result.prompt };
            } catch {
              return { error: `Failed to fetch skill: ${name}` };
            }
          }
        }
        return { error: err.message };
      }
      this.outputChannel.appendLine(`[jet.skill] Error: ${err}`);
      return { error: String(err) };
    }
  }
}
