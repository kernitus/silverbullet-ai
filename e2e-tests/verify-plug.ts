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
  assert.ok(manifest.functions.steerPanelChat);
  assert.ok(manifest.functions.connectPanelChat);
  assert.equal(
    manifest.functions.chatWithCurrentNote.command.name,
    "AI: Chat with Current Note",
  );
  assert.equal(
    manifest.functions.chatWithFolder.command.name,
    "AI: Chat with Folder",
  );
  assert.equal(manifest.functions.getPanelChatChunk, undefined);
  assert.equal(manifest.functions.getPollState, undefined);
  assert.ok(manifest.functions.streamChatOnPage);
  console.log(
    `SilverBullet worker loaded: ${Object.keys(manifest.functions).length} functions`,
  );

  const panel = await browser.newPage();
  await panel.route("http://localhost:9876/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await panel.goto("http://localhost:9876/");
  const panelErrors: string[] = [];
  panel.on("pageerror", (error) => panelErrors.push(error.message));
  panel.on("console", (message) => {
    if (message.type() === "error") console.error("Panel:", message.text());
  });
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
    let channel: BroadcastChannel | undefined;
    let sequence = 0;
    const pushUpdate = async () => {
      const saved = store["ai.panelChatHistory.sdk.v1"];
      const run = saved
        ? await (globalThis as any).syscall(
            "system.invokeFunction",
            "test.snapshot",
          )
        : undefined;
      if (saved && run)
        saved.run = {
          id: "test-stream",
          status: run.status,
          error: run.error,
          instructions: run.instructions,
        };
      channel?.postMessage({
        sequence: ++sequence,
        state: {
          agentRef: null,
          reasoningEnabled: false,
          run: run
            ? { ...run, id: "test-stream", chatId: saved.id }
            : undefined,
        },
      });
    };

    (globalThis as any).pushUpdate = pushUpdate;
    (globalThis as any).syscall = async (name: string, ...args: unknown[]) => {
      if (name === "clientStore.get") return store[String(args[0])];
      if (name === "clientStore.set") {
        store[String(args[0])] = JSON.parse(JSON.stringify(args[1]));
        return;
      }
      if (name === "markdown.markdownToHtml") return args[0];
      if (name !== "system.invokeFunction") return undefined;
      switch (args[0]) {
        case "silverbullet-ai.connectPanelChat": {
          channel?.close();
          const name = `test-${crypto.randomUUID()}`;
          channel = new BroadcastChannel(name);
          channel.onmessage = ({ data }) => {
            if (data.type === "ready") void pushUpdate();
          };
          return { channel: name };
        }
        case "silverbullet-ai.getPanelChatChunk":
        case "silverbullet-ai.getPollState":
          throw new Error("Polling is forbidden");
        case "silverbullet-ai.getPanelChatHistory":
          return store["ai.panelChatHistory.sdk.v1"];
        case "silverbullet-ai.resetPanelChatHistory":
          store["ai.panelChatHistory.sdk.v1"] = { id: args[1], messages: [] };
          return;
        case "silverbullet-ai.steerPanelChat": {
          if ((globalThis as any).rejectInstruction)
            return { error: "Instruction rejected for testing" };
          (globalThis as any).instruction = {
            id: "instruction",
            text: args[3],
            status: "queued",
          };
          void pushUpdate();
          return { id: "instruction" };
        }
        case "silverbullet-ai.cancelPanelChat":
          (globalThis as any).stopCalled = true;
          await pushUpdate();
          return;
        case "silverbullet-ai.getChatStatus":
          return {
            reasoning: { enabled: false },
            tokens: { total_tokens: 0 },
            model: { name: "test", contextLimit: 4096 },
          };
        case "silverbullet-ai.chatAgentState":
          return null;
        case "silverbullet-ai.startPanelChat":
          (globalThis as any).submittedOptions = args[3];
          (globalThis as any).submittedMessages.push(
            JSON.parse(JSON.stringify(args[1])),
          );
          store["ai.panelChatHistory.sdk.v1"] = {
            id: args[2],
            messages: JSON.parse(JSON.stringify(args[1])),
          };
          return { streamId: "test-stream" };
        case "test.snapshot": {
          if ((globalThis as any).holdRun)
            return (globalThis as any).stopCalled
              ? {
                  chunks: [],
                  status: "cancelled",
                  instructions: (globalThis as any).instruction
                    ? [
                        {
                          ...(globalThis as any).instruction,
                          status: "not-delivered",
                          reason: "aborted",
                        },
                      ]
                    : [],
                  error: "Stopped. Completed work has been kept.",
                  messages: store["ai.panelChatHistory.sdk.v1"].messages,
                }
              : {
                  chunks: [],
                  status: "streaming",
                  statusMessage: "Research: read_note Public/Notes",
                  preview: (globalThis as any).testPreview,
                  instructions: (globalThis as any).instruction
                    ? [(globalThis as any).instruction]
                    : [],
                };
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
  await panel
    .waitForFunction(() =>
      [...document.querySelectorAll(".message.assistant:not(.streaming)")].some(
        (element) =>
          element.textContent === "Search is available through tools.",
      ),
    )
    .catch(async (error) => {
      console.error(await panel.locator("body").innerText());
      console.error(await panel.evaluate(() => (globalThis as any).testStore));
      throw error;
    });
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
  assert.equal(await panel.locator(".tool-activity").count(), 1);
  assert.equal(await panel.locator(".tool-call").count(), 1);
  assert.equal(
    await panel
      .locator(".tool-activity")
      .evaluate((element: HTMLDetailsElement) => element.open),
    false,
  );
  assert.match(
    (await panel.locator(".tool-call").textContent()) || "",
    /Arguments.*Result/s,
  );
  await panel.locator("#attach-page").check();
  await panel.locator("#user-input").fill("Continue");
  await panel.locator("#send-btn").click();
  await panel.waitForFunction(
    () => (globalThis as any).submittedMessages.length === 2,
  );
  const submitted = await panel.evaluate(
    () => (globalThis as any).submittedMessages[1],
  );
  assert.deepEqual(
    await panel.evaluate(() => (globalThis as any).submittedOptions),
    { attachPage: true },
  );
  assert.equal(await panel.locator("#attach-page").isChecked(), false);
  assert.deepEqual(submitted.slice(0, -1), saved);
  assert.deepEqual(submitted.at(-1), { role: "user", content: "Continue" });
  await panel.locator("#stop-btn").waitFor({ state: "hidden" });
  await panel.evaluate(() => {
    (globalThis as any).holdRun = true;
  });
  await panel.locator("#user-input").fill("Research a large topic");
  await panel.locator("#send-btn").click();
  await panel.locator("#user-input").fill("Focus on Public/Notes");
  await panel.locator("#send-btn").click();
  await panel.waitForFunction(
    () => (globalThis as any).instruction?.text === "Focus on Public/Notes",
  );
  assert.equal(await panel.locator("#attach-page").isDisabled(), true);
  await panel.waitForFunction(() =>
    document
      .getElementById("run-progress")
      ?.textContent?.includes("Public/Notes"),
  );
  await panel.waitForFunction(() =>
    document
      .getElementById("run-instructions")
      ?.textContent?.includes("Queued for the next step"),
  );
  await panel.evaluate(async () => {
    (globalThis as any).testPreview = {
      parts: [
        {
          type: "tool-search_notes",
          toolCallId: "live-a",
          state: "output-available",
          input: { query: "college" },
          output: "Found notes",
        },
        {
          type: "tool-read_note",
          toolCallId: "live-b",
          state: "input-available",
          input: { page: "College/<script>" },
        },
      ],
    };
    await (globalThis as any).pushUpdate();
  });
  await panel.waitForFunction(
    () => document.querySelectorAll(".tool-call").length === 3,
  );
  const liveTools = panel.locator(".tool-activity").last();
  assert.equal(
    await liveTools.evaluate((element: HTMLDetailsElement) => element.open),
    true,
  );
  await panel.evaluate(async () => {
    (globalThis as any).testPreview.parts[1].state = "output-available";
    (globalThis as any).testPreview.parts[1].output =
      "<img src=x onerror=alert(1)>";
    (globalThis as any).testPreview.parts.push({
      type: "text",
      text: "Here are the relevant notes.",
    });
    await (globalThis as any).pushUpdate();
  });
  await panel.waitForFunction(() =>
    document
      .querySelector(".message.streaming")
      ?.textContent?.includes("relevant notes"),
  );
  assert.equal(
    await liveTools.evaluate((element: HTMLDetailsElement) => element.open),
    false,
  );
  assert.equal(await liveTools.locator("img, script").count(), 0);
  await liveTools.locator(":scope > summary").click();
  await panel.evaluate(async () => {
    (globalThis as any).testPreview.parts.at(-1).text += " More text.";
    await (globalThis as any).pushUpdate();
  });
  await panel.waitForFunction(() =>
    document
      .querySelector(".message.streaming")
      ?.textContent?.includes("More text"),
  );
  assert.equal(
    await liveTools.evaluate((element: HTMLDetailsElement) => element.open),
    true,
  );
  assert.equal(await liveTools.locator(".tool-call").count(), 2);
  assert.equal(await panel.locator("#run-progress").isVisible(), false);
  await panel.evaluate(() => {
    (globalThis as any).rejectInstruction = true;
  });
  await panel.locator("#user-input").fill("Keep this draft");
  await panel.locator("#send-btn").click();
  await panel.waitForFunction(() =>
    document
      .getElementById("run-instructions")
      ?.textContent?.includes("Instruction rejected for testing"),
  );
  assert.equal(
    await panel.locator("#user-input").inputValue(),
    "Keep this draft",
  );
  await panel.locator("#stop-btn").click();
  await panel.locator("#stop-btn").waitFor({ state: "hidden" });
  await panel.locator("#stop-btn").waitFor({ state: "hidden" });
  assert.equal(
    await panel.evaluate(() => (globalThis as any).stopCalled),
    true,
  );
  assert.equal(await panel.locator("#stop-btn").isVisible(), false);
  assert.equal(
    await panel.locator("#user-input").inputValue(),
    "Keep this draft",
  );
  assert.match(
    await panel.locator("#run-instructions").innerText(),
    /Not delivered/,
  );
  assert.equal(await panel.locator("#attach-page").isDisabled(), false);
  await panel.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    (globalThis as any).testStore["ai.panelChatHistory.sdk.v1"] = {
      id: "scoped-browser-chat",
      messages: [],
      chatScope: { kind: "note", path: "College/<Course>" },
    };
    const original = (globalThis as any).syscall;
    (globalThis as any).syscall = async (name: string, ...args: any[]) => {
      if (
        name === "system.invokeFunction" &&
        args[0] === "silverbullet-ai.connectPanelChat"
      )
        return { channel: `scope-${crypto.randomUUID()}` };
      return original(name, ...args);
    };
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
  });
  await panel.getByText("Note: College/<Course>", { exact: true }).waitFor();
  assert.equal(await panel.locator("#chat-scope-label course").count(), 0);
  await panel.getByText("Scoped Assistant", { exact: true }).waitFor();
  await panel.locator("#new-chat-btn").click();
  await panel.locator("#chat-scope-label").waitFor({ state: "hidden" });
  assert.deepEqual(panelErrors, []);
  console.log(
    "Chat panel loaded and completed a conversation without automatic RAG UI",
  );
  const diffBuild = await Bun.build({
    entrypoints: [new URL("../src/diff.ts", import.meta.url).pathname],
    target: "browser",
    minify: true,
  });
  assert.equal(diffBuild.success, true);
  await page.route("http://localhost:9876/approval-diff.js", async (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: await diffBuild.outputs[0].text(),
    }),
  );
  const preview = await page.evaluate(async () => {
    const module = await import("http://localhost:9876/approval-diff.js");
    return module.computeApprovalDiff(
      "repeat\r\nrepeat\r\n",
      "repeat\n<script>bad()</script>",
    );
  });
  const approval = await browser.newPage();
  await approval.setContent(
    await readFile(
      new URL("../assets/tool-approval-modal.html", import.meta.url),
      "utf8",
    ),
  );
  await approval.evaluate((diff) => {
    (globalThis as any).toolApprovalData = {
      approvalId: "preview",
      toolName: "edit_note",
      args: {},
      hasDiffSupport: true,
      isWriteApproval: true,
    };
    (globalThis as any).syscall = async (name: string, fn: string) => {
      if (
        name === "system.invokeFunction" &&
        fn === "silverbullet-ai.getWriteDiff"
      )
        return { diff };
    };
  }, preview);
  await approval.addScriptTag({
    content: await readFile(
      new URL("../assets/tool-approval-modal.js", import.meta.url),
      "utf8",
    ),
  });
  await approval.locator(".diff-line").first().waitFor();
  assert.match(await approval.locator("#diff-view").innerText(), /\[CRLF\]/);
  assert.match(
    await approval.locator("#diff-view").innerText(),
    /\[no final newline\]/,
  );
  assert.equal(await approval.locator("#diff-view script").count(), 0);
  console.log(
    "Library diff runs in Chromium and approval previews preserve line endings safely",
  );
  const account = await browser.newPage();
  const accountErrors: string[] = [];
  account.on("pageerror", (error) => accountErrors.push(error.message));
  await account.setContent(
    await readFile(
      new URL("../assets/codex-account.html", import.meta.url),
      "utf8",
    ),
  );
  await account.evaluate(() => {
    (globalThis as any).codexAccount = {
      providerKey: "codex",
      state: {
        status: "pending",
        userCode: "TEST-CODE",
        verificationUrl: "https://auth.openai.com/codex/device",
        interval: 1,
      },
    };
    (globalThis as any).syscall = async (_name: string, fn: string) => {
      if (fn === "silverbullet-ai.codexAccountStatus")
        return { status: "authenticated", user: { email: "test@example.com" } };
      if (fn === "silverbullet-ai.codexAccountLogout")
        (globalThis as any).signedOut = true;
    };
  });
  await account.addScriptTag({
    content: await readFile(
      new URL("../assets/codex-account.js", import.meta.url),
      "utf8",
    ),
  });
  assert.equal(await account.locator("#code").textContent(), "TEST-CODE");
  assert.equal(
    await account.locator("#verify").getAttribute("href"),
    "https://auth.openai.com/codex/device",
  );
  await account.waitForFunction(() =>
    document
      .getElementById("status")!
      .textContent!.includes("Using ChatGPT plan"),
  );
  assert.equal(await account.locator("#code").textContent(), "");
  await account.locator("#logout").click();
  assert.equal(
    await account.evaluate(() => (globalThis as any).signedOut),
    true,
  );
  assert.deepEqual(accountErrors, []);
  console.log("Codex sign-in dialogue completed login polling and sign-out");
} finally {
  await browser.close();
}
