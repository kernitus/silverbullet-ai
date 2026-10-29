import { expect, test } from "vitest";
import { computeApprovalDiff } from "./diff.ts";

test.each([
  ["same\nrepeat\nrepeat\nend\n", "same\nrepeat\nnew\nrepeat\nend\n"],
  ["A\nB\nC\nD\n", "C\nD\nA\nB\n"],
  ["one\r\ntwo\r\n", "one\ntwo\n"],
  ["one\n", "one"],
  ["", "new\n"],
  ["deleted", ""],
  ["\n\n", "\n"],
])(
  "preview reconstructs both exact texts including line endings",
  (before, after) => {
    const diff = computeApprovalDiff(before, after);
    expect(
      diff
        .filter((line) => line.type !== "add")
        .map((line) => line.line + line.ending)
        .join(""),
    ).toBe(before);
    expect(
      diff
        .filter((line) => line.type !== "remove")
        .map((line) => line.line + line.ending)
        .join(""),
    ).toBe(after);
  },
);

test("repeated lines keep an insertion local", () => {
  const diff = computeApprovalDiff(
    "same\nrepeat\nrepeat\nend\n",
    "same\nrepeat\nnew\nrepeat\nend\n",
  );
  expect(diff.filter((line) => line.type !== "same")).toEqual([
    { type: "add", line: "new", ending: "\n" },
  ]);
});

test("large notes with a small edit have a complete preview", () => {
  const before = Array.from({ length: 8000 }, (_, i) => `Line ${i}\n`).join("");
  const diff = computeApprovalDiff(
    before,
    before.replace("Line 4000\n", "Changed\n"),
  );
  expect(diff.filter((line) => line.type === "add")).toEqual([
    { type: "add", line: "Changed", ending: "\n" },
  ]);
  expect(diff.filter((line) => line.type === "remove")).toHaveLength(1);
});

test("oversized or expensive edits fail instead of producing an incomplete approval", () => {
  expect(() => computeApprovalDiff("x".repeat(2_000_001), "")).toThrow(
    "too large",
  );
  expect(() => computeApprovalDiff("\n".repeat(20_001), "")).toThrow(
    "too many lines",
  );
  const before = Array.from({ length: 4500 }, (_, i) => `Old ${i}\n`).join("");
  const after = Array.from({ length: 4500 }, (_, i) => `New ${i}\n`).join("");
  expect(() => computeApprovalDiff(before, after)).toThrow("comparison budget");
});
