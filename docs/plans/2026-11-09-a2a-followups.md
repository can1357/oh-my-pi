# A2A Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete A2A-1 through A2A-8: discover and address kept-alive agents, preserve incoming requests across delivery/worker races, route replies unambiguously, and truncate Unicode safely.

**Architecture:** Keep one main-owned incoming-request ledger and bridge it into workers through the existing A2A thread service. Replace destructive consumption with acknowledged leases, establish the record before IRC delivery, and bind cleanup to recipient removal and the existing reply deadline. Reuse the registry/lifecycle delivery path for idle/parked agents; the card advertises only agents that path can actually reach. Keep reply transport detached from turn settlement while exposing a deterministic drain for tests.

**Tech Stack:** TypeScript, Bun >=1.4.4, JSON-RPC 2.0/SSE, IRC bus, existing agent registry/lifecycle, worker-thread RPC, `bun:test`.

**Spec:** [2026-11-09-open-issues-design.md](../specs/2026-11-09-open-issues-design.md), **Группа A → A2A**, A2A-1..A2A-8, and **Общие требования**. Read both the spec and this plan. This plan does not implement Teams, INF, or Windows failure-classification workstreams.

## Global Constraints

The spec's shared requirements, verbatim:

- Bun 1.4.4 (`>=1.4.4`); на этой машине - явный путь к 1.4.4 первым в `PATH`/`Path`.
- Каждое изменение поведения - регресс-тест, падающий до правки и проходящий после.
- `bun check` пакета `coding-agent` зелёный; Rust - `cargo test -p pi-shell` без новых падений.
- Документация (`docs/a2a.md`, `docs/agent-teams.md`, `docs/settings.md`) и `[Unreleased]` в `packages/coding-agent/CHANGELOG.md` обновляются в задаче, которая меняет поведение.

Application to this workstream:

- Paths in task file lists are relative to `packages/coding-agent/`, except `docs/...`, which is repository-root-relative. Commands in Tasks 1–8 run from `packages/coding-agent/`; Task 9 explicitly distinguishes repository-root commands.
- Use Bun 1.4.4 for reproducibility. Before execution, resolve its installed executable, put its directory first in `PATH`/`Path`, and run `bun --version` to record `1.4.4`. Do not install dependencies or substitute a different runtime silently.
- `bun run check` explicitly invokes the coding-agent package's `check` script (lint, format check, types); it is the package gate intended by the spec's `bun check`, not just the Bun built-in type checker.
- Maintain loopback-only binding (`127.0.0.1`), bearer authentication on JSON-RPC, public card behavior, advisor exclusion, bridge-created-only cancellation, exact-ref ownership, and the distinction between `a2a.replyTimeoutMs` and `a2a.clientTimeoutMs`.
- Do not change the wire protocol, settings defaults, persisted formats, task/job ownership, or `a2aSpawn: true` behavior beyond the listed fixes. `a2a.replyTimeoutMs` remains `1_800_000`; `0` disables expiry. No new dependency, retry policy, delivery guarantee, or background polling of remote answers.
- Change exported interfaces by clean cutover: use LSP references first; migrate all production callers, proxies, protocol types, fixtures, and tests in that task. No old destructive-consume alias or compatibility shim.
- Update `docs/a2a.md` and package `[Unreleased]` with each user-visible behavior change. `docs/agent-teams.md` and `docs/settings.md` stay unchanged unless an existing statement about these A2A semantics becomes false; no new setting is planned. Test-only Task 1 needs no user-facing changelog entry.
- Implementers do not run builds, tests, lint, or formatters mid-flight. Each red/green command below is executed and its output recorded by the controller at the indicated checkpoint, before the task commit. Serialize checkpoints; do not test a sibling's half-written shared files. Commits below are execution steps, not permission to commit during this planning assignment; obtain execution/commit authorization first and stage only listed task-owned paths.

## Review Focus

These are the five seam failures that need explicit coverage beyond a straightforward happy-path implementation:

1. An idle/parked ref becomes unavailable between card discovery and delivery: fail like an unknown recipient, never revive or deliver to an unrelated replacement (Task 8).
2. Two terminals advertise the same skill and the supplied URL matches neither: never fall back to the first or sole wrong endpoint, and retain the request for manual reply (Task 5).
3. Recipient removal or expiry occurs while a lease is held: worker exit or a late release must not resurrect the discarded request (Tasks 2 and 4).
4. A ref is registered, removed, and optionally replaced before the registration promise callback runs: GetTask/ListTasks/SSE and CancelTask must never expose or cancel the stale generation (Task 6).
5. A detached send is deliberately blocked: turn finalization still completes, but a negative test assertion must wait until the relay's selection/send/cleanup work really settles (Task 1, retained in Tasks 2 and 5).

## Coverage and execution order

| Design item | Owning task | Deliverable |
| --- | --- | --- |
| A2A-1 | 8; live acceptance in 9 | Ordered/capped card, idle wake, supported parked revive, security regression |
| A2A-2 | 5 | URL-pinned sender resolution; ambiguous requests stay manually answerable |
| A2A-3 | 3 | Await incoming note before delivery; exact rollback on refusal/throw |
| A2A-4 | 6 | Exact-ref check at pending-registration settlement |
| A2A-5 | 2 | Leases, send acknowledgement, worker-exit recovery, all callers migrated |
| A2A-6 | 4 | Removal/deadline cleanup, including leased records |
| A2A-7 | 1 | Deterministic relay drain and meaningful negative assertions |
| A2A-8 | 7 | Code-point caps for task artifacts and wake-turn published output |

Execute **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9**. Tasks 6 and 7 have no semantic dependency on the lease work, but share `rpc.ts`/tests; keep this serial order in one checkout. If later executed in isolated worktrees, merge and rebase these shared-file changes before their controller checkpoints. Do not manufacture parallel tasks from this plan.

Each marked task gets a fresh per-task review after green and before acceptance. One final whole-branch review covers all tasks and their seams before Task 9's live run. Use subagent-driven execution because concurrency and exposure changes require those per-task reviews.

## File map

- `src/a2a/incoming-requests.ts`: authoritative open/leased request state, rollback, recipient/expiry cleanup; no second worker-local ledger.
- `src/thread/services/a2a-incoming.ts`, `a2a-incoming-protocol.ts`, `a2a-incoming-remote.ts`: main-assigned lease ownership, wire operations, exit recovery, worker proxy. Reuse `a2a-outgoing.ts`'s peer-state/exit pattern.
- `src/a2a/reply-relay.ts`: deterministic completion seam, safe peer choice, correlated send and lease acknowledgement for Main and subagent auto-replies.
- `src/task/index.ts`: explicit task-tool reply claims and acknowledgement; preserve addressed outgoing-job and remote-spawn branches.
- `src/task/executor.ts`: detached subagent reply, finalization integration and published-output cap.
- `src/a2a/rpc.ts`, `server.ts`, `src/main.ts`: pre-delivery bookkeeping, callback-to-ledger cutover, cleanup lifetime, exact pending-spawn generation, task artifact cap and agent-card selection.
- `src/a2a/agent-bridge.ts`, `client.ts`: retain existing sender URL/endpoint identity and peer registration/capping behavior; change only where Tasks 5/8 require it, not a transport rewrite.
- `src/registry/agent-registry.ts`, `agent-lifecycle.ts`, and existing IRC recipient delivery: activity/revivability decisions for Task 8; retain the existing revive path rather than starting another agent with the same ID.
- Tests: `test/a2a-incoming-requests.test.ts`, `a2a-reply-relay.test.ts`, `a2a-server.test.ts`, `a2a-client.test.ts`, `test/thread/a2a-incoming.test.ts`, its `test/fixtures/a2a-incoming-worker.ts`, `test/task/persisted-revive.test.ts`, `test/session/irc-bridge-relay.test.ts`, and the existing lifecycle/Unicode helper suite if extended.
- User docs: repository `docs/a2a.md`, package `CHANGELOG.md`. Execution/live evidence belongs in this plan's checkboxes/evidence block, not a new permanent report or throwaway script.

## Discrepancies and decisions

- **A2A-4 location:** the pending-registration callback is currently `onRegistrationResolved` in `src/a2a/rpc.ts` (around 605), not the peer-registration code in `agent-bridge.ts`. `server.ts` removes an already-resolved row only when `record.ref === removedRef`; it misses removal before the callback has stored `ref`. Task 6 fixes that actual state transition.
- **A2A-2 prerequisite:** `parseSendMessageParams` already reads `fromUrl`, but `A2aIncomingRequest` currently contains only `from`, `messageId`, `to`, `at`, and delivery drops the URL. Task 5 carries the existing optional metadata into the ledger; it does not add a new wire field.
- **A2A-5 affects more than the worker proxy:** Main relay, executor relay, and explicit `TaskTool.#runA2aSpawn` all call destructive `consume`. Task 2 migrates all of them together; fixing only worker exit would still lose requests or double-answer them.
- **Planner decision:** newest activity first within each advertised status group, with ID as a deterministic tie-breaker. The spec says “по последней активности” without a direction. Task 8 documents this choice.
- **Planner decision:** failed/ambiguous automatic attempts release their lease for a manual answer but do not use output from a later unrelated human turn to retry automatically. No exactly-once network guarantee is claimed: worker death after the peer accepted a reply but before local acknowledgement can reopen it.
- **Parked capability is conditional, not an exemption from implementation:** prove the existing lifecycle's actual revive capability and use it. Exclude unsupported parked refs; do not advertise them on status alone. Task 8 must test both supported and unsupported cases.
- No A2A-1..A2A-8 item is deferred. Known Windows/Rust baseline failures belong to Group C; the final controller gate records comparison without silently fixing or suppressing them here.

---

### Task 1: A2A-7 — make detached relay tests wait for the work they assert about

**Review:** per-task — concurrency

**Files:** Modify `src/a2a/reply-relay.ts`, `src/main.ts`; tests `test/a2a-reply-relay.test.ts`, `test/a2a-client.test.ts`, `test/task/persisted-revive.test.ts`.

**Interfaces:**
- Consumes existing `A2aReplyRelayOptions`, `SendA2aReplyOptions`, and event subscription.
- Produce `A2aReplyRelayHandle { stop(): void; settled(): Promise<void> }`; change `installA2aReplyRelay(options: A2aReplyRelayOptions): A2aReplyRelayHandle` and migrate all unsubscribe callers.
- Produce `settleA2aReplies(): Promise<void>` for detached sends in the current thread. Track each `sendA2aReply` operation synchronously on invocation and remove it in `finally`; drain until the tracked set is empty. Handle `settled()` first drains its event-decision queue, then detached sends, and rechecks for work enqueued while draining. It is an explicit test/control seam, never awaited by production turn finalization. It must include lease cleanup after Task 2, not only transport entry.

- [ ] **Step 1: Add the failing regression** `settled waits for selection and detached transport while terminal finalization stays nonblocking`. Gate `rescan` and `send` with `Promise.withResolvers<void>()`; emit terminal `agent_end`. Assert finalization/event handling completes while send is blocked, and a completion flag on `handle.settled()` remains false until the gates resolve. Once drained, assert the exact send count. In executor harness `finish()` plus `settleA2aReplies()` must cover the real finalization path. Change existing negative assertions for explicit reply, nonterminal end, aborted/error/empty turn, external reply, stale text, missing peer, and next human turn to await the appropriate drain, replacing `Bun.sleep(0)` and microtask guesses. Preserve a positive send control in the same harness so a no-op relay cannot make the negatives pass.
- [ ] **Step 2: Controller confirms red.** Run `bun test test/a2a-reply-relay.test.ts test/a2a-client.test.ts test/task/persisted-revive.test.ts`; expect missing handle/drain behavior or the new blocked-send assertion to fail. A fixture import/setup error is not the regression signal.
- [ ] **Step 3: Implement the completion seam and migrate callers.** Keep sends detached; do not replace `void sendA2aReply(...)` with an awaited network send in Main's decision queue or the executor. In `main.ts` call `handle.stop()` on shutdown. Tests explicitly drain before resetting globals/stopping fixtures, and unsubscribe handles in cleanup. No new runtime queue/retry policy.
- [ ] **Step 4: Controller confirms green** with the same command; all tests pass and blocked transport still does not block turn settlement. Run this command again after the later lease/selection changes only at their checkpoints, not in parallel.
- [ ] **Step 5: Commit.** `git add src/a2a/reply-relay.ts src/main.ts test/a2a-reply-relay.test.ts test/a2a-client.test.ts test/task/persisted-revive.test.ts` then `git commit -m "test(a2a): make detached reply assertions deterministic"`.

### Task 2: A2A-5 — lease incoming requests and recover a dead worker's unacknowledged claims

**Review:** per-task — concurrency

**Files:** Modify `src/a2a/incoming-requests.ts`, `reply-relay.ts`, `src/task/index.ts`, `src/task/executor.ts`, all three `src/thread/services/a2a-incoming*.ts`; tests `test/a2a-incoming-requests.test.ts`, `a2a-reply-relay.test.ts`, `a2a-client.test.ts`, `test/thread/a2a-incoming.test.ts`, `test/fixtures/a2a-incoming-worker.ts`, `test/task/persisted-revive.test.ts`; `docs/a2a.md`, `CHANGELOG.md`.

**Interfaces:**
- Consumes Task 1's drain; preserve `note(request): Promise<void>` and `list(to?): Promise<A2aIncomingRequest[]>` (open requests only, FIFO).
- Produce `IncomingRequestLease { leaseId: string; request: A2aIncomingRequest }`. Change `IncomingRequestsApi.consume(match: IncomingRequestMatch): Promise<IncomingRequestLease | undefined>`; add `confirm(leaseId: string): Promise<boolean>` and `release(leaseId: string): Promise<boolean>`. Confirm permanently removes; release returns the original request to its original FIFO position, not the tail. Duplicate/stale operations return false.
- Main concrete methods take an optional `home?: ThreadId` after their normal arguments for `consume`, `confirm`, `release`; service handlers bind `peer.threadId` on main, never accept a worker-supplied owner. Produce main-only `dropHome(home: ThreadId): void` to release only that worker's outstanding leases. Unowned main claims stay independent.
- `IncomingRequestsProtocol`/`RemoteIncomingRequests` expose the new return type and confirm/release methods, not `home`/`dropHome`. Service peer state rejects new claims after exit and prevents another worker confirming/releasing a foreign lease.
- Change `SendA2aReplyOptions` to carry `lease: IncomingRequestLease` instead of `request`; change `sendA2aReply(options): Promise<boolean>`. It sends `lease.request`, confirms only on `exitCode === 0`, releases on failure/no reachable peer/throw, and includes that settlement in Task 1's tracking. `false` means not successfully sent, not a silent successful acknowledgement.

- [ ] **Step 1: Add failing tests** `worker exit reopens only its unconfirmed incoming leases`, `confirmed lease never reopens`, and `explicit and automatic reply race has one claimant`. In the real-worker harness return `{ worker, probe }`, expose consume/confirm/release, and use an exit-hook completion promise (a test `ThreadService.onWorkerExit` after the incoming service) rather than a sleep. Claim request A in worker 1, leave B in worker 2, terminate worker 1 before send, await exit cleanup; assert A is open at its original FIFO position, B remains unavailable to other consumers, and a confirmed C is absent. Reclaim A and prove its old lease token cannot confirm/release the new claim. Race main/worker consumption: exactly one lease exists. Try cross-worker acknowledgement: it cannot close another worker's request. Gate transport in Main and executor tests; assert a successful send removes the request only after confirmation, and a failed/throwing send restores it for manual reply. Explicit task reply followed by automatic finalization still emits exactly one correlated response.
- [ ] **Step 2: Controller confirms red.** Run `bun test test/a2a-incoming-requests.test.ts test/thread/a2a-incoming.test.ts test/a2a-reply-relay.test.ts test/a2a-client.test.ts test/task/persisted-revive.test.ts`; expect destructive consumption/worker recovery assertions to fail.
- [ ] **Step 3: Implement the state transition and service.** Store open and leased entries in the same main ledger with stable order and fresh opaque lease IDs. `consume` is atomic with respect to all main and worker callers. Follow `a2a-outgoing.ts`'s per-peer dead-state and `onWorkerExit` pattern; do not depend on a worker running `finally` after it dies. Remove peer bookkeeping on every exit path.
- [ ] **Step 4: Migrate every consumer.** Main relay and executor pass the lease to `sendA2aReply`; explicit `#runA2aSpawn` passes `lease.request.messageId` to `#finishA2aRun`, acknowledges based on the actual `SpawnA2aAgentResult.exitCode`, and releases in failure/abort/throw paths before packaging the outcome. Keep `a2aSpawn: true` outside incoming matching. Retain the request's one automatic-turn opportunity even if it is released; a later human turn is not a retry. Migrate all tests/fixtures from `consume()?.messageId` to the lease contract. Update docs/changelog: claim is temporary until successful send; worker loss reopens an unacknowledged claim; do not promise exactly-once delivery across network/ack failure.
- [ ] **Step 5: Controller confirms green** using Step 2's command. The worker tests must use real worker links, and negative send assertions await Task 1's drain.
- [ ] **Step 6: Commit.** Stage exactly the Files block's modified paths (including `docs/a2a.md` from repository root) and run `git commit -m "fix(a2a): recover unacknowledged incoming reply leases"`.

### Task 3: A2A-3 — record the request before the recipient can finish its turn

**Review:** per-task — concurrency

**Files:** Modify `src/a2a/rpc.ts`, `server.ts`, `src/main.ts`, `src/a2a/incoming-requests.ts`, `src/thread/services/a2a-incoming-protocol.ts`, `a2a-incoming.ts`, `a2a-incoming-remote.ts`; tests `test/a2a-server.test.ts`, `a2a-client.test.ts`, `a2a-incoming-requests.test.ts`, `test/session/irc-bridge-relay.test.ts`, incoming worker fixture/test if they implement the API; `docs/a2a.md`, `CHANGELOG.md`.

**Interfaces:**
- Consumes Task 2's authoritative `IncomingRequestsApi`.
- Add `discard(match: IncomingRequestMatch): Promise<void>` to the API and worker protocol/proxy; removes matching open **and leased** records, invalidating their lease IDs. With an exact rollback match `{to, from, messageId}`, unrelated requests remain untouched. Task 4 uses `{to}` for recipient removal.
- Replace `A2aDispatchDeps.noteIncomingRequest?` and `A2aServerOptions.onIncomingRequest?` with `incoming?: IncomingRequestsApi`. `createA2aServer` resolves an omitted ledger to `IncomingRequests.global()`; dispatch callers without incoming tracking may omit it. Inject a fresh concrete ledger in isolated server fixtures. Production passes the same global instance used by relays and workers. Remove the old callback plumbing from `main.ts` and all fixtures/callers, rather than keeping two bookkeeping paths.

- [ ] **Step 1: Add failing tests** `fast recipient can claim request before send receipt resolves`, `refused delivery discards only its incoming request`, and `throwing delivery invalidates a pending claim`. In `send`'s stub, synchronously list/claim the just-addressed request and complete a correlated answer before returning the receipt; assert it was already present. Gate `note` and assert bus `send` has not entered until note resolves. Return a failed receipt, and separately throw; assert the exact record is absent afterwards, another queued request is retained, and release of a discarded lease cannot resurrect it. Include `inReplyTo` and absent-`from` cases: neither creates a new incoming request. Run the actual A2A→IRC integration and assert the original A2A message ID survives, not the IRC bus ID.
- [ ] **Step 2: Controller confirms red.** Run `bun test test/a2a-server.test.ts test/a2a-client.test.ts test/a2a-incoming-requests.test.ts test/thread/a2a-incoming.test.ts test/session/irc-bridge-relay.test.ts`; expect the fast recipient/order and refusal cleanup assertions to fail against post-delivery recording.
- [ ] **Step 3: Implement ordering and rollback** in `sendA2aMessage(params: unknown, deps: A2aDispatchDeps): Promise<A2aTask>`. For a request with `from` and no `inReplyTo`, build the exact incoming record and await `incoming.note(...)` **before** `deps.send`. If note fails, do not deliver. On `receipt.outcome === "failed"` or a send exception, await exact `discard` and preserve the existing failure/error mapping. Do not roll back a successful `woken`/`queued`/`injected` receipt. Preserve outgoing correlated-reply resolution before ordinary delivery and do not create an incoming record for a reply. Update callback users and docs/changelog in the same task.
- [ ] **Step 4: Controller confirms green** with Step 2's command; include the existing delivery-failure HTTP/JSON-RPC assertions, not just ledger unit tests.
- [ ] **Step 5: Commit.** Stage the Files block's actual changes by path and run `git commit -m "fix(a2a): record incoming requests before IRC delivery"`.

### Task 4: A2A-6 — expire requests and discard recipients that cannot answer

**Review:** per-task — concurrency

**Files:** Modify `src/a2a/incoming-requests.ts`, `src/a2a/server.ts`; tests `test/a2a-incoming-requests.test.ts`, `a2a-server.test.ts`, `test/thread/a2a-incoming.test.ts`; `docs/a2a.md`, `CHANGELOG.md`.

**Interfaces:**
- Consumes Task 3's `discard` and Task 2's leases. `discard({to})` invalidates both open records and leases for that recipient.
- Produce main-only `IncomingRequests.startCleanup(registry: Pick<AgentRegistryApi, "onChange">, replyTimeoutMs: number): () => void`; subscribe to `removed` and schedule the earliest positive deadline `request.at + replyTimeoutMs`. Expiry removes both states. Re-evaluate the timer on note, confirmation, release, discard, and expiry; `replyTimeoutMs <= 0` schedules no expiry timer but retains removal cleanup. Unref timers. The returned stop is idempotent and unsubscribes/clears timers.
- `startA2aServer` starts cleanup on the main concrete global/injected ledger with `cfgA2aReplyTimeoutMs.get(settings)` and stops it with the bridge, including failed startup after cleanup installation. Do not start a second cleanup service in each worker. Direct dispatcher/low-level server tests can explicitly install cleanup on their injected ledger.

- [ ] **Step 1: Add failing tests** `removed recipient cannot be resurrected by worker exit`, `reply deadline removes open and leased requests`, and `zero reply timeout retains requests until recipient removal`. With fake time, note at 100, configure timeout 50, assert open/claimable at 149 and absent at 150. Hold a second lease through expiry and assert its late release/confirm returns false. Remove one addressed ref while a worker holds its lease, await worker-exit hook, assert no reopening and no deletion of another recipient's request. With timeout 0 advance fake time well beyond 30 minutes: the request remains until `removed`. Stop cleanup and prove no active cleanup callback fires on subsequent removal/time advancement. Restore timers in cleanup.
- [ ] **Step 2: Controller confirms red.** Run `bun test test/a2a-incoming-requests.test.ts test/a2a-server.test.ts test/thread/a2a-incoming.test.ts`; expect expiry/removal assertions to fail, not a guessed-duration timeout.
- [ ] **Step 3: Implement cleanup** in the existing ledger/server lifetime. Use the same absolute `at` on lease release; releasing does not reset the deadline. Never recreate an expired/discarded request from a detached copy on worker exit. No idle/parked status transition alone deletes a still-addressable recipient's requests. Update docs/changelog to explain recipient removal, timeout `> 0`, and `0` semantics without conflating reply expiry with transport timeout or cancelling remote work.
- [ ] **Step 4: Controller confirms green** with Step 2's command; check removal-versus-release and expiry-versus-confirm yield one terminal ledger transition.
- [ ] **Step 5: Commit.** Stage the Files block's actual changes by path and run `git commit -m "fix(a2a): clean incoming requests on removal and deadline"`.

### Task 5: A2A-2 — resolve the sender by URL or refuse an ambiguous automatic reply

**Review:** per-task — security, concurrency

**Files:** Modify `src/a2a/rpc.ts`, `src/a2a/reply-relay.ts`; inspect existing URL forwarding/registration in `src/a2a/client.ts`, `agent-bridge.ts` and change only if necessary to preserve the contract; tests `test/a2a-server.test.ts`, `a2a-reply-relay.test.ts`, `a2a-client.test.ts`, `test/task/persisted-revive.test.ts`; `docs/a2a.md`, `CHANGELOG.md`.

**Interfaces:**
- Consumes Task 2's lease/release and Task 1's drain.
- Extend `A2aIncomingRequest` with `fromUrl?: string` and retain `ParsedSendMessage.fromUrl` when noting the request. Preserve it across worker serialization/lease return; no new transport field.
- Replace private `findPeer(bridge, from)` with `findPeer(bridge: A2aBridgeApi, request: A2aIncomingRequest): A2aRuntimeAgent | undefined`. Candidates have `skillId === request.from`. If `fromUrl` is supplied, require the registered endpoint URL to match (normal URL serialization, including a trailing `/`, not hostname alias/DNS equivalence); a mismatch never falls back. With no URL select only a single candidate. Duplicate matching registrations must not make selection arbitrary. Missing candidates may trigger the existing one rescan, followed by the same rule.
- When ambiguous, log structured candidate names/URLs (not tokens or answer text); do not send. Task 2 releases the lease and retains manual answerability. Use only registered peers and their existing credentials, never construct a destination or fetch credentials from inbound `fromUrl`.

- [ ] **Step 1: Add failing tests** `fromUrl selects the originating endpoint among equal skill ids`, `ambiguous sender remains open for a manual reply`, and `unmatched URL never selects a different endpoint`. Register two peers with identical `skillId` and distinct runtime names/URLs; the request with URL B must send only to B, with its original `inReplyTo`. Without URL, drain and assert zero sends, both candidate URLs in warning metadata, and the original request open. Manually claim that request and complete a reply to the deliberately selected runtime agent; confirm it closes once. With URL C (including a one-candidate wrong endpoint variant), assert zero sends after rescan, no network call to C and an open request. Also test a single legacy no-URL candidate and a newly discovered URL-matching peer. Main and executor both use this shared selection; test ambiguity through each automatic entry point, not only the private helper. Assert server bookkeeping retains optional `fromUrl` from the actual wire request.
- [ ] **Step 2: Controller confirms red.** Run `bun test test/a2a-server.test.ts test/a2a-reply-relay.test.ts test/a2a-client.test.ts test/task/persisted-revive.test.ts`; expect wrong-endpoint or prematurely-consumed-request assertions to fail against first-match lookup.
- [ ] **Step 3: Implement endpoint-aware resolution and metadata retention.** Resolve from the registered roster, log ambiguity once per attempted automatic opportunity, and release the lease on refusal. Do not relay a subsequent unrelated human turn after release. Existing `a2a:<name>-2` manual addressing remains the escape hatch; do not reinterpret `skillId` as the unique runtime name. Update docs/changelog with exact URL precedence and legacy ambiguity behavior.
- [ ] **Step 4: Controller confirms green** with Step 2's command and all negative assertions after `settled()`/`settleA2aReplies()`.
- [ ] **Step 5: Commit.** Stage the Files block's actual changes by path and run `git commit -m "fix(a2a): refuse ambiguous automatic reply destinations"`.

### Task 6: A2A-4 — do not resolve a pending spawn to an already-removed ref

**Review:** per-task — concurrency

**Files:** Modify `src/a2a/rpc.ts`, `src/a2a/server.ts` only if the removal transition needs factoring; test `test/a2a-server.test.ts`; `docs/a2a.md`, `CHANGELOG.md`.

**Interfaces:**
- Preserve `PendingSpawnRecord`, `PendingSpawnLedger`, `snapshotA2aTask(deps, id)` and the registration promise interface.
- `onRegistrationResolved(deps: A2aDispatchDeps, record: PendingSpawnRecord, ref: AgentRef): Promise<void>` must check **`deps.registry.get(ref.id) === ref` before** setting `outcome = "resolved"`, storing `record.ref`, claiming cancellation ownership, or invoking abort. A mismatch applies the existing removed-ref transition: discard the stale pending row and its ownership/context state, notify views, and never mutate a replacement ref. Do not introduce a new rejected/FAILED tombstone when normal removal yields missing.

- [ ] **Step 1: Add failing tests** `registration removed in the same turn never reappears through pending snapshot` and `pending cancel cannot affect replacement registered before promise settlement`. Use `Promise.withResolvers<AgentRef>()`, register the exact ref, resolve registration, then synchronously unregister it before yielding to `.then`. Establish an SSE subscription before this transition and await its final frame/closure, not a sleep. Assert `GetTask` has the existing missing-task response, `ListTasks` omits the old row, SSE emits the existing removal final failure exactly once and closes. Repeat with a distinct ref under the same ID and a pending cancel: views show the replacement, the old ref is not resurrected, and replacement abort/status spies remain untouched. Keep the legitimate still-registered resolution case green.
- [ ] **Step 2: Controller confirms red.** Run `bun test test/a2a-server.test.ts`; expect the stale pending snapshot/cancel assertions to fail.
- [ ] **Step 3: Implement the identity guard and shared removal transition.** Reuse server removal semantics rather than delaying by another microtask, adding a grace timer, trusting ID equality, or aborting whichever ref happens to own the ID. Guard against an obsolete callback deleting a newer ledger record by checking ledger record identity as well. Update docs/changelog to state pending registration cannot resurrect a removed agent.
- [ ] **Step 4: Controller confirms green** with the same command, including GetTask/ListTasks/SSE, registration rejection, cancellation, and replaced-generation coverage.
- [ ] **Step 5: Commit.** Stage the Files block's actual changes by path and run `git commit -m "fix(a2a): reject stale pending registration refs"`.

### Task 7: A2A-8 — cap output by Unicode code points without splitting surrogate pairs

**Files:** Modify `src/a2a/rpc.ts`, `src/task/executor.ts`, and an existing shared text helper only if no code-point truncator is available; tests `test/a2a-server.test.ts`, `test/task/persisted-revive.test.ts`, and that helper's existing test file if extended; `docs/a2a.md`, `CHANGELOG.md`.

**Interfaces:**
- Keep `A2A_ARTIFACT_MAX_CHARS = 100_000` and artifact/relay output shapes. Its unit becomes explicitly Unicode code points, not UTF-16 code units or grapheme clusters; no ellipsis is added.
- Both `taskFromAgentRef` artifact truncation and `relayA2aWakeTurnOutput`'s published-output branch use the same shared `truncateCodePoints(text: string, maxCodePoints: number): string` contract (reuse an equivalent existing utility if present; settle the exact existing import before editing). Prefer an index scan and one final slice, returning the original string when within the cap, rather than allocating an array of every code point. The uncapped plain final-text fallback remains unchanged.

- [ ] **Step 1: Add failing boundary tests** `artifact cap preserves astral code point at boundary` and `wake relay published output uses the same code-point cap`. Feed `"a".repeat(A2A_ARTIFACT_MAX_CHARS - 1) + "😀" + "z"` through the real artifact and executor published-output paths. Assert each emitted text equals the prefix ending in the complete `😀`, has exactly `100_000` code points, excludes `z`, and contains no new unpaired surrogate. Add distinct branches: ASCII over cap remains capped; all-astral text over cap retains exactly `100_000` full emoji; under/exact-cap output remains byte-for-byte identical. Use Task 1's send drain in the wake test. Do not claim grapheme preservation (a combining sequence may span the limit).
- [ ] **Step 2: Controller confirms red.** Run `bun test test/a2a-server.test.ts test/task/persisted-revive.test.ts`; expect the boundary emoji output assertions to fail against `.slice(0, 100_000)`.
- [ ] **Step 3: Implement/reuse the shared helper at both cap sites.** Search existing utilities first; preserve cap, artifact ID/metadata and published-file selection. Do not cap every ordinary relay text or change file transfer behavior. Update docs/changelog to name the code-point unit and safe astral truncation.
- [ ] **Step 4: Controller confirms green** with the same command, plus the exact existing helper suite if changed. Record that suite path in the task evidence when the helper is selected.
- [ ] **Step 5: Commit.** Stage the Files block's actual changes by path and run `git commit -m "fix(a2a): truncate published output at code-point boundaries"`.

### Task 8: A2A-1 — publish and deliver to reachable idle/parked subagents

**Review:** per-task — security, concurrency

**Files:** Modify `src/a2a/server.ts`, `src/a2a/rpc.ts`, existing registry/lifecycle and IRC recipient delivery code only where required; `src/a2a/agent-bridge.ts`/`client.ts` where peer cap placement requires it; tests `test/a2a-server.test.ts`, `a2a-client.test.ts`, `test/task/persisted-revive.test.ts`, `test/session/irc-bridge-relay.test.ts`, existing lifecycle suite; `docs/a2a.md`, `CHANGELOG.md`.

**Interfaces:**
- Consume registry refs, existing activity timestamps, and the lifecycle's existing revive/IRC wake interfaces. Keep `startA2aServer(options)`/`buildAgentCard` output shapes, skill IDs and Main's identity alias unchanged.
- Card order: Main first; `running` subagents; addressable kept-alive `idle` subagents; `parked` subagents supported by the existing revive path. Sort each status group by newest last activity, then ID. Exclude advisors, aborted agents, completed one-shot agents and unrevivable parked agents. Apply `cfgA2aMaxPeerSkills` after ordering; keep downstream peer registration caps as defense in depth.
- Addressed `sendA2aMessage` must use the existing IRC delivery for idle wake and lifecycle revive for parked recipients, not `spawnSubagent` as a new task. An impossible revive has the same externally observable unknown-agent failure as the current path (`RPC_ERRORS.TASK_NOT_FOUND`, HTTP 404 at addressed lookup); do not report a completed prior turn as accepted new work. Bus refusal after a legitimate lookup retains the existing `DELIVERY_FAILED` behavior.

- [ ] **Step 1: Add failing card/delivery/security tests** `card orders reachable kept-alive agents before applying maxPeerSkills` and `a2a addressed delivery wakes the idle kept-alive agent`. Mix Main, running, multiple idle with distinct activity times, supported parked, unsupported parked, aborted, completed one-shot and advisor refs; choose a cap cutting across status groups. Assert exact skill order and exclusions and that a peer registers that capped order. Deliver to an idle child through A2A→IRC and actual wake/finalize harness; assert same ID/session receives the request, wakes once, returns its unique correlated answer and does not call fresh spawn. Deliver to a supported parked child through persisted revive; assert original identity/context revived, response correlates once, and Main is not substituted. Unsupported/missing persisted state and a ref removed/replaced after discovery must not create a new same-ID agent or deliver to an unrelated replacement. Test the normal unknown-agent error contract and ensure no phantom incoming record remains after failure. Send unauthenticated and wrong-token requests to an idle/parked address: HTTP 401, no wake/revive/bus send; non-loopback bind is still refused. The public card must contain only existing public skill fields, not prompts, transcript/output contents, credentials, or filesystem paths.
- [ ] **Step 2: Controller confirms red.** Run `bun test test/a2a-server.test.ts test/a2a-client.test.ts test/task/persisted-revive.test.ts test/session/irc-bridge-relay.test.ts` plus the existing lifecycle suite selected below. Expect idle card visibility/order and supported parked delivery assertions to fail against the current running-only publication. Do not rerun the historical failed live scenario merely to reconfirm it.
- [ ] **Step 3: Implement card reachability and delivery.** Reuse real lifecycle eligibility/activity data; factor a narrow shared predicate only if card selection and delivery otherwise disagree. Use exact-ref/generation checks around asynchronous revive and handle ref removal while it is pending. Preserve normal idle wake, queued delivery, plan/authority guards, one-shot exclusion and the cap after sorting. Do not widen network exposure or export all registry entries indiscriminately.
- [ ] **Step 4: Update user docs and changelog in this task.** Replace the running-only `Card filtering` row in `docs/a2a.md`; document order, newest-activity sort, post-sort cap, kept-alive idle addressing, supported parked revive and refusal of unavailable recipients. Add an `a2a:` subagent example; distinguish terminal identity from child skill/runtime names and avoid promising every parked ref can revive. Add a concise `[Unreleased]` entry.
- [ ] **Step 5: Controller confirms green** with Step 2's exact commands; fresh per-task reviewer explicitly inspects public-card data exposure, authentication-before-wake, and stale-ref revive races. This is not the live acceptance: Task 9 must still run.
- [ ] **Step 6: Commit.** Stage the Files block's actual changes by path and run `git commit -m "feat(a2a): expose reachable idle and parked subagents"`.

### Task 9: Controller-only final gates and two-terminal live verification

**Files:** Modify only this plan's execution checkboxes and the evidence block below. No new production behavior, test bypass, temporary credential file, or permanent standalone smoke script.

**Interfaces:**
- Consumes all green task results, per-task reviews for Tasks 1–6 and 8, final whole-branch review, Task 8's card/delivery contract, actual source CLI and existing model credentials.
- Produces recorded command outcomes plus terminal identities, target child ID, idle state, skill address, original request/reply correlation, one received answer and cleanup evidence. Controller runs the live test itself; a subagent report, mocked server, two requests within one process, or Main-to-Main substitution is not acceptance.

- [ ] **Step 1: State the live regression test and red condition.** Test name: `two processes discover and address an idle kept-alive child after card expansion`. Assert B's child is idle and still kept alive, its ID appears in B's card, A registers the corresponding `a2a:` address, and A's actual task plus `wait` receives exactly the child's unique answer. The old running-only card fails the child-visibility/address-discovery assertion, as specified by A2A-1; use Task 8's recorded failing regression as red evidence rather than inventing a prior live run. Any missing assertion in the final real run is FAIL, not a reason to replace the target with Main or a running child.
- [x] **Step 2: Run final automated gates once after all edits/reviews land.** From `packages/coding-agent/` run:

  ```sh
  bun --version
  bun test test/a2a-server.test.ts test/a2a-client.test.ts test/a2a-incoming-requests.test.ts test/a2a-reply-relay.test.ts test/thread/a2a-incoming.test.ts test/thread/a2a-outgoing.test.ts test/session/irc-bridge-relay.test.ts test/task/persisted-revive.test.ts
  bun run check
  ```

  Include the exact lifecycle/shared-helper suites extended by Tasks 7/8. From repository root run `cargo test -p pi-shell` and compare its actual failure signatures with the known Group C baseline; no new failures are acceptable. A nonzero package check remains a failed gate, even if unrelated: report evidence and do not declare this plan verified. Do not rerun a user-reported failure solely to confirm it or broaden this plan to repair Group C. Do not mark checks green based on a subagent's statement.
- [ ] **Step 3: Start two real terminals on the changed source.** Use the same profile/agent directory and working tree, distinct names and ephemeral ports. From repository root, terminal A runs `bun run dev --a2a-name a2a-followup-sender --a2a-port 0`; terminal B runs `bun run dev --a2a-name a2a-followup-receiver --a2a-port 0`. Confirm both are running the changed checkout, not a globally installed binary, and record their bridge URLs. Use existing model credentials; do not expose tokens in logs or recorded commands. If real terminal/model access is unavailable, record the precise prerequisite and leave this task unchecked—automated tests do not replace it.
- [ ] **Step 4: Establish the actual idle child in B.** Ask B to create a named schema-less kept-alive subagent `A2aIdleProbe`, with instructions to finish its first turn, remain available, and on the next external request answer only its supplied unique marker in final text, without an explicit `task` reply. Confirm via B's roster/Agent Hub that the first turn finished and the child is `idle`, not running, completed one-shot, removed, or already parked. Record its exact registry ID. Fetch B's public card at its observed URL plus `/.well-known/agent-card.json` (PowerShell `Invoke-RestMethod` or the browser/read tool); record that exact child skill is present. This visibility assertion must occur after the card change and while the child is idle.
- [ ] **Step 5: Discover and address the child from A.** Run `/a2a auto` and `/a2a list` in A, or use `read agent://` to refresh. Copy the actual registered `a2a:<child-skill>` runtime name; never assume the human label equals the skill ID. Ask A to use `task` addressed to that exact `a2a:` child with prompt `Reply with A2A-IDLE-<unique-run-marker> in your final text; do not spawn a reply task.` Use normal addressed mode, not `a2aSpawn: true`. Record receipt and owned running reply-job ID. Have A invoke `wait` on that job; no sleep/poll loops and no sending directly to B's Main. Require `wait` to return the exact unique marker once.
- [ ] **Step 6: Verify causality and no duplicate.** Inspect B's child transcript: the original idle child received the external request, woke and produced the marker; no fresh child or explicit reply task produced it. Inspect A's result/correlation: original A2A message ID matches `inReplyTo`, the expected peer identity matches, the job completes once and there is no duplicate IRC answer or reply-back loop. Observe the recipient settle through the existing lifecycle UI/event stream, not a timed sleep. Stop both terminals cleanly and confirm their own discovery registrations are removed; never clear another process's registry file.
- [ ] **Step 7: Record outcomes and commit evidence.** Fill the evidence block with actual commands, pass/fail outputs/log locations, reviewed task commit IDs and live observations; keep secrets out. Update checkboxes only for exercised steps. From repository root run `git add docs/plans/2026-11-09-a2a-followups.md` then `git commit -m "docs(a2a): record followup verification evidence"`. This commit records real results, not an assertion that unrun checks passed.

## Execution evidence (controller fills during approved implementation)

- Runtime executable/version and task commits: bun 1.4.4 (~/.bun/bin/bun first in PATH). Task commits: T1 df746e6d65 (+chore 0329fe8b07), T2 371e2991dd, T3 d369cbf8fe (+chore 2a3c09d7f7), T4 4b559e867f, T5 9d5fc814c5, T6 a1d1a0f09c, T7 ab61dfaa65 (+polish 3a3eae00f3), T8 cd16dffd45 + fix 40dc418a3c, format chore for persisted-revive test. Branch: sdd/open-issues-2026-11-09.
- Red/green outputs and per-task review verdicts: every task recorded red (assertion failures, per task-N-report.md Evidence sections) before its fix; per-task reviews returned spec_compliant for all eight; fix rounds: T1 re-review all_addressed, T8 fix round 1 re-review all_addressed (see ledger .superpowers/sdd/2026-11-09-a2a-followups/progress.md for the full verdict chain). Final whole-branch review: Mergeable YES, 0 Critical/Important, 1 Minor (write-only LedgerEntry.seq).
- Final package checks and Rust baseline comparison: focused 8-file suite 320 pass / 0 fail (bun test a2a-server a2a-client a2a-incoming-requests a2a-reply-relay thread/a2a-incoming thread/a2a-outgoing session/irc-bridge-relay task/persisted-revive); bun run check exit 0 (after one oxfmt drift fix in persisted-revive.test.ts, committed); cargo test -p pi-shell: 2447 pass / 19 fail — failure set byte-identical to the pre-branch macOS baseline (zsh mod/zle/prompt/git/ps host failures unrelated to A2A files); no new failures.
- Final whole-branch review: complete (sdd-final-reviewer over all 12 A2A commits; ledger triage all-accept; Mergeable YES).
- Live terminal identities/URLs, idle child ID and actual `a2a:` name: NOT RUN — prerequisite unavailable: two interactive omp TUI terminals with live model credentials (bun run dev --a2a-name … --a2a-port 0) cannot be driven headlessly by this controller session. Task 8's recorded failing regression (card running-only order) serves as the red evidence per Step 1; the composite live path remains the one unverified acceptance step, per plan text permitting "record the precise prerequisite and leave this task unchecked".
- Live original message ID, reply-job ID, correlated marker and duplicate check: not run (same prerequisite as above).
- Clean shutdown/discovery cleanup: not run (same prerequisite as above).

## Planner self-review

- A2A-1..A2A-8 each has an owning task in the coverage table; none silently omitted or downgraded to a test-only substitute.
- Each task defines consumed/produced interfaces, a named failing regression with observable assertions, a runnable command, implementation/acceptance steps and a commit step. Task 9 is explicitly a controller-run live acceptance test, not a new unit-test fixture.
- Mandatory per-task reviews: A2A-1 security (Task 8), A2A-3 concurrency (Task 3), A2A-4 concurrency (Task 6), A2A-5 concurrency (Task 2); other concurrency/security seams are marked as well.
- All five Review Focus conditions map to tests in their owning tasks. Interface changes include main entry, explicit replies, executor, thread RPC, remote proxies and fixtures, not just local unit tests.
- Completion requires the final real idle-child run after the card change; no implementation, automated gate or live-verification outcome is claimed by this plan.
