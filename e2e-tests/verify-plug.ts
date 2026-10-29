import { chromium } from "@playwright/test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

// Use the same URL shape and module worker mode as SilverBullet's WorkerSandbox.
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SB_CHROME_PATH,
});
try {
  const page = await browser.newPage();
  const source = await readFile(
    new URL("../dist/silverbullet-ai.plug.js", import.meta.url),
    "utf8",
  );
  await page.route("http://localhost:9876/**", (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith(".js")
        ? "text/javascript"
        : "text/html",
      body: route.request().url().endsWith(".js") ? source : "<html></html>",
    }),
  );
  await page.goto("http://localhost:9876/");
  const manifest = await page.evaluate(
    () =>
      new Promise<{ name: string; functions: Record<string, unknown> }>(
        (resolve, reject) => {
          const worker = new Worker("/.fs/_plug/silverbullet-ai.plug.js", {
            type: "module",
          });
          const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error("Plug did not send its manifest"));
          }, 5000);
          worker.onerror = (event) => {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(event.message));
          };
          worker.onmessage = ({ data }) => {
            if (data.type === "manifest") {
              clearTimeout(timer);
              worker.terminate();
              resolve(data.manifest);
            }
          };
        },
      ),
  );
  assert.equal(manifest.name, "silverbullet-ai");
  assert.ok(manifest.functions.chat);
  assert.ok(manifest.functions.streamChatOnPage);
  console.log(
    `SilverBullet worker loaded: ${Object.keys(manifest.functions).length} functions`,
  );

  const panel = await browser.newPage();
  const panelErrors: string[] = [];
  panel.on("pageerror", (error) => panelErrors.push(error.message));
  await panel.setContent(
    await readFile(
      new URL("../assets/chat-panel.html", import.meta.url),
      "utf8",
    ),
    { waitUntil: "domcontentloaded" },
  );
  await panel.evaluate(() => {
    const store: Record<string, any> = {};
    (globalThis as any).testStore = store;
    (globalThis as any).submittedMessages = [];
    (globalThis as any).syscall = async (name: string, ...args: unknown[]) => {
      if (name === "clientStore.get") return store[String(args[0])];
      if (name === "clientStore.set") {
        store[String(args[0])] = JSON.parse(JSON.stringify(args[1]));
        return;
      }
      if (name === "markdown.markdownToHtml") return args[0];
      if (name !== "system.invokeFunction") return undefined;
      switch (args[0]) {
        case "silverbullet-ai.getPanelChatHistory":
          return store["ai.panelChatHistory.sdk.v1"];
        case "silverbullet-ai.resetPanelChatHistory":
          store["ai.panelChatHistory.sdk.v1"] = { id: args[1], messages: [] };
          return;
        case "silverbullet-ai.cancelPanelChat":
          (globalThis as any).stopCalled = true;
          return;
        case "silverbullet-ai.getChatStatus":
          return {
            reasoning: { enabled: false },
            tokens: { total_tokens: 0 },
            model: { name: "test", contextLimit: 4096 },
          };
        case "silverbullet-ai.chatAgentState":
          return null;
        case "silverbullet-ai.getPollState":
          return { agentRef: null };
        case "silverbullet-ai.startPanelChat":
          (globalThis as any).submittedMessages.push(
            JSON.parse(JSON.stringify(args[1])),
          );
          store["ai.panelChatHistory.sdk.v1"] = {
            id: args[2],
            messages: JSON.parse(JSON.stringify(args[1])),
          };
          return { streamId: "test-stream" };
        case "silverbullet-ai.getPanelChatChunk": {
          if ((globalThis as any).holdRun)
            return (globalThis as any).stopCalled
              ? {
                  chunks: [],
                  status: "cancelled",
                  error: "Stopped. Completed work has been kept.",
                  messages: store["ai.panelChatHistory.sdk.v1"].messages,
                }
              : { chunks: [], status: "streaming" };
          const result = {
            chunks: ["Search is available through tools."],
            status: "complete",
            messages: [
              { role: "user", content: "Search my notes" },
              {
                role: "assistant",
                content: [
                  {
                    type: "reasoning",
                    text: "Private reasoning",
                    providerOptions: {
                      openai: { reasoningEncryptedContent: "encrypted" },
                    },
                  },
                  {
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName: "search_notes",
                    input: { query: "notes" },
                  },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "search_notes",
                    output: { type: "text", value: "Full search results" },
                  },
                ],
              },
              {
                role: "assistant",
                content: [
                  { type: "text", text: "Search is available through tools." },
                ],
              },
            ],
          };
          store["ai.panelChatHistory.sdk.v1"].messages = result.messages;
          return result;
        }
        case "silverbullet-ai.postProcessToolCallHtml":
          return args[1];
        default:
          return undefined;
      }
    };
  });
  await panel.addScriptTag({
    content: await readFile(
      new URL("../assets/chat-panel.js", import.meta.url),
      "utf8",
    ),
  });
  await panel.locator("#user-input").fill("Find my notes");
  await panel.locator("#send-btn").click();
  await panel.waitForFunction(() =>
    [...document.querySelectorAll(".message.assistant:not(.streaming)")].some(
      (element) => element.textContent === "Search is available through tools.",
    ),
  );
  assert.equal(
    await panel
      .locator("#rag-indicator, #overflow-rag-btn, .rag-context")
      .count(),
    0,
  );
  await panel.waitForFunction(
    () =>
      (globalThis as any).testStore["ai.panelChatHistory.sdk.v1"]?.messages
        .length === 4,
  );
  const saved = await panel.evaluate(
    () => (globalThis as any).testStore["ai.panelChatHistory.sdk.v1"].messages,
  );
  assert.equal(
    saved[1].content[0].providerOptions.openai.reasoningEncryptedContent,
    "encrypted",
  );
  assert.equal(saved[2].content[0].output.value, "Full search results");
  assert.equal(
    await panel.getByText("Private reasoning", { exact: true }).count(),
    0,
  );
  await panel.locator("#user-input").fill("Continue");
  await panel.locator("#send-btn").click();
  await panel.waitForFunction(
    () => (globalThis as any).submittedMessages.length === 2,
  );
  const submitted = await panel.evaluate(
    () => (globalThis as any).submittedMessages[1],
  );
  assert.deepEqual(submitted.slice(0, -1), saved);
  assert.deepEqual(submitted.at(-1), { role: "user", content: "Continue" });
  await panel.waitForFunction(
    () => !(document.getElementById("send-btn") as HTMLButtonElement).disabled,
  );
  await panel.evaluate(() => {
    (globalThis as any).holdRun = true;
  });
  await panel.locator("#user-input").fill("Research a large topic");
  await panel.locator("#send-btn").click();
  await panel.locator("#stop-btn").click();
  await panel.waitForFunction(
    () => !(document.getElementById("send-btn") as HTMLButtonElement).disabled,
  );
  assert.equal(
    await panel.evaluate(() => (globalThis as any).stopCalled),
    true,
  );
  assert.equal(await panel.locator("#stop-btn").isVisible(), false);
  assert.equal(await panel.locator("#user-input").inputValue(), "");
  assert.deepEqual(panelErrors, []);
  console.log(
    "Chat panel loaded and completed a conversation without automatic RAG UI",
  );
} finally {
  await browser.close();
}
