import { chromium } from "@playwright/test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

// Use the same URL shape and module worker mode as SilverBullet's WorkerSandbox.
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SB_CHROME_PATH,
});
try {
  const page = await browser.newPage();
  const source = await readFile(
    new URL("../dist/silverbullet-ai.plug.js", import.meta.url),
    "utf8",
  );
  await page.route("http://localhost:9876/**", (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith(".js")
        ? "text/javascript"
        : "text/html",
      body: route.request().url().endsWith(".js") ? source : "<html></html>",
    }),
  );
  await page.goto("http://localhost:9876/");
  const manifest = await page.evaluate(
    () =>
      new Promise<{ name: string; functions: Record<string, unknown> }>(
        (resolve, reject) => {
          const worker = new Worker("/.fs/_plug/silverbullet-ai.plug.js", {
            type: "module",
          });
          const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error("Plug did not send its manifest"));
          }, 5000);
          worker.onerror = (event) => {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error(event.message));
          };
          worker.onmessage = ({ data }) => {
            if (data.type === "manifest") {
              clearTimeout(timer);
              worker.terminate();
              resolve(data.manifest);
            }
          };
        },
      ),
  );
  assert.equal(manifest.name, "silverbullet-ai");
  assert.ok(manifest.functions.chat);
  assert.ok(manifest.functions.streamChatOnPage);
  console.log(
    `SilverBullet worker loaded: ${Object.keys(manifest.functions).length} functions`,
  );
} finally {
  await browser.close();
}
