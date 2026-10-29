import { afterEach, expect, test, vi } from "vitest";

import { buildProxyUrl, proxiedFetch } from "./proxy.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each([
  "https://localhost:8443/v1",
  "https://192.168.1.2/v1",
  "https://host.docker.internal/v1",
  "https://localhost.example.com/v1",
  "http://model-server:8080/v1",
  "http://example.com/v1",
  "http://[::1]:8080/v1",
])("rejects scheme changes before sending credentials: %s", async (url) => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    proxiedFetch(
      url,
      { headers: { Authorization: "Bearer secret" } },
      true,
      1000,
      "AI",
    ),
  ).rejects.toThrow("Set useProxy = false");
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  ["http://localhost:8080/v1", "/.proxy/localhost:8080/v1"],
  ["http://192.168.1.2/v1", "/.proxy/192.168.1.2/v1"],
  ["https://[::1]:8443/v1", "/.proxy/[::1]:8443/v1"],
  ["HTTPS://EXAMPLE.COM/v1?q=a%20b#fragment", "/.proxy/example.com/v1?q=a%20b"],
])("preserves supported proxy destinations: %s", (url, expected) => {
  expect(buildProxyUrl(url)).toBe(expected);
});

test("preserves the SilverBullet URL prefix", () => {
  vi.stubGlobal("location", { pathname: "/notes/.fs/_plug/ai.plug.js" });
  expect(buildProxyUrl("https://example.com/v1")).toBe(
    "/notes/.proxy/example.com/v1",
  );
});

test("rejects unsupported protocols and URL credentials", () => {
  expect(() => buildProxyUrl("ftp://example.com/file")).toThrow(
    "only supports HTTP",
  );
  expect(() => buildProxyUrl("https://user:secret@example.com/v1")).toThrow(
    "containing credentials",
  );
});

test("direct requests preserve the configured scheme", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
  await proxiedFetch("https://localhost:8443/v1", {}, false, 1000, "AI");
  expect(fetchMock.mock.calls[0][0]).toBe("https://localhost:8443/v1");
});

test("proxy responses remain streamed", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(stream, {
        headers: { "x-proxy-status-code": "200" },
      }),
    ),
  );
  const response = await proxiedFetch(
    "https://example.com/v1",
    {},
    true,
    1000,
    "AI",
  );
  const reader = response.body!.getReader();
  controller.enqueue(new TextEncoder().encode("first chunk"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    "first chunk",
  );
  controller.close();
  expect((await reader.read()).done).toBe(true);
});

test("proxiedFetch surfaces the upstream status and headers", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: {
          "x-proxy-status-code": "429",
          "x-proxy-header-content-type": "application/json",
        },
      }),
    ),
  );

  const res = await proxiedFetch(
    "https://example.com/v1/chat/completions",
    { method: "POST" },
    true,
    1000,
    "Ollama",
  );

  expect(res.status).toEqual(429);
  expect(res.ok).toEqual(false);
  expect(res.headers.get("content-type")).toEqual("application/json");
});

test("proxiedFetch proxies the URL exactly once and tunnels headers", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response("{}", { headers: { "x-proxy-status-code": "200" } }),
    );
  vi.stubGlobal("fetch", fetchMock);

  await proxiedFetch(
    "https://example.com/v1/models",
    { headers: { Authorization: "Bearer sk-test" } },
    true,
    1000,
    "OpenAI",
  );

  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toEqual("/.proxy/example.com/v1/models");
  expect(init.headers).toEqual({
    "X-Proxy-Request": "true",
    "X-Proxy-Header-Authorization": "Bearer sk-test",
  });
});

test("proxiedFetch tunnels headers given as a Headers instance", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response("{}", { headers: { "x-proxy-status-code": "200" } }),
    );
  vi.stubGlobal("fetch", fetchMock);

  await proxiedFetch(
    "https://example.com/v1/models",
    { headers: new Headers({ Authorization: "Bearer sk-test" }) },
    true,
    1000,
    "OpenAI",
  );

  // Headers lowercases names; the proxy re-canonicalizes them upstream.
  expect(fetchMock.mock.calls[0][1].headers).toEqual({
    "X-Proxy-Request": "true",
    "X-Proxy-Header-authorization": "Bearer sk-test",
  });
});

test("proxiedFetch applies the configured timeout, not SilverBullet's", async () => {
  // Only settles when our AbortSignal fires, mimicking a model that stalls.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    ),
  );

  await expect(
    proxiedFetch(
      "https://example.com/v1/chat/completions",
      {},
      true,
      20,
      "Ollama",
    ),
  ).rejects.toThrow("Request to Ollama timed out after 0.02s");
});

test("proxiedFetch preserves caller cancellation", async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    ),
  );
  const request = proxiedFetch(
    "https://example.com",
    { signal: controller.signal },
    false,
    1000,
    "SDK",
  );
  controller.abort(new Error("Cancelled by caller"));
  await expect(request).rejects.toThrow("Cancelled by caller");
});
