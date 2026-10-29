import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "./mocks/syscalls.ts";
import { syscall } from "@silverbulletmd/silverbullet/syscalls";
import {
  aiSettings,
  currentEmbeddingProvider,
  initializeOpenAI,
} from "./init.ts";
import { buildSearchNotesTool, searchNotes } from "./search.ts";
import { discoverAllTools, executeTool } from "./tools.ts";
import { enrichChatMessages } from "./utils.ts";

const originalSyscall = (globalThis as any).syscall;
const pages: Record<string, string> = {
  "Notes/A": "First line\nNeedle [test]\nneedle again",
  "Notes/B": "needle elsewhere",
  "NotesOther/Private": "needle private",
  Secret: "needle secret",
};
let readPages: string[];

beforeEach(async () => {
  readPages = [];
  (globalThis as any).syscall = async (name: string, ...args: any[]) => {
    if (name === "space.listPages")
      return Object.keys(pages).map((name) => ({ name }));
    if (name === "space.readPage") {
      readPages.push(args[0]);
      return pages[args[0]];
    }
    return originalSyscall(name, ...args);
  };
  await syscall("mock.setConfig", "ai", {
    textModels: [
      { name: "mock", provider: "mock", modelName: "mock", requireAuth: false },
    ],
    indexEmbeddings: true,
    indexSummary: true,
    embeddingModels: [
      { name: "mock", provider: "mock", modelName: "mock", requireAuth: false },
    ],
    chat: {
      parseWikiLinks: false,
      bakeMessages: false,
      searchEmbeddings: true,
    },
  });
  await syscall("mock.clearClientStore");
  await syscall("mock.clearIndexedObjects");
  await initializeOpenAI();
  vi.spyOn(currentEmbeddingProvider!, "generateEmbeddings").mockResolvedValue([
    1, 0,
  ]);
});

afterEach(() => {
  (globalThis as any).syscall = originalSyscall;
  vi.restoreAllMocks();
});

test("search_notes is discoverable and enforces permissions before reading pages", async () => {
  const tools = await discoverAllTools();
  expect(tools.has("search_notes")).toBe(true);
  const result = await executeTool(
    "search_notes",
    { query: "needle", limit: 2 },
    tools,
    { allowedReadPaths: ["Notes/"] },
  );
  const output = JSON.parse(result.result!);
  expect(output.results).toEqual([
    { page: "Notes/A", line: 2, snippet: "Needle [test]" },
    { page: "Notes/A", line: 3, snippet: "needle again" },
  ]);
  expect(output.truncated).toBe(true);
  expect(readPages).not.toContain("Secret");
  expect(readPages).not.toContain("NotesOther/Private");
});

test("text search is literal and honours case and folder boundaries", async () => {
  const result = await searchNotes({
    query: "[test]",
    path: "Notes/",
    caseSensitive: true,
  });
  expect(JSON.parse(result.result!).results).toHaveLength(1);
  const sensitive = await searchNotes({
    query: "Needle",
    path: "Notes",
    caseSensitive: true,
  });
  expect(JSON.parse(sensitive.result!).results).toHaveLength(1);
  expect(readPages).not.toContain("NotesOther/Private");
});

test("text search works without embeddings and rejects invalid direct calls", async () => {
  aiSettings.indexEmbeddings = false;
  expect((await searchNotes({ query: "needle" })).success).toBe(true);
  expect(
    (await searchNotes({ query: "needle", mode: "semantic" })).success,
  ).toBe(false);
  for (const args of [
    { query: "" },
    { query: "x", limit: 0 },
    { query: "x", mode: "shell" },
    { query: "x", path: "Notes/../Secret" },
  ]) {
    expect((await searchNotes(args)).success).toBe(false);
  }
});

test("semantic search filters restricted notes and summaries before ranking and limiting", async () => {
  await syscall("mock.setIndexedObjects", "embedding", [
    { page: "Secret", ref: "Secret@0", text: "secret", embedding: [1, 0] },
    {
      page: "Notes/A",
      ref: "Notes/A@0",
      text: "allowed",
      embedding: [0.8, 0.2],
    },
  ]);
  await syscall("mock.setIndexedObjects", "aiSummary", [
    {
      page: "Secret",
      ref: "Secret@0",
      text: "secret summary",
      embedding: [1, 0],
    },
    {
      page: "NotesOther/Private",
      ref: "Other@0",
      text: "outside folder",
      embedding: [1, 0],
    },
  ]);
  const result = await executeTool(
    "search_notes",
    { query: "question", mode: "semantic", path: "Notes", limit: 1 },
    new Map([["search_notes", buildSearchNotesTool()]]),
    { allowedReadPaths: ["Notes/"] },
  );
  expect(result, result.error).toMatchObject({ success: true });
  expect(JSON.parse(result.result!).results.map((r: any) => r.page)).toEqual([
    "Notes/A",
  ]);
});

test("message enrichment never searches embeddings, even with the old setting enabled", async () => {
  const result = await enrichChatMessages([
    { role: "user", content: "Find needle" },
  ]);
  expect(currentEmbeddingProvider!.generateEmbeddings).not.toHaveBeenCalled();
  expect(result.messagesWithAttachments.flatMap((m) => m.attachments)).toEqual(
    [],
  );
});

test("text search pages matches without duplicates and includes numbered surrounding lines", async () => {
  const first = JSON.parse(
    (
      await searchNotes({
        query: "needle",
        path: "Notes",
        limit: 1,
        surroundingLines: 1,
      })
    ).result!,
  );
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(first.results[0]).toMatchObject({
    line: 2,
    startLine: 1,
    endLine: 3,
    context: "1: First line\n2: Needle [test]\n3: needle again",
  });
  const second = JSON.parse(
    (
      await searchNotes({
        query: "needle",
        path: "Notes",
        limit: 2,
        cursor: first.nextCursor,
        surroundingLines: 1,
      })
    ).result!,
  );
  expect(second.results.map((r: any) => [r.page, r.line])).toEqual([
    ["Notes/A", 3],
    ["Notes/B", 1],
  ]);
  expect(second.nextCursor).toBe(null);
});

test("title and path search rank names without reading contents or exposing denied paths", async () => {
  for (const mode of ["title", "path"]) {
    const result = JSON.parse(
      (
        await searchNotes(
          { query: mode === "title" ? "A" : "Notes", mode, limit: 1 },
          { allowedReadPaths: ["Notes"] },
        )
      ).result!,
    );
    expect(result.results).toEqual([{ page: "Notes/A" }]);
  }
  expect(readPages).toEqual([]);
  const result = JSON.parse(
    (
      await searchNotes(
        { query: "Notes", mode: "path", offset: 1 },
        { allowedReadPaths: ["Notes"] },
      )
    ).result!,
  );
  expect(result.results).toEqual([{ page: "Notes/B" }]);
});
