# Codex account access

The `codex` provider uses your ChatGPT account's Codex allowance through a local companion service. It does not require an OpenAI Platform API key. The plug uses the Vercel AI SDK Responses provider and retains its own note tools, approvals, cancellation and conversation history.

The integration uses the MIT-licensed [`@opencoredev/loginwithchatgpt-ai` and `@opencoredev/loginwithchatgpt-server`](https://github.com/opencoredev/login-with-chatgpt) libraries. They handle device-code authentication, token refresh and the Codex transport. This is a community integration with the Codex backend, whose protocol can change. It is separate from OpenAI's newer Sign in with ChatGPT plan-sharing integration.

## Run the account service

The companion requires Bun 1.4.4. From this repository:

```sh
bun install --cwd codex-account --production --frozen-lockfile
SB_CODEX_ORIGIN=https://notes.example.com bun run --cwd codex-account start
```

Replace the origin with your SilverBullet origin. The service listens on `127.0.0.1:8321`. Route `/api/chatgpt/*` on the **same origin as SilverBullet** to that service, preserving the path, cookies and Host header. For example, in an existing Caddy site:

```caddy
handle /api/chatgpt/* {
    reverse_proxy 127.0.0.1:8321
}

handle {
    reverse_proxy 127.0.0.1:3000
}
```

Use your actual SilverBullet address in the second handler. The account service rejects foreign origins and unexpected Host headers. Do not route these requests through SilverBullet's `/.proxy/` endpoint: authentication uses a browser session cookie. Keep the companion private to your own SilverBullet installation.

The service saves encrypted sessions and a private encryption key under `~/.local/share/silverbullet-ai-codex`. Keep this directory outside your SilverBullet space, Git checkout and synced dotfiles. Preserve both files across restarts. Losing the key requires signing in again.

| Variable | Purpose |
| --- | --- |
| `SB_CODEX_ORIGIN` | Required SilverBullet origin, using HTTPS except for local loopback development |
| `SB_CODEX_HOST` | Listening interface, default `127.0.0.1` |
| `SB_CODEX_PORT` | Listening port, default `8321` |
| `SB_CODEX_DATA_DIR` | Absolute path for private account state |
| `SB_CODEX_CLIENT_VERSION` | Codex protocol client version used for model discovery, default `0.165.0` |

The companion has its own dependencies and lockfile. Its server code and database dependencies are not bundled into the plug. CI checks both packages; the normal SilverBullet artefact contains the plug and library notes. Running the companion and configuring a reverse proxy are separate setup steps.

## Configure and sign in

Add a provider in Space Lua:

```lua
config.set("ai", {
  providers = {
    codex = {
      provider = "codex",
      baseUrl = "/api/chatgpt",
      useProxy = false,
      showPricing = false,
      timeout = 180000
    }
  }
})
```

Merge this provider into your existing configuration if you already use other providers.

1. Run **AI: Refresh Config**.
2. Run **AI: Sign in to Codex Account**.
3. Open the displayed OpenAI sign-in page and enter the device code. Device-code login must be enabled for your account.
4. After the panel confirms sign-in, run **AI: Refresh Model List**, then **AI: Select Text Model from Config**.

Model discovery queries the signed-in account. Model IDs are not restricted to the GPT-5 family. Access depends on your plan and the current Codex backend. You can set `defaultTextModel` to `codex:<model-id>` using an ID returned by discovery.

Use **AI: Sign out of Codex Account** to delete this browser session from the companion. Review allowance and account controls in [ChatGPT usage settings](https://chatgpt.com/settings/usage). Closing the sign-in dialogue stops polling; an unfinished device code expires naturally.

Account sessions use an HttpOnly cookie. OAuth credentials are never returned to the plug or stored in notes. Other users or browsers must sign in independently. The companion handles text models, including supported image inputs and function tools; it does not expose embedding or image-generation endpoints. It does not fall back to paid API billing.

## Validation

```sh
bun install --cwd codex-account --frozen-lockfile
bun run --cwd codex-account typecheck
bun run --cwd codex-account test
```

The automated tests use a mocked upstream. They cover device login, encrypted persistence across a restart, model discovery, streaming and collected Responses, function-call preservation, logout, rejected origins and interrupted streams. A live account sign-in and successful model response are required to verify your account's access and quota.
