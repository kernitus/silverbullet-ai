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
    (globalThis as any).syscall = async (name: string, ...args: unknown[]) => {
      if (name === "markdown.markdownToHtml") return args[0];
      if (name !== "system.invokeFunction") return undefined;
      switch (args[0]) {
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
          return { streamId: "test-stream" };
        case "silverbullet-ai.getPanelChatChunk":
          return {
            chunks: ["Search is available through tools."],
            status: "complete",
          };
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
  await panel.waitForFunction(
    () =>
      document.querySelector(".message.assistant:not(.streaming)")
        ?.textContent === "Search is available through tools.",
  );
  assert.equal(
    await panel
      .locator("#rag-indicator, #overflow-rag-btn, .rag-context")
      .count(),
    0,
  );
  assert.deepEqual(panelErrors, []);
  console.log(
    "Chat panel loaded and completed a conversation without automatic RAG UI",
  );
} finally {
  await browser.close();
}
