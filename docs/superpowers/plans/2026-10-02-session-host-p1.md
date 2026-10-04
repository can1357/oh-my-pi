# Session Host P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a detached `omp --mode host` process that serves one `AgentSession` to N RPC clients over a local socket or named pipe, with attach/resume, sequencing, first-answer-wins dialogs, write preconditions, a host registry, and `omp attach` listing.

**Architecture:** `runRpcMode`'s 1100-line closure becomes two classes: `RpcServer` (host-wide: session, shared UI context, fan-out, `seq` ring, epochs, preconditions) and `RpcConnection` (per client: codec, writer, event projection, prompt results, host-tool and host-URI bridges). Stdio `--mode rpc` is an `RpcServer` with one unsequenced connection and keeps its bytes unchanged. `runSessionHost` adds a token-authenticated `node:net` listener, the registry entry, and the D7 lifetime rules on top of `RpcServer`.

**Tech Stack:** TypeScript on Bun, `node:net` (Unix sockets / Windows named pipes), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-01-session-host-design.md`. Executors read both.

**Base:** `upstream/main` @ `2399a84091`. All paths below are relative to `packages/coding-agent/` unless they start with `.github/`, `docs/`, or `packages/`.

## Global Constraints

- Stdio `--mode rpc` / `rpc-ui` output stays byte-for-byte identical. New frames appear only on socket connections after `hello`.
- Every platform: Unix socket on POSIX, `\\.\pipe\omp-host-<id>` on Windows. Token is mandatory everywhere and compared with `crypto.timingSafeEqual`.
- Only the host process writes the session file (D9). The host claims the owner lease before listening and writes its registry entry last.
- Use `logger` from `@oh-my-pi/pi-utils`, never `console.*`, in host code.
- ES `#private` fields; no `private`/`public` keywords except constructor parameter properties. No `ReturnType<>`. No inline imports. `Promise.withResolvers()` over `new Promise`.
- Tests: behavioral, real host over a real socket where a transport is involved; isolated `PI_CODING_AGENT_DIR` and temp dirs per test; no `mock.module()`.
- Run `bun check` (never `tsc`) after each task. Run focused tests with `bun test <file>` from `packages/coding-agent/`.
- Commit only when the user asks; commit steps below are checkpoints for when committing is authorized.

## Spec refinements made while planning

1. `session_replaced` carries the new snapshot inline (`{epoch, sessionFile, reason, snapshot}`) instead of being followed by a separate `attached` frame, so no frame can interleave.
2. There is no `state` push frame. State changes already arrive as session events; the snapshot carries full state.
3. `seq` is host-wide and monotonic. A connection sees gaps only for frames its own `set_event_filter` drops.
4. `session_hosted` is detected for `switch_session` (explicit path). `open_session` keeps today's lease behavior in P1.
5. Per-connection output spools are capped at 64 MiB; a client past the cap is dropped and resumes with a fresh snapshot.
6. Known P1 gap, tracked for P3: fire-and-forget UI state (`setStatus`, `setWidget`, `setTitle`) is not replayed to late joiners.

## File Structure

| File | Responsibility |
|---|---|
| `src/session/session-manager.ts` (modify) | Replace single `onEntryAppended` field with `subscribeEntryAppended(listener)` |
| `src/ipc/private-endpoint.ts` (create) | Owner-private dir, socket path resolution, win32 pipe naming, atomic 0600 JSON write, token compare, liveness probe. Extracted from `collab/registry.ts` |
| `src/collab/registry.ts`, `src/collab/host.ts` (modify) | Use the extracted helpers and entry-listener API |
| `src/modes/rpc/rpc-connection.ts` (create) | `RpcConnection`: one client's codec, writer, projection, bridges, flags |
| `src/modes/rpc/rpc-server.ts` (create) | `RpcServer`: session-wide state, command switch, fan-out, `seq` ring, epochs, preconditions, UI arbitration, host-tool merge |
| `src/modes/rpc/rpc-mode.ts` (modify) | Keeps exported helpers; `runRpcMode` becomes a stdio wrapper over `RpcServer` |
| `src/modes/rpc/rpc-session-events.ts` (modify) | Split host-wide message-id stamping from per-connection projection |
| `src/modes/rpc/rpc-subagents.ts` (modify) | Registry emits unconditionally; per-connection level filters on delivery |
| `src/modes/rpc/host-uris.ts` (modify) | `clear()` unregisters only schemes this bridge still owns |
| `src/modes/rpc/rpc-output.ts` (modify) | Optional spool cap |
| `src/modes/rpc/rpc-types.ts` (modify) | New frames, commands, preconditions, error fields |
| `src/session-host/registry.ts` (create) | Host registry: publish, update, list, resolve, prune |
| `src/session-host/host.ts` (create) | `runSessionHost`: listener, handshake, lease, registry updates, lifetime |
| `src/session-host/client.ts` (create) | `connectSessionHost` (socket `RpcAgentProcess`), `spawnSessionHost` |
| `src/main.ts`, `src/cli/args.ts`, `src/cli/flag-tables.ts`, `src/commands/launch-help.ts` (modify) | `--mode host`, `--host-id` |
| `src/commands/attach.ts`, `src/cli-commands.ts`, `src/cli/command-help.ts` (create/modify) | `omp attach [--json]` listing |
| `src/cli.ts` (modify) | Smoke probe |
| `.github/workflows/ci.yml` (modify) | Windows job for session-host tests |
| `docs/rpc.md`, `CHANGELOG.md` (modify) | Protocol docs, changelog |

---

### Task 1: Multi-listener entry hook

**Files:**
- Modify: `src/session/session-manager.ts:816-820` (field), `:1805-1814` (`#notifyEntryAppended`)
- Modify: `src/collab/host.ts:454`, `:556`
- Modify tests: `test/agent-session-advisor-suppression.test.ts:251`, `test/agent-session-interrupted-thinking.test.ts:112-116,326-330`, `test/agent-session-queued-steer-delivery.test.ts:137`, `test/session-manager-atomic-rewrite-race.test.ts:1062`, `test/collab/session-replication.test.ts:28,59`, and the `onEntryAppended: undefined` stubs in `test/collab/{chunked-welcome,controller,guest-ui-request,host-registry,read-only,replication-shrink,steer-queue}.test.ts` and `test/collab/helpers/throttled-host.ts`
- Test: `test/collab/session-replication.test.ts`

**Interfaces:**
- Produces: `SessionManager.subscribeEntryAppended(listener: (entry: SessionEntry) => void): () => void`. Listeners run in subscription order; a throwing listener is logged and does not stop later listeners.

- [ ] **Step 1: Write the failing test** (append to `test/collab/session-replication.test.ts`)

```ts
it("delivers each appended entry to every subscriber, isolating a throwing one", () => {
	const { manager } = makeManager();
	const first: string[] = [];
	const second: string[] = [];
	const offFirst = manager.subscribeEntryAppended(entry => first.push(entry.id));
	manager.subscribeEntryAppended(() => {
		throw new Error("boom");
	});
	manager.subscribeEntryAppended(entry => second.push(entry.id));
	const a = manager.appendMessage({ role: "user", content: "a", timestamp: Date.now() });
	offFirst();
	const b = manager.appendMessage({ role: "user", content: "b", timestamp: Date.now() });
	expect(first).toEqual([a]);
	expect(second).toEqual([a, b]);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test test/collab/session-replication.test.ts` → `subscribeEntryAppended is not a function`.

- [ ] **Step 3: Implement.** Replace the field and notifier:

```ts
	/**
	 * Replication taps (collab host, session host): invoked for every appended
	 * entry with the in-memory (pre-blob-externalization) entry, so inline images survive.
	 */
	readonly #entryListeners = new Set<(entry: SessionEntry) => void>();

	subscribeEntryAppended(listener: (entry: SessionEntry) => void): () => void {
		this.#entryListeners.add(listener);
		return () => {
			this.#entryListeners.delete(listener);
		};
	}
```

```ts
	#notifyEntryAppended(entry: SessionEntry): void {
		for (const listener of this.#entryListeners) {
			try {
				listener(entry);
			} catch (err) {
				logger.warn("entry-appended listener failed", { error: String(err) });
			}
		}
	}
```

In `collab/host.ts` keep the unsubscribe: `this.#entryUnsubscribe = this.#ctx.sessionManager.subscribeEntryAppended(entry => { …existing body… });` and at `:556` replace the assignment with `this.#entryUnsubscribe?.(); this.#entryUnsubscribe = undefined;`. Add `#entryUnsubscribe: (() => void) | undefined;` to the class. Update the `InteractiveModeContext`-shaped stubs in collab tests from `onEntryAppended: undefined` to `subscribeEntryAppended: () => () => {}`. Migrate the other tests to `const off = manager.subscribeEntryAppended(...)`; where a test restored `previous`, call `off()` instead.

- [ ] **Step 4: Run** `bun test test/collab test/session-manager-atomic-rewrite-race.test.ts test/agent-session-advisor-suppression.test.ts test/agent-session-interrupted-thinking.test.ts test/agent-session-queued-steer-delivery.test.ts` → PASS. `bun check` → clean.

- [ ] **Step 5: Commit** — `refactor(session): allow multiple entry-appended listeners`.

---

### Task 2: Extract private IPC endpoint helpers

**Files:**
- Create: `src/ipc/private-endpoint.ts`
- Modify: `src/collab/registry.ts` (remove `tokenMatches`:206, `assertPrivateDir`:371, `ensurePrivateDir`:390, `SUN_PATH_LIMIT`:397, `DEFAULT_SOCKET_FALLBACK_BASE`:398, `socketFallbackDir`:405, `resolveSocketEndpoint`:422, `pidAlive`:595, the write-then-rename block :485-497; import replacements)
- Test: existing `test/collab/registry.test.ts` (behavior gate) + new `test/ipc/private-endpoint.test.ts`

**Interfaces:**
- Produces:

```ts
export const DEFAULT_SOCKET_FALLBACK_BASE = "/tmp";
export async function assertPrivateDir(dir: string, label: string): Promise<fs.Stats | null>;
export async function ensurePrivateDir(dir: string, label: string): Promise<void>;
export function socketFallbackDir(dir: string, base: string, prefix: string): string;
/** POSIX socket path for `entryId` under `dir` (relocated when past sun_path), or the win32 pipe name. */
export async function privateEndpoint(dir: string, entryId: string, options: { prefix: string; fallbackBase?: string; label: string }): Promise<string>;
export function tokenMatches(expected: string, presented: unknown): boolean;
export function pidAlive(pid: number): boolean;
/** Exclusive-create `${target}.<rand>.tmp` with mode 0600, write, rename over `target`. */
export async function writePrivateJson(target: string, value: unknown): Promise<void>;
/** Connect and immediately close. "dead" only for ENOENT/ECONNREFUSED. */
export function probeEndpoint(endpoint: string, timeoutMs: number): Promise<"alive" | "dead" | "unknown">;
```

`privateEndpoint` returns `\\.\pipe\omp-${prefix}-${entryId}` on win32. Collab passes `prefix: "collab"`, `label: "collab registry"`, so its socket paths, pipe names, and error messages stay identical. The temp file name gains a random suffix so concurrent rewrites of one entry in one process never collide; it still ends in `.tmp`, outside the `*.json` listing filter.

- [ ] **Step 1: Write the failing test** `test/ipc/private-endpoint.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { privateEndpoint, probeEndpoint, writePrivateJson } from "@oh-my-pi/pi-coding-agent/ipc/private-endpoint";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let dir: string;
afterEach(async () => dir && (await removeWithRetries(dir)));

describe("private endpoint", () => {
	it("relocates a socket path that would overflow sun_path and still binds it", async () => {
		if (process.platform === "win32") return;
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipc-"));
		const deep = path.join(dir, "x".repeat(120));
		await fs.mkdir(deep, { recursive: true });
		const endpoint = await privateEndpoint(deep, "abcdef0123456789", { prefix: "t", label: "test", fallbackBase: dir });
		expect(endpoint.startsWith(deep)).toBe(false);
		const server = net.createServer();
		await new Promise<void>(r => server.listen(endpoint, r));
		expect(await probeEndpoint(endpoint, 500)).toBe("alive");
		server.close();
		await new Promise(r => server.once("close", r));
		expect(await probeEndpoint(endpoint, 500)).toBe("dead");
	});

	it("writes owner-only JSON atomically", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipc-"));
		const target = path.join(dir, "e.json");
		await Promise.all([writePrivateJson(target, { n: 1 }), writePrivateJson(target, { n: 2 })]);
		expect([1, 2]).toContain((await Bun.file(target).json()).n);
		if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
		expect((await fs.readdir(dir)).filter(n => n.endsWith(".tmp"))).toEqual([]);
	});
});
```

- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement** by moving the listed functions verbatim into `src/ipc/private-endpoint.ts`, parameterizing the hard-coded `"collab registry"` message prefix with `label` and the `omp-collab-` fallback prefix with `` `omp-${prefix}-` ``. `writePrivateJson` is the `:485-497` block with `` `${target}.${crypto.randomBytes(4).toString("hex")}.tmp` ``. `probeEndpoint` is `net.connect(endpoint)` with the error classification from collab `:546-551`, destroying the socket on `connect` and resolving `"alive"`, with a timeout resolving `"unknown"`. Rewire `collab/registry.ts` to import them.
- [ ] **Step 4: Run** `bun test test/ipc test/collab/registry.test.ts test/collab/host-registry.test.ts` → PASS; `bun check`.
- [ ] **Step 5: Commit** — `refactor(ipc): share private endpoint helpers with collab registry`.

---

### Task 3: Split `runRpcMode` into `RpcServer` + `RpcConnection` (no behavior change)

This is a mechanical move. The gate is the full existing RPC suite, unchanged.

**Files:**
- Create: `src/modes/rpc/rpc-connection.ts`, `src/modes/rpc/rpc-server.ts`
- Modify: `src/modes/rpc/rpc-mode.ts:1088-2224` (closure body moves out), `:458-516` (`RpcInputDispatcher` accepts a shared tail)
- Test gate: `bun scripts/ci-test-ts.ts runtime` filtered to `test/rpc*.test.ts`, plus `test/session/rpc-*.test.ts`, `test/modes/print-persistence-failure.test.ts`

**Interfaces:**
- Produces:

```ts
// rpc-connection.ts
export interface RpcConnectionTransport {
	input: ReadableStream<Uint8Array>;
	sink: Writable;
}
export interface RpcConnectionOptions {
	/** Socket connections: frames carry `seq`; stdio: false. */
	sequenced: boolean;
	/** Receives extension_ui_request frames and may answer them. */
	ui: boolean;
	/** Drop the connection when its spool exceeds this (bytes). Undefined = unbounded (stdio). */
	maxSpoolBytes?: number;
	clientId: string;
	client?: { kind: string; label?: string };
}
export class RpcConnection {
	readonly id: string;
	readonly options: RpcConnectionOptions;
	readonly encoder: RpcFrameEncoder;
	readonly writer: RpcOutputWriter;
	readonly events: RpcSessionEventForwarder;   // per-connection projection (Task 4 splits stamping out)
	readonly promptResults: RpcPromptResults;
	readonly wordPredictor: RpcWordPredictor;
	readonly hostTools: RpcHostToolBridge;
	readonly hostUris: RpcHostUriBridge;
	subagentLevel: RpcSubagentSubscriptionLevel;
	askDialogEnabled: boolean;
	/** Encode and write one frame; flips the encoder to v2 after a successful negotiate_protocol response. */
	send(frame: object): void;
	/** Resolves when the input stream ends. */
	readonly inputClosed: Promise<void>;
	close(): Promise<void>;
}

// rpc-server.ts
export interface RpcServerOptions {
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	headless?: boolean;
	subagentEventBus?: EventBus;
}
export class RpcServer {
	static async start(session: AgentSession, options: RpcServerOptions): Promise<RpcServer>;
	readonly session: AgentSession;
	readonly connections: ReadonlySet<RpcConnection>;
	/** Start reading frames from a transport; returns once the connection is registered. */
	connect(transport: RpcConnectionTransport, options: RpcConnectionOptions): RpcConnection;
	/** Stop routing to `conn`; does not dispose the session. */
	disconnect(conn: RpcConnection, reason: string): Promise<void>;
	handleCommand(conn: RpcConnection, command: RpcCommand): Promise<RpcResponse>;
	/** Dispose the session; resolves the latched persistence failure, if any. */
	dispose(): Promise<{ persistenceFailure?: Error }>;
	readonly shutdownRequested: boolean;
}
```

- [ ] **Step 1: Baseline.** Run `bun test test/rpc*.test.ts test/session/rpc-*.test.ts test/modes/print-persistence-failure.test.ts` and record the pass count.

- [ ] **Step 2: Shared serial tail.** In `rpc-mode.ts`, add and use:

```ts
/** One FIFO for every connection's ordinary commands, so the host executes them in a single order (spec D10). */
export class RpcSerialTail {
	#tail: Promise<void> = Promise.resolve();
	run(task: () => Promise<void>): Promise<void> {
		const next = this.#tail.then(task, task);
		this.#tail = next.catch(() => {});
		return next;
	}
}
```

Change `RpcInputDispatcher`'s constructor to `{ deps; afterSerialCommand?; tail?: RpcSerialTail }`, defaulting to a private `new RpcSerialTail()`, and replace the `#tail.then(...)` block at `:483-487` with `const task = this.#serial.run(() => this.#dispatchSerialCommand(command));`.

- [ ] **Step 3: Create `RpcConnection`.** Move into its constructor the per-connection lines of `runRpcMode`: encoder (`:1112`), writer (`:1113`, `onFailure` becomes a constructor callback), `output` (`:1126-1130` → `send`), `wordPredictor` (`:1149`), `promptResults` (`:1150`), `sessionEvents` (`:1151`), `hostToolBridge` (`:1155`), `hostUriBridge` (`:1156`). `inputClosed` wraps the existing `readRpcInputFrames(input, onFrame, onParseError)` call; the frame callbacks are supplied by `RpcServer.connect`.

- [ ] **Step 4: Create `RpcServer`.** Move the remaining closure into the class:
  - fields: `extensionUserMessageTracker`, `settleWatcher`, `pendingExtensionRequests` (now server-wide), `subagentRegistry`, `shutdownState`, `persistenceFailure`, `serialTail = new RpcSerialTail()`, the `RpcShutdownCoordinator`;
  - `RpcExtensionUIContext` (`:1165-1355`) moves to module scope in `rpc-server.ts`; its `output` argument is `frame => this.#sendUi(frame)`, which sends to every connection with `options.ui`. With one stdio connection this is exactly today's `output`;
  - `success`/`error` (`:1133-1146`) become module functions `rpcSuccess`/`rpcError`;
  - `handleCommand` (`:1460-2163`) becomes `handleCommand(conn, command)`. Inside it, every former reference to `output`, `promptResults`, `sessionEvents`, `wordPredictor`, `hostToolBridge`, `hostUriBridge` becomes `conn.send`, `conn.promptResults`, etc. `rpcUiContext.askDialogEnabled = …` (`:1690`) becomes `conn.askDialogEnabled = …; this.#uiContext.askDialogEnabled = this.#allUiConnectionsAskEnabled();` where that helper returns true when at least one UI connection exists and all have it enabled;
  - session-level writers (`registerRpcPersistenceSurface` frame callback, `emitAvailableCommandsUpdate`, `reportRuntimeError`, `settleWatcher` output, subagent registry output) call `this.#broadcast(frame)`, which sends to every connection; `reportSendError` and the `:1496` error also broadcast because they have no originator;
  - `session.subscribe` (`:1384`) loops connections: `conn.events.forward(event); conn.promptResults.observe(event);` then `settleWatcher.observe(event)` once;
  - `connect()` builds `RpcInputFrameDeps` per connection (`output: f => conn.send(f)`, shared `pendingExtensionRequests`, the connection's bridges) and an `RpcInputDispatcher` with the shared `serialTail`, then starts `conn.inputClosed`.
  - `disposeAndExit` (`:1408-1441`) splits: `RpcServer.dispose()` returns `{ persistenceFailure }`; the stderr mirror and `process.exit` stay in `runRpcMode`.

- [ ] **Step 5: Rewrite `runRpcMode`** as the stdio wrapper:

```ts
export async function runRpcMode(session: AgentSession, options: RpcModeOptions = {}): Promise<never> {
	const { input = claimRpcInput(), ...serverOptions } = options;
	process.env.PI_NOTIFICATIONS = "off";
	const server = await RpcServer.start(session, serverOptions);
	const conn = server.connect(
		{ input, sink: process.stdout },
		{ sequenced: false, ui: !serverOptions.headless || !!serverOptions.setToolUIContext, clientId: "stdio" },
	);
	await conn.inputClosed;
	// stdin closed: the only client is gone (unchanged teardown order, :2209-2223).
	server.rejectPendingUi("RPC client disconnected before extension UI response completed");
	await server.disconnect(conn, "RPC client disconnected before host tool execution completed");
	return exitAfterDispose(server, conn);
}
```

`exitAfterDispose` is the former `disposeAndExit` body: await `server.dispose()`, drain `conn.writer.close()`, mirror a persistence failure on stderr, `process.exit(failure ? 1 : 0)`. Keep the `ready` frame write in `RpcConnection`'s constructor so stdio emits it first exactly as before. The writer `onFailure` for stdio keeps `void session.dispose().finally(() => process.exit(1))`.

Keep every symbol tests import from `rpc-mode.ts` exported from there (list in the scout report: `PendingExtensionRequest`, `requestRpcSelect`, `requestRpcAskDialog`, `requestRpcDialog`, `dispatchRpcInputFrame`, `RpcInputDispatcher`, `RpcInputFrameDeps`, `RpcPendingExtensionRequests`, `RpcShutdownCoordinator`, `tryRunRpcSkillCommand`, `dispatchRpcSkillPrompt`, `handleRpcCancelSubagent`, `handleRpcSteerSubagent`, `handleRpcSessionChange`, `openRpcSession`, `applyRpcQueueModeCommand`, `registerRpcPersistenceSurface`, `RpcWordPredictor`). Move nothing those tests import.

- [ ] **Step 6: Run the Step 1 command** → same pass count, no new failures. `bun check`. Also run `bun test test/rpc-event-filter.test.ts test/rpc-queued-message.test.ts` (spawned real processes).

- [ ] **Step 7: Commit** — `refactor(rpc): split rpc mode into a server and per-client connections`.

---

### Task 4: Multi-connection semantics

**Files:**
- Modify: `src/modes/rpc/rpc-session-events.ts`, `src/modes/rpc/rpc-subagents.ts:115,151-157,212-247`, `src/modes/rpc/host-uris.ts:134-140`, `src/modes/rpc/rpc-output.ts`, `src/modes/rpc/rpc-server.ts`, `src/modes/rpc/rpc-types.ts`
- Create: `test/helpers/rpc-server-harness.ts`
- Test: `test/rpc-server-multi.test.ts`; update `test/rpc-subagents.test.ts` for the moved level gate

**Interfaces:**
- Consumes: Task 3 `RpcServer`, `RpcConnection`.
- Produces:

```ts
// rpc-session-events.ts
export class RpcMessageIdStamper {
	stamp(event: AgentSessionEvent): RpcAgentSessionEventFrame;  // existing #stamp body
	/** Id of the innermost open message, for mid-turn snapshots. */
	openMessageId(): string | undefined;
}
export class RpcSessionEventForwarder {
	constructor(output: (frame: RpcProjectedSessionEventFrame) => void);
	setFilter(events: readonly string[] | null, messageUpdates?: RpcMessageUpdates): string[] | null;
	/** Applies this connection's filter and projection to an already-stamped frame. */
	forward(frame: RpcAgentSessionEventFrame): void;
	accepts(type: string): boolean;
}
// rpc-subagents.ts: setSubscriptionLevel/getSubscriptionLevel removed; output always called.
export function subagentFrameVisible(level: RpcSubagentSubscriptionLevel, frameType: string): boolean;
// rpc-server.ts
connect(...) // unchanged signature; RpcServer additionally:
	readonly uiPending: ReadonlyMap<string, RpcExtensionUIRequest>;  // open dialog requests by id
// host-uris.ts
clear(message?: string): void; // unregisters only schemes whose live handler belongs to this bridge
// rpc-output.ts
constructor(sink: Writable, onFailure: (error: Error) => void, options?: { maxSpoolBytes?: number });
```

Behavior:
1. **Message ids** are minted once by the server (`RpcMessageIdStamper`), then each connection projects. Two connections see identical `messageId`s.
2. **Originator-only frames:** command responses, `prompt_result`, `predict_word` responses, `host_tool_call`/`host_tool_cancel`, `host_uri_request`/`cancel`. **Broadcast:** session events, `session_settled`, `available_commands_update`, `notice`, `extension_error`, subagent frames (filtered by each connection's level), extension UI frames (UI connections only).
3. **UI arbitration:** `#sendUi(frame)` records dialog requests (`method` in `select | confirm | input | editor | ask`) in `uiPending` and forwards to UI connections. When an `extension_ui_response` resolves a pending id, the server deletes it from `uiPending` and sends `{type:"extension_ui_request", id: Snowflake.next(), method:"cancel", targetId}` to every other UI connection. A `cancel` emitted by the dialog helpers (abort/timeout) also deletes the id. Socket disconnects never reject shared dialogs; with zero UI connections, requests simply wait.
4. **Host tools:** each connection's `set_host_tools` stores its adapters; the server merges by tool name with the most recent registrant winning and calls `session.refreshRpcHostTools(merged)`. On disconnect: `conn.hostTools.close("host tool client disconnected")`, drop its set, re-merge.
5. **Host URIs:** `clear()` unregisters a scheme only if the router's current handler for it is one this bridge created (track handler instances in a `Set`; add `InternalUrlRouter.handlerFor(scheme)` returning the registered handler).
6. **Spool cap:** socket connections pass `maxSpoolBytes: 64 * 1024 * 1024`; exceeding it fails the writer, whose `onFailure` calls `server.disconnect(conn, "output backlog exceeded")`. `// ponytail: fixed cap, make it a setting if real clients hit it.`

- [ ] **Step 1: Harness** `test/helpers/rpc-server-harness.ts`:

```ts
import { PassThrough } from "node:stream";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { RpcConnection, RpcConnectionOptions } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-connection";
import { RpcServer } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-server";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

/**
 * Holds the assistant stream open after its first text delta until `gate` resolves, so a test
 * can act while a message is mid-stream (the mock model has no per-chunk delay).
 */
function holdAfterFirstDelta(inner: StreamFn, gate: Promise<void>): StreamFn {
	return async (...args) => {
		const source = await inner(...args);
		const out = new AssistantMessageEventStream();
		void (async () => {
			let held = false;
			for await (const event of source) {
				out.push(event);
				if (!held && event.type === "text_delta") {
					held = true;
					await gate;
				}
			}
		})();
		return out;
	};
}

export async function createTestSession(
	dir: string,
	mock: MockModelOptions,
	gate?: Promise<void>,
): Promise<AgentSession> {
	const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = createMockModel(mock);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		streamFn: gate ? holdAfterFirstDelta(model.stream, gate) : model.stream,
	});
	return new AgentSession({
		agent,
		sessionManager: SessionManager.create(dir, path.join(dir, "sessions")),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, path.join(dir, "models.yml")),
	});
}

/** In-process client: writes commands into the server and collects parsed frames. */
export class TestClient {
	readonly frames: Record<string, unknown>[] = [];
	readonly conn: RpcConnection;
	#input: ReadableStreamDefaultController<Uint8Array> | undefined;
	#waiters: Array<{ match: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }> = [];
	#nextId = 0;

	constructor(server: RpcServer, options: Partial<RpcConnectionOptions> = {}) {
		const input = new ReadableStream<Uint8Array>({ start: c => void (this.#input = c) });
		const sink = new PassThrough();
		let buffer = "";
		sink.on("data", chunk => {
			buffer += chunk.toString();
			for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
				const frame = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
				buffer = buffer.slice(nl + 1);
				this.frames.push(frame);
				this.#waiters = this.#waiters.filter(w => (w.match(frame) ? (w.resolve(frame), false) : true));
			}
		});
		this.conn = server.connect(
			{ input, sink },
			{ sequenced: true, ui: true, clientId: crypto.randomUUID(), ...options },
		);
	}

	write(frame: object): void {
		this.#input!.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
	}

	async command(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = `c${++this.#nextId}`;
		const response = this.next(f => f.type === "response" && f.id === id);
		this.write({ id, ...body });
		return response;
	}

	next(match: (f: Record<string, unknown>) => boolean, timeoutMs = 10_000): Promise<Record<string, unknown>> {
		const seen = this.frames.find(match);
		if (seen) return Promise.resolve(seen);
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
		this.#waiters.push({ match, resolve });
		const timer = setTimeout(() => reject(new Error("frame wait timed out")), timeoutMs);
		return promise.finally(() => clearTimeout(timer));
	}

	end(): void {
		this.#input!.close();
	}
}
```

- [ ] **Step 2: Write failing tests** `test/rpc-server-multi.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcServer } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-server";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createTestSession, TestClient } from "./helpers/rpc-server-harness";

let dir: string;
let session: AgentSession;
let server: RpcServer;
let ui: ExtensionUIContext;

async function startServer(mock: MockModelOptions): Promise<void> {
	session = await createTestSession(dir, mock);
	// `setToolUIContext` is the production seam main.ts uses for rpc-ui; it hands out the shared UI context.
	server = await RpcServer.start(session, { setToolUIContext: ctx => void (ui = ctx) });
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-multi-"));
});
afterEach(async () => {
	await server?.dispose();
	await removeWithRetries(dir);
});

describe("RpcServer with two connections", () => {
	it("fans one prompt's events to both clients with identical message ids, prompt_result only to the sender", async () => {
		await startServer({ handler: { content: ["hello back"] } });
		const a = new TestClient(server);
		const b = new TestClient(server);
		await a.command({ type: "prompt", message: "hi" });
		await a.next(f => f.type === "prompt_result");
		await b.next(f => f.type === "agent_end");
		const ids = (c: TestClient) => c.frames.filter(f => f.type === "message_end").map(f => f.messageId);
		expect(ids(b)).toEqual(ids(a));
		expect(ids(a).length).toBeGreaterThan(0);
		expect(b.frames.some(f => f.type === "prompt_result")).toBe(false);
	});

	it("first dialog answer wins and the other client receives cancel for that id", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const a = new TestClient(server);
		const b = new TestClient(server);
		const answer = ui.confirm("Proceed?", "msg");
		const reqA = await a.next(f => f.type === "extension_ui_request" && f.method === "confirm");
		await b.next(f => f.id === reqA.id);
		b.write({ type: "extension_ui_response", id: reqA.id, confirmed: true });
		expect(await answer).toBe(true);
		const cancel = await a.next(f => f.method === "cancel");
		expect(cancel.targetId).toBe(reqA.id);
		a.write({ type: "extension_ui_response", id: reqA.id, confirmed: false }); // late answer: ignored
		await Bun.sleep(20);
		expect(server.uiPending.size).toBe(0);
		expect(b.frames.some(f => f.method === "cancel" && f.targetId === reqA.id)).toBe(false);
	});

	it("keeps a dialog pending with no UI client and lets a late joiner answer it", async () => {
		await startServer({ handler: { content: ["ok"] } });
		const answer = ui.confirm("Late?", "msg");
		expect([...server.uiPending.values()].map(r => r.method)).toEqual(["confirm"]);
		const late = new TestClient(server);
		const [id] = server.uiPending.keys();
		late.write({ type: "extension_ui_response", id, confirmed: true });
		expect(await answer).toBe(true);
	});

	it("routes a host tool call to its latest registrant and fails it when that client drops", async () => {
		await startServer({
			responses: [{ content: [{ type: "toolCall", name: "probe", arguments: {} }] }],
			handler: { content: ["done"] },
		});
		const a = new TestClient(server);
		const b = new TestClient(server);
		const tool = { name: "probe", description: "p", parameters: { type: "object", properties: {} } };
		await a.command({ type: "set_host_tools", tools: [tool] });
		await b.command({ type: "set_host_tools", tools: [tool] });
		await a.command({ type: "prompt", message: "use probe" });
		await b.next(f => f.type === "host_tool_call" && f.toolName === "probe");
		expect(a.frames.some(f => f.type === "host_tool_call")).toBe(false);
		await server.disconnect(b.conn, "test");
		const result = await a.next(
			f => f.type === "message_end" && (f.message as { role: string }).role === "toolResult",
		);
		const message = result.message as { isError: boolean; content: Array<{ type: string; text?: string }> };
		expect(message.isError).toBe(true);
		expect(message.content.map(c => c.text ?? "").join("")).toContain("host tool client disconnected");
	});
});
```

Add `import type { MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";` and `import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";` to the test imports. Do not add test-only methods to `RpcServer`; `uiPending` is production state the snapshot reads.

- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement** behaviors 1-6. Move the level gate out of `RpcSubagentRegistry` (delete `#subscriptionLevel` and the three `if` checks) into:

```ts
export function subagentFrameVisible(level: RpcSubagentSubscriptionLevel, frameType: string): boolean {
	if (level === "off") return false;
	return frameType !== "subagent_event" || level === "events";
}
```

The `set_subagent_subscription` arm sets `conn.subagentLevel`. Update `test/rpc-subagents.test.ts` assertions that relied on the registry gate to assert on `subagentFrameVisible` and on the server delivery instead.
- [ ] **Step 5: Run** `bun test test/rpc-server-multi.test.ts test/rpc*.test.ts` → PASS; `bun check`.
- [ ] **Step 6: Commit** — `feat(rpc): serve one session to multiple connections`.

---

### Task 5: Sequencing, snapshots, epochs, preconditions

**Files:**
- Modify: `src/modes/rpc/rpc-server.ts`, `src/modes/rpc/rpc-types.ts`, `src/modes/rpc/rpc-mode.ts` (extract `buildRpcSessionState(session)` from the `get_state` arm `:1643-1687`)
- Test: `test/rpc-server-sequencing.test.ts`

**Interfaces:**
- Produces (types in `rpc-types.ts`):

```ts
export interface RpcPreconditions { ifEpoch?: number; ifLeaf?: string | null }
export type RpcCommand = (/* existing union */ | { id?: string; type: "detach" } | { id?: string; type: "exit" }) & RpcPreconditions;

export interface RpcSnapshot {
	state: RpcSessionState;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	streaming?: { messageId: string; message: AgentMessage };
	pendingUi: RpcExtensionUIRequest[];
	clients: RpcClientInfo[];
}
export interface RpcClientInfo { clientId: string; kind: string; label?: string }
export interface RpcAttachedFrame { type: "attached"; hostId: string; clientId: string; epoch: number; seq: number; snapshot: RpcSnapshot }
export interface RpcResumedFrame { type: "resumed"; epoch: number; replayed: number }
export interface RpcEntryFrame { type: "entry"; entry: SessionEntry; seq: number }
export interface RpcSessionReplacedFrame {
	type: "session_replaced";
	epoch: number;
	sessionFile: string | undefined;
	reason: "new" | "resume" | "fork" | "tree";
	snapshot: RpcSnapshot;
	seq: number;
}
export interface RpcClientsChangedFrame { type: "clients_changed"; clients: RpcClientInfo[]; seq: number }
// Failure response gains optional fields:
// | { id?; type:"response"; command: string; success:false; error: string; code?: string; epoch?: number; leafId?: string | null; hostId?: string }
```

- `RpcServer` additions:

```ts
	readonly epoch: number;
	/** Monotonic; incremented for every broadcast frame. */
	readonly seq: number;
	snapshot(): RpcSnapshot;
	/** Register a sequenced connection and return its first frame, built in the same tick. */
	attach(conn: RpcConnection, resume?: { epoch: number; lastSeq: number }): RpcAttachedFrame | RpcResumedFrame;
	/** Host hook: veto a switch to a file another host owns. */
	onBeforeSwitch?: (sessionFile: string) => Promise<{ hostId: string } | undefined>;
	/** Host hook: session file or epoch changed. */
	onEpochChanged?: (epoch: number, sessionFile: string | undefined) => void;
```

Behavior:
1. `#broadcast(frame)` assigns `seq = ++this.seq`, pushes `{seq, frame}` onto a ring (`RING_LIMIT = 4096`, `// ponytail: count-bounded ring, byte-bound it if snapshots stay cheaper than replay`), and sends `{...frame, seq}` to sequenced connections and `frame` unchanged to unsequenced ones. Session events go through the stamper, then the ring, then each connection's projection.
2. Entry frames: `session.sessionManager.subscribeEntryAppended(entry => this.#broadcast({ type: "entry", entry }))`. Unsequenced (stdio) connections never receive `entry`, `session_replaced`, or `clients_changed`, preserving stdio bytes.
3. `attach(conn, resume)`: when `resume.epoch === this.epoch` and the ring still holds `resume.lastSeq + 1`, return `resumed` and queue the ring tail `> lastSeq` to `conn` through its projection; otherwise return `attached` with `snapshot()`. Registration and snapshot happen synchronously in one call.
4. `snapshot()`: `state: buildRpcSessionState(session)`, `header`/`entries`/`leafId` from `session.sessionManager`, `streaming` from `session.agent.state.streamMessage` with `stamper.openMessageId()`, `pendingUi: [...uiPending.values()]`, `clients`.
5. Epoch: `session.registerSessionChangeCallback(() => void this.#replace(this.#pendingReason ?? "resume"))`. The `new_session`, `switch_session`, `open_session`, `branch`, `handoff` arms set `#pendingReason` (`new`, `resume`, `resume`, `fork`, `new`) before calling the session and clear it after. `#replace(reason)` awaits `session.waitForSessionTransition()`, increments `epoch`, broadcasts `session_replaced` with a fresh snapshot, then calls `onEpochChanged`.
6. Preconditions, checked for sequenced connections in `handleCommand` before the switch:

```ts
const PRECONDITION_EXEMPT: ReadonlySet<string> = new Set([
	"abort", "abort_bash", "abort_retry", "detach", "exit", "negotiate_protocol", "set_event_filter",
	"set_subagent_subscription", "set_ask_dialog", "set_host_tools", "set_host_uri_schemes",
	"predict_word", "predict_word_feedback",
]);
function preconditionFailure(server: RpcServer, command: RpcCommand): RpcResponse | undefined {
	if (PRECONDITION_EXEMPT.has(command.type) || command.type.startsWith("get_")) return undefined;
	if (command.ifEpoch !== undefined && command.ifEpoch !== server.epoch)
		return { id: command.id, type: "response", command: command.type, success: false, code: "stale",
			error: `Session changed (epoch ${server.epoch})`, epoch: server.epoch };
	const leafId = server.session.sessionManager.getLeafId();
	if (command.ifLeaf !== undefined && command.ifLeaf !== leafId)
		return { id: command.id, type: "response", command: command.type, success: false, code: "stale",
			error: "Session tree moved", leafId };
	return undefined;
}
```

7. `switch_session` calls `onBeforeSwitch(resolvedPath)` first; a result returns `{code:"session_hosted", hostId}` without switching.

- [ ] **Step 1: Failing tests** `test/rpc-server-sequencing.test.ts`. Copy Task 4's imports, `startServer`, `beforeEach`, and `afterEach`; add `import type { RpcAttachedFrame, RpcResumedFrame, RpcSnapshot } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";`. Wrap every test below in `describe("RpcServer sequencing", …)`; each test starts with `await startServer({ handler: { content: ["ok"] } });` unless it shows its own `startServer` call.

```ts
it("sends attached with a snapshot, then seq-ordered frames with no gaps for an unfiltered client", async () => {
	const a = new TestClient(server);
	const attached = server.attach(a.conn) as RpcAttachedFrame;
	expect(attached.type).toBe("attached");
	expect(attached.snapshot.entries).toEqual(session.sessionManager.getEntries());
	await a.command({ type: "prompt", message: "hi" });
	await a.next(f => f.type === "agent_end");
	const seqs = a.frames.filter(f => typeof f.seq === "number").map(f => f.seq as number);
	expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i));
	expect(a.frames.some(f => f.type === "entry")).toBe(true);
});

it("replays the ring tail on resume and falls back to a snapshot for a stale epoch", async () => {
	const a = new TestClient(server);
	server.attach(a.conn);
	await a.command({ type: "prompt", message: "one" });
	await a.next(f => f.type === "agent_end");
	const lastSeq = (a.frames.filter(f => typeof f.seq === "number").at(5)!.seq) as number;
	const b = new TestClient(server);
	const resumed = server.attach(b.conn, { epoch: server.epoch, lastSeq }) as RpcResumedFrame;
	expect(resumed.type).toBe("resumed");
	expect(resumed.replayed).toBe(server.seq - lastSeq);
	const c = new TestClient(server);
	expect(server.attach(c.conn, { epoch: server.epoch - 1, lastSeq }).type).toBe("attached");
});

it("broadcasts session_replaced with a new epoch to every client after new_session", async () => {
	const a = new TestClient(server);
	const b = new TestClient(server);
	server.attach(a.conn);
	server.attach(b.conn);
	const before = server.epoch;
	await a.command({ type: "new_session" });
	const replaced = await b.next(f => f.type === "session_replaced");
	expect(replaced.epoch).toBe(before + 1);
	expect(replaced.reason).toBe("new");
	expect((replaced.snapshot as RpcSnapshot).entries).toEqual([]);
});

it("rejects a stale-epoch prompt without appending anything, but still aborts", async () => {
	const a = new TestClient(server);
	server.attach(a.conn);
	const old = server.epoch;
	await a.command({ type: "new_session" });
	const entriesBefore = session.sessionManager.getEntries().length;
	const res = await a.command({ type: "prompt", message: "late", ifEpoch: old });
	expect(res).toMatchObject({ success: false, code: "stale", epoch: server.epoch });
	expect(session.sessionManager.getEntries().length).toBe(entriesBefore);
	expect(await a.command({ type: "abort", ifEpoch: old })).toMatchObject({ success: true });
});

it("rejects a stale-leaf branch", async () => {
	const a = new TestClient(server);
	server.attach(a.conn);
	await a.command({ type: "prompt", message: "one" });
	await a.next(f => f.type === "agent_end");
	const leaf = session.sessionManager.getLeafId();
	await a.command({ type: "prompt", message: "two" });
	await a.next(f => f.type === "agent_end" && a.frames.filter(x => x.type === "agent_end").length === 2);
	const userEntry = session.sessionManager.getEntries().find(e => e.type === "message" && e.message.role === "user")!;
	const res = await a.command({ type: "branch", entryId: userEntry.id, ifLeaf: leaf });
	expect(res).toMatchObject({ success: false, code: "stale", leafId: session.sessionManager.getLeafId() });
});

it("keeps stdio bytes free of seq, entry, and session_replaced", async () => {
	const s = new TestClient(server, { sequenced: false });
	await s.command({ type: "new_session" });
	await Bun.sleep(50);
	expect(s.frames.some(f => "seq" in f || f.type === "entry" || f.type === "session_replaced")).toBe(false);
});

it("gives a mid-turn joiner the streaming message under the id later updates use", async () => {
	const release = Promise.withResolvers<void>();
	session = await createTestSession(dir, { handler: { content: ["streamed reply"] } }, release.promise);
	server = await RpcServer.start(session, {});
	const a = new TestClient(server);
	server.attach(a.conn);
	await a.command({ type: "prompt", message: "go" });
	await a.next(f => f.type === "message_update");
	const late = new TestClient(server);
	const attached = server.attach(late.conn) as RpcAttachedFrame;
	expect(attached.snapshot.streaming).toBeDefined();
	release.resolve();
	const end = await late.next(f => f.type === "message_end" && f.messageId === attached.snapshot.streaming!.messageId);
	expect((end.message as { role: string }).role).toBe("assistant");
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** behaviors 1-7.
- [ ] **Step 4: Run** `bun test test/rpc-server-sequencing.test.ts test/rpc-server-multi.test.ts test/rpc*.test.ts` → PASS; `bun check`.
- [ ] **Step 5: Commit** — `feat(rpc): add attach snapshots, sequencing, epochs, and write preconditions`.

---

### Task 6: Host registry, socket listener, handshake, lifetime

**Files:**
- Create: `src/session-host/registry.ts`, `src/session-host/host.ts`, `src/session-host/client.ts` (only `connectSessionHost` in this task)
- Modify: `src/modes/rpc/rpc-types.ts` (`RpcHelloFrame`)
- Test: `test/session-host/registry.test.ts`, `test/session-host/host.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers, Task 5 `RpcServer.attach`, hooks.
- Produces:

```ts
// registry.ts
export const SESSION_HOST_REGISTRY_VERSION = 1;
export interface SessionHostEntry {
	version: number; hostId: string; pid: number; endpoint: string; token: string;
	cwd: string; sessionFile: string | undefined; title: string | undefined;
	clients: number; busy: boolean; startedAt: number;
}
export function sessionHostsDir(): string; // path.join(getBaseConfigRoot(), "run", "session-hosts")
export async function writeHostEntry(entry: SessionHostEntry, dir?: string): Promise<void>;
export async function removeHostEntry(hostId: string, dir?: string): Promise<void>;
/** Live entries only; dead ones (probe "dead") are pruned. */
export async function listSessionHosts(dir?: string): Promise<SessionHostEntry[]>;
export async function findHostForSession(sessionFile: string, dir?: string): Promise<SessionHostEntry | undefined>;
export function newHostId(): string; // crypto.randomBytes(8).toString("hex")

// rpc-types.ts
export interface RpcHelloFrame {
	type: "hello"; token: string; protocolVersion: 1 | 2;
	client: { kind: string; label?: string };
	capabilities: { ui: boolean };
	resume?: { epoch: number; lastSeq: number };
}

// host.ts
export interface SessionHostOptions extends RpcServerOptions {
	hostId: string;
	registryDir?: string;
	/** Called after the last client's `exit`; the caller disposes and exits. */
	onExit: () => Promise<never>;
}
export async function runSessionHost(session: AgentSession, options: SessionHostOptions): Promise<never>;

// client.ts
export interface ConnectSessionHostOptions {
	entry: Pick<SessionHostEntry, "endpoint" | "token">;
	client: { kind: string; label?: string };
	ui: boolean;
	resume?: { epoch: number; lastSeq: number };
}
/** Socket transport for RpcClient's `spawn` option. `kill()` closes the socket (a detach). */
export async function connectSessionHost(options: ConnectSessionHostOptions): Promise<RpcAgentProcess>;
```

Host behavior (`runSessionHost`):
1. Claim the owner lease: `const release = new FileSessionStorage().claimSessionFile(session.sessionFile)`. `null` → log, look up `findHostForSession`, throw `Error(\`session already open in ${host ? \`host ${host.hostId}\` : "another process"}\`)`.
2. `RpcServer.start(session, options)`; set `onBeforeSwitch` to claim the target's lease (null → `findHostForSession` → `{hostId}` or `{hostId: "unknown"}`), and `onEpochChanged` to release the previous lease, keep the new claim, and rewrite the registry entry.
3. `net.createServer` on `privateEndpoint(dir, hostId, { prefix: "host", label: "session host registry" })`; chmod 0600 on POSIX.
4. Per socket: wrap with `Readable.toWeb(socket)`. The first frame must be `hello` with `tokenMatches`; otherwise write `{type:"response", command:"hello", success:false, code:"unauthorized", error:"unauthorized"}` and destroy. A socket that closes before `hello` (registry liveness probe) is ignored. On success: `server.connect(..., { sequenced: true, ui: hello.capabilities.ui, maxSpoolBytes: 64 MiB, clientId, client })`, write `ready`, then the `server.attach(...)` result, then broadcast `clients_changed`.
5. `detach` command: respond success, then `server.disconnect(conn)`, close the socket, broadcast `clients_changed`. Socket close or error without `detach` does the same.
6. `exit` command: if other connections remain, behave as `detach`. Otherwise respond success, drain the writer, remove the registry entry, then `options.onExit()`.
7. Registry entry written after listen; rewritten (serialized through one promise chain) on `clients_changed`, `agent_start`/`agent_end` (`busy`), title change, and `onEpochChanged`. `process.once("exit", () => removeHostEntrySync)` as collab does.

- [ ] **Step 1: Failing tests.** `test/session-host/registry.test.ts`:

```ts
it("lists live hosts and prunes an entry whose endpoint is gone", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hosts-"));
	const live = await listenOn(dir, "aaaaaaaaaaaaaaaa"); // net server on privateEndpoint
	await writeHostEntry(entry("aaaaaaaaaaaaaaaa", live.endpoint), dir);
	await writeHostEntry(entry("bbbbbbbbbbbbbbbb", path.join(dir, "gone.sock")), dir);
	expect((await listSessionHosts(dir)).map(e => e.hostId)).toEqual(["aaaaaaaaaaaaaaaa"]);
	expect(await Bun.file(path.join(dir, "bbbbbbbbbbbbbbbb.json")).exists()).toBe(false);
	live.close();
});
```

(`listenOn` and `entry` are small local helpers in the test file: `privateEndpoint` + `net.createServer().listen`, and a full `SessionHostEntry` literal.)

`test/session-host/host.test.ts` runs `runSessionHost` in-process on a `createTestSession` session with `registryDir` in the temp dir and `onExit` resolving a test promise, then uses `RpcClient` with `spawn: () => connectSessionHost(...)`:

```ts
it("rejects a bad token", async () => {
	const host = await startHost();
	const sock = net.connect((await onlyEntry()).endpoint);
	sock.write(`${JSON.stringify({ type: "hello", token: "nope", protocolVersion: 1, client: { kind: "test" }, capabilities: { ui: false } })}\n`);
	const reply = JSON.parse((await once(sock, "data"))[0].toString().split("\n")[0]);
	expect(reply).toMatchObject({ success: false, code: "unauthorized" });
	await host.stop();
});

it("keeps the host after the last client detaches and after an abruptly closed client", async () => {
	const host = await startHost();
	const a = await attachClient(host);
	await a.detach();
	const b = await attachClient(host);
	await b.stop(); // socket destroyed without `detach`
	await waitFor(async () => (await onlyEntry()).clients === 0);
	expect(host.exited).toBe(false);
	const c = await attachClient(host);
	expect((await c.getState()).sessionId).toBe(host.session.sessionId);
	await host.stop();
});

it("treats exit as detach while another client remains and stops the host for the last one", async () => {
	const host = await startHost();
	const a = await attachClient(host);
	const b = await attachClient(host);
	await a.exit();
	expect(host.exited).toBe(false);
	await b.exit();
	await host.exitedPromise;
	expect(await listSessionHosts(registryDir)).toEqual([]);
});

it("refuses to switch to a session another host owns", async () => {
	const other = await startHost();
	const host = await startHost();
	const a = await attachClient(host);
	await expect(a.switchSession(other.session.sessionFile!)).rejects.toMatchObject({
		code: "session_hosted",
		hostId: other.hostId,
	});
	await other.stop();
	await host.stop();
});
```

Helpers at the top of the test file (`dir`/`registryDir` come from `beforeEach` temp dirs; each `startHost` call gets its own session subdirectory):

```ts
interface TestHost {
	hostId: string;
	session: AgentSession;
	exited: boolean;
	exitedPromise: Promise<void>;
	stop(): Promise<void>;
}

let hostCount = 0;
async function startHost(): Promise<TestHost> {
	const sessionDir = path.join(dir, `host-${++hostCount}`);
	await fs.mkdir(sessionDir, { recursive: true });
	const session = await createTestSession(sessionDir, { handler: { content: ["ok"] } });
	const hostId = newHostId();
	const done = Promise.withResolvers<void>();
	const host: TestHost = {
		hostId,
		session,
		exited: false,
		exitedPromise: done.promise,
		async stop() {
			if (host.exited) return;
			await (await attachClient(host)).exit();
			await done.promise;
		},
	};
	void runSessionHost(session, {
		hostId,
		registryDir,
		onExit: async () => {
			await session.dispose();
			host.exited = true;
			done.resolve();
			return new Promise<never>(() => {});
		},
	});
	await waitFor(async () => (await listSessionHosts(registryDir)).some(e => e.hostId === hostId));
	return host;
}

async function attachClient(host: TestHost): Promise<RpcClient> {
	const entry = (await listSessionHosts(registryDir)).find(e => e.hostId === host.hostId)!;
	const client = new RpcClient({ spawn: () => connectSessionHost({ entry, client: { kind: "test" }, ui: false }) });
	await client.start();
	return client;
}

async function onlyEntry(): Promise<SessionHostEntry> {
	const [entry] = await listSessionHosts(registryDir);
	return entry;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await Bun.sleep(25);
	}
}
```

`RpcClient` API added in this task (`src/modes/rpc/rpc-client.ts`): `detach(): Promise<void>` and `exit(): Promise<void>` sending the new commands, and `RpcCommandError` gains optional `epoch?: number`, `leafId?: string | null`, `hostId?: string`, filled by `#getData` (`:1452-1456`) from the failure response. P3's `RemoteSession` uses the same methods.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** registry, host, and `connectSessionHost` (`net.connect(endpoint)`, write `hello`, expose `stdout: Readable.toWeb(socket)`, `stdin: { write: d => socket.write(d) }`, `kill: () => socket.destroy()`, `exited` resolving on `close`, `peekStderr: () => ""`).
- [ ] **Step 4: Run** `bun test test/session-host` → PASS; `bun check`.
- [ ] **Step 5: Commit** — `feat(session-host): serve a session over a token-authenticated local socket`.

---

### Task 7: `omp --mode host` and `spawnSessionHost`

**Files:**
- Modify: `src/cli/args.ts:23` (`Mode` adds `"host"`, `Args` adds `hostId?: string`), `src/cli/flag-tables.ts:122-130` (accept `host`, message lists it) and `STRING_SETTERS` (`"--host-id"`), `src/commands/launch-help.ts:46-49`, `src/main.ts` sites `252, 1718, 1729, 1761, 1827, 1839, 1844, 2145, 2466`
- Modify: `src/session-host/client.ts` (add `spawnSessionHost`)
- Test: `test/session-host/spawn.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SpawnSessionHostOptions {
	cwd: string;
	/** Absolute session file to resume; omitted = new session. */
	sessionFile?: string;
	/** Extra launch flags (model, profile, …) forwarded verbatim. */
	args?: string[];
	registryDir?: string;
	timeoutMs?: number; // default 120_000, matching ompweb's cold-start budget
}
export async function spawnSessionHost(options: SpawnSessionHostOptions): Promise<SessionHostEntry>;
```

main.ts behavior for `mode === "host"`: does not claim stdin (`:1729`); counts as a protocol mode (`:1761`); applies `rpc` protocol defaults (`:1827`); sets `PI_NO_PTY`/`PI_NO_TITLE` like rpc (`:1839`, `:1844`); `hasUI` true (`:2145`, tool UI is routed over the protocol like `rpc-ui`); requires `--host-id` matching `/^[0-9a-f]{16}$/`. Dispatch next to `:2466`:

```ts
if (mode === "host") {
	stopStartupWatchdog();
	process.on("SIGHUP", () => {}); // a closed terminal must not end the host (spec D7)
	await runSessionHost(session, {
		hostId: parsedArgs.hostId!,
		setToolUIContext,
		headless: false,
		subagentEventBus,
		onExit: () => exitAfterHostDispose(session),
	});
}
```

`exitAfterHostDispose` reuses Task 3's `exitAfterDispose` logic minus the stdio writer. SIGTERM/SIGINT go through the existing `postmortem` path, which disposes the session.

`spawnSessionHost`: `hostId = newHostId()`; `logPath = path.join(dir, \`${hostId}.log\`)`; spawn as `tiny/title-client.ts:353-372` does, with `[...resolveCliEntryCmd(), "--mode", "host", "--host-id", hostId, "--cwd", cwd, ...(sessionFile ? ["--resume", sessionFile] : []), ...args]`, `env: workerEnvFromParent()`, `stdin: "ignore"`, `stdout`/`stderr` to the log fd, `...BROKER_SPAWN_OPTIONS` (detached on POSIX, `windowsHide` on win32), then `unref()`. Poll the registry every 50 ms for `hostId` until `timeoutMs`; reject early if the child's `exited` settles first. Errors include the log path.

- [ ] **Step 1: Failing test** `test/session-host/spawn.test.ts` (real CLI from source, isolated dirs):

```ts
it("spawns a detached host that outlives its spawner's client and exits on the last exit", async () => {
	const env = { PI_CODING_AGENT_DIR: dir, HOME: dir, PI_CONFIG_DIR: dir };
	const entry = await withEnv(env, () =>
		spawnSessionHost({ cwd: dir, registryDir, args: ["--no-extensions", "--no-skills", "--no-rules"] }),
	);
	expect(pidAlive(entry.pid)).toBe(true);
	const a = new RpcClient({ spawn: () => connectSessionHost({ entry, client: { kind: "test" }, ui: false }) });
	await a.start();
	expect((await a.getState()).sessionFile).toBe(entry.sessionFile);
	await a.stop(); // socket close = detach
	expect(pidAlive(entry.pid)).toBe(true);
	const b = new RpcClient({ spawn: () => connectSessionHost({ entry, client: { kind: "test" }, ui: false }) });
	await b.start();
	await b.exit();
	await waitFor(() => !pidAlive(entry.pid), 10_000);
	expect(await listSessionHosts(registryDir)).toEqual([]);
}, 150_000);
```

`withEnv` must not leak: implement it as `spawnSessionHost({ ..., env })`. Add `env?: Record<string, string>` to `SpawnSessionHostOptions`, merged over `workerEnvFromParent()`, instead of mutating `process.env`.

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test test/session-host` → PASS; `bun check`. Manual smoke: `bun src/cli.ts --mode host --host-id 0123456789abcdef --cwd /tmp` in one terminal; `bun src/cli.ts attach --json` (Task 8) in another shows it.
- [ ] **Step 5: Commit** — `feat(session-host): add --mode host and detached host spawning`.

---

### Task 8: `omp attach` listing

**Files:**
- Create: `src/commands/attach.ts`
- Modify: `src/cli-commands.ts:70-76` (register next to `collab`), `src/cli/command-help.ts:30` (`attachHelp`)
- Test: `test/cli/attach-cli.test.ts`

**Interfaces:**
- Consumes: `listSessionHosts`.
- Produces: `omp attach [--json]`. P1 lists only: one line per host `hostId  clients  busy|idle  cwd  title-or-session`, or a JSON array of `SessionHostEntry` without `token`. Exit 0 with "No session hosts running." when empty. P3 adds the target argument and picker; P1 accepts no positional argument (the parser rejects one).

```ts
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { attachHelp } from "../cli/command-help";
import { listSessionHosts } from "../session-host/registry";

export default class Attach extends Command {
	static description = attachHelp.description;
	static flags = { json: Flags.boolean({ description: "Print hosts as JSON" }) };
	static examples = ["omp attach", "omp attach --json"];
	async run(): Promise<void> {
		const { flags } = await this.parse(Attach);
		const hosts = (await listSessionHosts()).map(({ token: _token, ...rest }) => rest);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(hosts)}\n`);
			return;
		}
		if (hosts.length === 0) {
			process.stdout.write("No session hosts running.\n");
			return;
		}
		for (const h of hosts) {
			const label = h.title ?? h.sessionFile ?? "(new session)";
			process.stdout.write(`${h.hostId}  ${h.clients}  ${h.busy ? "busy" : "idle"}  ${h.cwd}  ${label}\n`);
		}
	}
}
```

Check `Flags` is exported from `@oh-my-pi/pi-utils/cli` (see another command using flags) before relying on it.

- [ ] **Step 1: Failing test** — spawn `bun src/cli.ts attach --json` with `PI_CONFIG_DIR` pointing at a temp root that holds one live entry (in-process `net` server + `writeHostEntry`) and one dead entry; assert the JSON lists only the live host and has no `token` key.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test test/cli/attach-cli.test.ts` → PASS; `bun check`.
- [ ] **Step 5: Commit** — `feat(cli): list session hosts with omp attach`.

---

### Task 9: Smoke probe and Windows CI

**Files:**
- Modify: `src/session-host/client.ts` (add `smokeTestSessionHost`), `src/cli.ts:136-188`
- Modify: `.github/workflows/ci.yml` (new job)

**Interfaces:**
- Produces: `export async function smokeTestSessionHost(): Promise<void>` — temp dir via `fs.mkdtemp(path.join(os.tmpdir(), "omp-host-smoke-"))`; `spawnSessionHost({ cwd: tmp, registryDir: tmp, env: { PI_CODING_AGENT_DIR: tmp, HOME: tmp }, args: ["--no-extensions", "--no-skills", "--no-rules"], timeoutMs: SMOKE_TEST_TIMEOUT_MS })`; connect; `get_state`; `exit`; wait for the pid to die; `finally` remove the temp dir. Same shape as `smokeTestDaemonBroker` (`launch/client.ts:516-535`).

- [ ] **Step 1:** Add the probe after the broker probe in `runSmokeTest` (`cli.ts:145`, `:178`).
- [ ] **Step 2:** Run `bun src/cli.ts --smoke-test` → prints `smoke-test: ok`. Run it with `bun build --compile` output too if a local compile is cheap (`bun run build:binary` per package.json); otherwise rely on CI's binary smoke jobs, and record which one ran.
- [ ] **Step 3:** Add a Windows job to `ci.yml`, modeled on the existing Linux coding-agent runtime job (same checkout, Bun setup, `bun install --frozen-lockfile`, native build or artifact download as that job does):

```yaml
  coding_agent_session_host_windows:
    name: Session host (windows)
    runs-on: windows-latest
    steps:
      # Copy the setup steps verbatim from the Linux runtime test job.
      - name: Session host tests
        working-directory: packages/coding-agent
        run: bun test test/session-host test/ipc test/rpc-server-multi.test.ts test/rpc-server-sequencing.test.ts
```

The executor copies the Linux job's setup steps exactly rather than writing new ones, and confirms the native addon is available on `windows-latest` x64 (the release job only executes arm64). If the native build cannot run there, report it as a blocker instead of skipping tests.
- [ ] **Step 4:** Push the branch to the fork and confirm the job passes (authorized CI run), or record why it could not run.
- [ ] **Step 5: Commit** — `test(session-host): smoke probe and windows CI coverage`.

---

### Task 10: Docs and changelog

**Files:**
- Modify: `docs/rpc.md` (new section "Session hosts"), `packages/coding-agent/CHANGELOG.md` (`## [Unreleased]` → `### Added`)

- [ ] **Step 1:** Document in `docs/rpc.md`: `omp --mode host --host-id`, registry location `~/.omp/run/session-hosts/<hostId>.json` (fields, owner-only), the `hello` frame, `attached`/`resumed`, `seq` and gaps from filters, ring fallback, `entry`, `session_replaced` (with snapshot), `clients_changed`, first-answer-wins dialogs and `cancel`, host-tool routing, `detach`/`exit`, `ifEpoch`/`ifLeaf` and `stale`, `session_hosted`. State that stdio RPC is unchanged.
- [ ] **Step 2:** Changelog lines:

```md
### Added

- Added `omp --mode host`: a detached session host that several RPC clients can attach to over a local socket or named pipe, with resume, dialog arbitration, and stale-write protection.
- Added `omp attach` to list running session hosts (`--json` for scripts).
```

- [ ] **Step 3: Commit** — `docs(rpc): document session hosts`.

---

## Later phases (separate plans, written after P1 lands)

- **P2:** move plan/goal/loop/compaction-queue/pending-model-switch/idle timers out of the TUI; `slash_command` RPC; tree-navigation and fork RPC commands (both take `ifLeaf`); missing read commands; replay of `setStatus`/`setWidget`/`setTitle` state in snapshots.
- **P3:** `tui.hosted` setting, `RemoteSession`, replica `SessionManager.inMemory` fed by `ingestReplicatedEntry`, `/attach`, `/detach`, `/exit`, `--solo`, `omp attach <target>` and picker, parity table.
- **P4:** flip the default, then delete the setting and the in-process interactive path.
