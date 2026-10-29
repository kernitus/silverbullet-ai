import { afterEach, expect, test, vi } from "vitest";
import "../mocks/syscalls.ts";
import "../init.ts";
import { SDKProvider, SDKEmbeddingProvider, SDKImageProvider } from "./sdk.ts";
import { toModelMessages } from "./messages.ts";

const connection = {
  provider: "openai",
  apiKey: "test-key",
  baseUrl: "https://api.openai.com/v1",
  requireAuth: true,
  useProxy: false,
  timeout: 1000,
};
const user = [{ role: "user" as const, content: "hello" }];
const reply = (content: string) => ({
  id: "chat-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
afterEach(() => vi.unstubAllGlobals());

test("SDK chat sends messages and reports usage", async () => {
  const fetch = vi.fn().mockResolvedValue(json(reply("hello back")));
  vi.stubGlobal("fetch", fetch);
  const result = await new SDKProvider(connection, "gpt-4o").chat(user);
  expect(result.content).toBe("hello back");
  expect(result.usage).toEqual({
    prompt_tokens: 3,
    completion_tokens: 2,
    total_tokens: 5,
  });
  expect(fetch.mock.calls[0][0]).toBe(
    "https://api.openai.com/v1/chat/completions",
  );
  expect(JSON.parse(fetch.mock.calls[0][1].body).messages).toEqual(user);
});

test("SDK chat surfaces provider errors, including errors inside a successful HTTP response", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        json({
          error: { message: "Rate limited", type: "rate_limit", code: "429" },
        }),
      ),
  );
  await expect(
    new SDKProvider(connection, "gpt-4o").chat(user),
  ).rejects.toThrow();
});

test("SDK streaming emits text, usage and completion exactly once", async () => {
  const chunks =
    [
      {
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Hello" },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { content: " world" }, finish_reason: "stop" },
        ],
      },
      {
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ]
      .map(
        (chunk) =>
          `data: ${JSON.stringify({ id: "chat-1", created: 1, model: "gpt-4o", ...chunk })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n";
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(chunks, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
  );
  const onChunk = vi.fn();
  const onComplete = vi.fn();
  const result = await new SDKProvider(connection, "gpt-4o").streamChat({
    messages: user,
    onChunk,
    onComplete,
  });
  expect(onChunk.mock.calls.flat().join("")).toBe("Hello world");
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(result.usage?.total_tokens).toBe(5);
});

test("SDK structured output uses the supplied JSON schema", async () => {
  const fetch = vi.fn().mockResolvedValue(json(reply('{"title":"Note"}')));
  vi.stubGlobal("fetch", fetch);
  await new SDKProvider(connection, "gpt-4o").chat(user, [], {
    type: "json_schema",
    json_schema: {
      name: "title",
      schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    },
  });
  expect(JSON.parse(fetch.mock.calls[0][1].body).response_format.type).toBe(
    "json_schema",
  );
});

test("SDK Gemini keeps system instructions separate and carries tool thought signatures", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: { name: "read_note", args: { page: "Note" } },
                  thoughtSignature: "signature",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 2,
          totalTokenCount: 5,
        },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const provider = new SDKProvider(
    { ...connection, provider: "gemini", baseUrl: "https://example.com" },
    "gemini-2.5-flash",
  );
  const result = await provider.chat(
    [{ role: "system", content: "Instructions" }, ...user],
    [
      {
        type: "function",
        function: {
          name: "read_note",
          description: "Read",
          parameters: {
            type: "object",
            properties: { page: { type: "string" } },
          },
        },
      },
    ],
  );
  const request = JSON.parse(fetch.mock.calls[0][1].body);
  expect(request.systemInstruction.parts[0].text).toBe("Instructions");
  expect(result.tool_calls?.[0].providerOptions).toBeDefined();
});

test("message conversion keeps images, documents and tool metadata", () => {
  const messages = toModelMessages([
    {
      role: "user",
      content: "Attachments",
      attachments: [
        {
          name: "cat.png",
          type: "image",
          binary: { mimeType: "image/png", url: "data:image/png;base64,YQ==" },
        },
        {
          name: "report.pdf",
          type: "document",
          binary: {
            mimeType: "application/pdf",
            url: "data:application/pdf;base64,YQ==",
          },
        },
      ],
    },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "read_note", arguments: "{}" },
          providerOptions: { google: { thoughtSignature: "signature" } },
        },
      ],
    },
  ]);
  expect(messages[0].content).toMatchObject([
    { type: "text" },
    { type: "image", mediaType: "image/png" },
    { type: "file", filename: "report.pdf" },
  ]);
  expect(messages[1].content[0]).toMatchObject({
    type: "tool-call",
    providerOptions: { google: { thoughtSignature: "signature" } },
  });
});

test("SDK batches embeddings through the configured endpoint", async () => {
  const fetch = vi.fn().mockResolvedValue(
    json({
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 1, embedding: [0, 1] },
      ],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(
    await new SDKEmbeddingProvider(
      connection,
      "text-embedding-3-small",
    )._generateEmbeddingsBatch(["one", "two"]),
  ).toEqual([
    [1, 0],
    [0, 1],
  ]);
  expect(JSON.parse(fetch.mock.calls[0][1].body).input).toEqual(["one", "two"]);
});

test("SDK image generation preserves the SilverBullet image result format", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(json({ created: 1, data: [{ b64_json: "YQ==" }] })),
  );
  const provider = new SDKImageProvider(
    { ...connection, provider: "dalle" },
    "dall-e-3",
  );
  expect(
    await provider.generateImage({
      prompt: "A cat",
      numImages: 1,
      size: "1024x1024",
      quality: "standard",
    }),
  ).toEqual({ data: [{ b64_json: "YQ==" }] });
});

test("SDK streaming errors reject without a completion callback", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        json(
          { error: { message: "Unauthorised", type: "auth", code: "401" } },
          401,
        ),
      ),
  );
  const onComplete = vi.fn();
  await expect(
    new SDKProvider(connection, "gpt-4o").streamChat({
      messages: user,
      onComplete,
    }),
  ).rejects.toThrow();
  expect(onComplete).not.toHaveBeenCalled();
});
