import { describe, expect, test } from "bun:test";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	isStandardSubagentClient,
	RfdSubagentTracker,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-rfd-subagents";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";

function lifecycle(status: string, extra: Record<string, unknown> = {}) {
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
		const states = sent.map(e => (e.update as { state?: { state?: string; stopReason?: string } }).state);
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
