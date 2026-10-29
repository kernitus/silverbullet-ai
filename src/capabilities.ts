import type { LuaToolDefinition, PathPermissions } from "./types.ts";

export function isRestricted(permissions?: PathPermissions): boolean {
  return (
    permissions?.allowedReadPaths !== undefined ||
    permissions?.allowedWritePaths !== undefined ||
    permissions?.readOnly === true
  );
}

// Lua metadata describes intent; it cannot sandbox a handler or an MCP server.
export function canUseTool(
  name: string,
  tool: LuaToolDefinition,
  permissions?: PathPermissions,
): boolean {
  if (
    (name === "eval_lua" || tool.unsafeLua) &&
    (permissions?.allowUnsafeLua !== true || isRestricted(permissions))
  )
    return false;
  if (isRestricted(permissions) && tool.source !== "builtin") return false;
  if (permissions?.readOnly && !tool.readOnly) return false;
  return true;
}

export function filterCapabilities(
  tools: Map<string, LuaToolDefinition>,
  permissions?: PathPermissions,
): Map<string, LuaToolDefinition> {
  return new Map(
    [...tools].filter(([name, tool]) => canUseTool(name, tool, permissions)),
  );
}
