import { describe, expect, it } from "bun:test";
import {
	type EventBusLike,
	SessionObserverRegistry,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";

class TestBus implements EventBusLike {
	#listeners = new Map<string, Set<(data: unknown) => void>>();

	on(channel: string, listener: (data: unknown) => void): () => void {
		let set = this.#listeners.get(channel);
		if (!set) {
			set = new Set();
			this.#listeners.set(channel, set);
		}
		set.add(listener);
		return () => set.delete(listener);
	}

	emit(channel: string, data: unknown): void {
		for (const listener of this.#listeners.get(channel) ?? []) listener(data);
	}
}

function progress(fields: Partial<AgentProgress>): AgentProgress {
	return {
		index: 0,
		id: "Worker",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...fields,
	};
}

function lifecycle(status: "started" | "completed") {
	return { id: "Worker", agent: "task", agentSource: "bundled", status, index: 0 };
}

function runTurn(bus: TestBus, fields: Partial<AgentProgress>): void {
	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("started"));
	bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		task: "",
		progress: progress(fields),
	});
	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("completed"));
}

describe("SessionObserverRegistry", () => {
	it("keeps an agent's usage from earlier runs when a follow-up turn starts a fresh monitor", () => {
		const bus = new TestBus();
		const observers = new SessionObserverRegistry();
		observers.subscribeToEventBus(bus, new TestBus());

		runTurn(bus, { cost: 0.5, tokens: 1000, requests: 4, toolCount: 3, durationMs: 60_000, contextTokens: 9000 });
		// The follow-up turn's executor monitor restarts its counters at zero.
		bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle("started"));
		bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "",
			progress: progress({
				cost: 0.25,
				tokens: 200,
				requests: 1,
				toolCount: 2,
				durationMs: 5_000,
				contextTokens: 9500,
			}),
		});

		const observed = observers.getSession("Worker")?.progress;
		expect(observed).toMatchObject({ cost: 0.75, tokens: 1200, requests: 5, toolCount: 5, durationMs: 65_000 });
		// Context occupancy is a point-in-time reading, not a per-run counter.
		expect(observed?.contextTokens).toBe(9500);
	});
});
