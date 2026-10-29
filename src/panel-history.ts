import { clientStore } from "@silverbulletmd/silverbullet/syscalls";
import type { ModelMessage } from "ai";
import { interruptedMessages, type RunCheckpoint } from "./execution.ts";

export const CHAT_HISTORY_KEY = "ai.panelChatHistory.sdk.v1";
export type PanelHistory = {
  id: string;
  messages: ModelMessage[];
  scope?: string;
  run?: {
    id: string;
    status: "streaming" | "complete" | "error" | "cancelled" | "interrupted";
    inFlight?: RunCheckpoint["inFlight"];
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
): Promise<void> {
  return serial(() =>
    clientStore.set(CHAT_HISTORY_KEY, {
      id,
      messages,
      scope,
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
      id,
      scope: stored.scope,
      messages: checkpoint.messages,
      run: { id: runId, status, inFlight: checkpoint.inFlight, error },
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
        status:
          stored.run.status === "streaming" ? "interrupted" : stored.run.status,
      };
      await clientStore.set(CHAT_HISTORY_KEY, stored);
    }
    return stored;
  });
}
export function clearPanelHistory(id: string): Promise<void> {
  return serial(() => clientStore.set(CHAT_HISTORY_KEY, { id, messages: [] }));
}
