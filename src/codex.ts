import { createChatGPTProxyProvider } from "@opencoredev/loginwithchatgpt-ai";
import { asset, editor } from "@silverbulletmd/silverbullet/syscalls";
import { sdkFetch } from "./proxy.ts";
import { aiSettings, initializeOpenAI } from "./init.ts";
import type { ProviderConnection } from "./providers/catalog.ts";

export function codexFetch(
  connection: Pick<ProviderConnection, "useProxy" | "timeout">,
): typeof fetch {
  if (connection.useProxy)
    throw new Error(
      "Codex account connections require useProxy = false so the browser can send its session cookie directly to the account service.",
    );
  const transport = sdkFetch(false, connection.timeout, "Codex account");
  return (input, init) =>
    transport(input, { ...init, credentials: "include", redirect: "error" });
}

export function codexProvider(connection: ProviderConnection) {
  return createChatGPTProxyProvider({
    basePath: connection.baseUrl,
    fetch: codexFetch(connection),
    credentials: "include",
  });
}

type AccountState = {
  status: string;
  userCode?: string;
  verificationUrl?: string;
  interval?: number;
  user?: { email?: string; plan?: string };
  error?: string;
};

async function accountRequest(
  providerKey: string,
  path: "login" | "status" | "logout",
): Promise<AccountState> {
  await initializeOpenAI(false);
  const config = aiSettings.providers?.[providerKey];
  if (!config || (config.provider ?? providerKey) !== "codex")
    throw new Error("Configure a provider with provider = 'codex' first.");
  const response = await codexFetch({
    useProxy: config.useProxy ?? false,
    timeout: config.timeout ?? 60000,
  })(`${(config.baseUrl ?? "/api/chatgpt").replace(/\/$/, "")}/${path}`, {
    method: path === "status" ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok)
    throw new Error(
      `Codex account service returned HTTP ${response.status}. Check its URL and reverse proxy configuration.`,
    );
  return response.json();
}

export async function codexAccountStatus(
  providerKey: string,
): Promise<AccountState> {
  return accountRequest(providerKey, "status");
}

export async function codexAccountLogin(): Promise<void> {
  await initializeOpenAI(false);
  const providers = Object.entries(aiSettings.providers ?? {}).filter(
    ([key, config]) => config && (config.provider ?? key) === "codex",
  );
  if (!providers.length)
    throw new Error(
      "Add ai.providers.codex = { provider = 'codex' } and configure the Codex account service. See docs/Codex.md.",
    );
  const selected =
    providers.length === 1
      ? providers[0][0]
      : await editor
          .filterBox(
            "Codex account provider",
            providers.map(([name]) => ({ name })),
          )
          .then((item) => item?.name);
  if (!selected) return;
  const state = await accountRequest(selected, "login");
  const [html, script] = await Promise.all([
    asset.readAsset("silverbullet-ai", "assets/codex-account.html"),
    asset.readAsset("silverbullet-ai", "assets/codex-account.js"),
  ]);
  await editor.showPanel(
    "modal",
    1,
    html,
    `globalThis.codexAccount = ${JSON.stringify({ providerKey: selected, state }).replace(/</g, "\\u003c")};\n${script}`,
  );
}

export async function codexAccountLogout(providerKey?: string): Promise<void> {
  await initializeOpenAI(false);
  const providers = Object.entries(aiSettings.providers ?? {}).filter(
    ([key, config]) => config && (config.provider ?? key) === "codex",
  );
  const selected =
    providerKey ??
    (providers.length === 1
      ? providers[0][0]
      : await editor
          .filterBox(
            "Sign out of Codex account",
            providers.map(([name]) => ({ name })),
          )
          .then((item) => item?.name));
  if (!selected) return;
  await accountRequest(selected, "logout");
  await editor.flashNotification("Signed out of Codex account");
}
