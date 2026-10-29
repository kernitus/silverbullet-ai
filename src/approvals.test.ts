import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "./mocks/syscalls.ts";
import { syscall } from "@silverbulletmd/silverbullet/syscalls";
import { initializeOpenAI, aiSettings } from "./init.ts";
import { callTool, requestWriteApproval, submitApproval } from "./tools.ts";
import { _setMCPClientFactory, clearMCPClients } from "./mcp/index.ts";

const originalSyscall = (globalThis as any).syscall;
let page: string | null;
let approvalId: string;
let writes: string[];
let failWrite: boolean;
let failRead: boolean;

beforeEach(async () => {
  await syscall("mock.setConfig", "ai", {
    textModels: [
      { name: "mock", provider: "mock", modelName: "mock", requireAuth: false },
    ],
    mcpServers: { srv: { url: "http://x/mcp", trusted: true } },
  });
  await initializeOpenAI();
  page = "original";
  approvalId = "";
  writes = [];
  failWrite = false;
  failRead = false;
  vi.stubGlobal("syscall", async (name: string, ...args: any[]) => {
    if (name === "space.pageExists") return page !== null;
    if (name === "space.readPage") {
      if (failRead) throw new Error("Read unavailable");
      return page;
    }
    if (name === "space.writePage") {
      if (failWrite) throw new Error("Disk full");
      writes.push(args[1]);
      page = args[1];
      return;
    }
    if (name === "asset.readAsset") return "data:text/plain;base64,";
    if (name === "editor.showPanel") {
      approvalId = JSON.parse(
        args[3].match(/globalThis.toolApprovalData = (.*);/)[1],
      ).approvalId;
      return;
    }
    if (name === "editor.hidePanel") return;
    return originalSyscall(name, ...args);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  _setMCPClientFactory(null);
  clearMCPClients();
});

async function preview() {
  const result = requestWriteApproval("Note", "proposed");
  await vi.waitFor(() => expect(approvalId).not.toBe(""));
  return { result, id: approvalId };
}

test("approved unchanged pages are written once even with duplicate submissions", async () => {
  const { result, id } = await preview();
  await Promise.all([
    submitApproval("write", id, true),
    submitApproval("write", id, true),
  ]);
  expect(await result).toEqual({ success: true });
  expect(writes).toEqual(["proposed"]);
});

test.each(["edited elsewhere", null])(
  "rejects stale approval after a page changes to %s",
  async (changed) => {
    const { result, id } = await preview();
    page = changed;
    await submitApproval("write", id, true);
    expect(await result).toMatchObject({
      success: false,
      error: expect.stringContaining("Page changed"),
    });
    expect(writes).toEqual([]);
    expect(page).toBe(changed);
  },
);

test("does not overwrite a page created while approval was open", async () => {
  page = null;
  const { result, id } = await preview();
  page = "";
  await submitApproval("write", id, true);
  expect((await result).success).toBe(false);
  expect(writes).toEqual([]);
});

test("failed writes settle the waiting tool and allow another approval", async () => {
  const { result, id } = await preview();
  failWrite = true;
  await submitApproval("write", id, true);
  expect(await result).toMatchObject({
    success: false,
    error: expect.stringContaining("Disk full"),
  });
  approvalId = "";
  const second = await preview();
  await submitApproval("write", second.id, false);
  expect((await second.result).success).toBe(false);
});

test("read errors cannot turn an existing page into a new page", async () => {
  failRead = true;
  await expect(requestWriteApproval("Note", "proposed")).rejects.toThrow(
    "Read unavailable",
  );
  expect(approvalId).toBe("");
  expect(writes).toEqual([]);
});

test("read errors at approval settle without writing", async () => {
  const { result, id } = await preview();
  failRead = true;
  await submitApproval("write", id, true);
  expect(await result).toMatchObject({
    success: false,
    error: expect.stringContaining("Read unavailable"),
  });
  expect(writes).toEqual([]);
});

test("concurrent approvals cannot replace the visible preview", async () => {
  const { result, id } = await preview();
  expect(await requestWriteApproval("Other", "other edit")).toMatchObject({
    success: false,
  });
  expect(approvalId).toBe(id);
  await submitApproval("write", id, false);
  expect((await result).success).toBe(false);
});

test("a running direct tool cannot bypass another call's write approval", async () => {
  let finish!: () => void;
  let started = false;
  _setMCPClientFactory(
    () =>
      ({
        listTools: async () => [
          { name: "wait", inputSchema: { type: "object", properties: {} } },
        ],
        callTool: async () => {
          started = true;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { content: [{ type: "text", text: "done" }] };
        },
      }) as any,
  );
  const running = callTool("mcp__srv__wait");
  await vi.waitFor(() => expect(started).toBe(true));
  const { result, id } = await preview();
  expect(writes).toEqual([]);
  finish();
  await running;
  await submitApproval("write", id, false);
  expect((await result).success).toBe(false);
  expect(page).toBe("original");
});

test("explicit skipToolApproval still allows direct writes", async () => {
  aiSettings.chat = { ...aiSettings.chat, skipToolApproval: true };
  expect(await requestWriteApproval("Note", "proposed")).toEqual({
    success: true,
  });
  expect(approvalId).toBe("");
  expect(writes).toEqual(["proposed"]);
});

test("cancelling a run dismisses its approval and prevents a later write", async () => {
  const { registerRun } = await import("./execution.ts");
  const controller = new AbortController();
  const unregister = registerRun("cancel-test", controller.signal);
  try {
    const result = requestWriteApproval("Note", "proposed", "cancel-test");
    await vi.waitFor(() => expect(approvalId).not.toBe(""));
    controller.abort(new DOMException("Stopped", "AbortError"));
    expect(await result).toMatchObject({
      success: false,
      error: expect.stringContaining("cancelled"),
    });
    await submitApproval("write", approvalId, true);
    expect(writes).toEqual([]);
  } finally {
    unregister();
  }
});

test("native edits require a unique match and preserve the expected snapshot through approval", async () => {
  const { buildWriteNoteTool } = await import("./note-tools.ts");
  const edit = buildWriteNoteTool(false, requestWriteApproval).execute!;
  const permissions = {
    allowedReadPaths: ["Note"],
    allowedWritePaths: ["Note"],
  };
  expect(
    (
      await edit(
        { page: "Secret", oldText: "original", newText: "edited" },
        permissions,
      )
    ).success,
  ).toBe(false);
  page = "original original";
  expect(
    (
      await edit(
        { page: "Note", oldText: "original", newText: "edited" },
        permissions,
      )
    ).success,
  ).toBe(false);
  expect(writes).toEqual([]);
  page = "original";
  const pending = edit(
    { page: "Note", oldText: "original", newText: "edited" },
    permissions,
  );
  await vi.waitFor(() => expect(approvalId).not.toBe(""));
  page = "concurrent edit";
  await submitApproval("write", approvalId, true);
  expect((await pending).success).toBe(false);
  expect(writes).toEqual([]);
});

test("native create refuses existing notes, unsafe restricted content and cancellation", async () => {
  const { buildWriteNoteTool } = await import("./note-tools.ts");
  const create = buildWriteNoteTool(true, requestWriteApproval).execute!;
  expect((await create({ page: "Note", content: "new" })).success).toBe(false);
  page = null;
  expect(
    (
      await create(
        { page: "Note", content: "```space-lua\nerror('x')\n```" },
        { allowedWritePaths: ["Note"] },
      )
    ).success,
  ).toBe(false);
  const controller = new AbortController();
  const pending = create({ page: "Note", content: "new" }, undefined, {
    abortSignal: controller.signal,
  });
  await vi.waitFor(() => expect(approvalId).not.toBe(""));
  controller.abort();
  expect((await pending).success).toBe(false);
  expect(writes).toEqual([]);
});

test("expected content is checked even when approvals are disabled", async () => {
  aiSettings.chat.skipToolApproval = true;
  expect(
    (await requestWriteApproval("Note", "replacement", undefined, "stale"))
      .success,
  ).toBe(false);
  expect(
    (await requestWriteApproval("Note", "replacement", undefined, "original"))
      .success,
  ).toBe(true);
  expect(writes).toEqual(["replacement"]);
});

test("native create and edit save approved content and reject read-only permissions", async () => {
  const { buildWriteNoteTool } = await import("./note-tools.ts");
  const permissions = {
    allowedReadPaths: ["Note"],
    allowedWritePaths: ["Note"],
  };
  const create = buildWriteNoteTool(true, requestWriteApproval).execute!;
  const edit = buildWriteNoteTool(false, requestWriteApproval).execute!;
  page = null;
  const creating = create(
    { page: "Note", content: "first line\nsecond line" },
    permissions,
  );
  await vi.waitFor(() => expect(approvalId).not.toBe(""));
  await submitApproval("write", approvalId, true);
  expect((await creating).success).toBe(true);
  expect(
    (
      await edit(
        { page: "Note", oldText: "first", newText: "changed" },
        { ...permissions, readOnly: true },
      )
    ).success,
  ).toBe(false);
  approvalId = "";
  const editing = edit(
    { page: "Note", oldText: "first", newText: "changed" },
    permissions,
  );
  await vi.waitFor(() => expect(approvalId).not.toBe(""));
  await submitApproval("write", approvalId, true);
  expect((await editing).success).toBe(true);
  expect(writes).toEqual([
    "first line\nsecond line",
    "changed line\nsecond line",
  ]);
});
