import { expect, test } from "vitest";
import "./mocks/syscalls.ts";
import { syscall } from "@silverbulletmd/silverbullet/syscalls";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import {
  configureSelectedModel,
  currentModel,
  initializeOpenAI,
  modelSupportsTools,
  parseDefaultModelString,
} from "./init.ts";
import { runAgenticChat, runStreamingAgenticChat } from "./tools.ts";
import { SDKProvider } from "./providers/sdk.ts";
import type { Tool, LuaToolDefinition } from "./types.ts";
const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};
const finishReason = { unified: "stop" as const, raw: "stop" };
const testTools: Tool[] = [
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read a note",
      parameters: { type: "object", properties: {} },
    },
  },
];

async function setup(model: MockLanguageModelV3) {
  await syscall("mock.setConfig", "ai", {
    providers: { ollama: { baseUrl: "http://localhost:11434/v1" } },
  });
  await initializeOpenAI(false);
  const provider = (await configureSelectedModel(
    parseDefaultModelString("ollama:gemma3:12b")!,
  )) as SDKProvider;
  Object.defineProperty(provider, "languageModel", { value: model });
  return provider;
}

test("SDK tool loop falls back when the model rejects tools", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async ({ tools }) => {
      if (tools?.length) throw new Error("Model does not support tools");
      return {
        content: [{ type: "text", text: "answer without tools" }],
        finishReason,
        usage,
        warnings: [],
      };
    },
  });
  const result = await runAgenticChat({
    messages: [{ role: "user", content: "Summarise Note" }],
    tools: testTools,
    luaTools: new Map(),
    provider: await setup(model),
  });
  expect(result.finalResponse).toBe("answer without tools");
  expect(model.doGenerateCalls).toHaveLength(2);
  expect(currentModel.supportsTools).toBe(false);
  expect(modelSupportsTools()).toBe(false);
});

test("SDK streaming tool loop falls back when the model rejects tools", async () => {
  const model = new MockLanguageModelV3({
    doStream: async ({ tools }) => {
      if (tools?.length) throw new Error("Model does not support tools");
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text" },
            { type: "text-delta", id: "text", delta: "answer streamed" },
            { type: "text-end", id: "text" },
            { type: "finish", finishReason, usage },
          ],
        }),
      };
    },
  });
  let streamed = "";
  const result = await runStreamingAgenticChat({
    messages: [{ role: "user", content: "hello" }],
    tools: testTools,
    luaTools: new Map(),
    provider: await setup(model),
    onChunk: (chunk) => {
      streamed += chunk;
    },
  });
  expect(result.finalResponse).toBe("answer streamed");
  expect(streamed).toBe("answer streamed");
});

test("SDK executes permitted tools and sends their results back to the model", async () => {
  let executions = 0;
  const model = new MockLanguageModelV3({
    doGenerate: [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_note",
            input: "{}",
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "Final answer" }],
        finishReason,
        usage,
        warnings: [],
      },
    ],
  });
  const luaTools = new Map<string, LuaToolDefinition>([
    [
      "read_note",
      {
        handler: "",
        description: "Read",
        parameters: {},
        readOnly: true,
        execute: async () => {
          executions++;
          return { success: true, result: "Note contents" };
        },
      },
    ],
  ]);
  const result = await runAgenticChat({
    messages: [{ role: "user", content: "hello" }],
    tools: testTools,
    luaTools,
    provider: await setup(model),
  });
  expect(executions).toBe(1);
  expect(result.finalResponse).toBe("Final answer");
  expect(result.usage?.total_tokens).toBe(10);
  expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain(
    "Note contents",
  );
});

test("SDK does not retry unrelated errors", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("HTTP error 500: boom");
    },
  });
  await expect(
    runAgenticChat({
      messages: [{ role: "user", content: "hello" }],
      tools: testTools,
      luaTools: new Map(),
      provider: await setup(model),
    }),
  ).rejects.toThrow("HTTP error 500");
  expect(model.doGenerateCalls).toHaveLength(1);
});

test("SDK rejects invalid tool inputs before executing a note tool", async () => {
  let executions = 0;
  const model = new MockLanguageModelV3({
    doGenerate: [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "bad",
            toolName: "read_note",
            input: '{"page":123}',
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "Invalid input handled" }],
        finishReason,
        usage,
        warnings: [],
      },
    ],
  });
  const tools: Tool[] = [
    {
      type: "function",
      function: {
        name: "read_note",
        description: "Read",
        parameters: {
          type: "object",
          properties: { page: { type: "string" } },
          required: ["page"],
        },
      },
    },
  ];
  const luaTools = new Map<string, LuaToolDefinition>([
    [
      "read_note",
      {
        handler: "",
        description: "Read",
        parameters: {},
        readOnly: true,
        execute: async () => {
          executions++;
          return { success: true, result: "Should not execute" };
        },
      },
    ],
  ]);
  await runAgenticChat({
    messages: [{ role: "user", content: "hello" }],
    tools,
    luaTools,
    provider: await setup(model),
    maxIterations: 2,
  });
  expect(executions).toBe(0);
});

test("SDK tool loop preserves note path permissions", async () => {
  let executions = 0;
  const model = new MockLanguageModelV3({
    doGenerate: [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "denied",
            toolName: "read_note",
            input: '{"page":"Private/Secret"}',
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "Access denied" }],
        finishReason,
        usage,
        warnings: [],
      },
    ],
  });
  const luaTools = new Map<string, LuaToolDefinition>([
    [
      "read_note",
      {
        handler: "",
        description: "Read",
        parameters: {},
        readOnly: true,
        readPathParam: "page",
        execute: async () => {
          executions++;
          return { success: true, result: "Private contents" };
        },
      },
    ],
  ]);
  const result = await runAgenticChat({
    messages: [{ role: "user", content: "hello" }],
    tools: testTools,
    luaTools,
    provider: await setup(model),
    permissions: { allowedReadPaths: ["Public/"] },
  });
  expect(executions).toBe(0);
  expect(result.finalResponse).toBe("Access denied");
  expect(JSON.stringify(model.doGenerateCalls[1].prompt)).not.toContain(
    "Private contents",
  );
});

test("SDK stops at the configured tool step limit", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [
        {
          type: "tool-call",
          toolCallId: "call",
          toolName: "read_note",
          input: "{}",
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage,
      warnings: [],
    },
  });
  const luaTools = new Map<string, LuaToolDefinition>([
    [
      "read_note",
      {
        handler: "",
        description: "Read",
        parameters: {},
        readOnly: true,
        execute: async () => ({ success: true, result: "Note contents" }),
      },
    ],
  ]);
  const result = await runAgenticChat({
    messages: [{ role: "user", content: "hello" }],
    tools: testTools,
    luaTools,
    provider: await setup(model),
    maxIterations: 2,
  });
  expect(model.doGenerateCalls).toHaveLength(2);
  expect(result.finalResponse).toContain("Maximum tool iterations reached");
});

test("native multipart history retains attachments and provider metadata", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text", text: "Continued" }],
      finishReason,
      usage,
      warnings: [],
    },
  });
  const history: import("ai").ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Read these" },
        {
          type: "file",
          data: "data:image/png;base64,YQ==",
          mediaType: "image/png",
        },
        {
          type: "file",
          data: "data:application/pdf;base64,Yg==",
          mediaType: "application/pdf",
          filename: "report.pdf",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Thinking",
          providerOptions: { google: { thoughtSignature: "signature" } },
        },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read_note",
          input: { page: "Note" },
          providerOptions: { google: { thoughtSignature: "tool-signature" } },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read_note",
          output: { type: "json", value: { content: "Full note" } },
        },
      ],
    },
    { role: "user", content: "Continue" },
  ];
  const saved = JSON.parse(JSON.stringify(history));
  const result = await runAgenticChat({
    messages: saved,
    provider: await setup(model),
    tools: [],
    luaTools: new Map(),
  });
  expect(result.messages.slice(0, -1)).toEqual(history);
  expect(result.messages.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "Continued" }],
  });
  const prompt = model.doGenerateCalls[0].prompt;
  expect(prompt[0].content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "file", mediaType: "image/png" }),
      expect.objectContaining({ type: "file", mediaType: "application/pdf" }),
    ]),
  );
  expect(prompt[1].content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "reasoning",
        providerOptions: { google: { thoughtSignature: "signature" } },
      }),
      expect.objectContaining({
        type: "tool-call",
        providerOptions: { google: { thoughtSignature: "tool-signature" } },
      }),
    ]),
  );
});
