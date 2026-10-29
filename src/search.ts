import { space } from "@silverbulletmd/silverbullet/syscalls";
import { aiSettings, currentEmbeddingProvider } from "./init.ts";
import { searchEmbeddings } from "./embeddings.ts";
import { isPathAllowed } from "./utils.ts";
import type { LuaToolDefinition, PathPermissions } from "./types.ts";
import type { ToolExecutionResult } from "./tools.ts";

export function matchesSearchPath(page: string, path?: string): boolean {
  if (!path) return true;
  const prefix = path.replace(/\/+$/, "");
  return page === prefix || page.startsWith(`${prefix}/`);
}

export async function searchNotes(
  args: Record<string, unknown>,
  permissions?: PathPermissions,
): Promise<ToolExecutionResult> {
  const {
    query,
    mode = "text",
    path,
    limit = 20,
    caseSensitive = false,
  } = args;
  if (typeof query !== "string" || !query.trim() || query.length > 1000)
    return {
      success: false,
      error: "query must contain 1 to 1000 characters.",
    };
  if (mode !== "text" && mode !== "semantic")
    return { success: false, error: "mode must be text or semantic." };
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
      const results = await searchEmbeddings(query, limit, false, {
        allowedReadPaths: permissions?.allowedReadPaths,
        path: path as string | undefined,
      });
      return {
        success: true,
        result: JSON.stringify({
          mode,
          results: results.map((r) => ({
            page: r.page,
            ref: r.ref,
            similarity: r.similarity,
            snippet: r.text.slice(0, 500),
          })),
        }),
        summary: `Semantic search returned ${results.length} matches`,
      };
    }

    const needle = caseSensitive ? query : query.toLowerCase();
    const results: { page: string; line: number; snippet: string }[] = [];
    let unreadablePages = 0;
    let truncated = false;
    const pages = (await space.listPages())
      .filter(
        (p) =>
          isPathAllowed(p.name, permissions?.allowedReadPaths) &&
          matchesSearchPath(p.name, path as string | undefined),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    search: for (const page of pages) {
      let content: string;
      try {
        content = await space.readPage(page.name);
      } catch {
        unreadablePages++;
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const position = (caseSensitive ? line : line.toLowerCase()).indexOf(
          needle,
        );
        if (position < 0) continue;
        if (results.length === limit) {
          truncated = true;
          break search;
        }
        const start = Math.max(0, position - 100);
        results.push({
          page: page.name,
          line: i + 1,
          snippet: line.slice(start, start + 500),
        });
      }
    }
    return {
      success: true,
      result: JSON.stringify({ mode, results, truncated, unreadablePages }),
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
      "Search note contents explicitly. Text mode finds literal text and returns page names, line numbers and snippets, like grep -F. Semantic mode finds related indexed passages and requires embeddings. Use read_note for more context. Results respect the current agent's read permissions.",
    readOnly: true,
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
          enum: ["text", "semantic"],
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
