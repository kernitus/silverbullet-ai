# Agent runtime improvements

Status: accepted by independent plan review on 29 October 2026. Implementation is in progress. No deployment is authorised or claimed.

Research and slice evidence: [research record](../research/agent-runtime-improvements.md). The diff slice selects jsdiff 9.0.0 (`^9.0.0`), BSD-3-Clause, no runtime dependencies. Its isolated minified browser entry is 4118 bytes. The diff slice passed type checking, 245 tests across 20 files, distribution compilation and Chromium approval preview checks. Native push topology is verified against the pinned core iframe factory, including reopening; production transport integration passes actual-core-iframe and compiled-worker checks; worker replacement followed by reopening also passes.

## Objective and scope

Implement all four requirements from the user's attached specification: replace panel polling with push delivery; replace the custom approval diff; improve note search with reliable pagination and measured performance; prevent conditional note writes from overwriting newer content. Research and validate each change against the actual SilverBullet integration. Prepare separately reviewable SilverBullet core patches where a plug cannot provide the required guarantee. Do not deploy, publish or change a running server.

Keep SDK model messages, provider metadata, agent permissions, approval rules, steering, research recovery and cancellation intact. The work is complete only when the requirement evidence below passes. A mock bridge, plug-local lock, increased polling interval or faster unrestricted scan is insufficient evidence for the corresponding requirement.

## Inspected baseline

- The repository uses Bun 1.4.4, AI SDK 7.0.156 and SilverBullet 2.12.0. Verify installed versions again before dependency changes.
- `assets/chat-panel.js:pollForChunks` calls `getPanelChatChunk` every 50 ms. `src/chat-panel.ts` drains text arrays and retains unused reasoning arrays. Saved SDK history and run checkpoints already support reload recovery.
- `src/tools.ts:runSDKChat` consumes the SDK stream and implements cancellation, steering and checkpoint hooks. The installed SDK provides a standalone `toUIMessageStream` helper; the result object's equivalent method is deprecated.
- `src/utils.ts:computeSimpleDiff` implements a custom line comparison used by approval previews in `src/tools.ts`. Existing write approval code captures expected content, rechecks it, then makes an unconditional `space.writePage` call.
- `src/search.ts` uses SilverBullet's fuzzy ranker for titles and paths, sequential reads for literal matching, and offset pagination that restarts scans. Semantic search is a separate existing mode.
- The installed `search.rank` syscall ranks supplied objects. The installed `space.writePage` syscall accepts only name and text. These interfaces do not establish whether other native facilities can meet the requirements.
- A full upstream checkout exists at `/tmp/silverbullet-core-fix`, revision `4f9edf885354e5cc28b4c1ceaebf40aec3eaa319`. Its `client/sandbox/widget_sandbox_iframe.ts` creates same-origin `about:blank` frames and bridges syscall requests and responses using `postMessage`. Confirm that this matches the supported deployed version before selecting a transport.
- The inspected core checkout identifies itself as 2.12.1 and adds `search.status`, `search.find` and `search.related` in `client/plugos/syscalls/search.ts`, backed by `client/search/server_search.ts`. The plug's installed 2.12.0 package exposes only `search.rank`. Native search selection must account for this version boundary. `search.find` supports page inclusion and exclusion, but also cancels a previous search from the same tab; verify agent and UI interaction before reuse.
- `patches/README.md` records existing server support for `If-Match` and `If-None-Match`. The core handler `server/src/handlers/fs.rs` checks these under a path lock. `client/spaces/space_primitives.ts` exposes unconditional writes. Trace the local storage and synchronisation route before designing an extension.

## Research record and selection gates

Record exact selected versions, licences, package maintenance evidence, browser support and measured bundle changes in `docs/Development.md` or a focused research document. Use official documentation and installed source; do not infer runtime support solely from a search result.

Sources checked for this plan:

- [AI SDK stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol): existing SDK stream parts cover text, reasoning and tool activity. Reuse SDK event shapes and stream helpers rather than define another model-output protocol.
- [SilverBullet editor API](https://docs.silverbullet.md/API/editor): panel creation is documented; source inspection is needed to establish push and lifecycle behaviour.
- [jsdiff](https://github.com/kpdecker/jsdiff): candidate for line diffs with bounded work and packaged TypeScript definitions. Confirm the selected release's licence and browser bundle before adding it.
- [MiniSearch](https://github.com/lucaong/minisearch): candidate for an in-memory full-text index. Ranked token search does not by itself preserve arbitrary literal substring matching.

Research still required before implementation choices are locked:

1. Compare supported SilverBullet event subscriptions, native browser messaging across its actual worker and panel origins, and a small core messaging extension. Determine cleanup, space isolation, frame replacement and worker restart behaviour. Native `BroadcastChannel` is a candidate because the inspected iframe is same-origin, but that alone does not prove compatibility or isolation.
2. Check SDK standalone UI stream conversion and reading helpers in version 7.0.156, including reasoning visibility and tool events. Determine the minimum transport envelope needed for run identity, recovery and delivery ordering without duplicating the SDK protocol.
3. Inspect the newer native `search.status` and `search.find` facilities, supported server modes and freshness guarantees. Decide whether to update the dependency or capability-detect the newer host API, and document the minimum supported host version. Compare native reuse against MiniSearch and a literal-search candidate strategy. Assess update events, memory, persistence and data exposure before adding a second index.
4. Trace all storage wrappers, local dirty state, synchronisation preconditions and server conditional writes. Establish whether version checks can be carried through the existing flow and which concurrent writers share a lock. Inspect external filesystem write behaviour explicitly.

## Implementation slices and acceptance evidence

### Slice 1: push transport and SDK stream rendering

Scope: `src/chat-panel.ts`, the shared streaming boundary in `src/tools.ts`, panel assets, manifest entries and browser tests. Reuse `panel-history.ts` and the current run lifecycle.

- Select and document the researched host-supported push route. If an upstream API is required, prepare a separate version-pinned patch and host tests; do not silently retain polling as the finished design.
- Send SDK stream events through that route. Keep integration-specific state such as run identity and instruction receipts separate from model output. Use SDK conversion and consumption helpers where compatible with the plain browser panel.
- Remove the 50 ms output loop and destructive chunk retrieval. Scope subscriptions to the current space, conversation and run. Reject stale events and unexpected senders. Never include provider credentials in panel transport state.
- Support panel attachment during a running request, disconnection, frame replacement and reopening. Recover from saved checkpoints and a bounded live snapshot or replay buffer. Specify what happens when a subscriber falls behind the retained window. Do not automatically repeat tools or model calls to recreate output.
- Bound retained live data and release listeners, channels and buffers after completion or abandonment. Preserve reasoning visibility controls, research progress, tool results, steering receipts and Stop.

Acceptance: browser checks using the actual built worker and actual host communication route prove ordered delivery, no duplicated or missing visible output after reconnect, reopening during a run, text and reasoning rendering, stale-run isolation and Stop propagation. Simulate a dropped connection and buffer overflow. Assert the periodic output polling loop is absent and an idle panel issues no repeated output requests. Measure retained memory during a long synthetic stream and show it remains within the chosen bound. Mock tests supplement these host checks.

### Slice 2: maintained diff implementation

Scope: `src/utils.ts`, approval preview adapter, focused diff tests and dependency lockfile.

- Evaluate `diff` against the current browser build and choose a major-compatible version after checking licence, maintenance and bundle cost.
- Replace the homemade algorithm with library line diffs, adapting its results to the existing preview interface. Preserve whitespace and newline distinctions needed to show the actual edit.
- Set documented execution limits. If the diff cannot be computed within those limits, fail clearly or show a complete bounded alternative that does not misrepresent the proposed write. Do not approve an incomplete preview silently.
- Keep approval identity, cancellation, path checks, expected content and conflict handling intact.

Acceptance: focused tests cover repeated lines, moved blocks, empty files, insertion and deletion, trailing newline changes, LF and CRLF, and large dissimilar edits. Reconstruct both inputs from diff output where applicable. Browser approval tests verify safe text rendering and rejection. Record build size and large-input time before and after.

### Slice 3: efficient literal and ranked note search

Scope: `src/search.ts`, any selected native search adapter or library, note update hooks, tests and a reproducible benchmark command.

- Choose the simplest measured implementation after the native capability and library comparison, prioritising the newer native search service where its exact semantics satisfy the requirement. Keep literal, grep-like matching explicit; any new ranked mode must have separate documented semantics. Preserve the existing title, path and semantic modes unless evidence justifies a compatible simplification.
- Introduce continuation semantics that avoid rereading and rescanning earlier pages merely to skip previous results. Bind continuation state to query options, path scope and permissions, with a bounded lifetime and capacity. Reject expired or mismatched continuations clearly.
- Filter permissions before returning indexed content, counts, snippets or continuation information. Do not let a cursor from a broader scope expose data to a narrower one.
- Handle changed, renamed and deleted notes through verified platform events or version validation. Ensure snippets and line numbers refer to current content. Define pagination behaviour under edits so stale data is not silently presented as current.
- Bound index or cache memory, preserve cancellation and avoid storing secrets or note caches in synced dotfiles.

Acceptance: tests prove exact case-sensitive and case-insensitive literal matches, non-word substrings, punctuation, line references, path filtering, denied paths, continuation integrity, no earlier-page rescans, cancellation, changes, renames and deletions. Include permission changes between requests and expired continuation state.

Benchmark: add a deterministic synthetic corpus with at least 10,000 notes, mixed note sizes, repeated and rare terms, and multiple permission scopes. Record corpus bytes, environment and warm-up policy. Compare baseline and selected implementation for cold preparation, warm search median and p95, first-page and later-page latency, note read counts, update cost and retained memory. Include no-match and late-match literal queries. Report measured trade-offs without claiming a universal speed-up. Store only generated benchmark summaries in the repository, not user note contents or caches.

### Slice 4: atomic conditional writes through SilverBullet

Scope: plug write and approval integration, native tool tests, and separately packaged SilverBullet core changes if needed.

- Reuse existing server conditional HTTP writes where their semantics suffice. Expose an expected revision or expected-absence precondition through a supported space API and the necessary local and synchronisation layers. Confirm a revision accompanies the exact content shown in the preview.
- Prevent another local write, pending synchronisation or remote client from invalidating the precondition unnoticed. A plug-local mutex or direct HTTP call bypassing local dirty state is not sufficient.
- Use atomic create-if-absent for new notes. Return a structured conflict without altering newer content. Require a fresh read, proposal and approval after conflict; never automatically overwrite or merge an uncertain write.
- If the host lacks the required capability, fail safely with precise compatibility guidance rather than silently use an unconditional write. Document the minimum supported patch or version.
- Package upstream changes as a separately applicable patch with exact base revision, tests and build commands. Preserve any existing proxy patch and explain patch ordering if necessary. Do not deploy.
- Establish the external filesystem boundary. Test adversarial writes at the precondition-to-write boundary and document which mechanisms can guarantee exclusion. Do not claim a guarantee against writers that bypass the cooperating storage mechanism unless the implementation proves it. Preserve recoverable content where a stronger filesystem guarantee cannot be supplied.

Acceptance: integration tests run against the modified core storage path with two independent clients. Prove that one of two competing updates fails without losing the winner, stale approved edits fail, competing creates do not overwrite, local dirty edits are preserved, and sync does not later overwrite a rejected edit. Cover deletion and recreation, cancellation before commit, and unknown outcomes without automatic retry. Tests for external filesystem writes must substantiate the documented guarantee or limitation. Verify patch applicability with `git apply --check` on the exact base revision and run the affected core tests.

## Security and performance invariants

Treat note text, tool output, stream messages and continuation input as untrusted. Use safe DOM rendering and validated identifiers. Preserve permissions in code on every request, including reconnects and pagination. Keep approval and write authority in the trusted runtime. A browser channel name is a routing identifier, not a security boundary against arbitrary same-origin scripts; account for the host's existing trust model explicitly.

Avoid unbounded stream logs, indices, query sessions or diff work. Measure material claims using the specified workloads. Keep dependencies minimal and include the incremental production bundle size in the research evidence. No new hosted service or external upload is required by this plan.

## Validation and completion gate

Use the pinned Bun version and run the narrowest relevant tests after each slice. Format changed TypeScript and JavaScript with the configured tooling. For the completed runtime changes run:

- `bun run typecheck`
- `bun run test`
- `bun run dist`
- `SB_CHROME_PATH=/usr/bin/chromium bun run --cwd e2e-tests test:build`
- `bun run bench:search` (10000 synthetic notes, two permission scopes).
- The affected core test commands and patch applicability checks, recorded here once the core changes are prepared.
- A clean production-only dependency installation and distribution build after dependency changes.
- `git diff --check`

Update the README and development documentation to describe the final behaviour, compatibility requirements and verified limits. Record each requirement's evidence, command result and remaining limitation in this plan before marking the objective complete. Passing unit tests alone does not prove cross-client atomicity, real-host push delivery or large-space performance.

## Decisions and open questions

Locked: all four slices remain in scope; preserve SDK history and existing capabilities; use push rather than periodic output polling; preserve literal matching; enforce conditional writes or fail safely; no deployment or publication.

Selected: jsdiff 9.0.0 with bounded comparisons; exact-text scan continuations with scoped invalidation, no added content index; existing SilverBullet fuzzy ranking for titles and paths. Open, to resolve by evidence: conditional write API across sync, and guarantees for uncooperative external filesystem writers. These are research tasks, not reasons to omit a slice.

## Evidence ledger

- [ ] Research and dependency decisions documented.
- [x] Push delivery and actual-core-iframe reconnect tests pass, including worker replacement with saved-history recovery. Host revision and fixture boundaries are recorded in the research document.
- [x] Maintained diff replaces the custom algorithm and preview tests pass.
- [x] Search correctness and invalidation tests pass; benchmark results recorded in `docs/research/note-search-benchmark.json` using `bun run bench:search`. Full suite: 257 tests across 21 files; type checking, distribution compilation and Chromium checks passed after integration.
- [ ] Conditional writes and competing-client tests pass; external-write boundary established.
- [ ] Required core patches apply and their tests pass.
- [ ] Final plug validation, production build and documentation pass.

Push integration evidence: type checking, 262 tests across 23 files, distribution compilation, `test:build` and `test:push` passed on 29 October 2026. See the research record for the exact host revision and exercised scenarios. Worker replacement and reopening also pass: completed messages survive and no model request is replayed.

Conditional-write progress: a separately retained draft core commit helper and seven focused tests are in `patches/silverbullet-conditional-writes-draft.patch`. The upstream TypeScript check passes. This draft is not wired into production and does not satisfy the conditional-write acceptance gate. See the research record for the pending lock, recovery, host API, plug and actual-server work.

Core integration progress: the draft now shares file locks with service-worker local mutations and sync, and sync verifies pending outcomes without replaying writes. Affected core checks pass (167 tests and TypeScript). The research record identifies unresolved public routing, manual recovery, real-server validation and a full-sync metadata-request cost that must be fixed before completion.

Draft API progress: the core syscall, permission and event wrappers, service-worker PATCH handler and server capability header are included. The plug is not wired to the API yet. Full-sync request-count regressions pass for 1000 unchanged notes and an intervening commit. The full route, Rust change and native cross-context behaviour still need integration validation; manual recovery and external filesystem tests remain unfinished.
