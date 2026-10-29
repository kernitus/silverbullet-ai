import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountHandler,
  completedResponse,
  validatedStream,
} from "./handler.ts";
import { SessionStore } from "./store.ts";

const origin = "https://notes.example.com";
const json = (body: unknown) => Response.json(body);
const events = (values: unknown[]) =>
  new Response(
    values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

test("device login, encrypted persistence, model discovery, Responses and logout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sb-codex-account-"));
  const path = join(directory, "sessions.sqlite");
  let store = new SessionStore(path);
  let cookie = "";
  let now = Date.now();
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const upstream = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ url, body, headers });
    if (url.endsWith("/deviceauth/usercode"))
      return json({ device_auth_id: "device", user_code: "CODE", interval: 1 });
    if (url.endsWith("/deviceauth/token"))
      return json({
        authorization_code: "code",
        code_verifier: "verifier",
        code_challenge: "challenge",
      });
    if (url.endsWith("/oauth/token"))
      return json({
        access_token: "private-access-token",
        refresh_token: "private-refresh-token",
        id_token: `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }))}.signature`,
        expires_in: 3600,
      });
    if (url.includes("/models"))
      return json({
        models: [
          {
            slug: "future-model",
            display_name: "Future model",
            visibility: "list",
          },
        ],
      });
    if (url.includes("/responses"))
      return events([
        {
          type: "response.completed",
          response: {
            id: "response",
            output: [
              {
                type: "function_call",
                name: "search_notes",
                call_id: "call",
                arguments: '{"query":"notes"}',
              },
            ],
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          },
        },
      ]);
    throw new Error(`Unexpected endpoint ${url}`);
  };
  // OAuth's token exchange uses URL-encoded form data rather than JSON.
  const transport = (input: RequestInfo | URL, init?: RequestInit) =>
    upstream(
      input,
      String(input).endsWith("/oauth/token")
        ? { ...init, body: undefined }
        : init,
    );
  const options = {
    secret: "test-only-secret-that-is-long-enough",
    fetch: Object.assign(transport, { preconnect() {} }),
    now: () => now,
  };
  let handler = accountHandler(origin, { ...options, sessionStore: store });
  const request = (path: string, body?: unknown) =>
    handler(
      new Request(`${origin}/api/chatgpt/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  try {
    expect((await request("models")).status).toBe(401);
    const login = await request("login", {});
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    cookie = setCookie.split(";")[0];
    expect(await login.json()).toMatchObject({
      status: "pending",
      userCode: "CODE",
    });
    now += 6000;
    const status = await request("status");
    expect(await status.json()).toMatchObject({ status: "authenticated" });
    expect(await readFile(path, "utf8")).not.toContain("private-access-token");
    expect(await readFile(path, "utf8")).not.toContain("private-refresh-token");
    store.close();
    store = new SessionStore(path);
    handler = accountHandler(origin, { ...options, sessionStore: store });
    expect(await (await request("models")).json()).toEqual({
      models: ["future-model"],
    });
    for (const stream of [false, true]) {
      const response = await request("responses", {
        model: "future-model",
        input: [],
        tools: [
          {
            type: "function",
            name: "search_notes",
            parameters: { type: "object" },
          },
        ],
        stream,
      });
      expect(response.status).toBe(200);
      if (stream) expect(await response.text()).toContain("response.completed");
      else
        expect(await response.json()).toMatchObject({
          output: [{ type: "function_call", name: "search_notes" }],
        });
      const call = calls.at(-1)!;
      expect(call.body).toMatchObject({
        model: "future-model",
        stream: true,
        store: false,
        tools: [{ name: "search_notes" }],
      });
      expect(call.headers.get("authorization")).toBe(
        "Bearer private-access-token",
      );
    }
    await request("logout", {});
    expect((await request("models")).status).toBe(401);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});

test("rejects cross-site requests, unexpected hosts and token-export paths", async () => {
  const handler = accountHandler(origin, { secret: "test-secret" });
  expect(
    (
      await handler(
        new Request(`${origin}/api/chatgpt/login`, {
          method: "POST",
          headers: { origin: "https://evil.example" },
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (await handler(new Request("https://evil.example/api/chatgpt/session")))
      .status,
  ).toBe(403);
  expect(
    (await handler(new Request(`${origin}/api/chatgpt/tokens`))).status,
  ).toBe(404);
});

test("non-streaming requests reject failed and interrupted event streams", async () => {
  for (const values of [
    [],
    [{ type: "response.failed" }],
    [{ type: "response.incomplete" }],
    [{ type: "error" }],
  ]) {
    expect((await completedResponse(events(values))).status).toBe(502);
  }
});

test("streaming calls surface missing terminal events and upstream failures", async () => {
  for (const values of [
    [],
    [{ type: "response.failed" }],
    [{ type: "response.incomplete" }],
  ])
    await expect(validatedStream(events(values)).text()).rejects.toThrow(
      /Codex/,
    );
  expect(
    await validatedStream(
      events([{ type: "response.completed", response: {} }]),
    ).text(),
  ).toContain("response.completed");
});
