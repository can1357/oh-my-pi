import { describe, expect, test } from "bun:test";
import type { SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { isStandardSubagentClient, RfdSubagentTracker } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-rfd-subagents";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, type SubagentLifecyclePayload } from "@oh-my-pi/pi-coding-agent/task";

function lifecycle(
	status: SubagentLifecyclePayload["status"],
	extra: Partial<SubagentLifecyclePayload> = {},
): SubagentLifecyclePayload {
	return {
		id: "worker-1",
		agent: "task",
		agentSource: "bundled",
		description: "Do the thing",
		status,
		index: 0,
		...extra,
	};
}

function sentNotifications() {
	const sent: SessionNotification[] = [];
	return { sent, send: async (v: SessionNotification) => void sent.push(v) };
}

describe("rfd subagent tracker", () => {
	test("spawn emits announce then running state", async () => {
		const { sent, send } = sentNotifications();
		const tracker = new RfdSubagentTracker({ parentSessionId: "p", send });
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
		const { sent, send } = sentNotifications();
		const tracker = new RfdSubagentTracker({ parentSessionId: "p", send });
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
		const { sent, send } = sentNotifications();
		const tracker = new RfdSubagentTracker({ parentSessionId: "p", send });
		await tracker.handleLifecycle(lifecycle("started", { id: "a" }));
		await tracker.handleLifecycle(lifecycle("started", { id: "b" }));
		await tracker.handleLifecycle(lifecycle("aborted", { id: "a" }));
		await tracker.handleLifecycle(lifecycle("failed", { id: "b" }));
		const states = sent.map(e => (e.update as { state?: unknown }).state);
		expect(states).toEqual([
			undefined,
			{ state: "running" },
			undefined,
			{ state: "running" },
			{ state: "idle", stopReason: "cancelled" },
			{ state: "idle", stopReason: "error" },
		]);
	});

	test("parked clears state; revived re-emits running", async () => {
		const { sent, send } = sentNotifications();
		const tracker = new RfdSubagentTracker({ parentSessionId: "p", send });
		await tracker.handleLifecycle(lifecycle("started"));
		expect(sent).toHaveLength(2);
		tracker.handleRegistryStatus({ id: "worker-1", status: "parked" });
		tracker.handleRegistryStatus({ id: "worker-1", status: "running" });
		expect(sent.slice(2).map(e => e.update)).toEqual([
			{ sessionUpdate: "subagent_update", sessionId: "worker-1", state: null },
			{ sessionUpdate: "subagent_update", sessionId: "worker-1", state: { state: "running" } },
		]);
	});

	test("concurrent settle serializes after announce and running", async () => {
		const { sent, send } = sentNotifications();
		const gate = Promise.withResolvers<void>();
		let calls = 0;
		const tracker = new RfdSubagentTracker({
			parentSessionId: "p",
			send: async notification => {
				calls++;
				if (calls === 1) await gate.promise;
				return send(notification);
			},
		});
		const started = tracker.handleLifecycle(lifecycle("started", { id: "w" }));
		const settled = tracker.handleLifecycle(lifecycle("completed", { id: "w" }));
		gate.resolve();
		await Promise.all([started, settled]);
		expect(sent.map(entry => entry.update)).toEqual([
			{
				sessionUpdate: "subagent_update",
				sessionId: "w",
				title: "task",
				description: "Do the thing",
				capabilities: { cancel: {} },
			},
			{ sessionUpdate: "subagent_update", sessionId: "w", state: { state: "running" } },
			{
				sessionUpdate: "subagent_update",
				sessionId: "w",
				state: { state: "idle", stopReason: "end_turn" },
				capabilities: { cancel: null },
			},
		]);
	});

	test("revival after settle restores the cancel capability", async () => {
		const { sent, send } = sentNotifications();
		const tracker = new RfdSubagentTracker({ parentSessionId: "p", send });
		await tracker.handleLifecycle(lifecycle("started"));
		await tracker.handleLifecycle(lifecycle("completed"));
		tracker.handleRegistryStatus({ id: "worker-1", status: "parked" });
		tracker.handleRegistryStatus({ id: "worker-1", status: "running" });
		expect(sent.slice(-2).map(entry => entry.update)).toEqual([
			{ sessionUpdate: "subagent_update", sessionId: "worker-1", state: null },
			{
				sessionUpdate: "subagent_update",
				sessionId: "worker-1",
				state: { state: "running" },
				capabilities: { cancel: {} },
			},
		]);
	});

	test("nested children associate under their spawning child", async () => {
		const { sent, send } = sentNotifications();
		const tracker = new RfdSubagentTracker({
			parentSessionId: "root",
			send,
			resolveSpawner: id => (id === "grandchild" ? "child" : undefined),
		});
		await tracker.handleLifecycle(lifecycle("started", { id: "child" }));
		await tracker.handleLifecycle(lifecycle("started", { id: "grandchild" }));
		const outerIds = sent.map(entry => entry.sessionId);
		expect(outerIds).toEqual(["root", "root", "child", "child"]);
		expect(sent[2]?.update).toMatchObject({ sessionUpdate: "subagent_update", sessionId: "grandchild" });
		await tracker.handleLifecycle(lifecycle("completed", { id: "grandchild" }));
		expect(sent.at(-1)).toMatchObject({
			sessionId: "child",
			update: {
				sessionUpdate: "subagent_update",
				sessionId: "grandchild",
				state: { state: "idle", stopReason: "end_turn" },
				capabilities: { cancel: null },
			},
		});
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
