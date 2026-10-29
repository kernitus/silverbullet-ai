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
