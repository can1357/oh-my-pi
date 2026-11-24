# Improvement: preserve fork behavior on quarantined upstream

## Intent

Repair carry assembly without importing upstream commits younger than the shared quarantine. The eligible base for this repair is c2f787e37c9c733b4489267eb4ff8eb72c619a47. Original topic refs remain intact.

## Migration inventory

- Compatibility: fork delta of merge 006b428ba2 relative to its upstream parent ad9206d87c, plus fork-only merge deltas c2a8b27a5a and db1ea413a4 and test port 680810785f. This retains all legacy compatibility behavior, SQL fallback, broker wake, hot reload, restart, eval visibility and forced CLI verification, without importing ad9206d87c. Conflicts retain eligible upstream APIs and fork effects together.
- Formatting: 24e04fc48a and 317cef09c9, retaining eligible upstream implementation in whitespace-only overlaps rather than reverting to older relay APIs. The newer upstream merge a340a833fe is excluded.
- AI fixtures: 1144eb84a5 and b2893ec509, retaining catalog-resolver-owned fixtures; newer upstream merge 5bcc9c6ce0 excluded.
- Advisor fallback: 0b83b37eca preserves explicit role identity; newer upstream merge 00f012e31f excluded.
- Tern launch: 52591c7414 behavior and regression cases ported to the eligible terminal-multiplexer registry instead of importing the younger driver rewrite. Exact argv, pane validation, nested-multiplexer precedence and SQL-backed session launch preserved.
- Unified find: separate feat/find-quarantine-01a20e96 replays 1bcb94917a, 33c3da2c37, be85a937df, 21ab71b570, 8f3f99460d, bf33e206b0 and 29ec284382; compatibility-merge ancestry is replaced by the safe compatibility topic.
- Export viewer: original topic was based on assembled probe merges, not independent source. Its only source changes are 61de072be7 formatting and 6c79c4d650 generated metadata; these are replayed after the safe find topic, never by merging its contaminated probe ancestry.

## Verification contract

Fresh replay uses committed source topics on the eligible base. The declared typecheck recipe is `bun install --frozen-lockfile && bun run check:ts`. No release build, dispatch, promotion or installation is part of this source repair.

## Preserved SQL picker evidence

### Open shared-store resume sessions without scanning every transcript

## SQL picker intent

Make the installed `omp --resume` picker visibly ready within a hard 30-second PTY deadline, preserving shared-only sessions and existing scope/filter behavior.

## Evidence

- Installed release `build-20261122225547-8829553-041ccf8` and a replay of its 18 carried topics both failed to render `Resume Session` within the 28-second observation window (hard outer deadline 30 seconds). Startup remained in `SessionManager.listForPicker`.
- Upstream-only source and compiled controls were fast because they used file storage; the fork's CLI explicitly supplies `resolveSessionStorage()` and therefore SQL storage. Bun 1.4.4 versus 1.4.5 and the release native addon were ruled out independently.
- Shared SQL initialization took 2107.54 ms. The current folder had 1183 shared rows, 226 with indexed titles. The picker then issued 247 per-file slice/line/assistant-turn reads before its 30-second diagnostic deadline; individual reads commonly took 130–700 ms, with some exceeding 5 seconds.
- The real SQLite SQL regression failed before the production change: expected one batched prefix call before blocked full scans, observed zero.

## Contract and ownership

`session-listing.ts` owns picker projection: titled indexed-storage rows use existing backend title/stat metadata and the existing batched header reader, then the unchanged full scan completes asynchronously. Shared-only paths never require a disk stat or realpath. All-project enumeration uses the storage's bucket listing. Header properties remain intact for assembly-owned foreign-session filtering; current-folder sibling directories, pinned empties, untitled completion, and explicit resume loading retain their existing owners.

## Pattern inventory

- One file-only fast-path decision in `pickerListing` excluded shared SQL storage; extended at the same owner.
- One disk-only global enumeration/deduplication path lost shared-only rows; backend enumeration and local-only realpath deduplication now distinguish their actual filesystem requirements.
- Existing batched prefix policy, title normalization, stat identity, full scan, and picker filtering are reused rather than duplicated.

## Verification

- `mise run test:resume-picker`: 13 passed, 0 failed, 32 assertions (2.38 s).
- Exact installed carry replay with correction: 14 passed, 0 failed, including foreign side-panel session exclusion (6.31 s).
- Release-equivalent compiled PTY proof: actual picker at 8.824 s, exit 0; independent parent probe at 5.216 s, exit 0. Original exact compiled control exceeded 28 s without rendering.
- `fix/sql-resume-picker-metadata` contains the correction and permanent `mise run smoke:resume-picker` (real login-zsh PTY with hard 30-second deadline). Registered assembly topic `zab/9bb1ecc8` is carried by fork config commit `8dcc46e04f`.
- The latest release pipeline remains independently blocked by an existing Tern/upstream conflict. The verified prior assembly plus this correction can be installed as explicit macOS arm64 prerelease `build-20261124171500-8829553-resumefix`, not promoted as latest.

## Preserved retry fallback evidence

### Prove exhausted model recovery and repair role coverage

## Retry fallback intent

“Models are supposed to be falling back”: preserve the selected model as a preference, advance its configured chain on route failures, and keep cancellation terminal.

## Observations

- The at-0hgvsm worker launched with `--model @task` and the pin-model overlay. Its print log recorded Grok HTTP 403 `personal-team-blocked:spending-limit` once.
- Supported transcript export `omp:01a20e81-88da-7285-965d-0fb3ca77fc99` contains 38 usage-bearing turns on `openai-codex/gpt-6.1-sol`, from Unix timestamp 1795539725.243 to 1795540565.16. Thus fallback had succeeded; a quiet print log did not establish a stalled model route. No retry-engine change is justified by this incident.
- Live `retry.fallbackChains.design` repeated only its primary. `judge` contained `@tiny` and `@smol`, both resolving to the same Grok model. Explicit chains supersede default inheritance. These were genuine configuration coverage defects, not classifier defects.
- A separate installed CLI regression changed only the primary assignment from `task: loopback/primary` to `task: @memory`, `memory: loopback/primary`. The same configured task chain then failed HTTP 403 with exit 1 and empty stdout rather than recovering. Runtime chain construction parsed raw `@memory` as a concrete selector, obtained no primary, and returned no candidates. This confirms a real alias-backed fallback defect independently of the historical worker.

## Ownership and contract

The existing shared classifier owns credit/budget classification; session recovery owns traversal, replay safety, and exhaustion. User YAML owns role-specific order. Preserve all role primaries, advisor separation, retry policy, and the pin overlay. Expand design with the existing default suffix and judge with the existing tiny chain. Do not append default chains globally or change cancellation semantics.

The new native Bun test launches either source CLI or `OMP_TEST_BINARY` under isolated HOME with loopback HTTP providers. It records actual model requests, compares complete request messages across fallback, requires the completion token and exit status, checks finite exhaustion and abort rejection, and optionally validates distinct routes for every configured role through `OMP_FALLBACK_CONFIG`.

## Retry fallback evidence

Before YAML repair, the installed CLI already recovered both HTTP 403 Grok credit and HTTP 422 budget failures via `loopback/primary -> loopback/fallback`, preserving request messages and returning exit 0. Both-denied routes terminated with exit 1. The coverage assertion failed with `error: design`, `Expected: > 1`, `Received: 1` (3 pass, 1 fail).

After the atomic YAML edit, the installed proof reports `5 pass`, `0 fail`, `33 expect() calls` in 10.05 seconds: credit and budget failures recover with exit 0, actual RPC user cancellation requests only primary and exits 0, both exhausted models terminate with exit 1, and all configured roles have distinct fallback identities. The tested executable is `/Users/zbornheimer/.local/share/mise/installs/github-zachbornheimer-oh-my-pi/build-20261124171500-8829553-resumefix/omp`.
Run the focused installed proof from this worktree:

```sh
OMP_TEST_BINARY="$(mise where github:zachbornheimer/oh-my-pi)/omp" \
OMP_FALLBACK_CONFIG="$HOME/.omp/agent/config.yml" \
bun test packages/coding-agent/test/cli-credit-fallback.test.ts
```

The shared fallback chain constructor now calls the existing `resolveConfiguredModelPatterns` owner for role primaries and entries, retaining nested alias expansion, outer effort precedence, and bounded cycle handling. No classifier, role-order, advisor separation, or retry policy is replaced. Focused selector and real CLI tests cover the changed path; the repaired source must be shipped through fork/mise before claiming installed alias recovery.

The existing configured-pattern expander deliberately layers effort suffixes; `parseModelString` now consumes every recognized layer with the outermost effort authoritative, retaining literal `:max`/`:auto` lookup guards. Source proof: 33 focused fallback/CLI tests pass (108 assertions); 15 shared model-string parser tests pass (29 assertions); coding-agent typecheck passes across 5,822 files. The CLI fixture passes the scanner with zero findings and uses a fixed executable argv launcher without a shell.

## Retire stale extension reporters during live refresh

### Refresh intent

Make live extension refresh observe dependency repairs without allowing detached work from a retired extension to report stale failures.

### Refresh evidence and hypotheses

- Real `loadLegacyPiModule` relative dependency probe observed A then B after only the dependency changed: relative import-cache retention is refuted on this source.
- The SDK regression through `createAgentSession`, production `initializeExtensions`, and `session.refreshExtensions({ changedOnly: true })` observed A, B, then a rejected A promise's stale message. Detached message delivery after replacement is confirmed.
- The same immediate dependency edit initially produced no replacement: asynchronous baseline capture could fingerprint repaired bytes before completing startup. Awaiting baseline capture removes this startup race.
- Absolute dependency imports retained old code in a separate probe. They are not the load checker's relative-import path and are not changed in this pass.

### Refresh ownership and contract

- Existing `extensionSignature` owns dependency change detection; no wrapper-level reload policy is added.
- The runner owns message authority: shutdown revokes an instance after its shutdown handlers finish; activation and session-start restore authority for a reused instance, including rollback.
- `ConcreteExtensionAPI.sendMessage` checks that authority before delegating. Live delivery and runtime errors retain their existing behavior. A retired instance's detached send is ignored because it no longer owns the session.
- Resource/subscription disposal also revokes message authority for removed and rejected instances.
- SDK baseline capture completes before the refresher is exposed.
- This host change cannot replace already-created APIs in an older compiled runtime through extension refresh. It becomes active when the fixed host binary starts; a successful extension refresh alone does not prove host activation.

### Refresh proof

The new regression was red on the old owner with `[A, B, stale A failure]` instead of `[A, B]`. Focused SDK and reloader suites then passed 42 tests. Coverage includes dependency-only edits without warmup, a pending rejected A promise after replacement B, unchanged entries, rollback, removal, rejected startup, timers, and bus subscriptions. Final restart-authority coverage is included in the focused gate.

Acceptance owner command:
`/Users/zbornheimer/.local/share/mise/installs/bun/1.4.5/bin/bun test /Users/zbornheimer/Developer/Personal/.worktrees/oh-my-pi-fix-extension-dependency-refresh/packages/coding-agent/test/sdk-extensions-hot-reload.test.ts /Users/zbornheimer/Developer/Personal/.worktrees/oh-my-pi-fix-extension-dependency-refresh/packages/coding-agent/test/session/extensions-hot-reload.test.ts`

The requested wrapper acceptance remains unchanged. Full repository build/gate and deployment are NOT PROVEN here; the parent owns release integration. No entrypoint extraction or new production module is introduced.

After rebasing the patch onto the already-carried quarantined compatibility owner, focused acceptance passed 47 tests with 131 assertions across SDK, reloader, and wrapper suites. The replay revealed and fixes one compatibility integration defect: all synthetic `<...>` host registrations, including `<custom-tools:cwd>`, are excluded from filesystem removal decisions rather than only `<inline-N>`. Native fixture artifact reports version 19.1.1 against checkout 19.1.0; no native behavior is changed or claimed, and the release assembly must test with its matching artifact.

# Improvement: Keep native atask carry within upstream quarantine

## Intent

Rebase the two native atask commits onto the fork's published quarantine-eligible upstream base without changing the quarantine policy.

## Evidence and compatibility

- Previous base: `26702495a57ba8f0161a99ec34a370cba014dedc`; release run `45460599717` rejected its young ancestry.
- Eligible base: `b3142bf7e7e459560919abec0658b5f3851bcbcc`, recorded by successful run `45459937259` and release `build-20261124183143-b3142bf-4556921` in `fork-plan.json`.
- Preserve native dispatch, parent-memory checks, durable atask verification, and restore routing. Apply task contract additions to this base's existing `packages/tui/src/tools/task.ts` owner; do not recreate the later coding-agent task-details module or import later renderer APIs.
- Preserve this base's extension rendering contracts and batch-input behavior rather than importing unrelated newer upstream changes.

## Verification

The three requested native atask test files passed: 30 tests, 138 assertions, zero failures, using Bun 1.4.5. The native loader warned that the existing binary is 19.1.1 while this eligible checkout is 19.1.0; assembled-release checks and installed-binary proof remain the release owner's responsibility.

## Outcome

The carry no longer needs young upstream ancestry. The separate fork-tool defect—creating topics from the mirror tip rather than the quarantine-selected base—is outside this native carry's scope and must be fixed by its owner.
