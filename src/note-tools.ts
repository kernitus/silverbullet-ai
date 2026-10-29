import { space } from "@silverbulletmd/silverbullet/syscalls";
import type { LuaToolDefinition } from "./types.ts";
import { isPathAllowed } from "./utils.ts";

export function buildReadNoteTool(): LuaToolDefinition {
  return {
    source: "builtin",
    handler: "",
    readOnly: true,
    readPathParam: "page",
    description:
      "Read a note with line numbers. Use startLine and endLine for bounded sections. The result reports remaining lines.",
    parameters: {
      type: "object",
      properties: {
        page: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
      },
      required: ["page"],
    },
    execute: async ({ page, startLine = 1, endLine }, permissions, context) => {
      context?.abortSignal?.throwIfAborted();
      if (
        typeof page !== "string" ||
        !isPathAllowed(page, permissions?.allowedReadPaths)
      )
        return { success: false, error: "Read access denied" };
      if (
        !Number.isInteger(startLine) ||
        (startLine as number) < 1 ||
        (endLine !== undefined &&
          (!Number.isInteger(endLine) ||
            (endLine as number) < (startLine as number)))
      )
        return { success: false, error: "Invalid line range" };
      const lines = (await space.readPage(page)).split(/\r?\n/);
      context?.abortSignal?.throwIfAborted();
      const start = startLine as number;
      const end = Math.min(
        (endLine as number | undefined) ?? start + 199,
        start + 199,
        lines.length,
      );
      const selected: string[] = [];
      let size = 0;
      let clipped = false;
      for (let line = start; line <= end; line++) {
        const fullLine = `${line}: ${lines[line - 1]}`;
        const text = fullLine.slice(0, 12000);
        clipped ||= text.length < fullLine.length;
        if (size + text.length > 12000) break;
        selected.push(text);
        size += text.length + 1;
      }
      return {
        success: true,
        result: JSON.stringify({
          page,
          totalLines: lines.length,
          startLine: start,
          endLine: start + selected.length - 1,
          truncated: clipped || start + selected.length - 1 < lines.length,
          content: selected.join("\n"),
        }),
      };
    },
  };
}

type ApproveWrite = (
  page: string,
  content: string,
  runId?: string,
  expected?: string | null,
  signal?: AbortSignal,
) => Promise<{ success: boolean; error?: string }>;

export function buildWriteNoteTool(
  create: boolean,
  approve: ApproveWrite,
): LuaToolDefinition {
  return {
    source: "builtin",
    handler: "",
    readPathParam: "page",
    writePathParam: "page",
    description: create
      ? "Create a new note with a diff preview. Fails if the note already exists."
      : "Replace exactly one occurrence of oldText with newText in a note, with a diff preview. Read the note first. Ambiguous matches are rejected.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: create
        ? { page: { type: "string" }, content: { type: "string" } }
        : {
            page: { type: "string" },
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
          },
      required: create ? ["page", "content"] : ["page", "oldText", "newText"],
    },
    execute: async (args, permissions, context) => {
      context?.abortSignal?.throwIfAborted();
      const { page } = args;
      if (
        typeof page !== "string" ||
        !page.trim() ||
        permissions?.readOnly ||
        !isPathAllowed(page, permissions?.allowedReadPaths) ||
        !isPathAllowed(page, permissions?.allowedWritePaths)
      )
        return { success: false, error: "Note access denied" };
      const exists = await space.pageExists(page);
      if (create && exists)
        return { success: false, error: "Note already exists" };
      if (!create && !exists)
        return { success: false, error: "Note does not exist" };
      const before = exists ? await space.readPage(page) : null;
      let after: string;
      if (create) {
        if (typeof args.content !== "string")
          return { success: false, error: "content must be text" };
        after = args.content;
      } else {
        const { oldText, newText } = args;
        if (
          typeof oldText !== "string" ||
          !oldText ||
          typeof newText !== "string"
        )
          return {
            success: false,
            error: "Provide non-empty oldText and a text replacement",
          };
        const at = before!.indexOf(oldText);
        if (at < 0 || before!.indexOf(oldText, at + 1) >= 0)
          return {
            success: false,
            error:
              "oldText must match exactly once. Read the note and include more surrounding text.",
          };
        after =
          before!.slice(0, at) + newText + before!.slice(at + oldText.length);
      }
      // Space Lua in a note can execute outside this tool's path permissions.
      if (
        (permissions?.allowedReadPaths !== undefined ||
          permissions?.allowedWritePaths !== undefined) &&
        /space-lua/i.test((before ?? "") + after)
      )
        return {
          success: false,
          error: "Restricted agents cannot edit notes containing Space Lua",
        };
      context?.abortSignal?.throwIfAborted();
      const result = await approve(
        page,
        after,
        context?.runId,
        before,
        context?.abortSignal,
      );
      return {
        ...result,
        result: result.success ? `Saved ${page}` : undefined,
      };
    },
  };
}
