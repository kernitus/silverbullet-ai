import type { ChatScope } from "./chat-scope.ts";
import { clientStore } from "@silverbulletmd/silverbullet/syscalls";
import type { ModelMessage } from "ai";
import { interruptedMessages, type RunCheckpoint } from "./execution.ts";

export const CHAT_HISTORY_KEY = "ai.panelChatHistory.sdk.v1";
export type RunInstruction = {
  id: string;
  text: string;
  status: "queued" | "delivered" | "not-delivered";
  reason?: string;
};

export type PanelHistory = {
  id: string;
  messages: ModelMessage[];
  scope?: string;
  chatScope?: ChatScope;
  compaction?: import("./context.ts").CompactionState;
  run?: {
    id: string;
    status: "streaming" | "complete" | "error" | "cancelled" | "interrupted";
    inFlight?: RunCheckpoint["inFlight"];
    instructions?: RunInstruction[];
    error?: string;
  };
};
let writes = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.then(operation);
  writes = next.then(
    () => {},
    () => {},
  );
  return next;
}
export function beginPanelTurn(
  id: string,
  runId: string,
  messages: ModelMessage[],
  scope?: string,
  compaction?: import("./context.ts").CompactionState,
  chatScope?: ChatScope,
): Promise<void> {
  return serial(() =>
    clientStore.set(CHAT_HISTORY_KEY, {
      id,
      messages,
      scope,
      chatScope,
      compaction,
      run: { id: runId, status: "streaming" },
    }),
  );
}
export function savePanelCheckpoint(
  id: string,
  runId: string,
  checkpoint: RunCheckpoint,
  status: NonNullable<PanelHistory["run"]>["status"] = "streaming",
  error?: string,
): Promise<void> {
  return serial(async () => {
    const stored = (await clientStore.get(CHAT_HISTORY_KEY)) as
      | PanelHistory
      | undefined;
    if (
      stored?.id !== id ||
      stored.run?.id !== runId ||
      stored.run.status !== "streaming"
    )
      return;
    await clientStore.set(CHAT_HISTORY_KEY, {
      ...stored,
      id,
      scope: stored.scope,
      messages: checkpoint.messages,
      run: {
        ...stored.run,
        id: runId,
        status,
        inFlight: checkpoint.inFlight,
        error,
      },
    });
  });
}
export function loadPanelHistory(
  isActive: (id: string) => boolean,
): Promise<PanelHistory | undefined> {
  return serial(async () => {
    const stored = (await clientStore.get(CHAT_HISTORY_KEY)) as
      | PanelHistory
      | undefined;
    if (!stored?.run || isActive(stored.run.id)) return stored;
    if (stored.run.status === "streaming" || stored.run.inFlight) {
      stored.messages = interruptedMessages({
        messages: stored.messages,
        inFlight: stored.run.inFlight,
      });
      stored.run = {
        ...stored.run,
        inFlight: undefined,
        instructions: stored.run.instructions?.map((instruction) =>
          instruction.status === "queued"
            ? {
                ...instruction,
                status: "not-delivered",
                reason: "Run interrupted before delivery was confirmed",
              }
            : instruction,
        ),
        status:
          stored.run.status === "streaming" ? "interrupted" : stored.run.status,
      };
      await clientStore.set(CHAT_HISTORY_KEY, stored);
    }
    return stored;
  });
}
export function clearPanelHistory(
  id: string,
  chatScope?: ChatScope,
): Promise<void> {
  return serial(() =>
    clientStore.set(CHAT_HISTORY_KEY, { id, messages: [], chatScope }),
  );
}

export function savePanelCompaction(
  id: string,
  runId: string,
  compaction: import("./context.ts").CompactionState,
): Promise<void> {
  return serial(async () => {
    const stored = (await clientStore.get(CHAT_HISTORY_KEY)) as
      | PanelHistory
      | undefined;
    if (
      stored?.id !== id ||
      stored.run?.id !== runId ||
      stored.run.status !== "streaming"
    )
      return;
    await clientStore.set(CHAT_HISTORY_KEY, { ...stored, compaction });
  });
}

// Merge instruction updates inside the same queue as message checkpoints.
export function savePanelInstruction(
  id: string,
  runId: string,
  instruction: RunInstruction,
): Promise<boolean> {
  return serial(async () => {
    const stored = (await clientStore.get(CHAT_HISTORY_KEY)) as
      | PanelHistory
      | undefined;
    if (stored?.id !== id || stored.run?.id !== runId) return false;
    const instructions = [...(stored.run.instructions ?? [])];
    const index = instructions.findIndex((item) => item.id === instruction.id);
    if (index < 0) {
      if (stored.run.status !== "streaming") return false;
      instructions.push(instruction);
    } else instructions[index] = instruction;
    await clientStore.set(CHAT_HISTORY_KEY, {
      ...stored,
      run: { ...stored.run, instructions },
    });
    return true;
  });
}
