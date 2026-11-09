# Agent Teams Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close T-1 through T-11 from the open-issues design: team notices stop distorting reply accounting and job waits, empty teams retire, one idle notice per turn, bounded stop timeout, prompt resolution of stops for never-registered members, revisioned plan approval, coded runtime errors, a complete read-only plan-gate allowlist, and notices that do not spend the member's IRC budget.

**Architecture:** All team state stays main-owned in `TeamRuntime` (`src/task/team-runtime.ts`); workers reach it only through the existing team thread service (`src/thread/services/team*.ts`). Notices remain IRC messages flagged `teamNotice`; this plan changes how the bus, the ingress guard and `wait` treat that flag, not the transport. No new persisted format, no new setting.

**Tech Stack:** TypeScript, Bun >=1.4.4, IRC bus (`src/irc/`), agent registry/lifecycle, worker-thread RPC (`src/thread/rpc.ts`), `bun:test`.

**Spec:** [2026-11-09-open-issues-design.md](../specs/2026-11-09-open-issues-design.md), section **Группа A → Teams** (T-1..T-11, plus the "Не делаем" paragraph) and **Общие требования**. Historical design: [2026-11-06-agent-teams-design.md](../specs/2026-11-06-agent-teams-design.md). User contract: [docs/agent-teams.md](../agent-teams.md).

## Global Constraints

The spec's shared requirements, verbatim:

- Bun 1.4.4 (`>=1.4.4`); на этой машине - явный путь к 1.4.4 первым в `PATH`/`Path`.
- Каждое изменение поведения - регресс-тест, падающий до правки и проходящий после.
- `bun check` пакета `coding-agent` зелёный; Rust - `cargo test -p pi-shell` без новых падений.
- Документация (`docs/a2a.md`, `docs/agent-teams.md`, `docs/settings.md`) и `[Unreleased]` в `packages/coding-agent/CHANGELOG.md` обновляются в задаче, которая меняет поведение.

Application to this workstream:

- Paths in Files blocks are relative to `packages/coding-agent/`, except `docs/...` (repository root). Commands run from `packages/coding-agent/`.
- Before any test run: put the Bun 1.4.4 directory first in `PATH` (and `Path` on Windows) and record `bun --version` = `1.4.4`. With Bun 1.3.x, `bun check` is not a built-in and recurses into the package `check` script (exit 23) — that is not a code failure. The package gate is `bun check` run in `packages/coding-agent/` (oxlint, oxfmt check, `bun check --no-script -p tsconfig.json`).
- Red/green discipline: write the failing test first, run it and record the failure, implement, rerun and record the pass. A red caused by an import/fixture error does not count; the assertion that encodes the behavior must be the one failing. Record the red and green output in the task's evidence block (commit message body or a short `## Evidence` note appended to this plan under the task).
- No `Bun.sleep`/timer guessing in new tests: wait on promises, registry events, `IrcBus` receipts, or fake timers already used by `test/thread/team-runtime.test.ts`.
- Keep main-owned authority: every runtime check resolves membership, lead and generation on main; workers never pass identity that main trusts without `#authorize`.
- Clean cutover for changed signatures (LSP references first): migrate `TeamRuntime`, `TeamProtocol`/`RemoteTeamClient`/`TeamEndpoint` (thread service), `test/fixtures/team-runtime-worker.ts`, and all tests in the same task.
- Do not change: whole-team stop semantics without ack (lead gets the timeout notice and decides `--force`), dedup semantics, `teamControl` meaning for lead→member control messages, A2A behavior. The spec's "Не делаем" items stay undone: no dedup between a decline notice and the lead's wake relay; no protection against extensions that register tools named like built-ins.
- One commit per task, conventional message given in the task; stage only the task's files.

## Review Focus

1. A notice must never be counted as an answer, and must never steal a job-only `wait` (T-1, T-2).
2. Retiring an empty team must not race a concurrent `/team start` of the same name, a pending spawn whose registration is still in flight, or a stop that is mid-release (T-3).
3. Exactly one idle notice per finished turn, including structured members whose first text stop is followed by a yield reminder, and wake turns (T-4).
4. Plan approval with `--rev` must be a compare-and-set against the current submitted revision; a stale revision changes nothing (T-8).
5. Notices exempt from the rate budget must remain runtime-authored only; an agent cannot set the exemption flag through any tool (T-11).

## Coverage and execution order

| Design item | Task | Deliverable |
| --- | --- | --- |
| T-1 | 1 | Notices never answer an open question |
| T-2 | 1 | Job/service `wait` is not interrupted by a notice; notice delivered after |
| T-11 | 2 | Runtime-authored member notices exempt from rate budget |
| T-5 | 3 | `team.stopAckTimeoutMs` clamped to 1000..2147483647 |
| T-6, T-7 | 4 | Never-registered member stop resolves immediately; handle-only stop of aborted member tested |
| T-3 | 5 | Empty generation retires and notifies lead; park guard released |
| T-4 | 6 | One idle notice per finished turn |
| T-9 | 7 | Coded runtime errors carried over RPC; cold-revival fallback compares `code` |
| T-10 | 8 | Plan gate admits `find`, `ast_grep` |
| T-8 | 9 | Plan revisions and `/team approve|reject --rev N` |
| docs | 10 | `docs/agent-teams.md`, CHANGELOG consolidated check, final verification |

Execute 1 → 10 serially in one checkout (Tasks 3–6 and 9 all edit `team-runtime.ts`). Per-task review after each green: security for 2, 7, 8; concurrency for 1, 4, 5, 6, 9. One final whole-branch review before Task 10's live check.

## File map

- `src/irc/bus.ts`: `#lastSent`/`#lastDirect`/`#lastProgress` reply accounting, `unansweredSends`, `sentSince`, `IrcWaitFilter`, `ircWaitAccepts`.
- `src/irc/ingress-guard.ts`: `#checkRate`/`#accept` exemptions (`broadcast`, `wakeRelay`, `external`, `teamControl`).
- `src/irc/messaging.ts`: rendering tags (`team notice; no reply needed`); the agent-facing send path must not be able to set runtime flags.
- `src/tools/wait.ts`: `busLeg` (`IrcBus.global().wait(senderId, { directOnly: true, repliesFrom }, ...)`) next to job/service legs.
- `src/task/team-runtime.ts`: `#observeRegistry` (idle notice, ~lines 83–144), `#notifyLead` (~303), `#releaseStop` (~326), `requestStop` (~430), `resolvePendingStop` (~444), `stop` (~529), `hasLiveTeam` (~541), plan methods `submitPlan`/`approve`/`reject` (~624–700), `#authorize` (~560).
- `src/task/settings.ts`: `cfgTeamStopAckTimeoutMs` (description text only).
- `src/slash-commands/builtin-teams.ts`: `USAGE`, approve/reject parsing (~145–158), stop timeout read.
- `src/thread/services/team-protocol.ts`, `team-client.ts`, `team-remote.ts`, `team.ts`: RPC surface for changed signatures.
- `src/session/agent-session.ts`: `#teamPlanGate` (~5749–5794).
- `src/registry/agent-registry.ts`: `subscribeRunState` → `setStatus` (~487), `markResultAccepted` (~369).
- `src/task/executor.ts`: yield reminder ladder (~2700–2790), run settlement (~3900).
- Tests: `test/irc-bus.baseline.test.ts`, `test/irc-guard.test.ts`, `test/tools/wait.test.ts`, `test/wait-reply-ask.test.ts`, `test/teams.test.ts`, `test/thread/team-runtime.test.ts`, `test/team-protocol.test.ts`, `test/team-plan-commands.test.ts`, `test/agent-session-team-plan.test.ts`, `test/fixtures/team-runtime-worker.ts`.

## Discrepancies and decisions

- **T-1 contradicts a current doc comment.** `IrcBus.unansweredSends` documents "An addressed team notice also answers" and `send()` records `teamNotice` sends in `#lastSent` (bus.ts ~205–211). T-1 reverses that: a notice records into no reply table. `sentSince` (wake-relay skip) also stops seeing notices, so a member's idle notice no longer suppresses the wake relay's real answer. Update the comment.
- **T-6 is partly present.** `resolvePendingStop(..., failure)` already clears the stop and notifies "failed during registration". The reported gap (ledger: "pending-registration stop for an agent aborted before registration only times out") is a path where the spawn ends without calling `resolvePendingStop` with a failure. Task 4 must first reproduce which path that is (abort signal before register, spawn throw after reservation, or worker exit) and route it through the failure branch; do not add a second resolution mechanism.
- **T-8 revision numbering.** Today `reject` also increments `plan.revision` (team-runtime ~689) as an internal invalidation counter. The user-visible revision must count submissions only. Decision: keep an internal epoch for compare-and-set and expose `revision` = number of submissions in the member's current generation.
- **T-5 is a clamp, not validation.** `register({ validate })` throws on bad values; the spec says out-of-range values are clamped. Clamp at the runtime read site; settings description documents the range.
- **T-11 flag choice.** `teamControl` already means "runtime-authored, not charged" in the guard but also marks lead→member control. Decision: runtime-authored notices sent *on behalf of a member* (idle notice, stop decline/timeout/failed notices) carry `teamControl: true` as well. The flag is only settable by runtime code: verify `src/irc/messaging.ts` and the `write agent://` / `write team://` handlers build `IrcMessage` explicitly without passing through caller-supplied flags (add a test if any path spreads caller input).

---

### Task 1: T-1, T-2 — notices neither answer questions nor interrupt job waits

**Review:** per-task — concurrency

**Files:** Modify `src/irc/bus.ts`, `src/tools/wait.ts`; tests `test/irc-bus.baseline.test.ts`, `test/tools/wait.test.ts` (or `test/wait-reply-ask.test.ts` if the reply-wait harness lives there); `docs/agent-teams.md`, `CHANGELOG.md`.

**Interfaces:**
- `IrcBus.send`: a message with `teamNotice: true` records into none of `#lastSent`, `#lastDirect`, `#lastProgress`. Progress-only messages keep current behavior.
- `IrcWaitFilter` gains `teamNotices?: boolean` (default `true` = accepted, current behavior). `ircWaitAccepts` rejects `msg.teamNotice` when `teamNotices === false`.
- `WaitTool`: when the wait has jobs (`jobs.length > 0`) or `serviceRunning`, `busLeg` passes `teamNotices: false`. Pure reply waits (`replyWait`) keep accepting notices.

- [ ] **Step 1: Failing tests.**
  - `a team notice from the asked agent leaves the question unanswered`: A sends B a direct message; B sends A a message with `teamNotice: true, progress: true`; assert `unansweredSends(A, t0)` still lists B with `promised: false`. Then B sends a plain message; assert the list is empty.
  - `a team notice does not count as sentSince for the wake relay`: same setup, assert `sentSince(B, A, t0) === false` after only a notice.
  - `a job wait is not interrupted by a team notice, which is delivered afterwards`: start `wait` on one running background job owned by the session; while blocked, send the waiting agent a `teamNotice`; assert the wait has not settled (resolve job afterwards; result `wake === "job"`); then assert the notice is still delivered to the agent (inbox/queued message visible through the same mechanism the existing "message arrives during wait" test uses).
  - `a reply wait still wakes on a team notice`: keep/confirm the existing behavior with a reply-only wait.
- [ ] **Step 2: Run red.** `bun test test/irc-bus.baseline.test.ts test/tools/wait.test.ts test/wait-reply-ask.test.ts` — the first three new tests fail on assertions.
- [ ] **Step 3: Implement.** In `send()`, skip all three `#record` calls when `message.teamNotice`. Fix the `unansweredSends` doc comment. Add `teamNotices` to `IrcWaitFilter`/`ircWaitAccepts`; pass `teamNotices: false` from `wait.ts` only for job/service waits. Confirm (read `IrcBus.wait` / mailbox code) that a message rejected by a waiter's filter stays queued for normal delivery and is not dropped; if it is dropped, fix that in the same task with a test.
- [ ] **Step 4: Run green** with the Step 2 command plus `test/teams.test.ts test/thread/team-runtime.test.ts`.
- [ ] **Step 5: Docs.** `docs/agent-teams.md`: notices are informational — they wake a reply wait but never count as an answer and never interrupt a wait on your own jobs/services. One `[Unreleased]` → `Fixed` line.
- [ ] **Step 6: Commit** `fix(teams): keep team notices out of reply accounting and job waits`.

### Task 2: T-11 — runtime-authored member notices do not spend the member's IRC budget

**Review:** per-task — security

**Files:** Modify `src/task/team-runtime.ts`; tests `test/irc-guard.test.ts`, `test/thread/team-runtime.test.ts`; `CHANGELOG.md`.

**Interfaces:** Idle notice (`#observeRegistry`) and `#notifyLead` sends add `teamControl: true`. No guard change: `teamControl` already skips `#checkRate`/`#accept` charging; dedup is not applied to `progress` messages (unchanged).

- [ ] **Step 1: Failing test** in `test/thread/team-runtime.test.ts` with the IRC ingress guard enabled (`Settings.isolated({ "irc.ingressGuard": true, "irc.rateLimitTokens": <small> })`, the pattern used by `test/irc-guard.test.ts`): emit an idle notice for member M (running→idle) whose body costs more than half the budget, then have M submit a plan whose cost fits the budget only if the notice was not charged; assert the plan submission succeeds. Second test: a stop timeout notice for M likewise leaves M's budget intact.
- [ ] **Step 2: Security check test** `an agent-authored send cannot claim teamControl`: send through the public messaging path (`src/irc/messaging.ts` send helper used by `write agent://`) with any extra fields in params; assert the resulting `IrcMessage` lacks `teamControl`/`teamNotice` and is charged. If the path already builds messages explicitly, this test passes immediately — keep it only if it would catch a plausible regression (it does: a future `...params` spread).
- [ ] **Step 3: Run red.** `bun test test/thread/team-runtime.test.ts test/irc-guard.test.ts`.
- [ ] **Step 4: Implement** the two flag additions; update the `teamControl` comment in `ingress-guard.ts` to "runtime-authored team traffic (control and notices on behalf of members)".
- [ ] **Step 5: Run green**, then `bun test test/teams.test.ts test/team-protocol.test.ts`.
- [ ] **Step 6: Commit** `fix(teams): do not charge runtime team notices to the member's IRC budget`.

### Task 3: T-5 — clamp `team.stopAckTimeoutMs` to 1000..2147483647

**Review:** none beyond final

**Files:** Modify `src/task/team-runtime.ts` (`requestStop` intent `timeoutMs`), `src/task/settings.ts` (description); tests `test/thread/team-runtime.test.ts`; `docs/settings.md` (row for `team.stopAckTimeoutMs`), `docs/agent-teams.md`, `CHANGELOG.md`.

- [ ] **Step 1: Failing test** with fake timers: `requestStop(..., timeoutMs = 2 ** 31)` (and `Number.MAX_SAFE_INTEGER`) must not time out after 1 ms; advancing timers by 1000 ms must not produce the timeout notice; the stored intent timeout equals `2147483647`. Existing tests already cover `0`, `-10`, `NaN` → 1000; keep them.
- [ ] **Step 2: Run red** `bun test test/thread/team-runtime.test.ts -t "clamp"` (Node/Bun `setTimeout` overflow fires immediately today).
- [ ] **Step 3: Implement** `Math.min(2_147_483_647, Math.max(1000, timeoutMs))` with a named constant; settings description: "Milliseconds (1000..2147483647; out-of-range values are clamped)".
- [ ] **Step 4: Run green** and `bun test test/teams.test.ts`.
- [ ] **Step 5: Commit** `fix(teams): clamp stop acknowledgement timeout to the timer range`.

### Task 4: T-6, T-7 — stops for never-registered members resolve at once; aborted handle-only stop is tested

**Review:** per-task — concurrency

**Files:** Modify `src/task/team-runtime.ts`, and the spawn path that fails to report registration failure (expected `src/slash-commands/builtin-teams.ts` member loop and/or `src/task/spawn-subagent.ts` / `src/task/executor.ts` abort-before-register path — determine in Step 1); tests `test/teams.test.ts`, `test/thread/team-runtime.test.ts`; `docs/agent-teams.md`, `CHANGELOG.md`.

**Interfaces:** No new API. Every terminal outcome of a reserved member's spawn that does not register a ref must call `resolvePendingStop(..., failure)` exactly once. The lead notice text becomes `Stop request for <id> released: never registered (<failure>)`.

- [ ] **Step 1: Reproduce.** Test `a stop requested while the member is pending resolves when its spawn is aborted before registration`: `/team start` with a spawn mock that reserves and then rejects/aborts before `registry.register`; issue `/team stop <handle>` while pending (returns "stop pending registration"); abort the spawn; assert, without advancing timers to the ack timeout, that the stop intent is gone, the lead got exactly one notice containing `never registered`, and `/team status` shows the member as not spawned/failed. Write variants for (a) spawn promise rejects, (b) abort signal fires before register, (c) worker-hosted member worker exits before register (use `test/fixtures/team-runtime-worker.ts`). Record which variants fail.
- [ ] **Step 2: Failing test T-7** `handle-only stop of a member already aborted outside /team stop releases it and keeps the team`: register member, `registry.setStatus(id, "aborted", ref)` with no release in flight, `/team stop <handle>` (no `--force`, handle only) → returns `released`, member removed, other members untouched, `listTeams(lead)` still contains the team. (Code path `requestStop` "aborted" branch exists; this test pins it.)
- [ ] **Step 3: Run red** `bun test test/teams.test.ts test/thread/team-runtime.test.ts`.
- [ ] **Step 4: Implement** the missing failure reporting at the actual site found in Step 1 and change the notice wording in `resolvePendingStop`.
- [ ] **Step 5: Run green**; also `bun test test/team-protocol.test.ts test/thread/subagent-worker.test.ts`.
- [ ] **Step 6: Commit** `fix(teams): resolve stops of members that never registered`.

### Task 5: T-3 — an empty team generation retires and tells the lead

**Review:** per-task — concurrency

**Files:** Modify `src/task/team-runtime.ts`; tests `test/thread/team-runtime.test.ts`, `test/teams.test.ts`; `docs/agent-teams.md`, `CHANGELOG.md`.

**Interfaces:**
- Private `#retireIfEmpty(state: RuntimeTeam): Promise<void>`: if `state.members.size === 0` and no member is pending registration (`pendingRefs`/reservations) and no release is in flight (`state.releasing.size === 0`), call `this.stop(state.lead, state.name)` and send the lead one notice `Team <name> finished: no members left.` (`teamNotice: true, progress: true, teamControl: true`, from the lead's own id is wrong — use a runtime sender convention already used for team notices; if none exists, send from the last member id, matching `#notifyLead`).
- Call it after every member removal: `#releaseStop` success (replace the `intent.wholeTeam && size === 0` special case — whole-team stop keeps its existing retirement but now through the same helper), registration failure in `resolvePendingStop`, and registry `removed` events for a member's current ref (add: on `removed` matching `member.ref.id`/generation, delete the member, then retire if empty).
- `hasLiveTeam(lead)` returns false once retired (it reads `#sessions`, which `stop` clears) — the lead becomes parkable.

- [ ] **Step 1: Failing tests.** (a) Two members; handle-only stop + ack of each → after the second release, `listTeams(lead)` is empty, the lead received exactly one "finished" notice, `hasLiveTeam(lead) === false`. (b) Single member removed from the registry (simulate kill: `registry.remove(id)` or release without the runtime) → team retires. (c) Race: last member's release in flight while `/team start <same name>` is invoked → the new generation is not stopped by the old generation's retirement (assert by generation number). (d) Whole-team stop where one member never acks: unchanged — team stays live, lead gets the timeout notice.
- [ ] **Step 2: Run red** `bun test test/thread/team-runtime.test.ts test/teams.test.ts`.
- [ ] **Step 3: Implement** with generation checks: retire only `state` whose generation is still current for `(lead, name)`.
- [ ] **Step 4: Run green**; plus `bun test test/team-protocol.test.ts test/task/persisted-revive.test.ts` (park guard).
- [ ] **Step 5: Docs/changelog:** empty teams end automatically; the lead is notified and can be parked again.
- [ ] **Step 6: Commit** `fix(teams): retire a team generation when its last member leaves`.

### Task 6: T-4 — one idle notice per finished turn

**Review:** per-task — concurrency

**Files:** Modify `src/task/team-runtime.ts` and the run-settlement signal source (expected `src/task/executor.ts` and/or `src/registry/agent-registry.ts`); tests `test/thread/team-runtime.test.ts`, `test/task/persisted-revive.test.ts` (wake turns), possibly `test/task/structured-subagent.test.ts`; `CHANGELOG.md`.

**Context:** The idle notice is emitted on every registry `status_changed` running→idle. `AgentRegistry` mirrors `session.subscribeRunState` into `setStatus` (agent-registry ~487), so a structured member that ends a prompt with text (idle) and is then re-prompted by the executor's yield reminder ladder (executor ~2715, `MAX_YIELD_RETRIES`) produces two running→idle transitions — the live run showed two notices per Builder turn. Wake turns of a kept-alive member settle through the same run-state path.

**Interfaces:** Decide the notice on "turn finally idle", defined as: the run reached its terminal decision (accepted `yield`/`handback`, reminders exhausted, or a wake turn ended) and the ref is idle. Preferred signal: the existing `markResultAccepted`/run-settlement point for spawned runs and wake-turn end for kept-alive members. If a registry event already distinguishes it (e.g. `metadata_changed` with `lifecycle.acceptedAt`), use it; otherwise add a minimal registry event field (e.g. `status_changed` carries `final: true` when emitted from settlement) rather than a new channel. The summary excerpt comes from that final turn; when it is empty, fall back to the run's yielded summary (fixes the "empty idle excerpt after yield" minor).

- [ ] **Step 1: Failing tests.** (a) Structured member: first prompt ends with text → executor reminder → member calls `yield` → assert exactly one idle notice, sent after the yield, whose excerpt is the yield summary. (b) Plain member whose reminders are exhausted without yield → exactly one notice. (c) Kept-alive member woken by a lead message, answers, ends turn → exactly one notice per wake turn. (d) Two consecutive wake turns → two notices (dedup must not suppress legit repeats; notices are `progress`, so dedup does not apply).
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Implement**; remove now-dead branches in `#observeRegistry`.
- [ ] **Step 4: Run green** with `bun test test/thread/team-runtime.test.ts test/teams.test.ts test/task/persisted-revive.test.ts test/task/structured-subagent.test.ts test/thread/subagent-worker.test.ts` (worker-hosted member notice must still be produced — check main-side ref.session may be undefined for worker refs).
- [ ] **Step 5: Commit** `fix(teams): send one idle notice per finished member turn`.

### Task 7: T-9 — coded team runtime errors

**Review:** per-task — security

**Files:** Modify `src/task/team-runtime.ts`, `src/session/agent-session.ts`; tests `test/agent-session-team-plan.test.ts`, `test/thread/team-runtime.test.ts` (worker RPC path); `CHANGELOG.md` (no user-visible text change → optional).

**Interfaces:** `export class TeamRuntimeError extends Error { readonly code: "TEAM_STALE_GENERATION" | "TEAM_LEAD_GONE" | ...; }` (name `"TeamRuntimeError"`). Throw it at the existing "Unknown or stale team generation" and "Team lead is no longer registered" sites (`#authorize`, `start`, `requestStop`, plan target lookup). Messages unchanged. `thread/rpc.ts` already transfers own fields (`#encodeError` → `props`, `#decodeError` restores) — verify `code` arrives on the worker side; do not register an error factory unless needed. `#teamPlanGate` fallback checks `isRecord(error) && (error.code === "TEAM_STALE_GENERATION" || error.code === "TEAM_LEAD_GONE")`.

- [ ] **Step 1: Failing tests.** (a) Worker-hosted gated member with `planApproval: false` after the lead is gone: tool call allowed (cold-revival fallback) — through real worker RPC (`test/fixtures/team-runtime-worker.ts`), asserting the error that crossed RPC has `code`. (b) Same error message but no `code` (a plain `Error("Team lead is no longer registered")` thrown by a stub) → gate blocks. (b) is the red test: today message comparison lets it through.
- [ ] **Step 2: Run red** `bun test test/agent-session-team-plan.test.ts test/thread/team-runtime.test.ts`.
- [ ] **Step 3: Implement.** Grep all `new Error("Unknown or stale team generation")` / `"Team lead is no longer registered"` sites and convert all of them.
- [ ] **Step 4: Run green**, then `bun test test/teams.test.ts test/team-protocol.test.ts`.
- [ ] **Step 5: Commit** `fix(teams): match cold-revival fallback on error codes, not text`.

### Task 8: T-10 — plan gate admits read-only `find` and `ast_grep`

**Review:** per-task — security

**Files:** Modify `src/session/agent-session.ts` (`#teamPlanGate` switch); tests `test/agent-session-team-plan.test.ts`; `docs/agent-teams.md`.

- [ ] **Step 1: Verify read-only.** Read `src/tools/find*` (`FindTool`, `name = "find"`) and `src/tools/ast-grep.ts` (`AstGrepTool`, `name = "ast_grep"`): confirm neither writes to disk or spawns mutating processes (record file:line). `ast_edit` stays blocked. If either can write, stop and report instead of allowlisting it.
- [ ] **Step 2: Failing test:** gated member with pending plan: `find` and `ast_grep` pass; `ast_edit`, `edit`, `bash`, `write` to a file path stay blocked.
- [ ] **Step 3: Run red** `bun test test/agent-session-team-plan.test.ts`.
- [ ] **Step 4: Implement** two `case` labels.
- [ ] **Step 5: Run green**; docs list of allowed tools updated.
- [ ] **Step 6: Commit** `fix(teams): allow read-only find and ast_grep before plan approval`.

### Task 9: T-8 — plan revisions and `--rev`

**Review:** per-task — concurrency

**Files:** Modify `src/task/team-runtime.ts` (`MemberPlan`, `submitPlan`, `approve`, `reject`, notices), `src/thread/services/team-protocol.ts`, `team-client.ts`, `team-remote.ts`, `team.ts`, `src/slash-commands/builtin-teams.ts` (USAGE, parsing, completion if any); tests `test/team-plan-commands.test.ts`, `test/teams.test.ts`, `test/thread/team-runtime.test.ts`; `docs/agent-teams.md`, `CHANGELOG.md`.

**Interfaces:**
- `MemberPlan` gets `submissions: number` (user-visible revision, increments on each accepted `submitPlan` within the member generation) and keeps an internal `epoch` (today's `revision` counter, incremented on submit and reject) for compare-and-set. Rename the existing field to `epoch` in the same change.
- `approve(lead, handle, revision?: number)`, `reject(lead, handle, reason, revision?: number)`: if `revision !== undefined && revision !== plan.submissions` → throw `Stale plan revision <revision>; current is <submissions>` (and `No submitted plan` as today when nothing is pending). Without `revision`, current behavior.
- Notices: plan submission notice to the lead includes `rev N`; approval/rejection notices to the member include `rev N`.
- Command: `/team approve <handle> [--rev N]`, `/team reject <handle> [--rev N] <reason>`; `--rev` must be a positive integer, else usage.

- [ ] **Step 1: Failing tests.** Submit twice (rev 1, rev 2); `approve --rev 1` → stale error naming current rev 2, plan still pending and gate still closed; `approve --rev 2` → approved; reject path symmetric; a resubmission after reject shows rev 3 (not 4). Slash command parsing test for `--rev` placement and bad values. Worker proxy test: revision argument crosses RPC.
- [ ] **Step 2: Run red** `bun test test/team-plan-commands.test.ts test/teams.test.ts test/thread/team-runtime.test.ts test/team-protocol.test.ts`.
- [ ] **Step 3: Implement** with clean cutover of protocol signatures and the worker fixture.
- [ ] **Step 4: Run green**; plus `bun test test/agent-session-team-plan.test.ts test/write-xdev-dispatch.test.ts`.
- [ ] **Step 5: Commit** `feat(teams): revisioned plan approval with --rev`.

### Task 10: Documentation consolidation and final verification

**Files:** `docs/agent-teams.md`, `docs/settings.md`, `packages/coding-agent/CHANGELOG.md` (dedupe lines added by Tasks 1–9 into a coherent `[Unreleased]` set).

- [ ] **Step 1:** Cross-check every user-visible statement in `docs/agent-teams.md` touched by Tasks 1–9 against the code (notice semantics, allowlist, `--rev`, empty-team retirement, timeout range). Fix stale text.
- [ ] **Step 2: Full focused suite:** `bun test test/teams.test.ts test/team-ledger.test.ts test/team-plan-commands.test.ts test/team-protocol.test.ts test/irc-guard.test.ts test/irc-bus.baseline.test.ts test/agent-session-team-plan.test.ts test/tools/wait.test.ts test/wait-reply-ask.test.ts test/thread/ test/task/persisted-revive.test.ts test/task/structured-subagent.test.ts test/write-xdev-dispatch.test.ts test/session/irc-bridge-relay.test.ts` — all pass.
- [ ] **Step 3: Package gate:** `bun check` in `packages/coding-agent` exits 0.
- [ ] **Step 4: Live check (optional if no interactive runtime is available; say so explicitly):** with `team.enabled: true` and a team of scout + reviewer (`planApproval: true` for reviewer), confirm: one idle notice per member turn; reviewer's `find`/`ast_grep` work before approval; `/team approve Reviewer --rev 1` after a second submission is refused; handle-only stop of every member retires the team with one "finished" notice.
- [ ] **Step 5: Commit** `docs(teams): document follow-up behavior`.
