import { expect, test } from "vitest";
import "./mocks/syscalls.ts";
import { MockLanguageModelV3 } from "ai/test";
import type { ModelMessage } from "ai";
import { standardContextLimit } from "./model-metadata.ts";
import { createContextManager } from "./context.ts";

const model = () =>
  new MockLanguageModelV3({
    doGenerate: {
      content: [
        {
          type: "text",
          text: "Search completed. Retain the evidence and answer the user's question.",
        },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 20, text: 20, reasoning: 0 },
      },
      warnings: [],
    },
  });

test("standard context excludes long-context pricing tiers and output limits", () => {
  expect(
    standardContextLimit({
      max_input_tokens: 1048576,
      input_cost_per_token_above_272k_tokens: 0.001,
    }),
  ).toBe(272000);
  expect(
    standardContextLimit({
      max_input_tokens: 1000000,
      input_cost_per_token_above_200k_tokens: 0.001,
    }),
  ).toBe(200000);
  expect(
    standardContextLimit({ max_input_tokens: 128000, max_tokens: 16384 }),
  ).toBe(128000);
  expect(standardContextLimit({ max_tokens: 8192 })).toBeNull();
});

test("normal large requests no longer hit a 60000-character default ceiling", async () => {
  const llm = model();
  const messages: ModelMessage[] = [
    { role: "user", content: "A useful note. ".repeat(6000) },
  ];
  expect(
    await createContextManager({ model: llm, contextWindow: 128000 })(messages),
  ).toBe(messages);
  expect(llm.doGenerateCalls).toHaveLength(0);
});

test("provider usage triggers compaction at 90% of standard context", async () => {
  const llm = model();
  const prepare = createContextManager({ model: llm, contextWindow: 8000 });
  const messages: ModelMessage[] = [
    { role: "user", content: "Earlier discussion. ".repeat(1500) },
    { role: "assistant", content: "Finished" },
    { role: "user", content: "Continue" },
  ];
  await prepare(messages);
  prepare.observeUsage(7199);
  expect(await prepare(messages)).toBe(messages);
  prepare.observeUsage(7200);
  expect(await prepare(messages)).not.toBe(messages);
  expect(llm.doGenerateCalls.length).toBeGreaterThan(0);
});

test("a single large completed tool batch can be compacted without orphaning calls", async () => {
  const llm = model();
  const request: ModelMessage = {
    role: "user",
    content: "Find notes about college",
  };
  const calls: ModelMessage = {
    role: "assistant",
    content: ["a", "b"].map((toolCallId) => ({
      type: "tool-call",
      toolCallId,
      toolName: "search_notes",
      input: { query: "college" },
    })),
  };
  const results: ModelMessage = {
    role: "tool",
    content: ["a", "b"].map((toolCallId) => ({
      type: "tool-result",
      toolCallId,
      toolName: "search_notes",
      output: { type: "text", value: "A college note. ".repeat(700) },
    })),
  };
  const compacted = await createContextManager({ model: llm, maxChars: 8000 })([
    request,
    calls,
    results,
  ]);
  expect(compacted).toContainEqual(request);
  expect(compacted.some((message) => message.role === "tool")).toBe(false);
  expect(JSON.stringify(compacted)).toContain("Search completed");
});
