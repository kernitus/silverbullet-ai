import { Validator, type Schema } from "@cfworker/json-schema";
import { jsonSchema, tool, type ToolSet, type LanguageModelUsage } from "ai";
import type { Tool, Usage } from "../types.ts";

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
