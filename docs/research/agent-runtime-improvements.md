# Runtime improvement research

Evidence gathered on 29 October 2026. Implementation and validation status is tracked in `docs/plans/agent-runtime-improvements.md`.

## Approval diffs

Selected `diff` 9.0.0 (jsdiff), declared as `^9.0.0`, replacing the custom set-based line comparison. Official source: <https://github.com/kpdecker/jsdiff>. The package has BSD-3-Clause licensing, bundled TypeScript declarations, ESM browser-compatible code and no runtime dependencies. The registry reports 615597 unpacked bytes; this includes distribution variants and declarations and is not the plug bundle cost. Bun 1.4.4 bundled the browser entry `src/diff.ts` with minification to 4118 bytes (including the adapter), using five modules. This isolated import measurement is not an assertion about the entire plug size.

`diffLines` uses Myers-style sequence comparison, preserves repeated lines and supports `timeout` and `maxEditLength`. These are useful for approval previews. Existing SilverBullet's `fast-diff` dependency targets character-level comparison; jsdiff provides the line operation and explicit computational limits needed here. No SDK API supplies edit-preview diffs.

The integration caps combined input at two million UTF-16 code units and 20000 newline characters, and asks jsdiff to stop after 100 ms or 4000 edits. An exhausted limit rejects the preview; it never authorises a blind or truncated edit. The preview preserves CRLF and missing-final-newline distinctions. Tests reconstruct both original texts exactly from the displayed diff records, test repeated lines and moved blocks, and cover an 8000-line note and budget exhaustion. The existing permission, cancellation and approval paths remain responsible for authorisation.

## Panel transport investigation

The installed package omits some client component sources. A complete local core checkout at `4f9edf885354e5cc28b4c1ceaebf40aec3eaa319` provides `client/sandbox/widget_sandbox_iframe.ts` and `client/plugos/sandboxes/worker_sandbox.ts`. It creates same-origin `about:blank` iframes and module workers from the space origin. The explicit syscall bridge is request-response. Browser-native `BroadcastChannel` can provide direct worker-to-panel push without a new server endpoint. `e2e-tests/probe-panel-push.ts` bundles and executes the actual core iframe factory in Chromium, exchanges SDK-shaped events with a module worker, and verifies delivery after the panel is removed and recreated. This probe passed against the pinned checkout. Space isolation, bounded retention and interrupted delivery still require implementation tests. The channel is within the existing same-origin trust boundary, not protection against arbitrary same-origin scripts.

The installed AI SDK 7.0.156 provides standalone `toUIMessageStream({stream})` and `readUIMessageStream`. Prefer these standard UI events and their SDK consumer to a bespoke token protocol. Official protocol documentation: <https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol>. Reconnection, bounded retention and permission isolation are still integration responsibilities.

## Search investigation

Installed SilverBullet 2.12.0 exposes `search.rank` for supplied objects. The inspected full core checkout also has `search.status`, `search.find` and `search.related`, backed by server search. The core APIs provide page allow-lists and modes `words`, `natural` and `phrase`. They have a server minimum query length and a per-tab cancellation identifier, return excerpts and page counts, and do not expose a continuation cursor. None of these facts establishes arbitrary literal substring completeness. Do not replace grep-like matching with ranked word results or silently omit short queries.

Evaluate native search for ranked retrieval and a permission-scoped, bounded continuation strategy for exact matching. MiniSearch (<https://github.com/lucaong/minisearch>) is an alternative maintained browser text index, but adopting it adds index lifecycle and memory costs and does not inherently solve literal substring matching. Measure candidates before choosing. SDK tools supply orchestration, not a SilverBullet content index.

## Conditional writes investigation

Core already implements conditional HTTP writes through `HttpSpacePrimitives.writeFileConditional`, mapping `matchesHash` to `If-Match` and `absent` to `If-None-Match: *`. Server validation is under a per-path lock. Sources: `client/spaces/http_space_primitives.ts` and `server/src/handlers/fs.rs` in the pinned checkout.

The installed plug interface `space.writePage(name, text)` does not expose a precondition. The core `SpacePrimitives` interface and local writes also need inspection; direct HTTP writes from the plug would bypass the local space and sync workflow. A complete solution must cover local concurrency, server concurrency, and conflict presentation, preserving newer content. The server path lock cannot by itself constrain external filesystem writers that do not acquire that lock. Establish and document that boundary through actual tests rather than claiming universal atomicity.

## Validation recorded so far

The diff slice passed `bun run typecheck`, all 245 plug tests across 20 files, `bun run dist`, and `SB_CHROME_PATH=/usr/bin/chromium bun run --cwd e2e-tests test:build`. Chromium executes the bundled jsdiff adapter and the actual approval modal script; the test checks CRLF and final-newline markers and verifies that note content is rendered as text. The existing 15 approval tests cover cancellation, stale content, concurrent approvals and failed writes. These results establish the diff slice only; push, search and conditional-write implementation remain open.

Native transport topology probe: `SB_CHROME_PATH=/usr/bin/chromium SB_CORE_CHECKOUT=/tmp/silverbullet-core-fix bun e2e-tests/probe-panel-push.ts`. It uses the actual `createWidgetSandboxIFrame` and the native module-worker origin, with a small syscall host fixture. It establishes browser connectivity and reopening, not complete application delivery or authorisation.

## Literal search decision and measurements

Selected a bounded scan continuation using SilverBullet's existing `LimitedMap` for eviction and its SHA-256 helper for validation. No additional search dependency or text index is introduced. MiniSearch 7.2.0 is MIT licensed, has no runtime dependencies and reports 826513 unpacked bytes. Its token-based ranked retrieval does not establish arbitrary literal substring completeness; adding it would require a separate literal path and index lifecycle. The newer native search API likewise supplies word, phrase and natural-language retrieval with minimum query length and per-tab cancellation. Existing fuzzy title and path search already reuse SilverBullet's ranker. For this exact-search workload, retaining only the scan position removes repeated pagination reads without introducing a second content index. This choice does not make cold literal searches indexed or sublinear.

Text continuation tokens bind query, case, context-line setting and read scope. They expire after five minutes; at most 32 remain in memory. Eight concurrent searches are allowed, and a serialised scope may contain at most 65536 characters. Relevant file events invalidate active searches and cursors, while permitted listing metadata detects observed changes, creation, deletion and renaming between calls. The resumed page is reread and its content hash checked even if its metadata is unchanged. Unobservable external edits on earlier pages with unchanged metadata cannot be detected without rereading those pages; searches operate on SilverBullet's observed state, not an atomic filesystem snapshot. No note text or result cache is retained. A cursor may be replayed while valid, and a changed limit is allowed. Nonzero text offsets now return migration guidance to use `nextCursor`; other modes retain offsets.

Run `bun run bench:search` to reproduce the benchmark. The synthetic corpus has 10000 notes and 26054840 UTF-8 bytes, with 8 to 55 lines per note, common and late matches, no-match queries, and unrestricted and Team-only read scopes. One cold run precedes ten measured runs per case, requesting five result pages where possible. Reads resolve asynchronously from memory with no simulated network latency. This measures CPU, scheduling and read counts; it is not a production server latency measurement. The baseline reproduces the previous offset scan. No index preparation is required; the cursor map retains only positions and validation state. Full output is in [note-search-benchmark.json](note-search-benchmark.json).

In the Team late-match workload, later-page median latency changed from 56.827 ms to 2.467 ms, and mean note reads from 8621 to 21. First-page medians were 55.166 ms and 68.551 ms. No-match medians were 58.7 ms and 71.953 ms. Validation, hashing and cancellation yields add overhead; this is a pagination improvement rather than a universal search speed-up. The retained 32 cursors used an estimated 19658 bytes of serialisable metadata; the separate post-GC heap delta also includes runtime caches and measurement overhead. The measured note invalidation took 0.25 ms.

## Push integration and validation

The worker uses the installed SDK's `toUIMessageStream` and `readUIMessageStream` to assemble `UIMessage` previews. A native `BroadcastChannel` carries those snapshots plus run identity, sequence and instruction receipts. Each subscription gets a random channel name. The panel registers its listener before sending ready, acknowledges after rendering, and checks run and chat identity. The worker allows one outstanding snapshot and coalesces intervening changes. No token event log is retained, and both output polling and periodic agent-state polling are removed.

The live preview accepts at most 262144 UTF-16 code units of serialised SDK events or 4096 events per streamed SDK invocation. On overflow, the panel displays a notice and preview updates stop; generation continues and completed SDK messages are saved intact. These bounds apply to the additional live preview, not total conversation history or SDK generation memory. Only the latest run is retained in the live cache, with one five-minute expiry timer after completion. Closing or hiding the panel closes its channel. Reopening or returning to the visible tab loads saved history and subscribes to the current snapshot without replaying model requests or tools. A connection failure after generation starts preserves Stop and reports how to reconnect.

The channel stays inside SilverBullet's existing same-origin trust boundary. Random names separate subscriptions; they do not protect against arbitrary same-origin scripts. The supported topology was verified with the actual iframe factory from core revision `4f9edf885354e5cc28b4c1ceaebf40aec3eaa319` (2.12.1), a real compiled plug module worker and a controlled HTTP streaming provider. This is not a deployment test against a running user's space.

Run the integration test with:

```sh
SB_CHROME_PATH=/usr/bin/chromium SB_CORE_CHECKOUT=/path/to/pinned/silverbullet bun run --cwd e2e-tests test:push
```

The test passed text and reasoning delivery, reasoning toggles, frame replacement, disconnected recovery, steering receipts, preview overflow with complete final history, Stop propagation to the provider, no idle polling, and worker replacement followed by reopening without replaying a model request or losing completed messages. Unit tests additionally exercise 10000 coalesced changes, stale acknowledgements and subscription replacement. The full plug validation passed type checking, 262 tests across 23 files, distribution compilation and the existing Chromium distribution checks (62 exported functions).

The tested host revision is the compatibility evidence; other host versions have not been verified. Conditional writes and their core integration remain unfinished requirements.

## Conditional writes: draft commit protocol

The pinned core already supplies SHA-256 `If-Match` and create-if-absent writes in `HttpSpacePrimitives`, but `ProxyRouter.handlePut` discards those preconditions when it writes into the local data store. A plug-only read/check/write remains vulnerable to races. The sync engine can also reconcile ordinary writes automatically, which is unsuitable for applying a proposal that was approved against different content.

The draft at `patches/silverbullet-conditional-writes-draft.patch` contains a core commit helper and focused tests against revision `4f9edf885354e5cc28b4c1ceaebf40aec3eaa319`. **It is unfinished and not wired into any syscall or service-worker route. Applying this draft alone provides no runtime protection.** The working checkout is `/tmp/silverbullet-core-fix`; existing proxy modifications remain separate.

The helper checks local content or absence before submitting one conditional server write. It records a durable intent before submission, returns structured applied/conflict/unknown results, and does not retry a lost response. A successful result requires the server's returned revision to match the proposed bytes, a local cache write and a persisted sync checkpoint. Local deletion conflicts unless the caller explicitly establishes an uncached file. Seven focused tests pass: competing updates, competing creates, newer local content, local deletion, lost response with no retry, local checkpoint failure, and cancellation before submission. These tests simulate the server's atomic precondition and do not prove real server or synchronisation behaviour. The upstream TypeScript check passes after generating its normal `version.json` build input.

Next integration requirements:

- Use the browser's existing [Web Locks API](https://www.w3.org/TR/web-locks/) for a shared per-space, per-file lock around conditional commits, ordinary local mutations and each sync operation. Re-read metadata inside that lock. This adds no dependency. Unrelated files should remain concurrent; no full-space lock across network sync is planned.
- Make sync honour durable pending intents. Recover by inspecting local and remote revisions, never by resending the proposal. Preserve unsynchronised local content if recovery finds another edit. Test worker termination at each commit boundary.
- Verify server and service-worker capability before sending a conditional mutation. Expose the checked API through SilverBullet's normal permission and event wrappers; fail safely on an unpatched host.
- Wire approved plug edits to that API, preserving fresh-read and fresh-approval requirements after conflicts. Validate with independent clients against the actual modified storage route, including stale approvals, competing creation, deletion and recreation, and later sync.
- Test and document external filesystem writes separately. Browser locks only coordinate cooperating local callers; the server's path lock does not exclude unrelated filesystem writers.

The lock and recovery integration, public API, plug integration, actual-server tests, external-write boundary and final patch applicability checks remain unfinished. No running host has been modified.

### Lock and recovery integration progress

The draft now includes a native per-space, per-file Web Lock around ordinary service-worker writes and deletions, each sync decision, and the conditional commit entry point on `SyncEngine`. Sync re-reads metadata after taking the lock. Conditional commits require Web Locks; ordinary sync retains its existing behaviour on hosts without that capability.

Sync inspects durable conditional-write intents before doing any further operation on that path. When the server still holds the proposed bytes and the local copy still holds the expected or proposed revision, recovery updates the local cache and sync checkpoint without sending a server write. A later local edit is preserved and leaves the path blocked for manual recovery. Changed remote content or a failed recovery also leaves the intent intact. This conservative unresolved state still needs a usable explicit recovery path before the feature is complete.

The affected core tests pass: 167 tests across `conditional_write.test.ts`, `sync.test.ts`, `sync_engine.test.ts` and `proxy_router.test.ts`; upstream TypeScript checking passes. Tests added for recovery cover a lost response before the local write, interruption after the local write, and a later local edit. Native cross-context lock behaviour, public routing and actual-server integration are not yet tested.

Performance issue to resolve before finalising: the current metadata refresh performs a remote metadata request for every path in a full sync cycle. Preserve correct decisions after queued mutations without introducing one network round trip per unchanged note. Measure or count the resulting requests in a regression test. This draft is not ready for use or deployment.

### Current draft API and request-cost checks

The draft now routes `space.writePageIfUnchanged` through the existing permission and event wrappers to a service-worker PATCH handler. The engine checks an explicit server capability header before starting a conditional write. Older service workers forward the unsupported method to the server, rather than performing an unconditional local write. The matching server header addition is included in the draft. The plug does not yet call this API, and the full route and server changes still require integration tests.

The earlier per-note remote metadata cost is removed. Sync captures the common revision before listing and refreshes remote metadata only if that revision changed while waiting for the file lock. Focused tests verify zero remote metadata calls for a full cycle of 1000 unchanged notes, and one refresh after an intervening commit. The affected sync tests and upstream TypeScript check pass. These counts do not measure browser lock or local storage latency.
