import * as vscode from "vscode";
import type { BootstrapResponse } from "../types";

// Configure your backend URL in VS Code settings: jetro.apiUrl
// Default: http://localhost:8787 (wrangler dev)
const DEFAULT_API_URL = "http://localhost:8787";
const DATA_TIMEOUT_MS = 15_000;
const BOOTSTRAP_TIMEOUT_MS = 10_000;

// Allow API calls to configured backend + localhost for development
const ALLOWED_API_HOSTS = [
  "localhost",
  "127.0.0.1",
];

function isAllowedUrl(url: string): boolean {
  try {
    new URL(url);
    return true; // OSS: trust any configured URL
  } catch {
    return false;
  }
}

export class JETApiClient {
  private baseUrl: string;

  constructor(private outputChannel: vscode.OutputChannel) {
    const config = vscode.workspace.getConfiguration("jetro");
    const configured = config.get<string>("apiUrl") || DEFAULT_API_URL;

    if (isAllowedUrl(configured)) {
      this.baseUrl = configured;
    } else {
      this.outputChannel.appendLine(
        `[api] WARNING: Invalid apiUrl "${configured}" — falling back to default`
      );
      this.baseUrl = DEFAULT_API_URL;
    }
  }

  async health(): Promise<{ status: string; version: string }> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/health`,
      { method: "GET" },
      5_000
    );
    return res.json() as Promise<{ status: string; version: string }>;
  }

  async bootstrap(jwt: string, mode?: string): Promise<BootstrapResponse & { status?: "cancelled" }> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/bootstrap`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: mode ?? "finance" }),
      },
      BOOTSTRAP_TIMEOUT_MS
    );

    if (res.status === 401) {
      throw new ApiError("auth_expired", "Authentication expired. Please sign in again.");
    }
    if (res.status === 429) {
      const body = await res.json() as { error?: string };
      throw new ApiError("rate_limit", body.error ?? "Rate limit exceeded");
    }
    if (!res.ok) {
      throw new ApiError("server", `Bootstrap failed: ${res.status}`);
    }

    return res.json() as Promise<BootstrapResponse & { status?: "cancelled" }>;
  }

  async data(
    jwt: string,
    provider: string,
    endpoint: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/data`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider, endpoint, params }),
      },
      DATA_TIMEOUT_MS
    );

    if (res.status === 401) {
      throw new ApiError("auth_expired", "Authentication expired. Please sign in again.");
    }
    if (res.status === 429) {
      const body = await res.json() as { error?: string };
      throw new ApiError(
        "rate_limit",
        body.error ?? "Rate limit exceeded",
        {
          limit: res.headers.get("X-RateLimit-Limit"),
          remaining: res.headers.get("X-RateLimit-Remaining"),
          reset: res.headers.get("X-RateLimit-Reset"),
        }
      );
    }
    if (res.status === 403) {
      throw new ApiError("forbidden", "Endpoint not permitted");
    }
    if (res.status === 502) {
      throw new ApiError("upstream", "Data provider error. Try again.");
    }
    if (!res.ok) {
      throw new ApiError("server", `Data request failed: ${res.status}`);
    }

    return res.json();
  }

  async skill(jwt: string, name: string): Promise<{ name: string; prompt: string }> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/skill`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      },
      DATA_TIMEOUT_MS
    );

    if (res.status === 401) {
      throw new ApiError("auth_expired", "Authentication expired. Please sign in again.");
    }
    if (res.status === 404) {
      throw new ApiError("server", `Skill not found: ${name}`);
    }
    if (!res.ok) {
      throw new ApiError("server", `Skill fetch failed: ${res.status}`);
    }

    return res.json() as Promise<{ name: string; prompt: string }>;
  }

  async deployRegister(jwt: string, slug: string): Promise<{ url: string }> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/deploy/register`,
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      },
      DATA_TIMEOUT_MS
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Registration failed" }));
      throw new Error((err as Record<string, string>).error || "Registration failed");
    }
    return res.json() as Promise<{ url: string }>;
  }

  async deployDeregister(jwt: string, slug: string): Promise<void> {
    await this.fetchWithTimeout(
      `${this.baseUrl}/api/deploy/${slug}`,
      {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${jwt}` },
      },
      DATA_TIMEOUT_MS
    );
  }

  async deployWake(jwt: string, slugs: string[]): Promise<{ wake: string[] }> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/deploy/wake?slugs=${slugs.join(",")}`,
      {
        method: "GET",
        headers: { "Authorization": `Bearer ${jwt}` },
      },
      DATA_TIMEOUT_MS
    );
    if (!res.ok) return { wake: [] };
    return res.json() as Promise<{ wake: string[] }>;
  }

  async telemetry(jwt: string, counters: Record<string, number>): Promise<void> {
    try {
      await this.fetchWithTimeout(
        `${this.baseUrl}/api/telemetry`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ counters }),
        },
        DATA_TIMEOUT_MS
      );
    } catch {
      // Telemetry is best-effort — never throw
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return response;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ApiError("timeout", `Request timed out after ${timeoutMs}ms`);
      }
      throw new ApiError("network", `Network error: ${err}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export type ApiErrorCode =
  | "auth_expired"
  | "rate_limit"
  | "forbidden"
  | "upstream"
  | "server"
  | "timeout"
  | "network";

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly meta?: Record<string, string | null>
  ) {
    super(message);
    this.name = "ApiError";
  }
}
