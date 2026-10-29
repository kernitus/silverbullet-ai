import { diffLines } from "diff";

export type DiffLine = {
  type: "add" | "remove" | "same";
  line: string;
  ending: "\n" | "\r\n" | "";
};

// Bound both tokenisation and the library's worst-case comparison work. A
// preview that cannot be calculated must never turn into a blind approval.
export function computeApprovalDiff(before: string, after: string): DiffLine[] {
  if (before.length + after.length > 2_000_000)
    throw new Error(
      "Edit is too large to preview safely. Propose a smaller edit.",
    );
  const lineCount =
    (before.match(/\n/g)?.length ?? 0) + (after.match(/\n/g)?.length ?? 0);
  if (lineCount > 20_000)
    throw new Error(
      "Edit has too many lines to preview safely. Propose a smaller edit.",
    );
  const changes = diffLines(before, after, {
    timeout: 100,
    maxEditLength: 4000,
  });
  if (!changes)
    throw new Error(
      "Diff exceeded its comparison budget. Propose a smaller edit.",
    );
  return changes.flatMap((change): DiffLine[] =>
    (change.value.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((text) => {
      const ending = text.endsWith("\r\n")
        ? "\r\n"
        : text.endsWith("\n")
          ? "\n"
          : "";
      return {
        type: change.added ? "add" : change.removed ? "remove" : "same",
        line: ending ? text.slice(0, -ending.length) : text,
        ending,
      };
    }),
  );
}
