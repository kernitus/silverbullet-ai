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
