import { expect, test } from "vitest";
import type { TextStreamPart, ToolSet, UIMessage } from "ai";
import {
  consumeAgentStream,
  LIVE_PREVIEW_CHARS,
  LIVE_PREVIEW_EVENTS,
} from "./ui-stream.ts";

function stream(parts: TextStreamPart<ToolSet>[]) {
  return new ReadableStream<TextStreamPart<ToolSet>>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

test("SDK converts streamed text and reasoning to complete UI snapshots in order", async () => {
  const snapshots: UIMessage[] = [];
  await consumeAgentStream(
    stream([
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", text: "Hello " },
      { type: "text-delta", id: "text", text: "world" },
      { type: "text-end", id: "text" },
      { type: "reasoning-start", id: "reason" },
      { type: "reasoning-delta", id: "reason", text: "Evidence" },
      { type: "reasoning-end", id: "reason" },
    ]),
    { onPreview: (snapshot) => snapshots.push(snapshot) },
  );
  expect(snapshots.at(-1)?.parts).toMatchObject([
    { type: "text", text: "Hello world", state: "done" },
    { type: "reasoning", text: "Evidence", state: "done" },
  ]);
  expect(snapshots[1].parts[0]).toMatchObject({ text: "Hello " });
});

test("preview overflow bounds SDK UI state but still consumes all generated output", async () => {
  let latest: UIMessage | undefined;
  let limited = 0;
  let observed = 0;
  const parts: TextStreamPart<ToolSet>[] = [{ type: "text-start", id: "text" }];
  for (let i = 0; i < LIVE_PREVIEW_EVENTS + 100; i++)
    parts.push({ type: "text-delta", id: "text", text: "x".repeat(100) });
  parts.push({ type: "text-end", id: "text" });
  await consumeAgentStream(stream(parts), {
    onPreview: (snapshot) => {
      latest = snapshot;
    },
    onPreviewLimited: () => {
      limited++;
    },
    onChunk: (text) => {
      observed += text.length;
    },
  });
  expect(limited).toBe(1);
  expect(observed).toBe((LIVE_PREVIEW_EVENTS + 100) * 100);
  expect(JSON.stringify(latest).length).toBeLessThan(LIVE_PREVIEW_CHARS);
});

test("SDK stream errors propagate to run recovery", async () => {
  await expect(
    consumeAgentStream(
      stream([{ type: "error", error: new Error("Connection failed") }]),
      {
        onPreview: () => {},
      },
    ),
  ).rejects.toThrow("Connection failed");
});
