## Build

To build this plug, install Bun 1.4.4 (the version in `.bun-version`).
From a clean checkout, install production dependencies and build:

```shell
bun install --production --frozen-lockfile
bun run build
```

This compiles the plug to `silverbullet-ai.plug.js`. Copy it into your space's `_plug` folder:

```shell
bun run build && cp silverbullet-ai.plug.js /my/space/_plug/
```

SilverBullet will automatically sync and load the new version of the plug (or speed up this process by running the {[Sync: Now]} command).

### Distribution Build

To generate a full distribution (plug + combined Space Lua library):

```shell
bun run dist
```

This creates the following files in `dist/`:
- `silverbullet-ai.plug.js` — the compiled plug
- `silverbullet-ai-library.md` — combined Space Lua pages for installation
- `PLUG.md` — the installable library page

Copy `silverbullet-ai-library.md` to your space root so SilverBullet can load the Space Lua functions.

Bun runs the existing SilverBullet `plug-compile` compiler, so the output remains a
SilverBullet browser plug. Use `bun run test` to run the Vitest suite; `bun test`
selects Bun's separate test runner. CI uses the version in `.bun-version` and
installs dependencies from `bun.lock` with `--frozen-lockfile`. Tests run in a
separate job with development dependencies. Build and release jobs use fresh
checkouts with only production dependencies installed.

After each successful CI build, the workflow uploads the three distribution files
as `silverbullet-ai-<commit SHA>`, retained for 30 days. Open the commit's
build check, follow it to the Actions run, and download the archive under
Artefacts. GitHub requires you to sign in to download it.
Extract the archive, copy `silverbullet-ai.plug.js` into your space's `_plug`
folder, and copy `silverbullet-ai-library.md` to the space root. The archive is
for manual installation; its download URL cannot be used as a SilverBullet
subscription URL.

For local tests and README generation, run `bun install --frozen-lockfile` to
include development dependencies. A production install does not remove existing
development packages; use `bun prune --production` before building locally if
you need to exclude them from an existing checkout.

## AI SDK integration

Vercel AI SDK handles text generation, streaming, structured output, tool steps,
embeddings and image generation. The provider packages cover OpenAI, Gemini and
Mistral; Ollama and other compatible endpoints use the OpenAI-compatible provider.
Ollama embeddings now use its `/v1/embeddings` endpoint.

`src/providers/sdk.ts` connects the SDK to the existing SilverBullet configuration.
`src/providers/messages.ts` converts saved conversations and validates tool inputs.
`src/providers/catalog.ts` retains model listing and Ollama metadata queries,
which are separate from the SDK's inference APIs. MCP uses `@ai-sdk/mcp`.

SilverBullet retains note access controls, tool approvals, attachment handling,
editor updates and embedding caching. SDK tool calls execute sequentially so note
edits and approval dialogues keep their order. Automatic request retries are
disabled to avoid repeating tool side effects. API credentials stay in the existing
configuration and requests use SilverBullet's proxy when configured.

The SDK is bundled into the browser plug. No Vercel deployment or account is
required when using your configured model providers directly.

After `bun run dist`, check the generated plug in Chromium:

```shell
bun install --cwd e2e-tests --frozen-lockfile
cd e2e-tests
bunx playwright install chromium
bun run test:build
```

Set `SB_CHROME_PATH` to use an existing Chromium executable. This check loads the
compiled module worker and verifies its SilverBullet manifest without API keys.
The model regression tests use simulated provider responses; live provider tests
still require the integration test setup below.

## Testing

### Unit Tests

Run unit tests with vitest:

```shell
bun run test
```

### E2E Tests (Browser Testing)

The project includes end-to-end tests using [Playwright](https://playwright.dev/) to test the plugin in a real browser.

#### Setup

First-time setup requires installing dependencies and Playwright browsers:

```shell
cd e2e-tests
bun install --frozen-lockfile
bunx playwright install
```

#### Running E2E Tests

Run all E2E tests:

```shell
cd e2e-tests
bunx playwright test
```

Run tests with interactive UI:

```shell
bunx playwright test --ui
```

Run tests in headed mode (see the browser):

```shell
bunx playwright test --headed
```

Run specific browser:

```shell
bunx playwright test --project=chromium
bunx playwright test --project=firefox
bunx playwright test --project="Mobile Chrome"
```

#### Test Structure

E2E tests are located in `e2e-tests/tests/`. See `e2e-tests/README.md` for detailed documentation.

The tests automatically:
- Start a SilverBullet instance on port 3000
- Load the test space from `test-space/`
- Run tests across multiple browsers and viewports
- Capture screenshots and videos on failure

For more information, see the [E2E Testing README](../e2e-tests/README.md).


## Docs

Documentation is located in the `docs/` directory and rendered using [mkdocs](https://github.com/mkdocs/mkdocs).

To make changes, use silverbullet (or any markdown editor) locally like: `silverbullet docs/`

If you want to see changes in real-time, open up two terminals and run these two commands:

- `mkdocs serve -a localhost:9000`
- `find docs -name \*.md -type f | egrep -v 'public' | entr bash ./render-docs.sh`

The first starts a local development server of mkdocs. The second uses the [entr](https://github.com/eradman/entr) command to run silverbullet-pub every time a file changes inside the silverbullet docs/ directory.

Markdown files inside of docs/ can also be manually edited using any editor.
