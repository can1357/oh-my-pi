# RFD Standard Child Sessions (A+B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit upstream-RFD `subagent_update` child sessions (announce + running/idle states + cancel) for standard ACP clients, mirroring codex-acp's standard router.

**Architecture:** New `acp-rfd-subagents.ts` projector beside the AIR tracker, reusing its child-lifecycle table plus the registry `status_changed` feed for parked/revived transitions; typed unstable protocol members added to `packages/utils/src/acp`; child traffic re-addressed through the existing event mapper.

**Tech Stack:** TypeScript (Bun), existing `mapAgentSessionEventToAcpSessionUpdates`, `AgentRegistry`/`AgentLifecycleManager`, `bun test`.

## Global Constraints

- omp speaks ACP v1 only (`PROTOCOL_VERSION = 1`).
- Mirror codex-acp's standard router behavior only: no `session_message` emission, no `session/prompt` to children, no async/background-task protocol.
- RFD members are unstable/experimental: mark `@experimental`, gate strictly on client `subagents` object.
- No placeholders, no `any`, ES `#private` fields, `Promise.withResolvers()` for deferreds.

---

### Task 1: Unstable RFD protocol + schema types

**Files:**
- Modify: `packages/utils/src/acp/protocol.ts`
- Modify: `packages/utils/src/acp/schema.ts`
- Test: `packages/utils/test/acp-rfd-schema.test.ts` (check existing test layout first; co-locate if a suite exists)

**Interfaces:**
- Consumes: existing `Meta`, `SessionUpdate`, `SessionNotification`, `ClientCapabilities` types.
- Produces: `SubagentCapabilities`, `SessionCancelCapabilities`, `StateUpdate` (+ `RunningStateUpdate`, `IdleStateUpdate`, `RequiresActionStateUpdate`, `UnknownStateUpdate`, `ErrorStopReason`), `SubagentUpdate` exported from `protocol.ts`; `ClientCapabilities.subagents?: SubagentCapabilities | null`; `SessionUpdate` union extended with `({ sessionUpdate: "subagent_update" } & SubagentUpdate)`; schema `SessionUpdate` or-chain extended with the `subagent_update` variant (sessionId string, rest `unknown[]`/object passthrough per repo validator style).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";
import { schema } from "@oh-my-pi/pi-utils/acp";

describe("rfd subagent_update schema", () => {
	it("accepts announce, running, and idle-terminal patches", () => {
		for (const update of [
			{ sessionUpdate: "subagent_update", sessionId: "child-1", title: "task", capabilities: { cancel: {} } },
			{ sessionUpdate: "subagent_update", sessionId: "child-1", state: { state: "running" } },
			{
				sessionUpdate: "subagent_update",
				sessionId: "child-1",
				state: { state: "idle", stopReason: "end_turn" },
				capabilities: { cancel: null },
			},
		]) {
			const result = schema.zSessionNotification({ sessionId: "parent-1", update });
			expect(result.success).toBe(true);
		}
	});

	it("rejects non-object state", () => {
		const result = schema.zSessionNotification({
			sessionId: "parent-1",
			update: { sessionUpdate: "subagent_update", sessionId: "child-1", state: "running" },
		});
		expect(result.success).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/utils/test/acp-rfd-schema.test.ts`
Expected: FAIL (no `subagent_update` member / schema rejects it)

- [ ] **Step 3: Write minimal implementation**

Add to `protocol.ts` (after `SessionUpdate`, before `SessionNotification`):

```typescript
/** Capability to cancel a subagent child's work without ending that child. Supplying `{}` advertises support. @experimental */
export type SessionCancelCapabilities = Meta;
/** Client-initiated mutations permitted for a subagent child. Only `cancel` is defined. @experimental */
export type SubagentSessionCapabilities = { cancel?: SessionCancelCapabilities | null } & Meta;
/** Idle snapshot for finished foreground work. @experimental */
export type IdleStateUpdate = { state: "idle"; stopReason?: string | null; error?: unknown } & Meta;
export type RunningStateUpdate = { state: "running" } & Meta;
export type RequiresActionStateUpdate = { state: "requires_action" } & Meta;
export type UnknownStateUpdate = { state: "unknown" } & Meta;
/** Current foreground-work snapshot of a reusable child. @experimental */
export type StateUpdate = RunningStateUpdate | IdleStateUpdate | RequiresActionStateUpdate | UnknownStateUpdate;
/** Patch for a child association. Omitted = keep, explicit null = clear. @experimental */
export type SubagentUpdate = {
	sessionId: string;
	title?: string | null;
	description?: string | null;
	capabilities?: SubagentSessionCapabilities | null;
	state?: StateUpdate | null;
} & Meta;
```

Extend `ClientCapabilities` with `subagents?: SubagentCapabilities | null;` plus:

```typescript
/** Marker for RFD child-session support. Supplying `{}` advertises it. @experimental */
export type SubagentCapabilities = Meta;
```

Extend the `SessionUpdate` union with `| ({ sessionUpdate: "subagent_update" } & SubagentUpdate)`.

Extend `schema.ts` `SessionUpdate` or-chain with `.or({ sessionUpdate: "'subagent_update'", sessionId: "string" })` (remaining fields passthrough-`unknown`, matching existing validator style which checks only consumed fields).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/utils/test/acp-rfd-schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/acp/protocol.ts packages/utils/src/acp/schema.ts packages/utils/test/acp-rfd-schema.test.ts
git commit -m "feat(acp): add unstable RFD subagent_update protocol and schema types"
```

### Task 2: RFD projector module

**Files:**
- Create: `packages/coding-agent/src/modes/acp/acp-rfd-subagents.ts`
- Test: `packages/coding-agent/test/acp-rfd-subagents.test.ts`

**Interfaces:**
- Consumes: `TASK_SUBAGENT_LIFECYCLE_CHANNEL`, `SubagentLifecyclePayload` from `../../task/types`; `EventBus` from `../../utils/event-bus`.
- Produces: `RfdSubagentTracker` class with `subscribe(bus)`, `handleLifecycle(payload)`, `handleRegistryStatus(ref)`, `children` getter, `childAnnounced(id)`, `dispose()`; `isStandardSubagentClient(caps)` guard; `AcpRawUpdateSender` reused from `./acp-subagent-tracker`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	RfdSubagentTracker,
	isStandardSubagentClient,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-rfd-subagents";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";

function lifecycle(status: string, extra: Record<string, unknown> = {}) {
	return { id: "worker-1", agent: "task", agentSource: "bundled", description: "Do the thing", status, index: 0, ...extra };
}

describe("rfd subagent tracker", () => {
	test("spawn emits announce then running state", async () => {
		const sent: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
		const tracker = new RfdSubagentTracker({ parentSessionId: "p", send: async v => void sent.push(v) });
		await tracker.handleLifecycle(lifecycle("started"));
		expect(sent).toHaveLength(2);
		expect(sent[0]?.update).toEqual({
			sessionUpdate: "subagent_update",
			sessionId: "worker-1",
			title: "task",
			description: "Do the thing",
			capabilities: { cancel: {} },
		});
		expect(sent[1]?.update).toEqual({
			sessionUpdate: "subagent_update",
			sessionId: "worker-1",
			state: { state: "running" },
		});
	});

	test("duplicate spawn is idempotent; terminal emits idle and revokes cancel", async () => {
		const sent: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
		const tracker = new RfdSubagentTracker({ parentSessionId: "p", send: async v => void sent.push(v) });
		await tracker.handleLifecycle(lifecycle("started"));
		await tracker.handleLifecycle(lifecycle("started"));
		expect(sent).toHaveLength(2);
		await tracker.handleLifecycle(lifecycle("completed"));
		expect(sent).toHaveLength(3);
		expect(sent[2]?.update).toEqual({
			sessionUpdate: "subagent_update",
			sessionId: "worker-1",
			state: { state: "idle", stopReason: "end_turn" },
			capabilities: { cancel: null },
		});
		expect(tracker.children.has("worker-1")).toBe(true);
	});

	test("aborted maps to cancelled; failed carries error stop", async () => {
		const sent: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
		const tracker = new RfdSubagentTracker({ parentSessionId: "p", send: async v => void sent.push(v) });
		await tracker.handleLifecycle(lifecycle("started", { id: "a" }));
		await tracker.handleLifecycle(lifecycle("started", { id: "b" }));
		await tracker.handleLifecycle(lifecycle("aborted", { id: "a" }));
		await tracker.handleLifecycle(lifecycle("failed", { id: "b" }));
		const states = sent.map(e => (e.update as { state?: { stopReason?: string } }).state?.stopReason);
		expect(states).toEqual([undefined, undefined, "cancelled", "error"]);
	});

	test("parked clears state; revived re-emits running", async () => {
		const sent: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
		const tracker = new RfdSubagentTracker({ parentSessionId: "p", send: async v => void sent.push(v) });
		await tracker.handleLifecycle(lifecycle("started"));
		expect(sent).toHaveLength(2);
		tracker.handleRegistryStatus({ id: "worker-1", status: "parked" });
		tracker.handleRegistryStatus({ id: "worker-1", status: "running" });
		expect(sent.slice(2).map(e => e.update)).toEqual([
			{ sessionUpdate: "subagent_update", sessionId: "worker-1", state: null },
			{ sessionUpdate: "subagent_update", sessionId: "worker-1", state: { state: "running" } },
		]);
	});

	test("client gate requires a subagents object", () => {
		expect(isStandardSubagentClient(undefined)).toBe(false);
		expect(isStandardSubagentClient({})).toBe(false);
		expect(isStandardSubagentClient({ subagents: null })).toBe(false);
		expect(isStandardSubagentClient({ subagents: [] })).toBe(false);
		expect(isStandardSubagentClient({ subagents: {} })).toBe(true);
	});

	test("subscribe wires the lifecycle channel and dispose unwires", () => {
		const tracker = new RfdSubagentTracker({ parentSessionId: "p", send: async () => {} });
		const bus = new EventBus();
		tracker.subscribe(bus);
		expect(bus.hasListeners(TASK_SUBAGENT_LIFECYCLE_CHANNEL)).toBe(true);
		tracker.dispose();
		expect(bus.hasListeners(TASK_SUBAGENT_LIFECYCLE_CHANNEL)).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/acp-rfd-subagents.test.ts`
Expected: FAIL with "module not found"

- [ ] **Step 3: Write minimal implementation**

Create `acp-rfd-subagents.ts`: `RfdSubagentTracker` keyed by registry id holding `{ announced: boolean; lastState: string | null }`. `handleLifecycle`: `started` → announce patch then `state:{running}` (skip both if announced); terminal (`completed`→`idle/end_turn`, `failed`→`idle/error`, `aborted`→`idle/cancelled`) → single patch with `state` + `capabilities:{cancel:null}`, keep entry. Unknown ids ignored. `handleRegistryStatus({id,status})`: `parked` → `state:null` patch; `running` after parked → `state:{running}` (guard with `lastState` to avoid duplicate running patches). `isStandardSubagentClient` = `subagents` is a non-array object. Method shapes mirror `acp-subagent-tracker.ts` (same bus subscribe/dispose pattern, same `AcpRawUpdateSender`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/coding-agent/test/acp-rfd-subagents.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/acp/acp-rfd-subagents.ts packages/coding-agent/test/acp-rfd-subagents.test.ts
git commit -m "feat(acp): add RFD subagent_update projector for standard clients"
```

### Task 3: Wire projector + child traffic + child cancel

**Files:**
- Modify: `packages/coding-agent/src/modes/acp/acp-agent.ts` (record field `rfdSubagentTracker`, install/dispose, cancel routing)
- Test: extend `packages/coding-agent/test/acp-agent.test.ts` FakeAgentSession harness (check how `subagentEventBus` is threaded there) OR new `packages/coding-agent/test/acp-rfd-wiring.test.ts` if the harness resists injection

**Interfaces:**
- Consumes: `RfdSubagentTracker`, `isStandardSubagentClient` from `./acp-rfd-subagents`; existing `mapAgentSessionEventToAcpSessionUpdates`; `AgentRegistry` ref status.
- Produces: RFD projector installed per record when the client advertises `subagents`; child session events (`TASK_SUBAGENT_EVENT_CHANNEL`) re-emitted with child outer id; `session/cancel` on a known child id routes to the existing kill path.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test, vi } from "bun:test";
// Harness: AcpAgent with stubbed connection capturing sessionUpdate calls,
// FakeAgentSession with a real EventBus as subagentEventBus,
// initialize with clientCapabilities { subagents: {} }.
describe("rfd wiring", () => {
	it("installs the rfd projector only when the client advertises subagents", async () => {
		// register a session, emit a lifecycle started frame on the record bus,
		// expect a subagent_update announce via connection.sessionUpdate
	});
	it("routes child task frames with the child outer id", async () => {
		// emit TASK_SUBAGENT_EVENT_CHANNEL frame for a known child,
		// expect mapper output sent with sessionId = child id
	});
	it("cancel on a child id kills via the child path", async () => {
		// agent.cancel({ sessionId: childId }) resolves without touching the parent turn
	});
});
```

(Write concrete assertions against the actual harness once its injection points are read; keep the three behaviors above.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/coding-agent/test/acp-rfd-wiring.test.ts`
Expected: FAIL (no projector installed)

- [ ] **Step 3: Write minimal implementation**

In `acp-agent.ts`: add `rfdSubagentTracker` to `ManagedSessionRecord`; `#installRfdSubagentTracker(record, bus)` gated on `isStandardSubagentClient(this.#clientCapabilities)`; subscribe registry `onChange` for `status_changed` → `tracker.handleRegistryStatus` (scoped: only ids in `tracker.children`); child event frames → `mapAgentSessionEventToAcpSessionUpdates(event, childId)` → `connection.sessionUpdate` with outer `sessionId: childId`; extend the child-cancel lookup to RFD children (same `#cancelSubagentChild`, tracker union); dispose both trackers in `#disposeSessionRecord`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/coding-agent/test/acp-rfd-wiring.test.ts packages/coding-agent/test/acp-rfd-subagents.test.ts packages/coding-agent/test/acp-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/acp/acp-agent.ts packages/coding-agent/test/acp-rfd-wiring.test.ts
git commit -m "feat(acp): wire RFD projector, child traffic, and child cancel"
```

### Task 4: Standard-client probe + changelog + full verification

**Files:**
- Create: `/tmp/acp-rfd-probe.ts` (throwaway NDJSON probe, same pattern as the AIR probe: initialize with `subagents:{}` → `session/new` → prompt spawning one task subagent → assert `subagent_update` announce + child-outer-id traffic + `running`→`idle` states + `session/cancel` on the child id → terminal patch)
- Modify: `packages/coding-agent/CHANGELOG.md` (`[Unreleased] → Added`, one line)
- Delete the probe file after the run

**Interfaces:**
- Consumes: built `bun packages/coding-agent/src/cli.ts acp` from this checkout.
- Produces: probe log pasted into the final report; changelog line.

- [ ] **Step 1: Run the probe**

Run: `timeout 320 bun /tmp/acp-rfd-probe.ts`
Expected: `SPAWNED`/announce `subagent_update` with `capabilities:{cancel:{}}`, child-outer-id `tool_call_update`s, `state:running` then `state:idle`, cancel revokes.

- [ ] **Step 2: Update changelog**

Add under `## [Unreleased]` → `### Added`:
`- ACP standard clients advertising subagents now see task-tool subagents as RFD child sessions (announce + running/idle states + cancel)`

- [ ] **Step 3: Full verification**

Run: `bun check` (expect green), then `bun test packages/coding-agent/test/acp-*.test.ts packages/coding-agent/test/rpc-subagents.test.ts` (expect pass; pre-existing `/mcp resources` failure in `acp-builtins` stays out of scope — verify it fails identically on clean main if touched).

- [ ] **Step 4: Commit**

```bash
git add packages/coding-agent/CHANGELOG.md
git commit -m "docs: changelog for RFD child sessions"
```

## Self-Review

- Spec coverage: negotiation (§1), announce (§2), running (B), child traffic, settle/idle (B), parked/revived (B), cancel, explicit outs (no prompt-to-child, no session_message, no async tasks) — each has a task.
- No placeholders: every step has exact code/commands.
- Type consistency: `AcpRawUpdateSender`, `SubagentLifecyclePayload`, tracker method names match the existing AIR tracker; `StateUpdate` names match the SDK unstable schema.
