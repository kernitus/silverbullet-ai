import { expect, test, vi } from "vitest";
import { createLiteralSearch, type LiteralOptions } from "./literal-search.ts";

function fixture(capacity = 32) {
  const notes: Record<string, { text: string; version: number }> = {
    "Allowed/A": {
      text: "needle first\nneedle second\nneedle third",
      version: 1,
    },
    "Allowed/B": { text: "prefixneedleSuffix [x]\nNeedle", version: 1 },
    "Secret/Note": { text: "needle private", version: 1 },
  };
  let time = 0;
  const read = vi.fn(async (page: string) => {
    if (!notes[page]) throw new Error("Missing");
    return notes[page].text;
  });
  const search = createLiteralSearch({
    listPages: async () =>
      Object.entries(notes).map(([name, note]) => ({
        name,
        lastModified: note.version,
      })),
    readPage: read,
    capacity,
    ttlMs: 100,
    now: () => time,
  });
  const args: LiteralOptions = {
    query: "needle",
    caseSensitive: false,
    surroundingLines: 0,
    limit: 1,
    scopeKey: "Allowed",
    acceptsPage: (page) => page.startsWith("Allowed/"),
  };
  return {
    notes,
    read,
    search,
    args,
    advance: () => {
      time += 101;
    },
  };
}

test("continuation reads only its current and subsequent pages without duplicate results", async () => {
  const { search, args, read } = fixture();
  const first = await search.search({ ...args, limit: 3 });
  expect(first.results.map((match) => match.line)).toEqual([1, 2, 3]);
  read.mockClear();
  const second = await search.search({
    ...args,
    cursor: first.nextCursor!,
    limit: 10,
  });
  expect(second.results.map((match) => [match.page, match.line])).toEqual([
    ["Allowed/B", 1],
    ["Allowed/B", 2],
  ]);
  expect(read.mock.calls.flat()).toEqual(["Allowed/B"]);
  expect(second.nextCursor).toBeNull();
});

test("literal matching preserves substrings, punctuation and case", async () => {
  const { search, args } = fixture();
  expect(
    (await search.search({ ...args, query: "fixneedleS", caseSensitive: true }))
      .results[0].line,
  ).toBe(1);
  expect(
    (await search.search({ ...args, query: "[x]" })).results[0].snippet,
  ).toContain("[x]");
  expect(
    (await search.search({ ...args, query: "Needle", caseSensitive: true }))
      .results,
  ).toHaveLength(1);
});

test("cursors reject forged tokens, expiry, changed query and permission scope before reading", async () => {
  const { search, args, read, advance } = fixture();
  const first = await search.search(args);
  read.mockClear();
  for (const change of [
    { cursor: "unknown" },
    { cursor: first.nextCursor!, query: "private" },
    { cursor: first.nextCursor!, scopeKey: "Secret" },
    { cursor: first.nextCursor!, surroundingLines: 1 },
    { cursor: first.nextCursor!, caseSensitive: true },
  ])
    await expect(search.search({ ...args, ...change })).rejects.toThrow(
      "continuation",
    );
  advance();
  await expect(
    search.search({ ...args, cursor: first.nextCursor! }),
  ).rejects.toThrow("expired");
  expect(read).not.toHaveBeenCalled();
});

test.each(["change", "rename", "delete", "create"])(
  "observed %s invalidates pagination",
  async (operation) => {
    const { search, args, notes } = fixture();
    const first = await search.search(args);
    if (operation === "change") notes["Allowed/B"].version++;
    if (operation === "rename") {
      notes["Allowed/C"] = notes["Allowed/B"];
      delete notes["Allowed/B"];
    }
    if (operation === "delete") delete notes["Allowed/B"];
    if (operation === "create")
      notes["Allowed/C"] = { text: "new", version: 1 };
    await expect(
      search.search({ ...args, cursor: first.nextCursor! }),
    ).rejects.toThrow("notes changed");
  },
);

test("content validation catches same-metadata changes on the resumed page", async () => {
  const { search, args, notes } = fixture();
  const first = await search.search(args);
  notes["Allowed/A"].text = "changed without a metadata update";
  await expect(
    search.search({ ...args, cursor: first.nextCursor! }),
  ).rejects.toThrow("notes changed");
});

test("events invalidate relevant scopes and do not expose changes outside read permissions", async () => {
  const { search, args, notes, read } = fixture();
  const first = await search.search(args);
  notes["Secret/Note"].version++;
  search.invalidate("Secret/Note");
  expect(
    (await search.search({ ...args, cursor: first.nextCursor! })).results[0]
      .page,
  ).toBe("Allowed/A");
  expect(read.mock.calls.flat()).not.toContain("Secret/Note");
  search.invalidate("Allowed/A");
  await expect(
    search.search({ ...args, cursor: first.nextCursor! }),
  ).rejects.toThrow("notes changed");
});

test("edits during a search prevent publishing stale continuations", async () => {
  const { search, args, read } = fixture();
  read.mockImplementationOnce(async () => {
    search.invalidate("Allowed/A");
    return "needle\nneedle";
  });
  await expect(search.search(args)).rejects.toThrow("notes changed");
});

test("cancellation stops scanning before the next page", async () => {
  const { search, args, read } = fixture();
  const controller = new AbortController();
  read.mockImplementationOnce(async () => {
    controller.abort(new Error("Stopped"));
    return "needle";
  });
  await expect(
    search.search({ ...args, limit: 10, abortSignal: controller.signal }),
  ).rejects.toThrow("Stopped");
  expect(read).toHaveBeenCalledTimes(1);
});

test("cursor retention is bounded and stores no note text", async () => {
  const { search, args } = fixture(2);
  const first = await search.search(args);
  await search.search(args);
  await search.search(args);
  expect(search.stats().cursors).toBe(2);
  expect(search.stats().retainedBytes).toBeLessThan(3000);
  await expect(
    search.search({ ...args, cursor: first.nextCursor! }),
  ).rejects.toThrow("expired");
});
