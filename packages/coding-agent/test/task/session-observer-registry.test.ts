/**
 * Frame-ordering contract of the observer registry the HUD, Agent Hub and tree
 * cost read: lifecycle and progress frames for one agent may arrive in any
 * order (progress is coalesced on a timer and heartbeats every 5 s, so a
 * flush can land after the terminal lifecycle frame), and none of those
 * orderings may leave a settled agent counted as active.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/task/session-observer-registry";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task/task-details";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function lifecycle(id: string, status: SubagentLifecyclePayload["status"]): SubagentLifecyclePayload {
	return { id, index: 0, agent: "task", agentSource: "bundled", description: `${id} work`, status };
}

function progress(id: string, status: AgentProgress["status"]): SubagentProgressPayload {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		task: `${id} work`,
		progress: {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			status,
			task: `${id} work`,
			recentTools: [],
			recentOutput: [],
			toolCount: 3,
			requests: 2,
			tokens: 100,
			cost: 0.25,
			durationMs: 10,
		},
	};
}

describe("SessionObserverRegistry frame ordering", () => {
	let bus: EventBus;
	let registry: SessionObserverRegistry;

	beforeEach(() => {
		bus = new EventBus();
		registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(bus, bus);
	});

	afterEach(() => {
		registry.dispose();
	});

	const emitLifecycle = (id: string, status: SubagentLifecyclePayload["status"]) =>
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle(id, status));
	const emitProgress = (id: string, status: AgentProgress["status"]) =>
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progress(id, status));

	it("tracks an agent whose progress arrives before its started frame, then settles it", () => {
		emitProgress("Early", "running");
		expect(registry.getSession("Early")?.status).toBe("active");
		emitLifecycle("Early", "started");
		emitLifecycle("Early", "completed");

		expect(registry.getSession("Early")?.status).toBe("completed");
		expect(registry.getActiveSubagentCount()).toBe(0);
	});

	it("never revives a settled agent from a straggler running progress frame", () => {
		emitLifecycle("Straggler", "started");
		emitProgress("Straggler", "running");
		emitProgress("Straggler", "completed");
		emitLifecycle("Straggler", "completed");
		const settledAt = registry.getSession("Straggler")?.lastUpdate;
		// A running snapshot that lost the race to the terminal frame.
		emitProgress("Straggler", "running");

		const session = registry.getSession("Straggler");
		expect(session?.status).toBe("completed");
		expect(session?.progress?.status).toBe("completed");
		expect(session?.lastUpdate).toBe(settledAt);
		expect(registry.getActiveSubagentCount()).toBe(0);
	});

	it("keeps a terminal snapshot's final totals without reopening the agent", () => {
		emitLifecycle("Totals", "started");
		emitLifecycle("Totals", "failed");
		emitProgress("Totals", "failed");

		const session = registry.getSession("Totals");
		expect(session?.status).toBe("failed");
		expect(session?.progress?.status).toBe("failed");
		expect(session?.progress?.toolCount).toBe(3);
	});

	it("creates an agent first seen through a settled snapshot as settled, not active", () => {
		// An observer that joined after the agent started (collab guest, session reset).
		emitProgress("LateJoin", "completed");

		expect(registry.getSession("LateJoin")?.status).toBe("completed");
		expect(registry.getActiveSubagentCount()).toBe(0);
	});

	it("reopens a settled agent only through its next turn's started frame", () => {
		emitLifecycle("KeptAlive", "started");
		emitLifecycle("KeptAlive", "completed");
		emitProgress("KeptAlive", "running");
		expect(registry.getSession("KeptAlive")?.status).toBe("completed");

		// Follow-up / IRC wake turn.
		emitLifecycle("KeptAlive", "started");
		emitProgress("KeptAlive", "running");
		expect(registry.getSession("KeptAlive")?.status).toBe("active");
		expect(registry.getActiveSubagentCount()).toBe(1);
	});

	it("counts a nested fan-out on the shared root bus, grandchildren included", () => {
		emitLifecycle("Anna", "started");
		emitLifecycle("Anna.Bob", "started");
		emitProgress("Anna.Bob.Cy", "running");
		emitLifecycle("Anna.Bob.Cy", "started");
		expect(registry.getActiveSubagentCount()).toBe(3);

		emitLifecycle("Anna.Bob.Cy", "completed");
		emitProgress("Anna.Bob.Cy", "running");
		emitLifecycle("Anna.Bob", "completed");
		expect(registry.getActiveSubagentCount()).toBe(1);
		expect(
			registry
				.getSessions()
				.filter(session => session.kind === "subagent")
				.map(session => [session.id, session.status]),
		).toEqual([
			["Anna", "active"],
			["Anna.Bob", "completed"],
			["Anna.Bob.Cy", "completed"],
		]);
	});
});
