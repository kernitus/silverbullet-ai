import { createMCPClient, type MCPClient as SDKMCPClient } from "@ai-sdk/mcp";
import { sdkFetch } from "../proxy.ts";
import type { MCPServerConfig } from "../types.ts";
import type { McpToolDef, McpCallToolResult } from "./types.ts";

// Adapt the SDK client to SilverBullet's tool discovery and approval boundary.
export class MCPClient {
  private client?: Promise<SDKMCPClient>;
  constructor(private readonly config: MCPServerConfig) {}

  private connect() {
    if (this.client) return this.client;
    this.client = createMCPClient({
      transport: {
        type: "http",
        url: this.config.url,
        headers: this.config.headers,
        fetch: sdkFetch(true, this.config.timeout ?? 60000, "MCP"),
      },
      protocolVersionDiscovery: false,
      initializationOptions: { timeout: this.config.timeout ?? 60000 },
      maxRetries: 0,
    }).catch((error) => {
      this.client = undefined;
      throw error;
    });
    return this.client;
  }

  async listTools(): Promise<McpToolDef[]> {
    const client = await this.connect();
    const tools: McpToolDef[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools({
        params: { cursor },
        options: { timeout: this.config.timeout ?? 60000 },
      });
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallToolResult> {
    signal?.throwIfAborted();
    const client = await this.connect();
    signal?.throwIfAborted();
    return client.callTool({
      name,
      arguments: args,
      options: { timeout: this.config.timeout ?? 60000, signal },
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await (await client).close();
  }
}
