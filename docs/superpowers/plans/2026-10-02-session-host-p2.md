# Session Host P2 Implementation Plan: Minimal Hosted TUI Client

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working, mergeable TUI client behind `tui.hosted` that drives a P1 session host for core chat. Every command it cannot yet support reports "unavailable when attached".

**Architecture:** The client is `InteractiveMode` over a local, permanently idle `AgentSession` whose session file is a replica of the host's. This is the collab-guest precedent (`src/collab/guest.ts`) with the relay swapped for `RpcClient` over `connectSessionHost`. Host `entry` frames feed the replica, host session events feed `EventController`, and user input routes to the host over RPC. Client mode turns every TUI-owned automation path off, so attaching N clients never runs anything N times.

**Tech Stack:** TypeScript, Bun, P1 session host and RPC, `bun:test`, PTY smoke through tmux.

**Spec:** `docs/superpowers/specs/2026-10-01-session-host-design.md`, sections "TUI client", "Client commands", "Unavailable in client mode", and the reordered "Phases" table (P2 = this plan).

**Base:** `feat/session-host` at `7235af1244`.

## Global Constraints

- Opt-in only: `tui.hosted` defaults to `false`. With it off, and without `omp attach <target>`, nothing changes.
- The client never writes the host's session file (D9). Its replica is owner-private: a `0700` directory `<config root>/run/hosted-replicas/` holding one `0600` file per client instance and snapshot (`<hostId>-<instance>-<n>.jsonl`), outside the sessions directory, so `/resume` never lists it. Two clients never share a replica, and a client deletes only its own files when it leaves.
- Client mode runs no automation: idle compaction, idle recap, goal continuation, loop auto-submit, plan-role reconciliation, plan-mode write-through, todo HUD writers, collab auto-host, and title generation are all off.
- Stdio RPC, ACP, print mode, collab guest and host behavior are unchanged.
- Repo rules apply: no `any`, no inline imports, `#private`, `Promise.withResolvers`, `logger` in runtime code, behavioral tests, no `mock.module`, `bun check`.
- Commit only when the user authorizes; commit steps are checkpoints.

## Review Focus

1. A prompt typed while the host is streaming must queue on the host (steer/follow-up) and appear in the pending band of every attached client.
2. A second client attaching mid-turn must render the partial assistant message once, not twice.
3. Closing the client terminal must detach (host keeps running); `/exit` from the last client must stop the host.
4. Two attached clients must never start a local model call, compaction, recap, or title generation.
5. A host that dies while attached must leave the client with a clear message and a non-zero exit, never a hung TUI.

## Decisions Made By This Plan

1. **Replica file, not in-memory.** The guest path (`switchSession(replica, { preserveLocalCwd: true })`) already renders, rebuilds after compaction, and swaps on replacement. The spec's "in-memory replica" wording is updated to match.
2. **No new `slash_command` RPC yet.** The host `prompt` arm already runs builtins with a headless `handle`. The client only sends `/name` when `lookupBuiltinSlashCommand(name)?.handle` exists, so nothing falls through to the model.
3. **Auto-reconnect is required, deferred from P2.** Initially, socket loss reports whether the host is alive and exits; rejoining is `omp attach <hostId>`. A P3 follow-up implements automatic reconnect using P1's host identity, epoch, and sequence replay, with snapshot fallback. It must land before P4 flips the default. Explicit `/detach` and `/exit` must never reconnect, and reconnect must not silently resend mutating commands whose outcome is unknown.
4. **Titles are unavailable when attached.** The host sets `PI_NO_TITLE` (P1). Moving title generation to the host is a P3 follow-up.
5. **Local startup is lean.** The client's local session starts with extensions, skills, rules, LSP, and MCP off; the host owns all of them. Extension commands, skills and prompt templates typed in the client go to the host as prompts.

## File Structure

| File | Responsibility |
|---|---|
| `src/session/replica-view.ts` (create) | Shared replica mechanics extracted from `CollabGuestLink`: write snapshot to a replica file and switch to it, ingest an entry, apply an event with the orphan-delta guard, apply host model/thinking state |
| `src/collab/guest.ts` (modify) | Uses `replica-view.ts`; behavior unchanged |
| `src/modes/rpc/rpc-types.ts`, `rpc-client.ts` (modify) | Typed host frames and an `onFrame` listener |
| `src/session-host/hosted-client.ts` (create) | `HostedClientLink`: owns `RpcClient`, applies host frames to the TUI, answers dialogs, forwards input |
| `src/modes/types.ts`, `interactive-mode.ts`, `controllers/{input,event,selector}-controller.ts`, `utils/ui-helpers.ts` (modify) | `ctx.hostedClient` field and the client-mode gates |
| `src/slash-commands/builtin-registry.ts`, `builtin-lifecycle.ts` (modify) | Client slash gate; `/detach`, `/attach`; `/exit` and `/quit` semantics |
| `src/main.ts`, `src/cli/args.ts`, `src/commands/attach.ts`, `src/modes/settings.ts` (modify) | `tui.hosted`, `omp attach <target>`, hosted startup branch |
| `docs/rpc.md`, `docs/cli-reference.md`, `CHANGELOG.md` (modify) | User docs and the "unavailable when attached" table |

---

### Task 1: Extract replica mechanics from the collab guest

**Files:**
- Create: `src/session/replica-view.ts`
- Modify: `src/collab/guest.ts` (`#finalizeSnapshot` :444, `#applyFrame` entry branch :547-565, `#applyEvent` :617-632, `#applyHostState` :642)
- Test: existing `test/collab/**` (behavior gate) plus `test/session/replica-view.test.ts`

**Interfaces:**

```ts
export interface ReplicaHostState {
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	disableReasoning?: boolean;
}
/** Write `[header, ...entries]` to `replicaPath` and switch the local session onto it, keeping the local cwd. */
export async function loadReplica(session: AgentSession, replicaPath: string, header: SessionHeader, entries: readonly SessionEntry[]): Promise<void>;
/** Append one host entry to the replica and update the agent's message list; compaction and branch-summary entries rebuild the context. */
export function ingestReplicaEntry(session: AgentSession, entry: SessionEntry): void;
/** Feed one host session event to the TUI; synthesizes `message_start` for an orphan assistant `message_update`. */
export function applyReplicaEvent(ctx: InteractiveModeContext, event: AgentSessionEvent): Promise<void>;
/** Mirror host model/thinking onto the idle local agent without persisting or clamping. */
export function applyReplicaHostState(session: AgentSession, state: ReplicaHostState): void;
```

- [ ] **Step 1:** Write `test/session/replica-view.test.ts`: `loadReplica` makes `session.sessionManager.getEntries()` equal the given entries and `getCwd()` keep the local cwd; `ingestReplicaEntry` of a user message appends to `session.messages`; ingesting a `compaction` entry rebuilds messages from `buildDisplaySessionContext()`; `applyReplicaEvent` of a lone assistant `message_update` calls `handleEvent` with a synthesized `message_start` first.
- [ ] **Step 2:** Run `bun test test/session/replica-view.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Move the logic out of `guest.ts` unchanged into these four functions; `guest.ts` calls them.
- [ ] **Step 4:** Run `bun test test/session/replica-view.test.ts test/collab` → PASS; `bun check`.
- [ ] **Step 5:** Commit checkpoint `refactor(collab): share replica mechanics`.

---

### Task 2: Typed host frames in `RpcClient`

**Files:**
- Modify: `src/modes/rpc/rpc-types.ts`, `src/modes/rpc/rpc-client.ts` (`#handleLine` :1285-1368), `src/modes/rpc/rpc-server.ts` (`command_output`, `config_update`, `session_info_update` literals use the new types)
- Test: `test/rpc-client-host-frames.test.ts`

**Interfaces:**

```ts
export interface RpcCommandOutputFrame { type: "command_output"; text: string }
export interface RpcConfigUpdateFrame { type: "config_update"; model?: Model; thinkingLevel?: ThinkingLevel }
export interface RpcSessionInfoUpdateFrame { type: "session_info_update"; title?: string; sessionId: string }
export type RpcHostFrame =
	| RpcAttachedFrame | RpcResumedFrame | RpcEntryFrame | RpcSessionReplacedFrame
	| RpcClientsChangedFrame | RpcCommandOutputFrame | RpcConfigUpdateFrame | RpcSessionInfoUpdateFrame;

// RpcClient
onHostFrame(listener: (frame: RpcHostFrame) => void): () => void;
```

`#handleLine` dispatches these eight types to `onHostFrame` listeners, in arrival order, and to nothing else. Frames carrying `seq` keep it.

- [ ] **Step 1:** Write tests against a real `runSessionHost` (reuse `test/session-host/host.test.ts` helpers): a client registering `onHostFrame` before `start()` receives `attached` first, then `entry` frames after a prompt, then `session_replaced` after `newSession()`, and `command_output` after `prompt("/session")`; frames arrive in `seq` order.
- [ ] **Step 2:** Run `bun test test/rpc-client-host-frames.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `connectSessionHost` already sends `hello`; registering listeners before `start()` must not lose `attached`.
- [ ] **Step 4:** Run `bun test test/rpc-client-host-frames.test.ts test/rpc-client*.test.ts test/session-host` → PASS; `bun check`.
- [ ] **Step 5:** Commit checkpoint `feat(rpc): route session-host frames in RpcClient`.

---

### Task 3: `HostedClientLink`

**Files:**
- Create: `src/session-host/hosted-client.ts`
- Modify: `src/modes/types.ts` (add `hostedClient?: HostedClientLink` beside `collabGuest` :169), `src/modes/interactive-mode.ts` (field beside :1490)
- Test: `test/session-host/hosted-client.test.ts`

**Interfaces:**

```ts
export interface HostedClientOptions {
	ctx: InteractiveModeContext;
	entry: SessionHostEntry;
	replicaDir: string;
	onClosed: (reason: { hostAlive: boolean; message: string }) => void;
}
export class HostedClientLink {
	static async connect(options: HostedClientOptions): Promise<HostedClientLink>;
	readonly hostId: string;
	/** Host queue as last reported by snapshot or `queue_update`. */
	readonly queued: { steering: readonly string[]; followUp: readonly string[] };
	prompt(text: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp"): Promise<void>;
	abort(): Promise<void>;
	removeQueued(text: string, queue: "steering" | "followUp"): Promise<boolean>;
	setModel(provider: string, modelId: string): Promise<void>;
	cycleModel(): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	cycleThinkingLevel(): Promise<void>;
	detach(): Promise<void>;
	exit(): Promise<void>;
}
```

Frame handling, all serialized through one promise chain as in `CollabGuestLink`:
- `attached` → `loadReplica` with `replicaDir/<hostId>-<instance>-<n>.jsonl` (a fresh per-client, per-snapshot path), `renderInitialMessages()`, apply `snapshot.state` (model, thinking, queue), replay `snapshot.streaming` through `applyReplicaEvent` as `message_start` + `message_update`, present every `snapshot.pendingUi`.
- `entry` → `ingestReplicaEntry`.
- every `AgentSessionEvent` (`RpcClient.onSessionEvent`, because `onEvent` filters out `queue_update`) → `applyReplicaEvent`; `queue_update` also refreshes `queued` and the pending band.
- `session_replaced` → abort local dialogs, `loadReplica` with the inline snapshot, re-render.
- `config_update` → `applyReplicaHostState`; `session_info_update` → status-line title; `command_output` → `ctx.showStatus(text)`; `clients_changed` → status-line participant count via `statusLine.setCollabStatus` with role `"hosted"`.
- `extension_ui_request`: `select|confirm|input|editor` → `showHookSelector|showHookConfirm|showHookInput|showHookEditor` with an `AbortSignal` per request id; `ask` → `ExtensionUiController.showAskDialog`; `cancel` aborts the matching request without replying; `notify|setStatus|setWidget|setTitle|set_editor_text|open_url` apply locally. Answers go back as `extension_ui_response`.
- Transport close → probe `pidAlive(entry.pid)` and call `onClosed`.

- [ ] **Step 1:** Write tests with a real in-process host (`runSessionHost` + `createTestSession`) and the existing fake `InteractiveModeContext` helper (`test/helpers/interactive-mode-context.ts`):
  - after `connect`, the replica's entries equal the host's entries and the host file is untouched (byte-compare before/after);
  - `prompt("hi")` produces one host turn; the fake ctx's `eventController.handleEvent` receives `message_start`…`agent_end` once each;
  - a second link attached mid-turn (gated mock stream) renders the partial message once;
  - a host `confirm` shown to two links: answering on one aborts the other's dialog and the second answer is ignored;
  - `prompt` while streaming with `"followUp"` updates `queued.followUp` on both links;
  - host `exit` from another client closes this link with `hostAlive: false`.
- [ ] **Step 2:** Run `bun test test/session-host/hosted-client.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `bun test test/session-host test/collab` → PASS; `bun check`.
- [ ] **Step 5:** Commit checkpoint `feat(session-host): add hosted TUI client link`.

---

### Task 4: Client-mode input routing, slash gate, and automation off

**Files:**
- Modify: `src/modes/controllers/input-controller.ts` (submit :1060-1109, Esc :545, retry :1699, dequeue :1612, follow-up :1851-1946, thinking/model keys :631/:636/:2660/:2674), `src/modes/controllers/selector-controller.ts` (model selection), `src/slash-commands/builtin-registry.ts` (:129-148), `src/modes/utils/ui-helpers.ts` (:1093 pending band), `src/modes/interactive-mode.ts` (:2421 plan-role listener, :2365/:2380 plan reconcile, :3967/:4010 todo writers, `getUserInput` timers), `src/modes/controllers/event-controller.ts` (:2225-2227)
- Test: `test/modes/hosted-client-input.test.ts`

**Rules:**
- Submit with `ctx.hostedClient`: text starting with `!` or `$` → status `Local execution is unavailable when attached`; otherwise `hostedClient.prompt(text, images, streaming ? defaultBehavior : undefined)` where `defaultBehavior` is the existing Enter behavior while streaming; Ctrl+Enter sends `"followUp"`. No local render; the host echo arrives as events.
- Slash gate in `executeBuiltinSlashCommand`, before `handleTui`:
  - local set `HOSTED_LOCAL_COMMANDS = { hotkeys, copy, open, detach, attach, exit, quit }` runs locally (`/detach` and `/attach` are added in Task 5; `/exit` and `/quit` get attached semantics there);
  - otherwise, `command.handle` exists → `hostedClient.prompt("/" + text)`;
  - otherwise → status `/<name> is unavailable when attached`.
  - Unknown `/x` (extension command, skill, template) → `hostedClient.prompt(text)`.
- Esc → `hostedClient.abort()`; F5 retry → status unavailable; dequeue → `removeQueued` of the last entry in `hostedClient.queued`; model/thinking keys and the model selector → the `HostedClientLink` setters.
- Pending band reads `hostedClient.queued` when attached.
- Automation off: `#scheduleIdleCompaction`, `#scheduleIdleRecap`, `#scheduleLoopAutoSubmit`, `#scheduleGoalContinuation`, `#reapplyPlanModeModelOnRoleChange`, `#reconcileModeFromSession`, `#syncTodoHudState` timer, `#reconcileTodosWithSubagents` each return immediately when `ctx.hostedClient` is set.

- [ ] **Step 1:** Write tests with the fake ctx and a recording `HostedClientLink` double built from its public interface: each rule above maps to one assertion (`!ls` blocked; `/plan` → unavailable status and no prompt; `/session` → `prompt("/session")`; `/hotkeys` runs locally; `/mytemplate x` → prompt; Esc → abort; Ctrl+Enter while streaming → `prompt(text, [], "followUp")`; dequeue removes the last host queue entry; the five schedulers never call `setTimeout` when attached, observed through `vi.spyOn(globalThis, "setTimeout")` restored in `afterEach`).
- [ ] **Step 2:** Run `bun test test/modes/hosted-client-input.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `bun test test/modes test/collab test/slash-commands` → PASS; `bun check`.
- [ ] **Step 5:** Commit checkpoint `feat(tui): route input to the session host when attached`.

---

### Task 5: Startup, `omp attach <target>`, `/attach`, `/detach`, `/exit`

**Files:**
- Modify: `src/modes/settings.ts` (register `tui.hosted`), `src/cli/args.ts` (`attach?: string` beside `join`), `src/commands/attach.ts`, `src/main.ts` (after session resolution ~:2118, `createSession` :2354, `runInteractiveMode` :595/:664/:744-772), `src/slash-commands/builtin-lifecycle.ts`
- Test: `test/session-host/hosted-startup.test.ts`, `test/cli/attach-cli.test.ts`

**Interfaces and behavior:**

```ts
export const cfgTuiHosted = register({
	id: "tui.hosted",
	type: "boolean",
	default: false,
	env: "OMP_TUI_HOSTED",
	ui: { tab: "interaction", group: "Startup & Updates", label: "Hosted Sessions (Experimental)", description: "Run each session in a detached host process; terminals attach as clients." },
});
```

- `omp attach <target>`: target is a 16-hex host id, a session id, or a session path. Host id → that host; session → `findHostForSession` or `spawnSessionHost({ cwd, sessionFile })`. A session file leased by a non-host process → exit 1 with `open in a non-host process (pid N)`. `omp attach` with no target keeps P1 listing.
- Plain `omp` with `tui.hosted` on: resolve the session exactly as today (`--resume`, `--continue`, `autoResume`, new), then find or spawn its host. A new session spawns the host with no `--resume`.
- Client local session: created with `noExtensions`, `noSkills`, `noRules`, `noLsp` forced on, MCP not started, `PI_NO_TITLE=1`, and `--no-session` semantics until `loadReplica` switches it onto the replica.
- `runInteractiveMode` gets `hostEntry?: SessionHostEntry`; with it, `init({ autoStartCollab: false })`, connect `HostedClientLink`, set `ctx.hostedClient`, and send `initialMessage`/`initialMessages` through `hostedClient.prompt`.
- `/detach` → `hostedClient.detach()`, exit 0. `/exit` and `/quit` when attached → `hostedClient.exit()`, exit 0. Ctrl+C/Ctrl+D quit paths and SIGHUP → detach. `/attach [target]` → detach, then attach to the target in the same process by repeating the startup branch; no argument opens a selector over `listSessionHosts()`.
- Host `session_hosted` on `--resume` of a file another host owns is impossible here, because the client attaches to that host instead.
- `onClosed` → print `host exited` or `connection lost (host <id> still running; omp attach <id>)` and exit 1.

- [ ] **Step 1:** Write tests: `omp attach <hostId|sessionId|path>` resolution against a temp registry (spawn tests reuse `spawn.test.ts` env isolation); `tui.hosted` off keeps the in-process path (the startup branch is not taken: assert no registry entry is created); `tui.hosted` on with `--resume <file>` reuses an existing host for that file instead of spawning a second one.
- [ ] **Step 2:** Run `bun test test/session-host/hosted-startup.test.ts test/cli/attach-cli.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests → PASS; `bun check`.
- [ ] **Step 5: PTY smoke.** In tmux with an isolated `HOME`, `PI_CODING_AGENT_DIR`, and a configured model:
  1. `OMP_TUI_HOSTED=1 bun src/cli.ts` → prompt `say hi` → answer renders.
  2. Second pane `bun src/cli.ts attach --json` → one host with `clients: 1`; `bun src/cli.ts attach <hostId>` → same transcript; prompt from pane 2 renders in both.
  3. Kill pane 1 → host still listed; `/exit` in pane 2 → host gone from `omp attach --json`.
  Record the commands and captured output in the task report.
- [ ] **Step 6:** Commit checkpoint `feat(tui): attach to session hosts`.

---

### Task 6: Documentation

**Files:** `docs/cli-reference.md`, `docs/rpc.md`, `packages/coding-agent/CHANGELOG.md`, spec "TUI client / Shape" wording (replica file)

- [ ] **Step 1:** Document `tui.hosted`, `OMP_TUI_HOSTED`, `omp attach <target>`, `/attach`, `/detach`, `/exit` semantics, and a table of everything unavailable when attached: titles, `!`/`$`, F5 retry, plan, goal, guided goal, loop, vibe, queue editor, new, clear, delete, fork, tree, branch, resume, btw, settings, login/logout, extensions/agents/hub/git panels, PTY overlays, extension custom components.
- [ ] **Step 2:** Changelog `### Added`: experimental hosted sessions (`tui.hosted`, `omp attach <target>`).
- [ ] **Step 3: Full gate.** `bun check`; from `packages/coding-agent`: `bun test test/session-host test/session test/modes test/collab test/rpc*.test.ts test/slash-commands test/cli`; `bun src/cli.ts --smoke-test`. Record skips.
- [ ] **Step 4:** Commit checkpoint `docs: document hosted TUI sessions`.

## Execution Handoff

Subagent-driven, one implementer and one reviewer per task, then one condensed final review. Tasks are sequential: each consumes the previous task's interfaces.
