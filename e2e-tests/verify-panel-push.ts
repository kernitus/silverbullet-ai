import { chromium } from "@playwright/test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const core = process.env.SB_CORE_CHECKOUT;
if (!core)
  throw new Error(
    "Set SB_CORE_CHECKOUT to the reviewed SilverBullet source checkout",
  );
const hostBuild = await Bun.build({
  entrypoints: [`${core}/client/sandbox/widget_sandbox_iframe.ts`],
  target: "browser",
});
if (!hostBuild.success) throw new Error(String(hostBuild.logs));
const hostSource = await hostBuild.outputs[0].text();
const plugSource = await readFile(
  new URL("../dist/silverbullet-ai.plug.js", import.meta.url),
  "utf8",
);
const panelHtml = await readFile(
  new URL("../assets/chat-panel.html", import.meta.url),
  "utf8",
);
const panelScript =
  (await readFile(
    new URL("../assets/purify.min.js", import.meta.url),
    "utf8",
  )) +
  "\n" +
  (await readFile(new URL("../assets/chat-panel.js", import.meta.url), "utf8"));
type RequestRecord = {
  body: any;
  send: (delta: Record<string, unknown>) => void;
  finish: () => void;
  cancelled: boolean;
};
const requests: RequestRecord[] = [];
let signalRequest: (() => void) | undefined;
async function requestAt(index: number): Promise<RequestRecord> {
  if (requests[index]) return requests[index];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Model request ${index} did not arrive`)),
      10_000,
    );
    signalRequest = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  assert.ok(requests[index]);
  return requests[index];
}
const encoder = new TextEncoder();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 30,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/worker.js")
      return new Response(plugSource, {
        headers: { "content-type": "text/javascript" },
      });
    if (path === "/host.js")
      return new Response(hostSource, {
        headers: { "content-type": "text/javascript" },
      });
    if (path === "/v1/chat/completions") {
      const body = await request.json();
      let record: RequestRecord;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let ended = false;
          const emit = (
            delta: Record<string, unknown>,
            finish_reason: string | null = null,
          ) => {
            if (ended) return;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
              ),
            );
          };
          record = {
            body,
            cancelled: false,
            send: emit,
            finish: () => {
              emit({}, "stop");
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              ended = true;
              controller.close();
            },
          };
          requests.push(record);
          signalRequest?.();
          signalRequest = undefined;
        },
        cancel() {
          record.cancelled = true;
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }
    if (path === "/v1/models") return Response.json({ data: [] });
    return new Response("<!doctype html><html><body></body></html>", {
      headers: { "content-type": "text/html" },
    });
  },
});
const browser = await chromium.launch({
  executablePath: process.env.SB_CHROME_PATH,
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  await page.goto(server.url.href);
  await page.evaluate(
    async ({ html, script }) => {
      const origin = location.origin;
      const { createWidgetSandboxIFrame } = await import(`${origin}/host.js`);
      const pending = new Map<
        number,
        { resolve: (value: any) => void; reject: (error: Error) => void }
      >();
      const store = new Map<string, any>([
        [
          "ai.modelMetadataCache",
          {
            fetchedAt: Date.now(),
            data: { fixture: { max_input_tokens: 8192 } },
          },
        ],
      ]);
      const calls: string[] = [];
      const channels: string[] = [];
      let invocation = 0;
      let worker = new Worker("/worker.js", { type: "module" });
      let ready!: () => void;
      const boot = new Promise<void>((resolve) => {
        ready = resolve;
      });
      function invoke(name: string, args: any[] = []) {
        return new Promise<any>((resolve, reject) => {
          const id = ++invocation;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Timed out: ${name}`));
          }, 10_000);
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });
          worker.postMessage({ type: "inv", id, name, args });
        });
      }
      async function syscall(name: string, args: any[]) {
        calls.push(name === "system.invokeFunction" ? args[0] : name);
        if (name === "system.invokeFunction") {
          const result = await invoke(
            args[0].replace(/^silverbullet-ai\./, ""),
            args.slice(1),
          );
          if (args[0] === "silverbullet-ai.connectPanelChat")
            channels.push(result.channel);
          return result;
        }
        if (name === "clientStore.get")
          return structuredClone(store.get(args[0]));
        if (name === "clientStore.set") {
          store.set(args[0], structuredClone(args[1]));
          return;
        }
        if (name === "clientStore.del") {
          store.delete(args[0]);
          return;
        }
        if (name === "system.getConfig")
          return args[0] === "ai"
            ? {
                textModels: [
                  {
                    name: "fixture",
                    provider: "openai",
                    modelName: "fixture",
                    baseUrl: `${origin}/v1`,
                    requireAuth: false,
                    useProxy: false,
                    api: "chat",
                  },
                ],
                chat: {
                  enableTools: false,
                  parseWikiLinks: false,
                  bakeMessages: false,
                  showReasoning: true,
                  contextMaxChars: 1_000_000,
                },
              }
            : args[1];
        if (name === "space.getPageMeta")
          return { name: args[0], lastModified: 0 };
        if (name === "editor.getCurrentPage") return "Fixture";
        if (name === "editor.getSelection") return { text: "" };
        if (name === "editor.getText") return "Fixture page";
        if (name === "editor.getUiOption") return "";
        if (name === "editor.flashNotification" || name === "editor.hidePanel")
          return;
        if (name === "lua.evalExpression") return {};
        if (name === "lua.parseExpression") return args[0];
        if (name === "index.queryLuaObjects") return [];
        if (name === "event.dispatch") return [];
        if (name === "markdown.expandMarkdown") return args[0];
        if (name === "markdown.parseMarkdown")
          return { type: "Document", children: [{ text: args[0] }] };
        if (name === "markdown.markdownToHtml") return args[0];
        throw new Error(`Unimplemented host syscall: ${name}`);
      }
      worker.onmessage = ({ data }) => {
        if (data.type === "manifest") {
          ready();
          return;
        }
        if (data.type === "invr") {
          const item = pending.get(data.id);
          pending.delete(data.id);
          if (data.error) item?.reject(new Error(data.error));
          else item?.resolve(data.result);
        } else if (data.type === "sys") {
          void syscall(data.name, data.args ?? []).then(
            (result) =>
              worker.postMessage({ type: "sysr", id: data.id, result }),
            (error) =>
              worker.postMessage({
                type: "sysr",
                id: data.id,
                error: String(error),
              }),
          );
        }
      };
      await boot;
      let mounted: any;
      const mount = () => {
        mounted?.dispose();
        mounted?.iframe.remove();
        mounted = createWidgetSandboxIFrame(
          { clientSystem: { localSyscall: syscall } },
          null,
          { html, script },
        );
        mounted.iframe.id = "test-panel";
        mounted.iframe.style.width = "1000px";
        mounted.iframe.style.height = "700px";
        document.body.append(mounted.iframe);
      };
      (globalThis as any).fixture = {
        store,
        calls,
        channels,
        mount,
        invoke,
        get worker() {
          return worker;
        },
        restartWorker: async () => {
          const handler = worker.onmessage;
          worker.terminate();
          const restarted = new Promise<void>((resolve) => {
            ready = resolve;
          });
          worker = new Worker("/worker.js", { type: "module" });
          worker.onmessage = handler;
          await restarted;
        },
      };
      mount();
    },
    { html: panelHtml, script: panelScript },
  );
  let panel = page.frameLocator("#test-panel");
  await panel.locator("#user-input").fill("Research the fixture");
  await panel.locator("#send-btn").click();
  const first = await requestAt(0);
  first.send({ role: "assistant", reasoning_content: "Check the evidence" });
  first.send({ content: "A" });
  first.send({ content: " B" });
  await panel
    .getByText("Reasoning: Check the evidence\n\nA B", { exact: true })
    .waitFor();
  await panel.locator("#reasoning-indicator").click();
  await panel.getByText("A B", { exact: true }).waitFor();
  await panel.locator("#reasoning-indicator").click();
  await panel
    .getByText("Reasoning: Check the evidence\n\nA B", { exact: true })
    .waitFor();
  await page.evaluate(() => (globalThis as any).fixture.mount());
  panel = page.frameLocator("#test-panel");
  first.send({ content: " C" });
  await panel
    .getByText("Reasoning: Check the evidence\n\nA B C", { exact: true })
    .waitFor();
  assert.equal(await panel.locator(".message.streaming").count(), 1);
  // A disposed frame's channel cannot replace the current run preview.
  await page.evaluate(() => {
    const old = new BroadcastChannel((globalThis as any).fixture.channels[0]);
    old.postMessage({
      sequence: Number.MAX_SAFE_INTEGER,
      state: { agentRef: null },
    });
    old.close();
  });
  first.send({ content: "" });
  await panel
    .getByText("Reasoning: Check the evidence\n\nA B C", { exact: true })
    .waitFor();
  // Disconnect delivery while generation continues, then reconnect from current state.
  await panel
    .locator("body")
    .evaluate(() => window.dispatchEvent(new Event("pagehide")));
  first.send({ content: " D" });
  first.send({ content: " E" });
  await panel
    .locator("body")
    .evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await panel
    .getByText("Reasoning: Check the evidence\n\nA B C D E", { exact: true })
    .waitFor();
  await panel.locator("#user-input").fill("Focus on evidence");
  await panel.locator("#send-btn").click();
  await panel
    .getByText("Queued for the next step: Focus on evidence", { exact: true })
    .waitFor();
  first.finish();
  const second = await requestAt(1);
  assert.match(JSON.stringify(second.body.messages), /Focus on evidence/);
  second.send({ content: "Refined answer" });
  second.finish();
  await panel.getByText("Refined answer", { exact: true }).waitFor();
  await panel.locator("#stop-btn").waitFor({ state: "hidden" });
  assert.equal(await panel.getByText("A B C D E", { exact: true }).count(), 0); // Reasoning shares the saved assistant message.
  const history = await page.evaluate(() =>
    (globalThis as any).fixture.store.get("ai.panelChatHistory.sdk.v1"),
  );
  assert.equal(
    history.messages.filter(
      (message: any) =>
        message.role === "user" && message.content === "Focus on evidence",
    ).length,
    1,
  );
  assert.equal(history.run.status, "complete");
  // Overflow limits the preview, while the final SDK message remains complete.
  await panel.locator("#user-input").fill("Generate a long answer");
  await panel.locator("#send-btn").click();
  const third = await requestAt(2);
  const large = "x".repeat(300_000);
  third.send({ content: large });
  await panel.getByText(/Live preview limit reached/).waitFor();
  third.finish();
  await panel.locator("#stop-btn").waitFor({ state: "hidden" });
  const savedLong = await page.evaluate(() =>
    (globalThis as any).fixture.store
      .get("ai.panelChatHistory.sdk.v1")
      .messages.at(-1),
  );
  assert.equal(
    savedLong.content.find((part: any) => part.type === "text").text.length,
    large.length,
  );
  await panel.locator("#user-input").fill("Wait for Stop");
  await panel.locator("#send-btn").click();
  const fourth = await requestAt(3);
  fourth.send({ content: "Before Stop" });
  await panel.getByText("Before Stop", { exact: true }).waitFor();
  await panel.locator("#stop-btn").click();
  await panel.locator("#stop-btn").waitFor({ state: "hidden" });
  await panel
    .getByText("Stopped. Completed work has been kept.", { exact: true })
    .waitFor();
  const countBefore = await page.evaluate(
    () => (globalThis as any).fixture.calls.length,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    await page.evaluate(() => (globalThis as any).fixture.calls.length),
    countBefore,
  );
  assert.equal(requests.length, 4);
  assert.equal(fourth.cancelled, true);
  const calls = await page.evaluate(
    () => (globalThis as any).fixture.calls as string[],
  );
  assert.equal(
    calls.some((name) => /getPanelChatChunk|getPollState/.test(name)),
    false,
  );
  await panel.locator("#user-input").fill("Survive a worker restart");
  await panel.locator("#send-btn").click();
  const interrupted = await requestAt(4);
  interrupted.send({ content: "Unsaved partial output" });
  await panel.getByText("Unsaved partial output", { exact: true }).waitFor();
  await page.evaluate(async () => {
    await (globalThis as any).fixture.restartWorker();
    (globalThis as any).fixture.mount();
  });
  panel = page.frameLocator("#test-panel");
  await panel.getByText(/The previous turn was interrupted/).waitFor();
  await panel.locator("#stop-btn").waitFor({ state: "hidden" });
  const recovered = await page.evaluate(() =>
    (globalThis as any).fixture.store.get("ai.panelChatHistory.sdk.v1"),
  );
  assert.equal(recovered.run.status, "interrupted");
  assert.equal(
    recovered.messages.some(
      (message: any) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part: any) => part.type === "text" && part.text === "Refined answer",
        ),
    ),
    true,
  );
  assert.equal(requests.length, 5, "Recovery must not replay a model request");
  assert.deepEqual(errors, []);
  await page.evaluate(() => (globalThis as any).fixture.worker.terminate());
  console.log(
    "Built plug and actual SilverBullet iframe: SDK text/reasoning, reopen, disconnected recovery, steering, overflow, Stop, idle push and worker restart checks passed",
  );
} finally {
  await browser.close();
  server.stop(true);
}
