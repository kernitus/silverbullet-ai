import { chromium } from "@playwright/test";
import { strict as assert } from "node:assert";

// Exercise SilverBullet's actual iframe factory, not a setContent imitation.
// Set SB_CORE_CHECKOUT to the separately inspected upstream checkout.
const core = process.env.SB_CORE_CHECKOUT;
if (!core)
  throw new Error(
    "Set SB_CORE_CHECKOUT to the reviewed SilverBullet source checkout",
  );
const build = await Bun.build({
  entrypoints: [`${core}/client/sandbox/widget_sandbox_iframe.ts`],
  target: "browser",
});
if (!build.success) throw new Error(String(build.logs));
const source = await build.outputs[0].text();
const browser = await chromium.launch({
  executablePath: process.env.SB_CHROME_PATH,
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.route("http://localhost:9877/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      contentType: path.endsWith(".js") ? "text/javascript" : "text/html",
      body:
        path === "/host.js"
          ? source
          : path === "/worker.js"
            ? `
        const channels = new Map();
        onmessage = ({data}) => {
          if (!channels.has(data.name)) channels.set(data.name, new BroadcastChannel(data.name));
          channels.get(data.name).postMessage({type: "text-delta", id: "text", delta: data.text});
        };
        postMessage("ready");
      `
            : "<!doctype html><html><body></body></html>",
    });
  });
  await page.goto("http://localhost:9877/");
  const observations = await page.evaluate(async () => {
    const { createWidgetSandboxIFrame } = await import(
      "http://localhost:9877/host.js"
    );
    const worker = new Worker("/worker.js", { type: "module" });
    await new Promise<void>((resolve) => {
      worker.onmessage = () => resolve();
    });
    const name = `probe-${crypto.randomUUID()}`;
    const received: unknown[] = [];
    for (const text of ["first opening", "reopened panel"]) {
      let resolveResult!: (value: unknown) => void;
      const result = new Promise((resolve) => {
        resolveResult = resolve;
      });
      const client = {
        clientSystem: {
          localSyscall: async (method: string, args: unknown[]) => {
            if (method === "probe.ready") worker.postMessage({ name, text });
            if (method === "probe.received") resolveResult(args);
          },
        },
      };
      const mounted = createWidgetSandboxIFrame(client, null, {
        html: "<div id='output'></div>",
        script: `
          const channel = new BroadcastChannel(${JSON.stringify(name)});
          channel.onmessage = ({data}) => {
            document.getElementById("output").textContent = data.delta;
            syscall("probe.received", data, location.origin, self.origin);
            channel.close();
          };
          syscall("probe.ready");
        `,
      });
      document.body.append(mounted.iframe);
      received.push(await result);
      mounted.dispose();
      mounted.iframe.remove();
    }
    worker.terminate();
    return received;
  });
  assert.equal((observations[0] as any[])[0].delta, "first opening");
  assert.equal((observations[1] as any[])[0].delta, "reopened panel");
  assert.equal((observations[0] as any[])[2], "http://localhost:9877");
  console.log(
    "Actual SilverBullet iframe factory receives native push from a module worker, including after reopening",
  );
} finally {
  await browser.close();
}
