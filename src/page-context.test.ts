import { afterEach, expect, test, vi } from "vitest";
import "./mocks/syscalls.ts";
import { currentPageContext } from "./page-context.ts";

afterEach(() => vi.unstubAllGlobals());
test("page content is read only for explicit attachments within scope", async () => {
  const call = vi.fn(async (name: string) => {
    if (name === "editor.getCurrentPage") return "Notes/A";
    if (name === "editor.getSelection") return { text: "Selected text" };
    if (name === "editor.getText") return "Entire note";
    throw new Error(name);
  });
  vi.stubGlobal("syscall", call);
  expect(await currentPageContext()).toEqual({
    text: "Current page: Notes/A\nSelected text (quoted data): Selected text",
  });
  expect(call.mock.calls.some(([name]) => name === "editor.getText")).toBe(
    false,
  );
  call.mockClear();
  expect(await currentPageContext(["Private"], true)).toEqual({
    text: "Current page is outside the agent's allowed paths.",
  });
  expect(call).toHaveBeenCalledTimes(1);
  expect((await currentPageContext(["Notes"], true)).attachment).toEqual({
    page: "Notes/A",
    content: "Entire note",
  });
});
