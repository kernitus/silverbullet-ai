import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { accountHandler } from "./handler.ts";
import { SessionStore } from "./store.ts";

const publicOrigin = process.env.SB_CODEX_ORIGIN;
if (!publicOrigin)
  throw new Error(
    "Set SB_CODEX_ORIGIN to your SilverBullet origin, for example https://notes.example.com",
  );
const origin = new URL(publicOrigin);
if (
  origin.protocol !== "https:" &&
  !(
    origin.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  )
)
  throw new Error("Use HTTPS, or HTTP on loopback for local development");
const directory = resolve(
  process.env.SB_CODEX_DATA_DIR ??
    join(homedir(), ".local", "share", "silverbullet-ai-codex"),
);
const repository = resolve(import.meta.dir, "..");
if (directory === repository || directory.startsWith(repository + "/"))
  throw new Error(
    "Store account credentials outside the repository and your SilverBullet space",
  );
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const secretPath = join(directory, "session.key");
try {
  await writeFile(
    secretPath,
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    { flag: "wx", mode: 0o600 },
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
const secret = (await readFile(secretPath, "utf8")).trim();
if (secret.length < 32)
  throw new Error(
    "The stored session key is invalid; restore it from a secure backup",
  );
const store = new SessionStore(join(directory, "sessions.sqlite"));
await chmod(join(directory, "sessions.sqlite"), 0o600);
Bun.serve({
  hostname: process.env.SB_CODEX_HOST ?? "127.0.0.1",
  port: Number(process.env.SB_CODEX_PORT ?? 8321),
  maxRequestBodySize: 8 * 1024 * 1024,
  idleTimeout: 255,
  fetch: accountHandler(origin.origin, {
    secret,
    sessionStore: store,
    clientVersion: process.env.SB_CODEX_CLIENT_VERSION ?? "0.165.0",
  }),
});
console.log(
  "Codex account service ready. Mount /api/chatgpt at your SilverBullet origin.",
);
