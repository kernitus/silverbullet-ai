import type { ModelMessage } from "ai";

const signals = new Map<string, AbortSignal>();
export function registerRun(id: string, signal: AbortSignal): () => void {
  signals.set(id, signal);
  return () => {
    signals.delete(id);
  };
}
export function signalForRun(id?: string): AbortSignal | undefined {
  if (!id) return undefined;
  const signal = signals.get(id);
  if (!signal)
    throw new Error(
      "This tool execution has ended. Propose the edit in a new turn.",
    );
  signal.throwIfAborted();
  return signal;
}
export type PendingTool = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};
export type RunCheckpoint = {
  messages: ModelMessage[];
  inFlight?: PendingTool;
};

export function interruptedMessages(checkpoint: RunCheckpoint): ModelMessage[] {
  const pending = checkpoint.inFlight;
  if (!pending) return checkpoint.messages;
  return [
    ...checkpoint.messages,
    { role: "assistant", content: [{ type: "tool-call", ...pending }] },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          output: {
            type: "error-text",
            value:
              "Execution was interrupted. The operation may already have completed. Do not repeat a write or external action automatically. Verify the current state and ask the user if its outcome cannot be established.",
          },
        },
      ],
    },
  ];
}
