import {
  toUIMessageStream,
  readUIMessageStream,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
} from "ai";

export const LIVE_PREVIEW_CHARS = 256 * 1024;
export const LIVE_PREVIEW_EVENTS = 4096;

export async function consumeAgentStream(
  stream: ReadableStream<TextStreamPart<ToolSet>>,
  options: {
    onChunk?: (text: string) => void;
    onReasoningChunk?: (text: string) => void;
    onPreview?: (message: UIMessage) => void;
    onPreviewLimited?: () => void;
  },
): Promise<string> {
  let reasoning = "";
  const tapped = stream.pipeThrough(
    new TransformStream({
      transform(part, controller) {
        if (part.type === "error") throw part.error;
        if (part.type === "text-delta") options.onChunk?.(part.text);
        else if (part.type === "reasoning-delta") {
          // Only callers that use the separate reasoning result need another copy.
          if (!options.onPreview) reasoning += part.text;
          options.onReasoningChunk?.(part.text);
        }
        controller.enqueue(part);
      },
    }),
  );
  if (!options.onPreview) {
    const reader = tapped.getReader();
    try {
      while (!(await reader.read()).done) {
        /* Consume SDK output. */
      }
    } finally {
      reader.releaseLock();
    }
    return reasoning;
  }
  let chars = 0;
  let events = 0;
  let limited = false;
  const bounded = toUIMessageStream({
    stream: tapped,
    sendReasoning: true,
  }).pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (limited) return;
        chars += JSON.stringify(chunk).length;
        if (chars > LIVE_PREVIEW_CHARS || ++events > LIVE_PREVIEW_EVENTS) {
          limited = true;
          options.onPreviewLimited?.();
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  // Continue consuming the model even if the live preview reaches its limit.
  // Final SDK history is saved by the normal execution checkpoint lifecycle.
  for await (const message of readUIMessageStream({
    stream: bounded,
    terminateOnError: true,
  })) {
    options.onPreview(message);
  }
  return reasoning;
}
