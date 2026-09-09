import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { AgentRegistry } from "../src/registry/agent-registry";
import {
	createSubagentObservability,
	type SubagentEvent,
} from "../src/extensibility/extensions/subagent-observability";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "../src/task/types";
import { EventBus } from "../src/utils/event-bus";

function lifecycle(
	id: string,
	status: SubagentLifecyclePayload["status"],
	parentToolCallId: string,
	detached = false,
): SubagentLifecyclePayload {
	return {
		id,
		agent: "task",
		agentSource: "bundled",
		status,
		parentToolCallId,
		index: 0,
		detached,
	};
}

function createHarness() {
	let now = 1_000;
	const registry = new AgentRegistry();
	const bus = new EventBus();
	registry.register({ id: "Root", displayName: "root", kind: "main", session: null, createdAt: 10, lastActivity: 20 });
	const observer = createSubagentObservability({ registry, eventBus: bus, rootAgentId: "Root", now: () => ++now });
	return { registry, bus, observer };
}

describe("public subagent observability", () => {
	test("discovers v1 and snapshots stable nested identities in deterministic order", () => {
		const { registry, observer } = createHarness();
		registry.register({
			id: "Child",
			displayName: "child secret prompt",
			kind: "sub",
			parentId: "Root",
			session: null,
			createdAt: 30,
			lastActivity: 40,
		});
		registry.register({
			id: "Grandchild",
			displayName: "nested secret prompt",
			kind: "sub",
			parentId: "Child",
			session: null,
			createdAt: 50,
			lastActivity: 60,
		});
		registry.register({ id: "OtherRoot", displayName: "other", kind: "main", session: null });

		const snapshot = observer.getSnapshot();
		expect(observer.version).toBe(1);
		expect(snapshot.agents.map(agent => agent.agentId)).toEqual(["Root", "Child", "Grandchild"]);
		expect(snapshot.agents[2]).toMatchObject({
			agentId: "Grandchild",
			rootAgentId: "Root",
			parentAgentId: "Child",
			kind: "task",
		});
		expect(JSON.stringify(snapshot)).not.toContain("secret prompt");
	});

	test("correlates direct and eval launches and projects only allowlisted progress", () => {
		const { registry, bus, observer } = createHarness();
		registry.register({ id: "Direct", displayName: "direct", kind: "sub", parentId: "Root", session: null });
		registry.register({ id: "Eval", displayName: "eval", kind: "sub", parentId: "Root", session: null });
		const events: SubagentEvent[] = [];
		observer.subscribe(event => events.push(event));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("Direct", "started", "task-call-1", true));
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("Eval", "started", "eval-call-2"));
		const progress: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "TOP SECRET prompt",
			assignment: "SECRET assignment",
			parentToolCallId: "eval-call-2",
			sessionFile: "/Users/person/.omp/secret.jsonl",
			progress: {
				index: 0,
				id: "Eval",
				agent: "task",
				agentSource: "bundled",
				status: "running",
				task: "TOP SECRET prompt",
				lastIntent: "exfiltrate SECRET",
				currentTool: "read",
				currentToolArgs: "PASSWORD=SECRET",
				recentTools: [{ tool: "bash", args: "token=SECRET", endMs: 1 }],
				recentOutput: ["SECRET output"],
				toolCount: 3,
				requests: 2,
				tokens: 99,
				contextTokens: 44,
				cost: 0.25,
				durationMs: 10,
				resolvedModelIdentity: "openai/gpt-5.6",
				resolvedThinkingLevel: ThinkingLevel.High,
			},
		};
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress);

		const snapshot = observer.getSnapshot();
		expect(snapshot.agents.find(agent => agent.agentId === "Direct")).toMatchObject({
			parentToolCallId: "task-call-1",
			detached: true,
		});
		expect(snapshot.agents.find(agent => agent.agentId === "Eval")).toMatchObject({
			parentToolCallId: "eval-call-2",
			progress: {
				currentTool: "read",
				toolCount: 3,
				tokens: 99,
				contextTokens: 44,
				costUsd: 0.25,
				resolvedModel: "openai/gpt-5.6",
				effort: "high",
			},
		});
		const serialized = JSON.stringify({ events, snapshot });
		for (const forbidden of ["TOP SECRET", "SECRET assignment", "PASSWORD", "SECRET output", "/Users/person"]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	test("reports an explicitly registered eval invocation as eval in its event and snapshot", () => {
		const { registry, observer } = createHarness();
		const events: SubagentEvent[] = [];
		observer.subscribe(event => events.push(event));

		registry.register({
			id: "Eval",
			displayName: "eval",
			kind: "sub",
			parentId: "Root",
			session: null,
			invocationKind: "eval",
		});

		const registered = events.find(event => event.type === "registered");
		expect(registered?.type === "registered" ? registered.agent.kind : undefined).toBe("eval");
		expect(observer.getSnapshot().agents.find(agent => agent.agentId === "Eval")?.kind).toBe("eval");
	});

	test("emits ordered register, park, revive, cancel, terminal, and remove events", () => {
		const { registry, bus, observer } = createHarness();
		const events: SubagentEvent[] = [];
		observer.subscribe(event => events.push(event));
		registry.register({ id: "Worker", displayName: "worker", kind: "sub", parentId: "Root", session: null });
		registry.setStatus("Worker", "parked");
		registry.setStatus("Worker", "running");
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("Worker", "aborted", "task-call"));
		registry.setStatus("Worker", "aborted");
		registry.unregister("Worker");

		expect(events.map(event => event.type)).toEqual(["registered", "lifecycle", "lifecycle", "lifecycle", "removed"]);
		expect(events.map(event => event.revision)).toEqual([1, 2, 3, 4, 5]);
		expect(events.filter(event => event.type === "lifecycle").map(event => event.to)).toEqual([
			"parked",
			"running",
			"aborted",
		]);
	});

	test("subscribe then snapshot closes races and unsubscribe is idempotent", () => {
		const { registry, observer } = createHarness();
		const events: SubagentEvent[] = [];
		const unsubscribe = observer.subscribe(event => events.push(event));
		registry.register({ id: "BeforeSnapshot", displayName: "one", kind: "sub", parentId: "Root", session: null });
		const snapshot = observer.getSnapshot();
		registry.register({ id: "AfterSnapshot", displayName: "two", kind: "sub", parentId: "Root", session: null });
		const after = events.filter(event => event.revision > snapshot.revision);
		expect(after.map(event => event.agentId)).toEqual(["AfterSnapshot"]);
		unsubscribe();
		unsubscribe();
		registry.register({ id: "Ignored", displayName: "ignored", kind: "sub", parentId: "Root", session: null });
		expect(events.at(-1)?.agentId).toBe("AfterSnapshot");
	});

	test("bounds snapshots while retaining the root correlation record", () => {
		const { registry, observer } = createHarness();
		for (let index = 0; index < 520; index++) {
			registry.register({
				id: `Worker-${index.toString().padStart(3, "0")}`,
				displayName: "worker",
				kind: "sub",
				parentId: "Root",
				session: null,
				createdAt: 100 + index,
			});
		}
		const snapshot = observer.getSnapshot();
		expect(snapshot.agents).toHaveLength(512);
		expect(snapshot.agents[0]?.agentId).toBe("Root");
		expect(snapshot.agents.at(-1)?.agentId).toBe("Worker-519");
	});

	test("isolates throwing listeners, returns immutable copies, and disposes upstream subscriptions", () => {
		const { registry, observer } = createHarness();
		let calls = 0;
		let secondListenerAgentId: string | undefined;
		observer.subscribe(() => {
			throw new Error("listener failure");
		});
		observer.subscribe(event => {
			if (event.type === "registered") {
				(event.agent as { agentId: string }).agentId = "listener mutation";
			}
		});
		observer.subscribe(event => {
			calls++;
			secondListenerAgentId = event.type === "removed" ? event.agentId : event.agent.agentId;
		});
		registry.register({ id: "Worker", displayName: "worker", kind: "sub", parentId: "Root", session: null });
		expect(calls).toBe(1);
		expect(secondListenerAgentId).toBe("Worker");

		const snapshot = observer.getSnapshot();
		(snapshot.agents as unknown as Array<{ agentId: string }>)[0]!.agentId = "mutated";
		expect(observer.getSnapshot().agents[0]?.agentId).toBe("Root");

		observer.dispose();
		registry.register({ id: "AfterDispose", displayName: "ignored", kind: "sub", parentId: "Root", session: null });
		expect(calls).toBe(1);
	});
});
