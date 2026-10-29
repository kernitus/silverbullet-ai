import { LimitedMap } from "@silverbulletmd/silverbullet/lib/limited_map";
import { hashSHA256 } from "@silverbulletmd/silverbullet/lib/crypto";

export type SearchPage = {
  name: string;
  lastModified?: unknown;
  created?: unknown;
  size?: unknown;
};
export type LiteralOptions = {
  query: string;
  caseSensitive: boolean;
  surroundingLines: number;
  limit: number;
  scopeKey: string;
  acceptsPage: (page: string) => boolean;
  cursor?: string;
  abortSignal?: AbortSignal;
};
type Cursor = {
  key: string;
  listingHash: string;
  page: string;
  line: number;
  pageHash: string;
  expires: number;
  invalidated: boolean;
  acceptsPage: (page: string) => boolean;
};
export type LiteralMatch = {
  page: string;
  line: number;
  snippet: string;
  context?: string;
  startLine?: number;
  endLine?: number;
};

// SilverBullet's bounded map supplies eviction. No note contents or results are
// retained: a cursor contains only the scan position and validation hashes.
export function createLiteralSearch(options: {
  listPages: () => Promise<SearchPage[]>;
  readPage: (page: string) => Promise<string>;
  now?: () => number;
  capacity?: number;
  ttlMs?: number;
}) {
  const cursors = new LimitedMap<Cursor>(options.capacity ?? 32);
  const active = new Set<{
    acceptsPage: (page: string) => boolean;
    invalidated: boolean;
  }>();
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 5 * 60_000;
  const stale = () =>
    new Error(
      "Search continuation expired or notes changed. Start a new search without cursor.",
    );

  return {
    invalidate(page: string) {
      for (const request of active)
        if (request.acceptsPage(page)) request.invalidated = true;
      for (const { value } of Object.values(cursors.toJSON()) as {
        value: Cursor;
      }[]) {
        if (value.acceptsPage(page)) value.invalidated = true;
      }
    },
    stats() {
      const records = Object.values(cursors.toJSON()) as { value: Cursor }[];
      return {
        cursors: records.length,
        retainedBytes:
          JSON.stringify(
            records.map(
              ({ value: { acceptsPage: _predicate, ...value } }) => value,
            ),
          ).length * 2,
      };
    },
    async search(input: LiteralOptions) {
      if (input.scopeKey.length > 65_536)
        throw new Error("Search scope is too large to retain safely.");
      if (active.size >= 8)
        throw new Error(
          "Too many note searches are running. Retry after one finishes.",
        );
      const request = { acceptsPage: input.acceptsPage, invalidated: false };
      active.add(request);
      try {
        const signal = input.abortSignal;
        signal?.throwIfAborted();
        const key = await hashSHA256(
          JSON.stringify([
            input.query,
            input.caseSensitive,
            input.surroundingLines,
            input.scopeKey,
          ]),
        );
        const saved = input.cursor ? cursors.get(input.cursor) : undefined;
        if (
          input.cursor &&
          (!saved ||
            saved.key !== key ||
            saved.expires <= now() ||
            saved.invalidated)
        )
          throw stale();
        const pages = (await options.listPages())
          .filter((page) => input.acceptsPage(page.name))
          .sort((a, b) => a.name.localeCompare(b.name));
        signal?.throwIfAborted();
        const listingHash = await hashSHA256(
          JSON.stringify(
            pages.map((page) => [
              page.name,
              page.lastModified,
              page.created,
              page.size,
            ]),
          ),
        );
        if (saved && saved.listingHash !== listingHash) throw stale();
        const start = saved
          ? pages.findIndex((page) => page.name === saved.page)
          : 0;
        if (start < 0) throw stale();
        const results: LiteralMatch[] = [];
        const needle = input.caseSensitive
          ? input.query
          : input.query.toLowerCase();
        let unreadablePages = 0;
        let nextCursor: string | null = null;
        let lastYield = performance.now();
        for (let p = start; p < pages.length; p++) {
          signal?.throwIfAborted();
          if (performance.now() - lastYield > 8) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            lastYield = performance.now();
            signal?.throwIfAborted();
          }
          let content: string;
          try {
            content = await options.readPage(pages[p].name);
            if (typeof content !== "string")
              throw new Error("Page is unavailable");
          } catch (error) {
            signal?.throwIfAborted();
            if (saved && p === start) throw stale();
            unreadablePages++;
            continue;
          }
          signal?.throwIfAborted();
          if (saved?.invalidated || request.invalidated) throw stale();
          if (
            saved &&
            p === start &&
            (await hashSHA256(content)) !== saved.pageHash
          )
            throw stale();
          const lines = content.split(/\r?\n/);
          for (
            let i = saved && p === start ? saved.line : 0;
            i < lines.length;
            i++
          ) {
            if (i && i % 10_000 === 0) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              signal?.throwIfAborted();
            }
            const line = lines[i];
            const position = (
              input.caseSensitive ? line : line.toLowerCase()
            ).indexOf(needle);
            if (position < 0) continue;
            if (results.length === input.limit) {
              nextCursor = crypto.randomUUID();
              cursors.set(nextCursor, {
                key,
                listingHash,
                page: pages[p].name,
                line: i,
                pageHash: await hashSHA256(content),
                expires: now() + ttl,
                invalidated: false,
                acceptsPage: input.acceptsPage,
              });
              break;
            }
            const startLine = Math.max(0, i - input.surroundingLines);
            const endLine = Math.min(
              lines.length,
              i + input.surroundingLines + 1,
            );
            const snippetStart = Math.max(0, position - 100);
            results.push({
              page: pages[p].name,
              line: i + 1,
              snippet: line.slice(snippetStart, snippetStart + 500),
              ...(input.surroundingLines
                ? {
                    startLine: startLine + 1,
                    endLine,
                    context: lines
                      .slice(startLine, endLine)
                      .map(
                        (text, index) =>
                          `${startLine + index + 1}: ${text.slice(0, 500)}`,
                      )
                      .join("\n"),
                  }
                : {}),
            });
          }
          if (nextCursor) break;
        }
        signal?.throwIfAborted();
        if (saved?.invalidated || request.invalidated) throw stale();
        return {
          results,
          unreadablePages,
          truncated: nextCursor !== null,
          nextCursor,
        };
      } finally {
        active.delete(request);
      }
    },
  };
}
