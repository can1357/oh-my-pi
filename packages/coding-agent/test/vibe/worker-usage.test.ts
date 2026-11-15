/**
 * Contracts: vibe worker usage aggregation and the in-flight-turn query that
 * goal continuation relies on in combined goal+vibe mode.
 *
 * 1. `hasInFlightTurns` reports workers with a running/unknown turn job and
 *    stays false when every worker is idle.
 * 2. `aggregateVibeWorkerUsage` sums live worker sessions' assistant usage and
 *    is monotonic across park/revive: a worker whose live session disappears
 *    keeps its recorded spend, and a revived transcript does not double-count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { MAIN_AGENT_ID, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { aggregateVibeWorkerUsage, VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

const TEST_PARENT_ID = "test-parent-session";

function fakeParentSession() {
	return {
		getSessionId: () => TEST_PARENT_ID,
		getSessionFile: () => null,
		settings: Settings.isolated({}),
	};
}

/** Test fixture: aggregateVibeWorkerUsage reads only `role` and `usage`. */
function usageMessage(input: number, output = 0): AgentMessage {
	return { role: "assistant", usage: { input, output, cacheRead: 0, cacheWrite: 0 } } as unknown as AgentMessage;
}

describe("vibe worker usage aggregation", () => {
	beforeEach(() => {
		VibeSessionRegistry.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
	});

	it("hasInFlightTurns is true only while a worker turn runs", () => {
		const registry = VibeSessionRegistry.global();
		expect(registry.hasInFlightTurns(fakeParentSession())).toBe(false);

		registry.registerRecordForTests({ id: "w-idle", ownerId: MAIN_AGENT_ID });
		expect(registry.hasInFlightTurns(fakeParentSession())).toBe(false);

		registry.registerRecordForTests({ id: "w-busy", ownerId: MAIN_AGENT_ID, jobId: "job-1" });
		expect(registry.hasInFlightTurns(fakeParentSession())).toBe(true);
	});

	it("sums live worker usage and stays monotonic across park and revive", () => {
		const registry = VibeSessionRegistry.global();
		registry.registerRecordForTests({ id: "w-1", ownerId: MAIN_AGENT_ID });

		let messages: AgentMessage[] = [usageMessage(10, 4)];
		const agentRef = { kind: "sub", parentId: MAIN_AGENT_ID, session: { messages } } as never;
		const get = vi.spyOn(AgentRegistry.global(), "get").mockReturnValue(agentRef);

		let totals = aggregateVibeWorkerUsage(MAIN_AGENT_ID);
		expect(totals).toEqual({ input: 10, output: 4, cacheRead: 0, cacheWrite: 0 });

		// New spend visible through the live session.
		messages.push(usageMessage(5, 1));
		totals = aggregateVibeWorkerUsage(MAIN_AGENT_ID);
		expect(totals).toEqual({ input: 15, output: 5, cacheRead: 0, cacheWrite: 0 });

		// Parked worker: live session gone from the registry — spend must persist.
		get.mockReturnValue(undefined);
		expect(aggregateVibeWorkerUsage(MAIN_AGENT_ID)).toEqual({
			input: 15,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
		});

		// Revived with a fresh session object replaying the same transcript: no
		// double count, and new spend keeps accumulating from the high-water mark.
		messages = [usageMessage(15, 5), usageMessage(2)];
		const revivedRef = { kind: "sub", parentId: MAIN_AGENT_ID, session: { messages } } as never;
		get.mockReturnValue(revivedRef);
		expect(aggregateVibeWorkerUsage(MAIN_AGENT_ID)).toEqual({
			input: 17,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
});
