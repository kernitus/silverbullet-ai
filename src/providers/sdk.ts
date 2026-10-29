import {
  generateText,
  streamText,
  embedMany,
  generateImage,
  Output,
  jsonSchema,
  type LanguageModel,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { AbstractProvider } from "../interfaces/Provider.ts";
import { AbstractEmbeddingProvider } from "../interfaces/EmbeddingProvider.ts";
import { AbstractImageProvider } from "../interfaces/ImageProvider.ts";
import { sdkFetch } from "../proxy.ts";
import type {
  ChatMessage,
  ChatResponse,
  StreamChatOptions,
  Tool,
  ImageGenerationOptions,
} from "../types.ts";
import {
  ModelCatalog,
  googleBaseUrl,
  type ProviderConnection,
} from "./catalog.ts";
import { toSDKTools, toUsage } from "./messages.ts";

function sdkProvider(connection: ProviderConnection) {
  const c = connection;
  const settings = {
    apiKey: c.apiKey,
    baseURL: c.baseUrl.replace(/\/$/, ""),
    fetch: sdkFetch(c.useProxy, c.timeout, c.provider),
  };
  if (c.provider === "gemini")
    return createGoogleGenerativeAI({
      ...settings,
      baseURL: googleBaseUrl(c.baseUrl),
    });
  if (c.provider === "mistral") return createMistral(settings);
  if (
    c.provider === "openai" &&
    (c.api === "responses" || new URL(c.baseUrl).hostname === "api.openai.com")
  )
    return createOpenAI(settings);
  if (c.provider === "dalle") return createOpenAI(settings);
  return createOpenAICompatible({
    ...settings,
    apiKey: c.requireAuth ? c.apiKey : undefined,
    baseURL:
      c.provider === "ollama"
        ? `${c.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "")}/v1`
        : settings.baseURL,
    name: c.provider,
    includeUsage: true,
    supportsStructuredOutputs: true,
  });
}

export class SDKProvider extends AbstractProvider {
  readonly languageModel: LanguageModel;
  private readonly catalog: ModelCatalog;
  readonly api: "responses" | "chat" | "native";

  constructor(
    private readonly connection: ProviderConnection,
    modelName: string,
  ) {
    super(
      connection.provider,
      connection.apiKey,
      connection.baseUrl,
      modelName,
      connection.useProxy,
      connection.timeout,
    );
    if (
      connection.api !== undefined &&
      connection.api !== "responses" &&
      connection.api !== "chat"
    )
      throw new Error('Provider api must be "responses" or "chat".');
    if (connection.api && connection.provider !== "openai")
      throw new Error(
        'The api setting applies to OpenAI and OpenAI-compatible providers (provider = "openai").',
      );
    const provider = sdkProvider(connection);
    this.api =
      connection.provider === "openai"
        ? (connection.api ??
          (new URL(connection.baseUrl).hostname === "api.openai.com"
            ? "responses"
            : "chat"))
        : "chat" in provider
          ? "chat"
          : "native";
    this.languageModel =
      this.api === "responses" && "responses" in provider
        ? provider.responses(modelName)
        : "chat" in provider
          ? provider.chat(modelName)
          : provider.languageModel(modelName);
    this.catalog = new ModelCatalog(connection);
  }

  get providerOptions(): import("../types.ts").ProviderOptions | undefined {
    if (this.api === "responses")
      return {
        openai: {
          // Conversations live in SilverBullet. The SDK replays items between tool steps.
          store: false,
          ...(this.reasoningEffort
            ? { reasoningEffort: this.reasoningEffort }
            : {}),
        },
      };
    if (!this.reasoningEffort) return undefined;
    return this.connection.provider === "gemini"
      ? {
          google: {
            thinkingConfig: {
              thinkingLevel: this.reasoningEffort,
              includeThoughts: true,
            },
          },
        }
      : {
          [this.connection.provider]: { reasoningEffort: this.reasoningEffort },
        };
  }

  private options(
    messages: ChatMessage[],
    tools?: Tool[],
    format?: StreamChatOptions["response_format"],
  ) {
    return {
      model: this.languageModel,
      messages,
      tools: toSDKTools(tools),
      providerOptions: this.providerOptions,
      maxRetries: 0,
      allowSystemInMessages: true,
      ...(format?.type === "json_schema"
        ? {
            output: Output.object({
              schema: jsonSchema(format.json_schema.schema),
              name: format.json_schema.name,
            }),
          }
        : format?.type === "json_object"
          ? { output: Output.json() }
          : {}),
    };
  }

  async chat(
    messages: ChatMessage[],
    tools?: Tool[],
    format?: StreamChatOptions["response_format"],
  ): Promise<ChatResponse> {
    const result = await generateText(this.options(messages, tools, format));
    return this.response(result);
  }

  async streamChat(options: StreamChatOptions): Promise<ChatResponse> {
    const result = streamText({
      ...this.options(options.messages, options.tools, options.response_format),
      abortSignal: options.abortSignal,
    });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") options.onChunk?.(part.text);
      else if (part.type === "reasoning-delta")
        options.onReasoningChunk?.(part.text);
      else if (part.type === "error") throw part.error;
    }
    const response = this.response({
      text: await result.text,
      reasoningText: await result.reasoningText,
      toolCalls: await result.toolCalls,
      finishReason: await result.finishReason,
      usage: await result.usage,
    });
    await options.onComplete?.(response);
    return response;
  }

  private response(
    result: Pick<
      Awaited<ReturnType<typeof generateText>>,
      "text" | "reasoningText" | "toolCalls" | "finishReason" | "usage"
    >,
  ): ChatResponse {
    return {
      content: result.text,
      reasoning: result.reasoningText,
      tool_calls: result.toolCalls.length
        ? result.toolCalls.map((call) => ({
            id: call.toolCallId,
            type: "function",
            function: {
              name: call.toolName,
              arguments: JSON.stringify(call.input),
            },
            providerOptions: call.providerMetadata,
          }))
        : undefined,
      finish_reason:
        result.finishReason === "tool-calls"
          ? "tool_calls"
          : result.finishReason === "length"
            ? "length"
            : "stop",
      usage: toUsage(result.usage),
    };
  }

  listModels() {
    return this.catalog.listModels();
  }
  override getModelCapabilities(model = this.modelName) {
    return this.catalog.getModelCapabilities(model);
  }
  override getContextLimit(model = this.modelName) {
    return this.catalog.getContextLimit(model);
  }
}

export class SDKEmbeddingProvider extends AbstractEmbeddingProvider {
  private readonly model;
  constructor(connection: ProviderConnection, modelName: string) {
    super(
      connection.apiKey,
      connection.baseUrl,
      connection.provider,
      modelName,
      connection.requireAuth,
      connection.useProxy,
      connection.timeout,
    );
    this.model = sdkProvider(connection).embeddingModel(modelName);
  }
  async _generateEmbeddings({
    text,
    abortSignal,
  }: {
    text: string;
    abortSignal?: AbortSignal;
  }) {
    return (await this._generateEmbeddingsBatch([text], abortSignal))[0];
  }
  override async _generateEmbeddingsBatch(
    texts: string[],
    abortSignal?: AbortSignal,
  ) {
    if (!texts.length) return [];
    return (
      await embedMany({
        model: this.model,
        values: texts,
        abortSignal,
        maxRetries: 0,
        maxParallelCalls: 1,
      })
    ).embeddings;
  }
}

export class SDKImageProvider extends AbstractImageProvider {
  private readonly model;
  constructor(connection: ProviderConnection, modelName: string) {
    super(
      connection.apiKey,
      connection.baseUrl,
      connection.provider,
      modelName,
      connection.requireAuth,
      connection.useProxy,
      connection.timeout,
    );
    this.model = sdkProvider(connection).imageModel(modelName);
  }
  async generateImage(options: ImageGenerationOptions) {
    const quality = this.modelName.startsWith("gpt-image")
      ? options.quality === "hd"
        ? "high"
        : "medium"
      : options.quality;
    const result = await generateImage({
      model: this.model,
      prompt: options.prompt,
      n: options.numImages,
      size: options.size,
      providerOptions: { openai: { quality } },
      maxRetries: 0,
    });
    return { data: result.images.map((image) => ({ b64_json: image.base64 })) };
  }
}
