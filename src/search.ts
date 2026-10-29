import { rank } from "@silverbulletmd/silverbullet/lib/fuzzy";
import { space } from "@silverbulletmd/silverbullet/syscalls";
import { aiSettings, currentEmbeddingProvider } from "./init.ts";
import { searchEmbeddings } from "./embeddings.ts";
import { isPathAllowed } from "./utils.ts";
import type {
  LuaToolDefinition,
  PathPermissions,
  ToolExecutionContext,
} from "./types.ts";
import type { ToolExecutionResult } from "./tools.ts";

export function matchesSearchPath(page: string, path?: string): boolean {
  if (!path) return true;
  const prefix = path.replace(/\/+$/, "");
  return page === prefix || page.startsWith(`${prefix}/`);
}

export async function searchNotes(
  args: Record<string, unknown>,
  permissions?: PathPermissions,
  context?: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  context?.abortSignal?.throwIfAborted();
  const {
    query,
    mode = "text",
    path,
    limit = 20,
    caseSensitive = false,
    offset = 0,
    surroundingLines = 0,
  } = args;
  if (typeof query !== "string" || !query.trim() || query.length > 1000)
    return {
      success: false,
      error: "query must contain 1 to 1000 characters.",
    };
  if (!["text", "semantic", "title", "path"].includes(String(mode)))
    return {
      success: false,
      error: "mode must be text, semantic, title or path.",
    };
  if (
    !Number.isInteger(offset) ||
    (offset as number) < 0 ||
    (offset as number) > 10000 ||
    !Number.isInteger(surroundingLines) ||
    (surroundingLines as number) < 0 ||
    (surroundingLines as number) > 5
  )
    return {
      success: false,
      error: "offset must be 0 to 10000 and surroundingLines 0 to 5.",
    };
  if (
    path !== undefined &&
    (typeof path !== "string" ||
      path.split("/").some((p) => p === "." || p === ".."))
  )
    return {
      success: false,
      error: "path must be a note or folder without dot segments.",
    };
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    return {
      success: false,
      error: "limit must be an integer between 1 and 50.",
    };
  if (typeof caseSensitive !== "boolean")
    return { success: false, error: "caseSensitive must be a boolean." };

  try {
    if (mode === "semantic") {
      if (!aiSettings?.indexEmbeddings || !currentEmbeddingProvider)
        return {
          success: false,
          error:
            "Semantic search requires enabled embedding indexing and an embedding model. Use text mode otherwise.",
        };
      const results = await searchEmbeddings(
        query,
        (offset as number) + limit + 1,
        false,
        {
          allowedReadPaths: permissions?.allowedReadPaths,
          path: path as string | undefined,
          abortSignal: context?.abortSignal,
        },
      );
      context?.abortSignal?.throwIfAborted();
      return {
        success: true,
        result: JSON.stringify({
          mode,
          nextOffset:
            results.length > (offset as number) + limit
              ? (offset as number) + limit
              : null,
          results: results
            .slice(offset as number, (offset as number) + limit)
            .map((r) => ({
              page: r.page,
              ref: r.ref,
              similarity: r.similarity,
              snippet: r.text.slice(0, 500),
            })),
        }),
        summary: `Semantic search returned ${results.slice(offset as number, (offset as number) + limit).length} matches`,
      };
    }

    const needle = caseSensitive ? query : query.toLowerCase();
    const results: {
      page: string;
      line: number;
      snippet: string;
      context?: string;
      startLine?: number;
      endLine?: number;
    }[] = [];
    let skipped = 0;
    let unreadablePages = 0;
    let truncated = false;
    const pages = (await space.listPages())
      .filter(
        (p) =>
          isPathAllowed(p.name, permissions?.allowedReadPaths) &&
          matchesSearchPath(p.name, path as string | undefined),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    if (mode === "title" || mode === "path") {
      const ranked = rank(
        pages.map((p) => ({
          page: p.name,
          name: mode === "title" ? p.name.split("/").at(-1)! : p.name,
        })),
        query,
        { fields: { name: { weight: 1, segments: mode === "path" } } },
      ).filter((p) => !caseSensitive || p.name.includes(query));
      return {
        success: true,
        result: JSON.stringify({
          mode,
          results: ranked
            .slice(offset as number, (offset as number) + limit)
            .map((p) => ({ page: p.page })),
          nextOffset:
            ranked.length > (offset as number) + limit
              ? (offset as number) + limit
              : null,
        }),
      };
    }
    search: for (const page of pages) {
      context?.abortSignal?.throwIfAborted();
      let content: string;
      try {
        content = await space.readPage(page.name);
      } catch {
        unreadablePages++;
        continue;
      }
      context?.abortSignal?.throwIfAborted();
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const position = (caseSensitive ? line : line.toLowerCase()).indexOf(
          needle,
        );
        if (position < 0) continue;
        if (skipped++ < (offset as number)) continue;
        if (results.length === limit) {
          truncated = true;
          break search;
        }
        const start = Math.max(0, position - 100);
        results.push({
          page: page.name,
          line: i + 1,
          snippet: line.slice(start, start + 500),
          ...(surroundingLines
            ? {
                startLine: Math.max(0, i - (surroundingLines as number)) + 1,
                endLine: Math.min(
                  lines.length,
                  i + (surroundingLines as number) + 1,
                ),
                context: lines
                  .slice(
                    Math.max(0, i - (surroundingLines as number)),
                    i + (surroundingLines as number) + 1,
                  )
                  .map(
                    (text, index) =>
                      `${Math.max(0, i - (surroundingLines as number)) + index + 1}: ${text.slice(0, 500)}`,
                  )
                  .join("\n"),
              }
            : {}),
        });
      }
    }
    return {
      success: true,
      result: JSON.stringify({
        mode,
        results,
        truncated,
        unreadablePages,
        nextOffset: truncated ? (offset as number) + results.length : null,
      }),
      summary: `Text search returned ${results.length} matches${truncated ? " (limit reached)" : ""}`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildSearchNotesTool(): LuaToolDefinition {
  return {
    description:
      "Search notes explicitly. Title and path modes rank note names without reading contents. Text mode finds literal text and returns page names, line numbers and snippets, like grep -F. Semantic mode finds related indexed passages and requires embeddings. Use read_note for more context. Results respect the current agent's read permissions.",
    readOnly: true,
    source: "builtin",
    handler: "",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to find, or a semantic search question.",
        },
        mode: {
          type: "string",
          enum: ["text", "semantic", "title", "path"],
          description:
            "Defaults to text. No regular expressions or shell commands.",
        },
        path: {
          type: "string",
          description: "Optional note name or folder to narrow the search.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum matches, default 20.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: 10000,
          description:
            "Use nextOffset from the previous result with the same search arguments.",
        },
        surroundingLines: {
          type: "integer",
          minimum: 0,
          maximum: 5,
          description: "Surrounding lines for text matches, default 0.",
        },
        caseSensitive: {
          type: "boolean",
          description: "Text mode only. Defaults to false.",
        },
      },
      required: ["query"],
    },
    execute: searchNotes,
  };
}
