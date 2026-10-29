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
OpenAI text requests use the SDK's Responses adapter by default. Provider or model
configuration can select `api = "responses"` for compatible gateways or
`api = "chat"` for endpoints that require Chat Completions. Responses requests
use `store: false`; the SDK replays reasoning and tool results between steps.
`src/providers/messages.ts` validates tool inputs. Conversations use SDK `ModelMessage` arrays directly.
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
# Implementation guidance

Check current official library documentation and the installed APIs before adding custom infrastructure. Prefer maintained libraries over reimplementing their capabilities, and use Vercel AI SDK for model transport, streaming, agent loops, subagents, cancellation, context preparation, messages and MCP. Keep custom code focused on SilverBullet integration and its permission and persistence boundaries.

Evaluate dependencies for maintenance, licence, security, runtime compatibility and bundle cost. Validate behaviour with focused tests and the browser build check where relevant. See [AGENTS.md](../AGENTS.md) for repository-wide guidance.


## Agent execution and recovery

The shared runtime uses Vercel AI SDK `ToolLoopAgent`, `prepareStep`, `pruneMessages`, SDK tool output conversion and cancellation signals. The assistant panel checkpoints SDK messages after each step, and records tool starts and completed results before proceeding. Checkpoint failures stop further actions. A failed tool that may modify data stops the loop, including the remaining calls in that batch.

Use **Stop** to cancel model requests, research subagents, MCP calls and pending approvals. Completed actions are retained. Cancellation cannot undo a request already accepted by an external service or forcibly interrupt arbitrary Space Lua. Built-in editing handlers pass their execution context to `ai.writePage`, which checks cancellation before approving or starting a write. Custom handlers must pass the supplied second `context` argument to `ai.writePage(page, content, context)` for the same checks.

Reopening the panel reconnects to an active run. After a worker reload, an unfinished tool becomes a paired SDK call and error result stating that its outcome is uncertain. Continue from the saved conversation and verify the affected state; do not resubmit the original edit blindly.

## Context and research tools

`chat.contextMaxChars` defaults to 60000 and limits text and message structure sent to the model. It is a character budget, not a token estimate. Base64 attachments and opaque provider metadata are excluded from that count; the provider still applies its own image, document and context limits. Oversized current turns fail explicitly rather than silently dropping instructions.

Older turns and completed steps in long tool loops are summarised through the configured model, retaining requirements, decisions, completed actions, uncertain outcomes and unresolved work. Current SDK parts and system instructions stay intact. Summary requests are bounded and use no tools; they can add latency and model usage. The panel persists summaries between turns with an exact history-prefix hash and a model, instruction and permission fingerprint. Unchanged prefixes are reused; only newly compacted records are added to the summary. Changed history or execution settings invalidate the cache. Full conversation history remains in the browser client store. Tool outputs sent to the model are bounded by `chat.toolResultMaxChars` (default 12000); the existing tool-result cache retains full successful tool results.

`read_note` supports `startLine` and `endLine`, returning at most 200 lines and 12000 characters per call. `research_notes` runs a separate read-only agent using the parent's model and read permissions. It has only `search_notes` and `read_note`, its own context, a default six-step budget (`chat.researchMaxSteps`, capped at 12), no recursive delegation, no MCP and no Lua. Main-loop tool execution remains serial, so at most one research subagent runs at a time. Usage is recorded after each completed SDK step, including research and summary calls. Reported usage survives cancellation and later failures. The panel shows cumulative chat usage, separately from the model context limit. Providers may not report tokens for an interrupted request.

`chat.runMaxTokens` optionally limits reported total tokens across the main agent, research and summaries. The runtime checks the budget before each further model request. A request already running can exceed it; this is not a hard billing cap. `chat.runTimeoutMs` optionally sets a shared elapsed-time deadline for model calls, tools and approval waits. Both settings require positive integers. Neither is enabled by default.

The panel supplies the current page name and selected text within the agent's read permissions. **Attach current page** includes the editor's full current content for the next turn, including unsaved changes, and resets after submission. Without that explicit attachment, the agent uses `read_note` to inspect content. Explicit custom context and configured agent attachments still apply.

`search_notes` supports literal `text`, fuzzy `title` and `path`, and indexed `semantic` modes. Title and path matching reuse SilverBullet's fuzzy ranker and do not read note contents. `offset` and the returned `nextOffset` paginate matching results; keep the same search arguments between pages. Text mode's `surroundingLines` adds up to five numbered lines on either side. Text search scans permitted pages in deterministic name order; each offset request scans again, and changes between requests can shift results. No additional index is maintained.

`edit_note` replaces exactly one occurrence of `oldText` with `newText`; absent or ambiguous matches fail. `create_note` refuses to overwrite an existing page. Both enforce read and write permissions, use the existing diff approval dialogue, propagate cancellation and check the expected page content before approval and before the approved write. The plug API does not offer an atomic conditional write, so a concurrent edit in the final read-to-write interval remains possible. Restricted agents cannot use these tools on content containing Space Lua.

## Quality gates

Run `bun run typecheck`, `bun run test` and `bun run dist`. Both build and release CI run type checking and tests before the production-only build. TypeScript is a development dependency and is not required by the production install.

The optional upstream proxy change and its validation commands are in [patches/README.md](../patches/README.md). Applying a patch and deploying a server are separate operations from building this plug.
