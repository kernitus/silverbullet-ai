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
  id: "resp-1",
  created_at: 1,
  model: "gpt-4o",
  output: [
    {
      type: "message",
      id: "msg-1",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }],
    },
  ],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
});
const streamReply = (content: string) => {
  const response = reply(content);
  return [
    { type: "response.created", response },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg-1" },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg-1",
      output_index: 0,
      delta: content,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: response.output[0],
    },
    { type: "response.completed", response },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
};
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
  expect(fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
  const request = JSON.parse(fetch.mock.calls[0][1].body);
  expect(request.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "hello" }] },
  ]);
  expect(request.store).toBe(false);
  expect(request.messages).toBeUndefined();
});

test("SDK chat surfaces provider errors, including errors inside a successful HTTP response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
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
  const chunks = streamReply("Hello world");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
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
  expect(JSON.parse(fetch.mock.calls[0][1].body).text.format.type).toBe(
    "json_schema",
  );
});

test("SDK Gemini keeps system instructions separate and carries tool thought signatures", async () => {
  const fetch = vi.fn().mockResolvedValue(
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

test.each(["gpt-4o", "gpt-4.1", "gpt-5", "gpt-6-astra", "o3-pro"])(
  "OpenAI model %s uses Responses by default",
  async (model) => {
    const fetch = vi.fn().mockResolvedValue(json(reply("answer")));
    vi.stubGlobal("fetch", fetch);
    await new SDKProvider(connection, model).chat(user);
    expect(fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe(model);
  },
);

test("a custom OpenAI endpoint can explicitly select Responses", async () => {
  const fetch = vi.fn().mockResolvedValue(json(reply("answer")));
  vi.stubGlobal("fetch", fetch);
  await new SDKProvider(
    { ...connection, baseUrl: "https://gateway.example/v1", api: "responses" },
    "model",
  ).chat(user);
  expect(fetch.mock.calls[0][0]).toBe("https://gateway.example/v1/responses");
});

test.each([
  { ...connection, api: "chat" as const },
  { ...connection, baseUrl: "https://compatible.example/v1" },
])(
  "Chat Completions remains available for an explicitly selected or compatible endpoint",
  async (config) => {
    const fetch = vi.fn().mockResolvedValue(
      json({
        id: "chat-1",
        object: "chat.completion",
        created: 1,
        model: "legacy",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const response = await new SDKProvider(config, "legacy").chat(user);
    expect(response.content).toBe("answer");
    expect(fetch.mock.calls[0][0]).toBe(`${config.baseUrl}/chat/completions`);
  },
);

test("Responses failure never silently retries through Chat Completions", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      json(
        {
          error: {
            message: "Unsupported model",
            type: "invalid_request_error",
            code: "model_not_supported",
          },
        },
        400,
      ),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(
    new SDKProvider(connection, "unknown").chat(user),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
});

test("Responses receives configured reasoning effort", async () => {
  const fetch = vi.fn().mockResolvedValue(json(reply("answer")));
  vi.stubGlobal("fetch", fetch);
  const provider = new SDKProvider(connection, "gpt-5");
  provider.reasoningEffort = "high";
  await provider.chat(user);
  const request = JSON.parse(fetch.mock.calls[0][1].body);
  expect(request.reasoning.effort).toBe("high");
  expect(request.store).toBe(false);
  expect(request.include).toContain("reasoning.encrypted_content");
});

test.each([false, true])(
  "Responses tool loop replays function results and encrypted reasoning (streaming=%s)",
  async (streaming) => {
    const { runAgenticChat, runStreamingAgenticChat } = await import(
      "../tools.ts"
    );
    const reasoning = {
      type: "reasoning",
      id: "rs-1",
      summary: [],
      encrypted_content: "encrypted-reasoning",
    };
    const call = {
      type: "function_call",
      status: "completed",
      id: "fc-1",
      call_id: "call-1",
      name: "read_note",
      arguments: '{"page":"Note"}',
    };
    const firstResponse = { ...reply(""), output: [reasoning, call] };
    const firstStream = [
      { type: "response.created", response: firstResponse },
      { type: "response.output_item.added", output_index: 0, item: reasoning },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...call, arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc-1",
        output_index: 1,
        delta: call.arguments,
      },
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.completed", response: firstResponse },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const sse = (body: string) =>
      new Response(body, { headers: { "content-type": "text/event-stream" } });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(streaming ? sse(firstStream) : json(firstResponse))
      .mockResolvedValueOnce(
        streaming
          ? sse(streamReply("Here is the note"))
          : json(reply("Here is the note")),
      );
    vi.stubGlobal("fetch", fetch);
    const execute = vi
      .fn()
      .mockResolvedValue({ success: true, result: "Note contents" });
    const parameters = {
      type: "object",
      properties: { page: { type: "string" } },
      required: ["page"],
    };
    const onChunk = vi.fn();
    const result = await (streaming ? runStreamingAgenticChat : runAgenticChat)(
      {
        provider: new SDKProvider(connection, "gpt-5"),
        messages: [{ role: "user", content: "Read Note" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read_note",
              description: "Read a note",
              parameters,
            },
          },
        ],
        luaTools: new Map([
          [
            "read_note",
            { description: "Read", handler: "", parameters, execute },
          ],
        ]),
        onChunk,
      },
    );
    expect(result.finalResponse).toBe("Here is the note");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.every(
        (call) => call[0] === "https://api.openai.com/v1/responses",
      ),
    ).toBe(true);
    const request = JSON.parse(fetch.mock.calls[1][1].body);
    expect(request.store).toBe(false);
    expect(request.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          call_id: "call-1",
          name: "read_note",
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call-1",
          output: "Note contents",
        }),
        expect.objectContaining({
          type: "reasoning",
          encrypted_content: "encrypted-reasoning",
        }),
      ]),
    );
    if (streaming)
      expect(onChunk.mock.calls.flat().join("")).toBe("Here is the note");
  },
);
