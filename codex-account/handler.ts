import {
  createChatGPTHandler,
  type CreateChatGPTHandlerOptions,
} from "@opencoredev/loginwithchatgpt-server";
import { createParser } from "eventsource-parser";
import { EventSourceParserStream } from "eventsource-parser/stream";

export const ACCOUNT_PATH = "/api/chatgpt";

// Adapt only the non-streaming HTTP envelope. The provider library owns OAuth
// and Codex transport; Vercel's OpenAI provider owns message and tool conversion.
export async function completedResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  if (!response.body)
    return Response.json(
      { error: { message: "Codex returned an empty stream" } },
      { status: 502 },
    );
  const events = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());
  const reader = events.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.data === "[DONE]") continue;
      const event = JSON.parse(value.data);
      if (event.type === "response.completed")
        return Response.json(event.response, {
          headers: { "Cache-Control": "no-store" },
        });
      if (
        ["response.failed", "response.incomplete", "error"].includes(event.type)
      )
        return Response.json(
          {
            error: {
              message:
                "Codex did not complete the response. Check your account usage or try a smaller request.",
            },
          },
          { status: 502 },
        );
    }
    return Response.json(
      { error: { message: "Codex stream ended before completion" } },
      { status: 502 },
    );
  } finally {
    await reader.cancel();
  }
}

export function validatedStream(response: Response): Response {
  if (!response.ok || !response.body) return response;
  let completed = false;
  const decoder = new TextDecoder();
  const parser = createParser({
    onEvent: (event) => {
      if (event.data === "[DONE]") return;
      const value = JSON.parse(event.data);
      if (value.type === "response.completed") completed = true;
      if (
        ["response.failed", "response.incomplete", "error"].includes(value.type)
      )
        throw new Error("Codex did not complete the response");
    },
  });
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        parser.feed(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        parser.feed(decoder.decode());
        if (!completed) throw new Error("Codex stream ended before completion");
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    },
  });
}

export function accountHandler(
  publicOrigin: string,
  options: CreateChatGPTHandlerOptions,
) {
  const origin = new URL(publicOrigin).origin;
  const auth = createChatGPTHandler({
    ...options,
    basePath: ACCOUNT_PATH,
    cookieName: "sb_ai_codex",
    cookie: {
      path: ACCOUNT_PATH,
      secure: origin.startsWith("https:"),
      httpOnly: true,
      sameSite: "Strict",
    },
    allowedOrigins: [origin],
    dangerouslyAllowTokenExport: false,
    dangerouslyAllowRefreshTokenExport: false,
  });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host !== new URL(origin).host)
      return new Response("Unexpected host", { status: 403 });
    const requestOrigin = request.headers.get("origin");
    if (
      (requestOrigin && requestOrigin !== origin) ||
      (request.method !== "GET" && requestOrigin !== origin)
    )
      return new Response("Unexpected origin", { status: 403 });
    if (
      ![
        "/login",
        "/status",
        "/session",
        "/logout",
        "/models",
        "/responses",
      ].some((path) => url.pathname === ACCOUNT_PATH + path)
    )
      return new Response("Not found", { status: 404 });
    try {
      if (
        url.pathname === `${ACCOUNT_PATH}/responses` &&
        request.method === "POST"
      ) {
        const text = await request.text();
        if (new TextEncoder().encode(text).length > 8 * 1024 * 1024)
          return new Response("Request too large", { status: 413 });
        const body = JSON.parse(text);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          typeof body.model !== "string" ||
          !body.model.trim()
        )
          return new Response("A model is required", { status: 400 });
        const stream = body.stream === true;
        const response = await auth.handler(
          new Request(request.url, {
            method: "POST",
            headers: request.headers,
            signal: request.signal,
            body: JSON.stringify({ ...body, stream: true, store: false }),
          }),
        );
        return stream ? validatedStream(response) : completedResponse(response);
      }
      const response = await auth.handler(request);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      return Response.json(
        {
          error:
            error instanceof SyntaxError
              ? "Invalid JSON"
              : "Codex account request failed",
        },
        { status: error instanceof SyntaxError ? 400 : 502 },
      );
    }
  };
}
