// Transport snapshots contain SDK UI messages plus SilverBullet run state.
// Only one delivery can be outstanding; slow frames receive the newest state
// after acknowledging it, rather than an accumulating queue of token events.
export interface PushChannel {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
}
export function createPanelPush<T>(
  snapshot: () => T,
  createChannel: (name: string) => PushChannel = (name) =>
    new BroadcastChannel(name),
) {
  let connection: PushChannel | undefined;
  let sequence = 0;
  let pending: number | undefined;
  let dirty = false;
  let ready = false;
  function flush() {
    if (!connection || !ready || pending !== undefined || !dirty) return;
    pending = sequence;
    dirty = false;
    try {
      connection.postMessage({ sequence, state: snapshot() });
    } catch {
      close();
    }
  }
  function close() {
    if (connection) {
      connection.onmessage = null;
      connection.close();
    }
    connection = undefined;
    pending = undefined;
    ready = false;
  }
  return {
    connect() {
      close();
      const name = `silverbullet-ai-panel-${crypto.randomUUID()}`;
      const channel = createChannel(name);
      connection = channel;
      dirty = true;
      channel.onmessage = ({ data }) => {
        if (connection !== channel || !data || typeof data !== "object") return;
        if (data.type === "ready") {
          ready = true;
          pending = undefined;
          dirty = true;
        } else if (data.type === "ack" && data.sequence === pending)
          pending = undefined;
        else if (data.type === "close") {
          close();
          return;
        } else return;
        flush();
      };
      return { channel: name };
    },
    changed() {
      sequence++;
      dirty = true;
      flush();
    },
    close,
  };
}
