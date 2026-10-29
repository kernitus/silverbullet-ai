import { expect, test } from "vitest";
import { createPanelPush, type PushChannel } from "./panel-push.ts";

class Channel implements PushChannel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: any[] = [];
  closed = false;
  postMessage(value: unknown) {
    this.sent.push(structuredClone(value));
  }
  close() {
    this.closed = true;
  }
  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

test("push waits for the listener handshake and bounds outstanding delivery to one snapshot", () => {
  const channel = new Channel();
  let text = "first";
  const push = createPanelPush(
    () => ({ text }),
    () => channel,
  );
  push.connect();
  push.changed();
  expect(channel.sent).toHaveLength(0);
  channel.receive({ type: "ready" });
  const first = channel.sent[0];
  for (let i = 0; i < 10_000; i++) {
    text = String(i);
    push.changed();
  }
  expect(channel.sent).toHaveLength(1);
  channel.receive({ type: "ack", sequence: first.sequence });
  expect(channel.sent).toHaveLength(2);
  expect(channel.sent[1].state.text).toBe("9999");
  channel.receive({ type: "ack", sequence: channel.sent[1].sequence });
  expect(channel.sent).toHaveLength(2);
  push.close();
  expect(channel.closed).toBe(true);
});

test("reconnection replaces stale listeners and sends current state without replay", () => {
  const channels: Channel[] = [];
  let state = "before";
  const push = createPanelPush(
    () => state,
    () => {
      const channel = new Channel();
      channels.push(channel);
      return channel;
    },
  );
  const old = push.connect();
  channels[0].receive({ type: "ready" });
  const oldHandler = channels[0].onmessage;
  state = "after disconnect";
  push.changed();
  const fresh = push.connect();
  expect(fresh.channel).not.toBe(old.channel);
  expect(channels[0].closed).toBe(true);
  oldHandler?.({ data: { type: "close" } } as MessageEvent);
  channels[1].receive({ type: "ready" });
  expect(channels[1].closed).toBe(false);
  expect(channels[1].sent[0].state).toBe("after disconnect");
  channels[1].receive({ type: "ack", sequence: -10 });
  state = "terminal";
  push.changed();
  expect(channels[1].sent).toHaveLength(1);
  channels[1].receive({ type: "ack", sequence: channels[1].sent[0].sequence });
  expect(channels[1].sent[1].state).toBe("terminal");
  push.close();
});
