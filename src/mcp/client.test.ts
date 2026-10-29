import { afterEach, expect, test, vi } from "vitest";
import { MCPClient } from "./client.ts";

afterEach(() => vi.unstubAllGlobals());

test("SDK MCP client initialises, paginates tools, calls tools and closes through the proxy", async () => {
  const methods: string[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(String(init.body));
    methods.push(request.method);
    if (!("id" in request)) return new Response(null, { status: 202 });
    let result: unknown;
    switch (request.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        };
        break;
      case "tools/list":
        result = request.params?.cursor
          ? {
              tools: [
                {
                  name: "second",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : {
              tools: [
                {
                  name: "first",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
              nextCursor: "page-2",
            };
        break;
      case "tools/call":
        result = { content: [{ type: "text", text: "tool result" }] };
        break;
      default:
        throw new Error(`Unexpected MCP method: ${request.method}`);
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      {
        headers: {
          "x-proxy-status-code": "200",
          "x-proxy-header-content-type": "application/json",
          "x-proxy-header-mcp-session-id": "session-1",
        },
      },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const client = new MCPClient({
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer test" },
  });
  try {
    expect((await client.listTools()).map((t) => t.name)).toEqual([
      "first",
      "second",
    ]);
    expect(await client.callTool("first", {})).toMatchObject({
      content: [{ type: "text", text: "tool result" }],
    });
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/list",
      "tools/call",
    ]);
    expect(
      fetch.mock.calls.every(([url]) => url === "/.proxy/example.com/mcp"),
    ).toBe(true);
    expect(
      new Headers(fetch.mock.calls[0][1].headers).get(
        "x-proxy-header-authorization",
      ),
    ).toBe("Bearer test");
  } finally {
    await client.close();
  }
  expect(fetch.mock.calls.at(-1)?.[1].method).toBe("DELETE");
});

test("SDK MCP client retries connection after failed initialisation", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async () => new Response("Unavailable", { status: 503 }),
    );
  vi.stubGlobal("fetch", fetch);
  const client = new MCPClient({
    url: "https://example.com/mcp",
    timeout: 100,
  });
  await expect(client.listTools()).rejects.toThrow();
  await expect(client.listTools()).rejects.toThrow();
  expect(
    fetch.mock.calls.filter(([, init]) => init.method === "POST"),
  ).toHaveLength(2);
});
