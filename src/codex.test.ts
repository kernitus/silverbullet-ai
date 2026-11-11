import { afterEach, expect, test, vi } from "vitest";
import "./mocks/syscalls.ts";
import { syscall } from "@silverbulletmd/silverbullet/syscalls";
import { codexAccountStatus, codexAccountLogout, codexFetch } from "./codex.ts";
import { parseDefaultModelString } from "./init.ts";

afterEach(() => vi.unstubAllGlobals());
test("Codex transport removes only the SDK placeholder and retains cookie authentication", async () => {
  const fetch = vi.fn(async () => Response.json({ status: "ok" }));
  vi.stubGlobal("fetch", fetch);
  const transport = codexFetch({ useProxy: false, timeout: 1000 });
  await transport("/api/chatgpt/responses", {
    method: "POST",
    headers: { Authorization: "Bearer login-with-chatgpt-proxy", "Content-Type": "application/json" },
    body: "{}",
  });
  const init = (fetch.mock.calls as unknown as [string, RequestInit][])[0][1];
  expect(new Headers(init.headers).has("authorization")).toBe(false);
  expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  expect(init.credentials).toBe("include");
  expect(init.redirect).toBe("error");
  await transport(new Request("https://notes.example.com/api/chatgpt/status", {
    headers: { Authorization: "Basic dGVzdDp0ZXN0" },
  }));
  const second = (fetch.mock.calls as unknown as [Request, RequestInit][])[1][1];
  expect(new Headers(second.headers).get("authorization")).toBe("Basic dGVzdDp0ZXN0");
});
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
