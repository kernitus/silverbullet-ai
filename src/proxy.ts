// Route outbound requests through SilverBullet's `/.proxy/` endpoint to avoid
// browser CORS. Dependency-free leaf so providers and the MCP client can share
// it. Originally from silverbullet/client/plugos/syscalls/fetch.ts.

export function buildProxyHeaders(
  headers?: Record<string, any>,
): Record<string, any> {
  const newHeaders: Record<string, any> = { "X-Proxy-Request": "true" };
  if (!headers) {
    return newHeaders;
  }
  for (const [key, value] of Object.entries(headers)) {
    newHeaders[`X-Proxy-Header-${key}`] = value;
  }
  return newHeaders;
}

class ProxySchemeError extends Error {}

function proxyBase(): string {
  const pathname = globalThis.location?.pathname ?? "";
  return pathname.includes("/.fs/") ? pathname.split("/.fs/")[0] : "";
}

export function buildProxyUrl(url: string): string {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("SilverBullet's proxy only supports HTTP and HTTPS URLs.");
  }
  if (target.username || target.password) {
    throw new Error(
      "URLs containing credentials cannot use SilverBullet's proxy. Use an Authorization header instead.",
    );
  }
  // Match the server's heuristic exactly, including its prefix matching. The
  // proxy protocol omits the scheme and offers no way to override this choice.
  const path = `${target.host}${target.pathname}${target.search}`;
  const proxyProtocol =
    /^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+|host\.docker\.internal)/.test(
      path,
    )
      ? "http:"
      : "https:";
  if (target.protocol !== proxyProtocol) {
    throw new ProxySchemeError(
      `SilverBullet's proxy would change the configured ${target.protocol.slice(0, -1).toUpperCase()} URL to ${proxyProtocol.slice(0, -1).toUpperCase()}. ` +
        "Set useProxy = false for this connection and allow browser access (CORS) on the endpoint. " +
        "An HTTPS SilverBullet page also requires an HTTPS endpoint for direct requests.",
    );
  }
  // Plug workers are loaded from <prefix>/.fs/..., so derive the prefix from our
  // own location to support SilverBullet instances hosted under a URL prefix.
  return `${proxyBase()}/.proxy/${path}`;
}

// When proxied, SilverBullet returns its own 200 and moves the upstream status to
// `x-proxy-status-code` and upstream headers to `x-proxy-header-*`. These read the
// real values back (and fall through to the direct response when not proxying).
export function readResponseHeader(
  res: Response,
  name: string,
  useProxy: boolean,
): string | undefined {
  if (useProxy) {
    return (
      res.headers.get(`x-proxy-header-${name}`) ??
      res.headers.get(name) ??
      undefined
    );
  }
  return res.headers.get(name) ?? undefined;
}

export function readStatus(res: Response, useProxy: boolean): number {
  if (useProxy) {
    const s = res.headers.get("x-proxy-status-code");
    if (s) return Number(s);
  }
  return res.status;
}

// Rebuild a proxied response as if it came straight from upstream, so callers can
// use `res.ok`/`res.status`/`res.headers` normally. Mirrors what SilverBullet's
// own worker fetch shim does with the `x-proxy-*` headers.
function unwrapProxyResponse(res: Response): Response {
  const headers = new Headers();
  for (const [key, value] of res.headers.entries()) {
    if (key.toLowerCase().startsWith("x-proxy-header-")) {
      headers.set(key.slice("x-proxy-header-".length), value);
    }
  }
  const status = readStatus(res, true);
  // Pass the body through rather than buffering it; the Response constructor
  // rejects a body for these statuses.
  const body =
    status === 204 || status === 205 || status === 304 ? null : res.body;
  return new Response(body, { status, headers });
}

// `RequestInit.headers` may also be a Headers instance or an array of tuples,
// and `Object.entries` yields nothing for either — which would silently drop
// every header, Authorization included.
function toHeaderRecord(
  headers: HeadersInit | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers || Array.isArray(headers)) {
    return Object.fromEntries(new Headers(headers).entries());
  }
  return headers as Record<string, string>;
}

// The plug worker's `fetch` is monkey-patched to route through SilverBullet's
// `sandboxFetch` syscall, which drops our AbortSignal and applies its own
// non-configurable 30s cap. We build the proxy URL and headers ourselves, so
// always go through the original. Resolved at call time; outside a plug worker
// there is no `nativeFetch`.
const rawFetch: typeof fetch = (url, init) =>
  ((globalThis as any).nativeFetch ?? globalThis.fetch)(url, init);

async function proxyUrlForFetch(
  url: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    return buildProxyUrl(url);
  } catch (error) {
    if (!(error instanceof ProxySchemeError)) throw error;
    // Probe without provider headers or a target URL. Older servers must never
    // receive credentials for a request whose scheme they would change.
    const capability = await rawFetch(`${proxyBase()}/.proxy/`, {
      method: "OPTIONS",
      headers: { "X-Proxy-Request": "true" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (
      capability.status !== 204 ||
      capability.headers.get("x-silverbullet-proxy-version") !== "2"
    )
      throw error;
    const target = new URL(url);
    target.hash = "";
    return `${proxyBase()}/.proxy/${encodeURIComponent(target.href)}`;
  }
}

/**
 * Fetch through `/.proxy/` when `useProxy` is set, with `timeout` as the only
 * request deadline.
 */
export async function proxiedFetch(
  url: string,
  options: RequestInit,
  useProxy: boolean,
  timeout: number,
  name: string,
): Promise<Response> {
  try {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);
    const target = useProxy ? await proxyUrlForFetch(url, signal) : url;
    const res = await rawFetch(target, {
      ...options,
      headers: useProxy
        ? buildProxyHeaders(toHeaderRecord(options.headers))
        : options.headers,
      signal,
    });
    return useProxy ? unwrapProxyResponse(res) : res;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `Request to ${name} timed out after ${timeout / 1000}s. ` +
          `Increase timeout in provider config.`,
      );
    }
    throw error;
  }
}

/** Adapt the SDK fetch contract to SilverBullet's proxy without buffering streams. */
export function sdkFetch(
  useProxy: boolean,
  timeout: number,
  name: string,
): typeof fetch {
  return (input, init) => {
    const request = input instanceof Request ? input : undefined;
    return proxiedFetch(
      request?.url ?? String(input),
      {
        ...(request
          ? {
              method: request.method,
              headers: request.headers,
              body: request.body,
              signal: request.signal,
            }
          : {}),
        ...init,
      },
      useProxy,
      timeout,
      name,
    );
  };
}
