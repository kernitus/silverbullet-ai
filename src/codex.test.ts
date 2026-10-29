import { afterEach, expect, test, vi } from "vitest";
import "./mocks/syscalls.ts";
import { syscall } from "@silverbulletmd/silverbullet/syscalls";
import { codexAccountStatus, codexAccountLogout } from "./codex.ts";
import { parseDefaultModelString } from "./init.ts";

afterEach(() => vi.unstubAllGlobals());
test("Codex account commands work without a selected model or API key", async () => {
  await syscall("mock.clearClientStore");
  await syscall("mock.setConfig", "ai", {
    providers: {
      codex: { provider: "codex", baseUrl: "/api/chatgpt", useProxy: false },
    },
  });
  const fetch = vi.fn(async () =>
    Response.json({
      status: "authenticated",
      user: { email: "test@example.com" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  expect((await codexAccountStatus("codex")).status).toBe("authenticated");
  const model = parseDefaultModelString("codex:future-model")!;
  expect(model).toMatchObject({
    provider: "codex",
    requireAuth: false,
    baseUrl: "/api/chatgpt",
    useProxy: false,
  });
  await codexAccountLogout("codex");
  expect(
    (fetch.mock.calls as unknown as [string, RequestInit][]).at(-1),
  ).toMatchObject([
    "/api/chatgpt/logout",
    { method: "POST", credentials: "include" },
  ]);
  await expect(codexAccountStatus("openai")).rejects.toThrow(
    "Configure a provider",
  );
});
