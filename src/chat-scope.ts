import type { PathPermissions } from "./types.ts";

export type ChatScope = { kind: "note" | "folder"; path: string };
export type PathRule = string | { exact: string } | { folder: string };

export function scopePermissions(scope: ChatScope): PathPermissions {
  const rule: PathRule =
    scope.kind === "note" ? { exact: scope.path } : { folder: scope.path };
  return {
    allowedReadPaths: [rule],
    allowedWritePaths: [rule],
    allowUnsafeLua: false,
  };
}

export function noteFolders(pages: { name: string }[]): string[] {
  const folders = new Set<string>();
  for (const { name } of pages) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++)
      folders.add(parts.slice(0, i).join("/"));
  }
  return [...folders].sort((a, b) => a.localeCompare(b));
}
