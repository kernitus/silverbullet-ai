import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "./mocks/syscalls.ts";
import { syscall } from "@silverbulletmd/silverbullet/syscalls";
import { initializeOpenAI } from "./init.ts";
import {
  chatWithCurrentNote,
  chatWithFolder,
  getPanelChatHistory,
  resetPanelChatHistory,
  startPanelChat,
} from "./chat-panel.ts";
import { noteFolders, scopePermissions } from "./chat-scope.ts";
import { isPathAllowed } from "./utils.ts";
import { buildReadNoteTool, buildWriteNoteTool } from "./note-tools.ts";
import { buildSearchNotesTool } from "./search.ts";
import { filterCapabilities } from "./capabilities.ts";
import { beginPanelTurn, savePanelCheckpoint } from "./panel-history.ts";

const original = (globalThis as any).syscall;
let selected: { name: string; path: string } | undefined;
let picker: { name: string; path: string }[];
let currentPage: string;
let readPages: string[];
const names = [
  "College/Course",
  "College/Course/Child",
  "College/Other",
  "CollegeExtra/Private",
  "Other",
];

beforeEach(async () => {
  await syscall("mock.setConfig", "ai", {
    textModels: [
      { name: "mock", provider: "mock", modelName: "mock", requireAuth: false },
    ],
  });
  await initializeOpenAI();
  selected = undefined;
  picker = [];
  currentPage = "College/Course";
  readPages = [];
  vi.stubGlobal("syscall", async (name: string, ...args: any[]) => {
    if (name === "editor.getCurrentPage") return currentPage;
    if (name === "space.listPages") return names.map((name) => ({ name }));
    if (name === "space.readPage") {
      readPages.push(args[0]);
      return "college evidence";
    }
    if (name === "editor.filterBox") {
      picker = args[1];
      return selected;
    }
    if (name === "asset.readAsset") return "data:text/plain;base64,";
    if (name === "editor.showPanel" || name === "editor.hidePanel") return;
    return original(name, ...args);
  });
  await resetPanelChatHistory("old-chat");
});
afterEach(() => vi.unstubAllGlobals());

test("current-note command creates a fresh persisted exact scope", async () => {
  await chatWithCurrentNote();
  const stored = await getPanelChatHistory();
  expect(stored?.id).not.toBe("old-chat");
  expect(stored?.messages).toEqual([]);
  expect(stored?.chatScope).toEqual({ kind: "note", path: "College/Course" });
  currentPage = "Other";
  expect((await getPanelChatHistory())?.chatScope).toEqual(stored?.chatScope);
  const permissions = scopePermissions(stored!.chatScope!);
  expect(isPathAllowed("College/Course", permissions.allowedReadPaths)).toBe(
    true,
  );
  expect(
    isPathAllowed("College/Course/Child", permissions.allowedReadPaths),
  ).toBe(false);
  expect(isPathAllowed("College/Other", permissions.allowedWritePaths)).toBe(
    false,
  );
});

test("folder picker includes nested folders and cancellation preserves the conversation", async () => {
  await chatWithFolder();
  expect(picker.map((item) => item.path)).toEqual([
    "College",
    "College/Course",
    "CollegeExtra",
  ]);
  expect((await getPanelChatHistory())?.id).toBe("old-chat");
  selected = { name: "College", path: "College" };
  await chatWithFolder();
  expect((await getPanelChatHistory())?.chatScope).toEqual({
    kind: "folder",
    path: "College",
  });
});

test("scope survives checkpoints and ordinary New chat clears it", async () => {
  await chatWithCurrentNote();
  const stored = (await getPanelChatHistory())!;
  await beginPanelTurn(
    stored.id,
    "run",
    [],
    "permissions",
    undefined,
    stored.chatScope,
  );
  await savePanelCheckpoint(
    stored.id,
    "run",
    { messages: [{ role: "assistant", content: "Finished" }] },
    "complete",
  );
  expect((await getPanelChatHistory())?.chatScope).toEqual(stored.chatScope);
  await resetPanelChatHistory("new-chat");
  expect((await getPanelChatHistory())?.chatScope).toBeUndefined();
});

test("exact scope constrains search, reads and edits before any note access", async () => {
  const permissions = scopePermissions({
    kind: "note",
    path: "College/Course",
  });
  const search = await buildSearchNotesTool().execute!(
    { query: "college", mode: "text" },
    permissions,
  );
  expect(search.success).toBe(true);
  expect(readPages).toEqual(["College/Course"]);
  readPages = [];
  const read = await buildReadNoteTool().execute!(
    { page: "College/Course/Child" },
    permissions,
  );
  expect(read.success).toBe(false);
  const approve = vi.fn();
  const write = await buildWriteNoteTool(false, approve).execute!(
    { page: "College/Other", oldText: "evidence", newText: "new" },
    permissions,
  );
  expect(write.success).toBe(false);
  expect(readPages).toEqual([]);
  expect(approve).not.toHaveBeenCalled();
});

test("folder scope includes descendants but excludes similarly named folders and unsafe tools", () => {
  const permissions = scopePermissions({ kind: "folder", path: "College" });
  expect(
    isPathAllowed("College/Course/Child", permissions.allowedReadPaths),
  ).toBe(true);
  expect(
    isPathAllowed("CollegeExtra/Private", permissions.allowedReadPaths),
  ).toBe(false);
  expect(isPathAllowed("College/../Other", permissions.allowedReadPaths)).toBe(
    false,
  );
  const definitions = new Map<string, any>([
    ["eval_lua", { source: "builtin", unsafeLua: true }],
    ["mcp", { source: "mcp" }],
    ["read_note", { source: "builtin", readOnly: true }],
  ]);
  expect([...filterCapabilities(definitions, permissions).keys()]).toEqual([
    "read_note",
  ]);
  expect(noteFolders([{ name: "Root" }])).toEqual([]);
});

test("an old panel cannot bypass the new scope with a different conversation id", async () => {
  await chatWithCurrentNote();
  const result = await startPanelChat(
    [{ role: "user", content: "Read Other" }],
    "old-chat",
  );
  expect(result.error).toContain("This chat has changed");
  expect(readPages).toEqual([]);
});
