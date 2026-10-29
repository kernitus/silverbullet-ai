import { expect, test } from "vitest";
import "./mocks/syscalls.ts";
import {
  beginPanelTurn,
  loadPanelHistory,
  savePanelCheckpoint,
  clearPanelHistory,
} from "./panel-history.ts";

test("reload recovers an interrupted tool exactly once", async () => {
  await beginPanelTurn("chat", "run", [{ role: "user", content: "Edit" }]);
  await savePanelCheckpoint("chat", "run", {
    messages: [{ role: "user", content: "Edit" }],
    inFlight: { toolCallId: "call", toolName: "edit", input: {} },
  });
  expect((await loadPanelHistory(() => true))?.run?.status).toBe("streaming");
  const recovered = await loadPanelHistory(() => false);
  expect(recovered?.run?.status).toBe("interrupted");
  expect(recovered?.messages).toHaveLength(3);
  expect((await loadPanelHistory(() => false))?.messages).toHaveLength(3);
});

test("late checkpoints cannot overwrite a completed turn or a new conversation", async () => {
  await beginPanelTurn("chat", "run", []);
  await savePanelCheckpoint(
    "chat",
    "run",
    { messages: [{ role: "assistant", content: "Saved" }] },
    "cancelled",
  );
  await savePanelCheckpoint("chat", "run", { messages: [] });
  expect((await loadPanelHistory(() => false))?.messages).toHaveLength(1);
  await clearPanelHistory("new");
  await savePanelCheckpoint(
    "chat",
    "run",
    { messages: [{ role: "assistant", content: "Late" }] },
    "complete",
  );
  expect(await loadPanelHistory(() => false)).toEqual({
    id: "new",
    messages: [],
  });
});

test("compaction survives checkpoints and subsequent turns, and rejects stale updates", async () => {
  const { savePanelCompaction } = await import("./panel-history.ts");
  const state = {
    version: 1 as const,
    key: "scope",
    count: 2,
    hash: "digest",
    summary: "Completed work",
  };
  await beginPanelTurn("summary-chat", "first", [], "scope");
  await savePanelCompaction("summary-chat", "first", state);
  await savePanelCheckpoint(
    "summary-chat",
    "first",
    { messages: [] },
    "complete",
  );
  const saved = await loadPanelHistory(() => false);
  expect(saved?.compaction).toEqual(state);
  await beginPanelTurn(
    "summary-chat",
    "second",
    [],
    "scope",
    saved?.compaction,
  );
  await savePanelCompaction("summary-chat", "first", {
    ...state,
    summary: "Stale",
  });
  expect((await loadPanelHistory(() => true))?.compaction).toEqual(state);
});

test("research recovery retains completed evidence exactly once", async () => {
  await beginPanelTurn("research-chat", "research-run", []);
  await savePanelCheckpoint("research-chat", "research-run", {
    messages: [],
    inFlight: {
      toolCallId: "research",
      toolName: "research_notes",
      input: { task: "Find evidence" },
      research: {
        messages: [
          { role: "assistant", content: "Evidence from Public/Note:12" },
        ],
      },
    },
  });
  const recovered = await loadPanelHistory(() => false);
  expect(JSON.stringify(recovered?.messages)).toContain(
    "Evidence from Public/Note:12",
  );
  expect(recovered?.run?.inFlight).toBeUndefined();
  expect((await loadPanelHistory(() => false))?.messages).toEqual(
    recovered?.messages,
  );
});

test("queued instruction receipts survive checkpoints and are marked undelivered on reload", async () => {
  const { savePanelInstruction } = await import("./panel-history.ts");
  await beginPanelTurn("steering-chat", "steering-run", []);
  const instruction = {
    id: "instruction",
    text: "Focus on evidence",
    status: "queued" as const,
  };
  expect(
    await savePanelInstruction("wrong-chat", "steering-run", instruction),
  ).toBe(false);
  expect(
    await savePanelInstruction("steering-chat", "wrong-run", instruction),
  ).toBe(false);
  expect(
    await savePanelInstruction("steering-chat", "steering-run", instruction),
  ).toBe(true);
  await savePanelCheckpoint("steering-chat", "steering-run", { messages: [] });
  expect(
    (await loadPanelHistory(() => true))?.run?.instructions?.[0].status,
  ).toBe("queued");
  expect(
    (await loadPanelHistory(() => false))?.run?.instructions?.[0],
  ).toMatchObject({
    text: "Focus on evidence",
    status: "not-delivered",
  });
  await clearPanelHistory("new-chat");
  expect(
    await savePanelInstruction("steering-chat", "steering-run", {
      ...instruction,
      status: "delivered",
    }),
  ).toBe(false);
  expect((await loadPanelHistory(() => false))?.id).toBe("new-chat");
});
