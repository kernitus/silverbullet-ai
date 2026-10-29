import { expect, test, vi } from "vitest";
import "./mocks/syscalls.ts";
import { MockLanguageModelV3 } from "ai/test";
import { runAgenticChat } from "./tools.ts";
import { interruptedMessages, type RunCheckpoint } from "./execution.ts";
import { createContextManager, boundedToolOutput } from "./context.ts";
import { researchTool } from "./research.ts";
import { filterCapabilities } from "./capabilities.ts";
import { buildReadNoteTool } from "./note-tools.ts";
import { buildSearchNotesTool } from "./search.ts";
import { isPathAllowed } from "./utils.ts";
import { syscall } from "@silverbulletmd/silverbullet/syscalls";
import type { ProviderInterface } from "./interfaces/Provider.ts";
import type { ModelMessage } from "ai";

const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};
const answer = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage,
  warnings: [],
});
const provider = (model: MockLanguageModelV3) =>
  ({ languageModel: model, modelName: "test" }) as unknown as ProviderInterface;

test("cancellation reaches an in-flight SDK model request", async () => {
  const controller = new AbortController();
  let started = false;
  const model = new MockLanguageModelV3({
    doGenerate: async ({ abortSignal }) => {
      started = true;
      return await new Promise((_resolve, reject) =>
        abortSignal!.addEventListener(
          "abort",
          () => reject(abortSignal!.reason),
          { once: true },
        ),
      );
    },
  });
  const run = runAgenticChat({
    provider: provider(model),
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    luaTools: new Map(),
    abortSignal: controller.signal,
  });
  const rejected = expect(run).rejects.toThrow("Stopped");
  await vi.waitFor(() => expect(started).toBe(true));
  controller.abort(new DOMException("Stopped", "AbortError"));
  await rejected;
});

test("tool start and completion are checkpointed before the next model step", async () => {
  const checkpoints: RunCheckpoint[] = [];
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      if (++calls === 1)
        return {
          ...answer(""),
          content: [
            {
              type: "tool-call",
              toolCallId: "edit-1",
              toolName: "edit",
              input: "{}",
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
        };
      expect(checkpoints.some((c) => c.inFlight?.toolCallId === "edit-1")).toBe(
        true,
      );
      expect(checkpoints.at(-1)?.messages.some((m) => m.role === "tool")).toBe(
        true,
      );
      return answer("Edited");
    },
  });
  const execute = vi.fn(async () => {
    expect(checkpoints.at(-1)?.inFlight?.toolName).toBe("edit");
    return { success: true, result: "Saved once" };
  });
  const result = await runAgenticChat({
    provider: provider(model),
    messages: [{ role: "user", content: "Edit" }],
    tools: [
      {
        type: "function",
        function: {
          name: "edit",
          description: "Edit",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    luaTools: new Map([
      ["edit", { handler: "", description: "Edit", parameters: {}, execute }],
    ]),
    onCheckpoint: async (checkpoint) => {
      checkpoints.push(JSON.parse(JSON.stringify(checkpoint)));
    },
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(result.messages.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "Edited" }],
  });
});

test("interrupted tools recover as paired SDK messages with an uncertain outcome", () => {
  const recovered = interruptedMessages({
    messages: [{ role: "user", content: "Edit" }],
    inFlight: { toolCallId: "edit-1", toolName: "edit", input: {} },
  });
  expect(recovered[1]).toMatchObject({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "edit-1" }],
  });
  expect(recovered[2]).toMatchObject({
    role: "tool",
    content: [
      {
        type: "tool-result",
        output: {
          type: "error-text",
          value: expect.stringContaining("Do not repeat"),
        },
      },
    ],
  });
});

test("context compaction uses SDK summarisation and preserves current parts and instructions", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: answer(
      "Keep the user's constraints; the prior edit is complete.",
    ),
  });
  const original: ModelMessage[] = [
    { role: "system", content: "Never edit private notes" },
    { role: "user", content: "Old research " + "x".repeat(9000) },
    { role: "assistant", content: "The edit is complete" },
    { role: "user", content: "Continue the research" },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Current",
          providerOptions: { google: { thoughtSignature: "signature" } },
        },
      ],
    },
  ];
  const saved = JSON.stringify(original);
  const compact = createContextManager({ model, maxChars: 8000 });
  const result = await compact(original);
  expect(JSON.stringify(result).length).toBeLessThan(8000);
  expect(result[0]).toEqual(original[0]);
  expect(result.at(-1)).toEqual(original.at(-1));
  expect(JSON.stringify(original)).toBe(saved);
  const count = model.doGenerateCalls.length;
  await compact(original);
  expect(model.doGenerateCalls).toHaveLength(count);
  expect(count).toBeGreaterThan(0);
});

test("oversized current turns fail without silently dropping instructions", async () => {
  const model = new MockLanguageModelV3({ doGenerate: answer("unused") });
  await expect(
    createContextManager({ model, maxChars: 8000 })([
      { role: "user", content: "x".repeat(10000) },
    ]),
  ).rejects.toThrow("context budget");
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(boundedToolOutput("x".repeat(15000))).toContain("Output truncated");
});

test("restricted agents cannot use Lua or MCP metadata to escape path restrictions", () => {
  const tools = new Map([
    ["read_note", buildReadNoteTool()],
    ["search_notes", buildSearchNotesTool()],
    [
      "fake_read",
      {
        handler: "fake_read",
        description: "Read",
        parameters: {},
        readOnly: true,
        readPathParam: "page",
      },
    ],
    [
      "eval_lua",
      {
        handler: "eval_lua",
        description: "Lua",
        parameters: {},
        readOnly: true,
      },
    ],
    [
      "mcp",
      {
        handler: "",
        description: "MCP",
        parameters: {},
        source: "mcp" as const,
        readOnly: true,
      },
    ],
  ]);
  expect([
    ...filterCapabilities(tools, {
      allowedReadPaths: ["Public"],
      allowUnsafeLua: true,
    }).keys(),
  ]).toEqual(["read_note", "search_notes"]);
  expect(filterCapabilities(tools).has("eval_lua")).toBe(false);
  expect(
    filterCapabilities(tools, { allowUnsafeLua: true }).has("eval_lua"),
  ).toBe(true);
  expect(isPathAllowed("Public-secret/Note", ["Public"])).toBe(false);
  expect(isPathAllowed("Public/../Private", ["Public"])).toBe(false);
  expect(isPathAllowed("Public/Note", [])).toBe(false);
});

test("research subagents have separate context, restricted tools and inherited paths", async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async ({ tools, prompt }) => {
      expect(
        tools?.map((t) => (t.type === "function" ? t.name : "")).sort(),
      ).toEqual(["read_note", "search_notes"]);
      expect(JSON.stringify(prompt)).not.toContain("Parent secret context");
      if (++calls === 1)
        return {
          ...answer(""),
          content: [
            {
              type: "tool-call",
              toolCallId: "read-1",
              toolName: "read_note",
              input: '{"page":"Private/Note"}',
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
        };
      expect(JSON.stringify(prompt)).toContain("Read access denied");
      return answer("The requested note is outside the allowed paths.");
    },
  });
  const tool = researchTool({
    model,
    permissions: { allowedReadPaths: ["Public"] },
  });
  const output = await tool.execute!(
    { task: "Research Private/Note" },
    {
      context: {},
      toolCallId: "research-1",
      messages: [{ role: "user", content: "Parent secret context" }],
      abortSignal: new AbortController().signal,
    },
  );
  expect(output).toContain("outside the allowed paths");
});

test("native note reads enforce ranges and limits", async () => {
  await syscall(
    "mock.setPage",
    "Public/Long",
    Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
  const read = buildReadNoteTool();
  const result = await read.execute!(
    { page: "Public/Long", startLine: 30, endLine: 32 },
    { allowedReadPaths: ["Public"] },
  );
  expect(JSON.parse(result.result!)).toMatchObject({
    startLine: 30,
    endLine: 32,
    content: "30: line 30\n31: line 31\n32: line 32",
    truncated: true,
  });
});

test("binary attachments are retained without treating base64 bytes as text tokens", async () => {
  const model = new MockLanguageModelV3({ doGenerate: answer("unused") });
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "image/png",
          data: "data:image/png;base64," + "YQ==".repeat(20000),
        },
      ],
    },
  ];
  expect(
    await createContextManager({ model, maxChars: 8000 })(messages),
  ).toEqual(messages);
  expect(model.doGenerateCalls).toHaveLength(0);
});

test("checkpoint failure prevents all writes in the model's batch", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: {
      ...answer(""),
      content: ["one", "two"].map((id) => ({
        type: "tool-call" as const,
        toolCallId: id,
        toolName: "edit",
        input: "{}",
      })),
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    },
  });
  const execute = vi.fn(async () => ({ success: true, result: "written" }));
  await expect(
    runAgenticChat({
      provider: provider(model),
      messages: [{ role: "user", content: "Edit" }],
      tools: [
        {
          type: "function",
          function: {
            name: "edit",
            description: "Edit",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      luaTools: new Map([
        ["edit", { handler: "", description: "Edit", parameters: {}, execute }],
      ]),
      onCheckpoint: async () => {
        throw new Error("Storage unavailable");
      },
    }),
  ).rejects.toThrow("Could not persist");
  expect(execute).not.toHaveBeenCalled();
});

test("a failed write stops further tools and cannot be retried by the agent loop", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: {
      ...answer(""),
      content: ["one", "two"].map((id) => ({
        type: "tool-call" as const,
        toolCallId: id,
        toolName: "edit",
        input: "{}",
      })),
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    },
  });
  const execute = vi.fn(async () => ({
    success: false,
    error: "Write response lost",
  }));
  await expect(
    runAgenticChat({
      provider: provider(model),
      messages: [{ role: "user", content: "Edit" }],
      tools: [
        {
          type: "function",
          function: {
            name: "edit",
            description: "Edit",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      luaTools: new Map([
        ["edit", { handler: "", description: "Edit", parameters: {}, execute }],
      ]),
    }),
  ).rejects.toThrow("Verify its outcome");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(model.doGenerateCalls).toHaveLength(1);
});

test("long tool loops compact completed steps while keeping the user request and latest pair", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: answer("Prior searches found useful evidence."),
  });
  const request: ModelMessage = {
    role: "user",
    content: "Research, but do not modify anything",
  };
  const call = (id: string): ModelMessage => ({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "search_notes",
        input: {},
      },
    ],
  });
  const result = (id: string, value: string): ModelMessage => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "search_notes",
        output: { type: "text", value },
      },
    ],
  });
  const messages = [
    request,
    call("old"),
    result("old", "x".repeat(9000)),
    call("latest"),
    result("latest", "Latest result"),
  ];
  const compacted = await createContextManager({ model, maxChars: 8000 })(
    messages,
  );
  expect(compacted).toContainEqual(request);
  expect(compacted.slice(-2)).toEqual(messages.slice(-2));
  expect(JSON.stringify(compacted)).not.toContain('"toolCallId":"old"');
});
