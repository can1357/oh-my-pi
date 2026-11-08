# Agent Teams Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make team roles safe for read-only agents, make shared task claims atomic within an omp process, and add idle, cooperative stop, and plan-approval protocols.

**Architecture:** A main-owned `TeamRuntime` owns team generations, the actual lead and member identities, the ledger and control state. All sessions, including worker-thread sessions, use that single runtime via the existing thread-service RPC pattern; `team://` is a handler-backed coordination protocol whose caller identity comes from the tool session. The ledger is authoritative and `TASKS.md` is a generated view; IRC carries control requests and non-request notifications, not authority.

**Tech Stack:** TypeScript, Bun, `bun:test`, existing internal-URL router, IrcBus, AgentRegistry, AgentLifecycleManager and thread services.

**Spec:** `docs/specs/2026-11-08-review-fixes-design.md` W4.1–W4.3 and W7; `docs/specs/2026-11-06-agent-teams-design.md` §9 remains the underlying team design. All `src/` and `test/` paths below are relative to `packages/coding-agent/`; documentation paths are relative to the repository root.

## Global Constraints

- Execute in order W4.1 → W4.2 → W4.3; W1 is a prerequisite in the spec, so preserve the actual structured completion behavior present when executing and do not implement W1 here.
- Teams are in-process only; `team.enabled` remains default false and `team.maxTeammates` retains its existing behavior. Do not change ordinary non-team agents, IRC request/reply semantics, or session plan mode.
- Read-only team members retain their repository mutation prohibition; their added write grant is only `agent://` and `team://`, regardless of xdev. Existing explicit/full write grants remain full.
- Identify the caller from trusted session/worker context, never from a URL, request body or a worker-supplied arbitrary identity; reject nonmembers and stale generations. Preserve registry ref identity checks on release.
- Prompts live in static Markdown/Handlebars, not newly constructed code strings. Embed bundled prompt files at build time. Follow `AGENTS.md`; do not commit unless explicitly requested.
- Run the indicated failing-first tests during implementation, then the indicated focused checks. Each task is reviewed in the final branch review; marked tasks also get a fresh per-task reviewer.

## Review Focus

1. A discovered team prompt path is missing or unreadable: fail discovery/start with its file and reason rather than silently using an incompatible prompt (Task 1).
2. URI normalization or xdev cannot turn the restricted team write grant into disk, `xd://`, `local://`, or another coordination/device operation (Task 1).
3. A workspace already containing `TASKS.md` but no ledger must not lose user data on start (Task 2).
4. A stale ref or a delayed message from a previous generation must not mutate or stop the replacement member (Tasks 2 and 4).
5. Extension-rewritten or mounted calls must not bypass the unapproved plan gate (Task 5).

## File Map

- `src/task/types.ts`, `src/discovery/helpers.ts`, `src/task/agents.ts`, `src/task/discovery.ts`: parse and load team-specific agent prompts, including embedded prompts.
- `src/prompts/agents/{scout,reviewer}.md` and adjacent team prompt Markdown files; `src/prompts/system/subagent-system-prompt.md`: role and team instructions.
- `src/task/structured-subagent.ts`, `src/task/spawn-subagent.ts`, `src/task/executor.ts`, `src/sdk.ts`, `src/tools/{index,write}.ts`: propagate team identity and restricted write capability through child construction.
- `src/task/teams.ts`, `src/task/team-runtime.ts`, `src/slash-commands/builtin-teams.ts`: team parsing, main-owned membership/ledger and commands.
- `src/internal-urls/team-protocol.ts`, `src/internal-urls/router.ts`, `src/thread/services/{team,team-protocol,team-remote,index}.ts`: URI entry point and a typed main-owned service; follow `agents*` service registration/boot and worker-disconnect patterns.
- `src/registry/agent-registry.ts`, `src/session/irc-bridge.ts`, `src/session/agent-session.ts`, `src/task/settings.ts`: state transition notification, non-request semantics, gate and timeout. Modify only where the existing event/identity APIs need extension.
- `test/teams.test.ts`, focused internal-URL/thread/session tests: exercise actual commands, tool execution and worker/main routing, not just configuration objects.
- `docs/agent-teams.md`, `docs/specs/2026-11-06-agent-teams-design.md`, `packages/coding-agent/CHANGELOG.md`: user contract and design amendment.

---

### Task 1 (W4.1): Team role prompts and coordination-only write

**Review:** per-task — security

**Files:** Modify `src/task/{types,agents,discovery,structured-subagent,spawn-subagent,executor}.ts`, `src/discovery/helpers.ts`, `src/sdk.ts`, `src/tools/{index,write}.ts`, `src/prompts/agents/{scout,reviewer}.md`, `src/prompts/system/subagent-system-prompt.md`, `src/slash-commands/builtin-teams.ts`; create `src/prompts/agents/scout-team.md` and `reviewer-team.md`; test `test/teams.test.ts` and the existing agent-discovery and write-tool suites.

**Interfaces:** `AgentDefinition` gains `teamSystemPrompt?: string` and `team?: boolean`. `team-prompt` is a path relative to a discovered definition; bundled definitions use statically imported adjacent prompt assets mapped by their frontmatter path. Team spawn metadata carries a distinct `coordinationOnlyWrite` capability; do not infer a full-write grant merely from the presence of the tool name `write`.

- [ ] **Failing tests:** Extend the existing start fixture to use real definitions. Assert `/team start` rejects before reserving IDs, creating a workspace, or spawning any member when a read-only definition lacks a team prompt or when `team: false` lacks one; output names the member and reason. Assert writable definitions without a team prompt still start; assert a definition with `team: false` and a team prompt is accepted as specified. Parse a relative `team-prompt` in a temporary agent file and verify its content is selected only for team spawns, the normal body remains selected outside teams, and a missing file reports its path. Verify bundled scout/reviewer load their embedded team variants without requiring source files at runtime.
- [ ] **Failing capability tests:** Through the actual spawned child's write tool, with xdev both on and off, assert `write agent://<peer>` succeeds and a handler-backed `team://` coordination write reaches the handler; ordinary disk, `local://`, `xd://` and unrelated schemes are refused. Assert a definition already granting full `write` can still write a permitted file and non-team behavior is unchanged. Exercise selector/hashline/alias normalization, and assert a rebuild of tools cannot upgrade the restricted capability. Replace the old `withTeamIrcTools` assertion that treats adding a bare `write` as sufficient.
- [ ] Run `bun test test/teams.test.ts` from `packages/coding-agent`; expect the new tests to fail on missing prompt support and unrestricted writes. Use a minimal registered test handler for `team://` until Task 2 supplies the real one; remove it when that task lands.
- [ ] Implement prompt discovery: parse `team` and `team-prompt`, load relative file contents in the async discovery path, and map bundled frontmatter paths to statically imported text in `agents.ts` (the synchronous `parseAgent` cannot asynchronously read files). Preserve discovery precedence and report bad references rather than fallback. Add team variants that retain each role's substantive read-only/review instructions while explicitly permitting peer messages, team operations and a report to the actual lead.
- [ ] Check compatibility for all selected members before any side effects. Replace `withTeamIrcTools`' full `write` injection with explicit capability propagation through spawn, executor and SDK to `ToolSession` and `createTools`; instantiate the normal write tool even when xdev is off. In `WriteTool.execute`, after the existing normalized target resolution and before dispatch, restrict this capability to schemes `agent` and `team`; do not reuse `deviceOnlyWrite` alone because it also allows device, local sandbox and other file-free operations. Retain existing device-only behavior for non-team callers.
- [ ] Render the team system prompt instead of the normal one only for team members. Make the shared subagent template branch on team metadata: direct coordination and report to the lead replace the non-team automatic-Main/no-intermediate-message instructions. Preserve normal templates for other subagents and existing plan-mode restrictions.
- [ ] Run `bun test test/teams.test.ts` and the affected discovery/write test files; expect all to pass.

### Task 2 (W4.2): Main-owned runtime, atomic ledger, and worker protocol

**Review:** per-task — concurrency and persisted format

**Files:** Create `src/task/team-runtime.ts`, `src/internal-urls/team-protocol.ts`, `src/thread/services/{team,team-protocol,team-remote}.ts`; modify `src/task/teams.ts`, `src/slash-commands/builtin-teams.ts`, `src/internal-urls/router.ts`, `src/thread/services/index.ts` and service bootstrap/identity context as required; test `test/teams.test.ts` and a real thread-service integration test under `test/thread/`.

**Interfaces:** Define serializable `TeamTask = { id: string; title: string; owner: string | null; status: "open" | "done"; note: string }`. `TeamRuntime` owns `start`, `members`, `readTasks`, `addTask`, `claim`, `releaseTask`, and `completeTask`; every operation takes a runtime-resolved team generation and trusted caller identity. `claim` returns a discriminated `claimed | already-owned | conflict` result with the current owner for conflict. Expose these operations through the main-owned service and a worker proxy; neither filesystem locks nor a per-worker runtime are substitutes.

- [ ] **Failing tests:** Via actual router `read`/`write` dispatch, create a team with two members and one lead. `write team://audit/tasks` as lead adds a title and `read team://audit/tasks` returns the specified `{id,title,owner,status,note}` rows; a member cannot add. For two concurrent members claiming the same ID use `Promise.all`: exactly one gets `claimed`, the other gets `conflict` naming the winner; repeat the winner's claim and assert `already-owned` with no state change. Assert owner and lead can release, a different member cannot; done requires the owner or lead, records the body as note, and cannot be claimed until released/reopened. Assert unknown ID, malformed path, nonmember and old-generation requests fail without mutation.
- [ ] **Failing persistence/thread tests:** Start two different teams on the same workspace through equivalent canonical paths (including a symlink where supported); race claims against the same persisted ID from a main caller and a real worker caller, and assert one winner, one shared ledger and one generated view. Test no-workspace teams are isolated in memory; restart a workspace team and verify existing tasks/ownership survive and initial `tasks:` titles are not duplicated. Seed an old `TASKS.md` without `tasks.json` and assert startup preserves its bytes by refusing with an actionable migration error instead of overwriting it; invalid JSON must likewise fail closed. Test an I/O failure leaves no successful claim response and a subsequent read returns the authoritative ledger.
- [ ] Run `bun test test/teams.test.ts` and the added thread test from `packages/coding-agent`; expect failure because runtime and protocol do not exist.
- [ ] Move the command's `WeakMap` memberships into a single main-owned runtime without changing reservations, pending/failed reporting, collision behavior, `team.maxTeammates`, or stale-ref protection. Record lead session/ref, reserved member ID and an incrementing generation before spawn; propagate team identity/generation through `spawnSubagentForSession` to the child's trusted tool-session context. Resolve calls from the session bridge, verifying the registered ref and generation on the main side. Register and boot the typed thread service using the `agents` service pattern, including worker exit cleanup; route both lead commands and worker URI calls to the same main runtime.
- [ ] Extend `TeamDefinition`/parser with optional `tasks: string[]`; reject malformed entries. At first creation initialize IDs deterministically in input order (`"1"`, `"2"`, …), `owner: null`, `status: "open"`, `note: ""`; use the next unused numeric ID for lead additions. Never reseed an existing ledger. With a workspace, create it and resolve its canonical directory with `realpath`, then key a process-wide async mutex by `path.join(canonicalDirectory, "tasks.json")` (normalize platform path casing as required by the filesystem); all reads and read-check-write operations on that path, including initialization and view generation, run under this same lock. Two teams sharing a workspace intentionally share its ledger. Without a workspace use a runtime-owned ledger and per-team-generation lock.
- [ ] Store `tasks.json` as a JSON array of `TeamTask`; under the lock read the latest array, validate it, update it and replace via a same-directory temporary file and atomic rename, then regenerate `TASKS.md` from the committed ledger. On view-write failure report the error and regenerate on the next operation/start; never report an uncommitted ledger mutation as success. Do not overwrite an orphaned pre-existing `TASKS.md` as specified by the test. Remove `ensureTeamTasksFile`, `TEAM_TASKS_HEADER` and the manual-owner convention, and render `team://` instructions from a static prompt template.
- [ ] Implement `TeamProtocolHandler` as a virtual handler with `write: { via: "handler", payload: "verbatim", scope: "coordination", ... }`, registered in `InternalUrlRouter`. Support exactly `read team://<team>/tasks`, lead-only `write .../tasks` with title, and `write .../tasks/<id>/{claim,release,done}`; use caller context, not body identity. Generate readable conflict errors naming the owner. Ensure URI routing does not expose `tasks.json` as a located editable path.
- [ ] Run `bun test test/teams.test.ts` plus the new thread integration test; expect pass. Remove Task 1's temporary URI test handler and run that capability test against the real router.

### Task 3 (W4.3): Idle transition notifications

**Files:** Modify `src/task/team-runtime.ts`, `src/registry/agent-registry.ts`, `src/task/executor.ts` and `src/session/irc-bridge.ts` only where existing event data is insufficient; test `test/teams.test.ts` and existing IRC wake tests.

**Interfaces:** Runtime subscribes to registry status changes and tracks each `(team generation, member ref, transition)`; it sends to the stored lead ref using existing IRC non-request metadata (`progress` where appropriate), with member ID, a bounded first-lines summary of the completed turn and `agent://<actual-id>`.

- [ ] **Failing tests:** Start a team from a non-Main lead, publish `running → idle` after an assistant result and assert exactly one notice goes to that lead, containing the member, first lines and link, never to Main. Repeated idle events produce no duplicate; a later `running → idle` produces one new notice. Replace the member with a new ref or generation and deliver a delayed old event: no notice for the new member. Deliver the notice to an idle subagent lead and assert no automatic response and no wake-relay loop, while a normal direct request still gets its existing relay.
- [ ] Run `bun test test/teams.test.ts` and the relevant existing IRC wake test; expect failures for absent notifications.
- [ ] Subscribe once from the main runtime, unsubscribe on teardown, associate summaries with the completed turn before publishing idle, and deduplicate on the real transition rather than text/time. Deliver via the existing non-request IRC form; if its current metadata is insufficient, extend the bridge and wake monitor together so notifications can wake a lead without generating reply obligations. Do not change ordinary request or wake-relay semantics.
- [ ] Run the focused tests again; expect pass.

### Task 4 (W4.3): Cooperative stop and pending intent

**Review:** per-task — destructive operation and concurrency

**Files:** Modify `src/task/team-runtime.ts`, `src/internal-urls/team-protocol.ts`, `src/slash-commands/builtin-teams.ts`, `src/task/settings.ts`, team prompt Markdown and thread protocol; test `test/teams.test.ts` and thread integration tests.

**Interfaces:** `TeamRuntime.requestStop(team, member, force)` generates a unique request ID, records `(team generation, member ref/id, lead, deadline)` and returns promptly. `respondStop(caller, team, requestId, body)` accepts only the targeted current member and only `ack` or `decline: <reason>`. Register numeric `team.stopAckTimeoutMs` default `120000` in the existing Teams settings group.

- [ ] **Failing tests:** `/team stop audit` sends each member a request containing its request ID and reply URL without immediately releasing it; targeted `ack` releases exactly that ref with `{ tombstone: true }` once. `decline: busy` sends the reason to the actual lead, does not release, and leaves the member live. Using fake timers, timeout at the configured setting notifies the lead once and never releases. A late, duplicate, wrong-member or old-generation response cannot release a member. `/team stop --force audit` and `/team stop --force <handle>` immediately release only recorded matching refs; preserve `all` and handle targeting, and prevent an unrelated/replaced ref from being released.
- [ ] **Pending test:** Make spawn return `SpawnPendingError` with a controllable registration promise. Stop while pending and assert intent persists; on registration cooperative stop sends its request to that exact ref, while force releases that exact ref immediately after registration. A rejected registration clears the intent and reports failure; a restarted generation is unaffected by the old promise. Test both outcomes through the command, not a direct private-state assignment.
- [ ] Run `bun test test/teams.test.ts`; expect existing immediate-stop expectations and new protocol tests to fail until migrated. Change existing immediate-stop tests to use `--force` where their purpose is ref safety.
- [ ] Parse `/team stop [--force] <name|handle|all>`; resolve members in the invoking lead's live runtime state, reject ambiguous handles rather than targeting another team. Send a genuine wakeable control request using the normal IRC request channel, and teach the team prompt the exact reply URL/bodies. Support `write team://<team>/stop/<requestId>` through the runtime and thread proxy. On ack clear timer, verify generation and current ref, release with tombstone, then remove membership only on successful release. Decline/timeout close that request and notify the lead without force; later stop may issue a new request. Clean up timers on release, failed registration, generation replacement and runtime teardown.
- [ ] Run the focused team and thread tests; expect pass.

### Task 5 (W4.3): Plan submission and approval gate

**Review:** per-task — security

**Files:** Modify `src/task/teams.ts`, `src/task/team-runtime.ts`, `src/internal-urls/team-protocol.ts`, `src/slash-commands/builtin-teams.ts`, `src/session/agent-session.ts`, spawn/SDK/thread identity propagation and team prompt Markdown; add focused session tests and extend `test/teams.test.ts`.

**Interfaces:** `TeamDefinition.planApproval?: boolean` and `TeamMember.planApproval?: boolean`; a member override, including explicit `false`, takes precedence over team default. Runtime stores pending/approved per member generation. `submitPlan(caller, team, text)`, `approve(lead, handle)`, and `reject(lead, handle, reason)` are main-owned operations, exposed via the thread service. `write team://<team>/plan` identifies its author from the session.

- [ ] **Failing tests:** Parse team-level and per-member booleans, including `false` override. Drive real `AgentSession` tool dispatch for a gated member: `read`, `grep`, `glob`, `lsp`, `web_search`, `wait`, and `write agent://`/`team://` pass the team gate; `write` to disk, `edit`, `bash`, `task`, `xd://` device dispatch and unlisted tools are blocked with `plan approval required: send it via write team://<team>/plan`. A permitted coordination target cannot be smuggled as a normalized disk path or an extension-rewritten argument. After submission, assert the actual lead receives the plan; `/team reject <handle> <reason>` informs that member and leaves mutations blocked, then resubmission plus `/team approve <handle>` permits a real disk write. Wrong lead, nonmember, stale generation and ambiguous handle cannot submit for or approve another member. Non-team sessions and members without the flag remain unchanged.
- [ ] Run the team and focused AgentSession tests; expect failure because the gate and commands are absent.
- [ ] Set gate state before child execution starts and look it up from the main runtime for every call, including worker sessions; fail closed on service failure. In `AgentSession.#beforeToolCall`, block everything except the exact allowlist, and allow `write` only after the same normalized URL resolution used by `WriteTool` confirms scheme `agent` or `team`. Recheck the final arguments after extension `tool_call` rewriting, before returning them to the loop; ensure nested/device dispatch cannot bypass the check. Do not enable the session's plan mode and do not accidentally upgrade the Task 1 write capability after approval.
- [ ] Implement plan submission and lead-only `/team approve <handle>` and `/team reject <handle> <reason>`, with generation and actual-ref validation. Deliver submissions and rejection as non-request notifications so they cannot cause relay loops; keep rejected gate closed, remove it only on approval. Update slash usage, completion and `team.enabled` gating for both commands. Define safe behavior for an approval with no submitted plan: reject with an actionable error, leaving the gate closed.
- [ ] Run the team, session and thread integration tests; expect pass.

### Task 6 (W7): Documentation, design amendment and changelog

**Files:** Modify `docs/agent-teams.md`, `docs/specs/2026-11-06-agent-teams-design.md`, `packages/coding-agent/CHANGELOG.md`.

- [ ] Replace obsolete claims that team members receive full write, that `TASKS.md` is manually edited, and that idle and shutdown negotiation do not exist. Document agent `team-prompt` resolution and compatibility, role permissions, optional `tasks:` and `planApproval`, all `team://` operations with examples, lead/member authorization, generated `TASKS.md`, in-memory mode and orphaned legacy file migration error.
- [ ] Document `/team stop [--force] <name|handle|all>`, request/ack/decline/timeout behavior and `team.stopAckTimeoutMs: 120000`, `/team approve|reject`, non-Main leads and no relay loop. State that the mutex protects only one omp process, and direct external edits to `tasks.json` are not prevented; other processes must not share the workspace concurrently. Keep existing cross-terminal and UI limitations accurate.
- [ ] Add a dated amendment to the historical design: §9 remains in force; atomic claim and control protocol extend it; contradictory prompt composition and timeout-driven `FAILED` are fixes; wake-relay is not an idle notification. Attribute the pending-spawn `FAILED` correction to W3, not to this plan's implementation.
- [ ] Add a user-facing `[Unreleased]` coding-agent changelog entry; do not modify pi-shell or unrelated W7 README/A2A documentation. Cross-check each documented URL, example and default against the landed implementation and the tests.

### Task 7: Live scout + reviewer verification

**Files:** No permanent fixture or source changes; use a temporary workspace and a team definition with bundled `scout` and `reviewer`.

- [ ] With `team.enabled: true`, launch a real omp session and create an `audit` team with scout and reviewer, a workspace, initial `tasks:` and `planApproval: true` for the reviewer. Run `/team start audit <assignment>` and capture actual IDs and status. Verify both agents receive their team role prompts and can send `agent://`/`team://` messages; have them attempt repository writes and confirm refusal.
- [ ] Ask both to claim the same task and inspect `read team://audit/tasks`, `tasks.json` and generated `TASKS.md`: record the single owner and conflict naming it. Confirm the lead receives an idle notice once per transition, including the member link; confirm no ping-pong relay.
- [ ] Ask the reviewer to submit a plan and attempt a mutation before approval, reject with a reason, then approve a revised plan; confirm the gate blocks before approval and is lifted after it, without granting the read-only reviewer disk write. A separate writable gated member or automated Task 5 test must demonstrate actual mutation succeeding after approval.
- [ ] Request cooperative stop for one member and observe its ack or decline, then force-stop any remaining member with `/team stop --force audit`; record request IDs, replies, outcomes, and `/team status audit`. If no ack arrives, record the timeout as such rather than claiming ack success. Restore settings and remove only the temporary fixture.
- [ ] Run final focused verification from `packages/coding-agent`: `bun test test/teams.test.ts` plus the exact added discovery, write, thread, IRC and AgentSession test files; run `bun check` from repository root. Record commands, exit status and observed results. Live verification requires a working configured model and interactive runtime; if unavailable, report that prerequisite and the automated evidence separately, never claim the live run passed.
