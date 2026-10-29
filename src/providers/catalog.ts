import { clientStore } from "@silverbulletmd/silverbullet/syscalls";
import type { TextAPI } from "../types.ts";
import type { ProviderDefaults } from "../interfaces/Provider.ts";
import { proxiedFetch } from "../proxy.ts";

export const providerDefaults: Record<string, ProviderDefaults> = {
  codex: {
    baseUrl: "/api/chatgpt",
    requireAuth: false,
    useProxy: false,
    showPricing: false,
    timeout: 180000,
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    requireAuth: true,
    useProxy: false,
    showPricing: true,
    timeout: 60000,
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com",
    requireAuth: true,
    useProxy: true,
    showPricing: true,
    timeout: 60000,
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    requireAuth: false,
    useProxy: true,
    showPricing: false,
    timeout: 120000,
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    requireAuth: true,
    useProxy: false,
    showPricing: true,
    timeout: 60000,
  },
};

export type ProviderConnection = {
  api?: TextAPI;
  provider: string;
  apiKey: string;
  baseUrl: string;
  useProxy: boolean;
  timeout: number;
  requireAuth: boolean;
};

export function googleBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "").replace(/\/v1beta$/, "")}/v1beta`;
}

type CatalogResponse = {
  models?: Array<{ name: string }>;
  data?: Array<{ id: string }>;
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  parameters?: string;
};

// AI SDK handles inference. Model listing and Ollama metadata are separate APIs.
export class ModelCatalog {
  constructor(private readonly connection: ProviderConnection) {}

  private async request(
    path: string,
    body?: unknown,
  ): Promise<CatalogResponse> {
    const c = this.connection;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (c.requireAuth && c.apiKey) {
      if (c.provider === "gemini") headers["x-goog-api-key"] = c.apiKey;
      else headers.Authorization = `Bearer ${c.apiKey}`;
    }
    const base =
      c.provider === "gemini"
        ? googleBaseUrl(c.baseUrl)
        : c.provider === "ollama"
          ? c.baseUrl.replace(/\/v1\/?$/, "")
          : c.baseUrl.replace(/\/$/, "");
    const response = await proxiedFetch(
      `${base}${path}`,
      {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      c.useProxy,
      c.timeout,
      c.provider,
    );
    if (!response.ok)
      throw new Error(`Model discovery failed: HTTP ${response.status}`);
    return response.json();
  }

  async listModels(): Promise<string[]> {
    const provider = this.connection.provider;
    const data = await this.request(
      provider === "ollama" ? "/api/tags" : "/models",
    );
    if (provider === "gemini")
      return (data.models ?? []).map((m: { name: string }) =>
        m.name.replace(/^models\//, ""),
      );
    if (provider === "ollama")
      return (data.models ?? []).map((m: { name: string }) => m.name);
    return (data.data ?? []).map((m: { id: string }) => m.id);
  }

  private async modelInfo(model: string): Promise<CatalogResponse | null> {
    if (this.connection.provider !== "ollama") return null;
    const key = `ai.ollamaModelInfo.${this.connection.baseUrl}:${model}`;
    const cached = (await clientStore.get(key)) as CatalogResponse | undefined;
    if (cached) return cached;
    try {
      const data = await this.request("/api/show", { model });
      await clientStore.set(key, data);
      return data;
    } catch {
      return null;
    }
  }

  async getModelCapabilities(model: string): Promise<string[] | null> {
    return (await this.modelInfo(model))?.capabilities ?? null;
  }

  async getContextLimit(model: string): Promise<number | null> {
    const data = await this.modelInfo(model);
    for (const [key, value] of Object.entries(data?.model_info ?? {})) {
      if (key.includes("context_length") && typeof value === "number")
        return value;
    }
    const match = data?.parameters?.match(/num_ctx\s+(\d+)/);
    return match ? Number(match[1]) : null;
  }
}
