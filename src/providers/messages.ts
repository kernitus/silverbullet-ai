import { Validator, type Schema } from "@cfworker/json-schema";
import {
  jsonSchema,
  tool,
  type ModelMessage,
  type UserModelMessage,
  type ToolSet,
  type LanguageModelUsage,
} from "ai";
import type { ChatMessage, Tool, Usage } from "../types.ts";

// Translate the saved SilverBullet conversation format at the SDK boundary.
export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === "system")
      return { role: "system", content: message.content };
    if (message.role === "tool") {
      if (!message.tool_call_id || !message.name)
        throw new Error("Tool result is missing its call ID or name");
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.tool_call_id,
            toolName: message.name,
            output: { type: "text", value: message.content },
          },
        ],
      };
    }
    if (message.role === "assistant")
      return {
        role: "assistant",
        content: [
          ...(message.content
            ? [{ type: "text" as const, text: message.content }]
            : []),
          ...(message.tool_calls ?? []).map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.function.name,
            input: JSON.parse(call.function.arguments || "{}"),
            providerOptions: call.providerOptions,
          })),
        ],
      };
    const content: Exclude<UserModelMessage["content"], string> = [
      { type: "text", text: message.content },
    ];
    for (const attachment of message.attachments ?? []) {
      if (!attachment.binary) continue;
      const { mimeType, url } = attachment.binary;
      content.push(
        mimeType.startsWith("image/")
          ? { type: "image", image: new URL(url), mediaType: mimeType }
          : {
              type: "file",
              data: new URL(url),
              mediaType: mimeType,
              filename: attachment.name,
            },
      );
    }
    return { role: "user", content };
  });
}

export function toSDKTools(tools: Tool[] = []): ToolSet {
  return Object.fromEntries(
    tools.map(({ function: definition }) => {
      const validator = new Validator(definition.parameters as Schema);
      return [
        definition.name,
        tool({
          description: definition.description,
          inputSchema: jsonSchema<Record<string, unknown>>(
            definition.parameters,
            {
              validate: (value) => {
                const result = validator.validate(value);
                return result.valid
                  ? { success: true, value: value as Record<string, unknown> }
                  : {
                      success: false,
                      error: new Error(
                        result.errors.map((error) => error.error).join("; "),
                      ),
                    };
              },
            },
          ),
        }),
      ];
    }),
  );
}

export function toUsage(usage: LanguageModelUsage): Usage {
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens:
      usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
  };
}
