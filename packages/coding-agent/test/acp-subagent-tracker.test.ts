import { describe, expect, test } from "bun:test";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	AcpSubagentTracker,
	declaresNativeSubagents,
	isAirClient,
	withSubagentMeta,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-subagent-tracker";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
} from "@oh-my-pi/pi-coding-agent/task";

function lifecycle(overrides: Partial<SubagentLifecyclePayload>): SubagentLifecyclePayload {
	return {
		id: "worker-1",
		agent: "task",
		agentSource: "bundled",
		description: "Implement the widget",
		status: "started",
		index: 0,
		...overrides,
	};
}

function progress(id: string): {
	index: number;
	agent: string;
	agentSource: "bundled";
	task: string;
	progress: AgentProgress;
} {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		progress: {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "Do work",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 1,
			tokens: 10,
			cost: 0,
			durationMs: 0,
		},
	};
}

function updateState(update: Record<string, unknown>): string | undefined {
	const state = update["state"];
	return typeof state === "string" ? state : undefined;
}

function airCapabilities() {
	return { _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } } };
}

describe("acp subagent tracker", () => {
	test("spawn emits subagent_spawned with the AIR-required fields", async () => {
		const sent: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
		const tracker = new AcpSubagentTracker({
			parentSessionId: "parent-1",
			send: async params => void sent.push(params),
		});
		await tracker.handleLifecycle(lifecycle({ id: "worker-1", parentToolCallId: "tc-1" }));
		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			sessionId: "parent-1",
			update: {
				sessionUpdate: "subagent_spawned",
				subagentSessionId: "worker-1",
				name: "task",
				task: "Implement the widget",
				capabilities: {},
			},
		});
	});

	test("duplicate spawn does not re-announce; terminal emits once and clears the child", async () => {
		const sent: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
		const tracker = new AcpSubagentTracker({
			parentSessionId: "parent-1",
			send: async params => void sent.push(params),
		});
		await tracker.handleLifecycle(lifecycle({ id: "worker-1" }));
		await tracker.handleLifecycle(lifecycle({ id: "worker-1" }));
		expect(sent).toHaveLength(1);
		await tracker.handleLifecycle(lifecycle({ id: "worker-1", status: "completed" }));
		expect(sent).toHaveLength(2);
		expect(sent[1]?.update).toMatchObject({
			sessionUpdate: "subagent_state_update",
			subagentSessionId: "worker-1",
			state: "completed",
		});
		await tracker.handleLifecycle(lifecycle({ id: "worker-1", status: "completed" }));
		expect(sent).toHaveLength(2);
		expect(tracker.children.has("worker-1")).toBe(false);
	});

	test("aborted maps to cancelled; failed stays failed; unknown ids are ignored", async () => {
		const sent: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
		const tracker = new AcpSubagentTracker({
			parentSessionId: "parent-1",
			send: async params => void sent.push(params),
		});
		await tracker.handleLifecycle(lifecycle({ id: "ghost", status: "completed" }));
		expect(sent).toHaveLength(0);
		await tracker.handleLifecycle(lifecycle({ id: "a", description: "A" }));
		await tracker.handleLifecycle(lifecycle({ id: "b", description: "B" }));
		await tracker.handleLifecycle(lifecycle({ id: "a", status: "aborted" }));
		await tracker.handleLifecycle(lifecycle({ id: "b", status: "failed" }));
		expect(sent.map(entry => updateState(entry.update))).toEqual([undefined, undefined, "cancelled", "failed"]);
	});

	test("falls back to name and task labels when payload fields are blank", async () => {
		const sent: Array<{ sessionId: string; update: Record<string, unknown> }> = [];
		const tracker = new AcpSubagentTracker({
			parentSessionId: "parent-1",
			send: async params => void sent.push(params),
		});
		await tracker.handleLifecycle(lifecycle({ id: "0123456789abcdef", agent: "  ", description: "   " }));
		expect(sent[0]?.update).toMatchObject({
			name: "Agent 89abcdef",
			task: "Delegated task for Agent 89abcdef",
		});
	});

	test("subscribe wires both subagent channels and dispose unwires them", () => {
		const tracker = new AcpSubagentTracker({ parentSessionId: "parent-1", send: async () => {} });
		const bus = new EventBus();
		tracker.subscribe(bus);
		expect(bus.hasListeners(TASK_SUBAGENT_LIFECYCLE_CHANNEL)).toBe(true);
		expect(bus.hasListeners(TASK_SUBAGENT_PROGRESS_CHANNEL)).toBe(true);
		tracker.dispose();
		expect(bus.hasListeners(TASK_SUBAGENT_LIFECYCLE_CHANNEL)).toBe(false);
		expect(bus.hasListeners(TASK_SUBAGENT_PROGRESS_CHANNEL)).toBe(false);
	});

	test("tool ownership follows parentToolCallId and clears on terminal", async () => {
		const tracker = new AcpSubagentTracker({ parentSessionId: "parent-1", send: async () => {} });
		expect(tracker.childForToolCall("tc-9")).toBeUndefined();
		await tracker.handleLifecycle(lifecycle({ id: "worker-9", parentToolCallId: "tc-9" }));
		expect(tracker.childForToolCall("tc-9")).toBe("worker-9");
		tracker.handleProgress(progress("worker-9"));
		expect(tracker.children.get("worker-9")?.progress?.toolCount).toBe(1);
		await tracker.handleLifecycle(lifecycle({ id: "worker-9", status: "completed" }));
		expect(tracker.childForToolCall("tc-9")).toBeUndefined();
		tracker.dispose();
	});

	test("AIR client detection requires the jetbrains.air object and declared capability", () => {
		expect(isAirClient(undefined)).toBe(false);
		expect(isAirClient({})).toBe(false);
		expect(isAirClient({ _meta: { jetbrains: { air: null } } })).toBe(false);
		expect(isAirClient(airCapabilities())).toBe(true);
		expect(declaresNativeSubagents({})).toBe(false);
		expect(declaresNativeSubagents({ _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } })).toBe(false);
		expect(declaresNativeSubagents(airCapabilities())).toBe(true);
	});

	test("withSubagentMeta preserves existing meta and sets the routing key", () => {
		const tagged = withSubagentMeta(
			{ sessionUpdate: "tool_call_update", toolCallId: "tc-1", _meta: { other: true } },
			"worker-1",
		);
		expect(tagged).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-1",
			_meta: { other: true, jetbrains: { air: { subagentSessionId: "worker-1" } } },
		});
	});
});
