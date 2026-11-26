/**
 * Contracts: vibe worker usage aggregation and the in-flight-turn query that
 * goal continuation relies on in combined goal+vibe mode.
 *
 * 1. `hasInFlightTurns` reports running, starting, and queued worker work and
 *    stays false when every worker is idle with only a terminal job.
 * 2. `aggregateVibeWorkerUsage` sums record-level cumulative usage and keeps a
 *    killed (dead) worker's spend in the total, so a worker's disappearance
 *    cannot mask a live worker's new delta under per-field clamped deltas.
 * 3. `seedPersistedWorkerUsage` re-arms the baseline from persisted
 *    turn-settled events after a process restart, so a revived worker's first
 *    turn charges only new spend instead of replaying its whole transcript.
 */
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	aggregateVibeWorkerUsage,
	releaseVibeWorkerUsage,
	seedPersistedWorkerUsage,
	VibeSessionRegistry,
	type VibeParentSession,
	type VibeWorkerUsageTotals,
} from "@oh-my-pi/pi-coding-agent/vibe/runtime";

function usage(input: number, output = 0): VibeWorkerUsageTotals {
	return { input, output, cacheRead: 0, cacheWrite: 0 };
}

describe("vibe worker usage aggregation", () => {
	beforeEach(() => {
		VibeSessionRegistry.resetGlobalForTests();
	});

	afterEach(() => {
		VibeSessionRegistry.resetGlobalForTests();
	});

	it("hasInFlightTurns counts queued and pending worker work, not a finished turn", () => {
		const jobs = new Map<string, { status: string; queued?: boolean }>();
		const parent = {
			getSessionId: () => "test-parent-session",
			getSessionFile: () => null,
			settings: Settings.isolated({}),
			asyncJobManager: {
				getJob: (id: string) => jobs.get(id),
			},
		} as VibeParentSession;
		const registry = VibeSessionRegistry.global();
		expect(registry.hasInFlightTurns(parent)).toBe(false);

		registry.registerRecordForTests({ id: "w-idle", ownerId: MAIN_AGENT_ID, state: "idle" });
		expect(registry.hasInFlightTurns(parent)).toBe(false);

		// Follow-up text parked after the current turn was cleared is still work
		// the director handed off.
		const queued = registry.listWorkerRecordsByOwner(MAIN_AGENT_ID).find(record => record.id === "w-idle");
		queued?.queue.push("follow up");
		expect(registry.hasInFlightTurns(parent)).toBe(true);
		if (queued) queued.queue.length = 0;
		expect(registry.hasInFlightTurns(parent)).toBe(false);

		// A spawn that has not registered its turn yet is pending, not idle.
		registry.registerRecordForTests({ id: "w-starting", ownerId: MAIN_AGENT_ID, state: "starting" });
		expect(registry.hasInFlightTurns(parent)).toBe(true);

		VibeSessionRegistry.resetGlobalForTests();
		const settled = VibeSessionRegistry.global();
		settled.registerRecordForTests({ id: "w-job", ownerId: MAIN_AGENT_ID, state: "idle", jobId: "job-1" });
		jobs.set("job-1", { status: "completed" });
		expect(settled.hasInFlightTurns(parent)).toBe(false);
		// A job parked before it executes is not idle just because its status
		// is something other than `running`.
		jobs.set("job-1", { status: "pending", queued: true });
		expect(settled.hasInFlightTurns(parent)).toBe(true);
	});

	it("keeps a killed worker's spend in the aggregate", () => {
		const registry = VibeSessionRegistry.global();
		registry.registerRecordForTests({ id: "w-done", ownerId: MAIN_AGENT_ID, usage: usage(50, 5) });
		expect(aggregateVibeWorkerUsage(MAIN_AGENT_ID)).toEqual(usage(50, 5));

		// The director kills the finished worker; its record turns dead.
		const records = registry.listWorkerRecordsByOwner(MAIN_AGENT_ID);
		for (const record of records) {
			if (record.id === "w-done") record.state = "dead";
		}
		registry.registerRecordForTests({ id: "w-next", ownerId: MAIN_AGENT_ID, usage: usage(3) });
		// The dead worker's 50 input tokens must still be part of the total;
		// dropping them would clamp away w-next's 3 new tokens in a goal delta.
		expect(aggregateVibeWorkerUsage(MAIN_AGENT_ID)).toEqual(usage(53, 5));
	});

	it("releases an owner's worker spend so a later window cannot re-charge it", () => {
		const registry = VibeSessionRegistry.global();
		registry.registerRecordForTests({ id: "w-done", ownerId: MAIN_AGENT_ID, state: "dead", usage: usage(50, 5) });
		expect(aggregateVibeWorkerUsage(MAIN_AGENT_ID)).toEqual(usage(50, 5));

		releaseVibeWorkerUsage(MAIN_AGENT_ID);
		expect(aggregateVibeWorkerUsage(MAIN_AGENT_ID)).toEqual(usage(0));

		registry.registerRecordForTests({ id: "w-next", ownerId: MAIN_AGENT_ID, usage: usage(3) });
		// The dead worker's 50 is gone, so the new worker's 3 is the whole total
		// instead of being clamped away or stacked on already-flushed spend.
		expect(aggregateVibeWorkerUsage(MAIN_AGENT_ID)).toEqual(usage(3));
	});

	it("seeds restart baselines from persisted turn-settled usage", () => {
		seedPersistedWorkerUsage(MAIN_AGENT_ID, "w-1", usage(120, 30));
		// Simulate a revived worker whose first post-restart turn adds 10 more.
		VibeSessionRegistry.global().registerRecordForTests({
			id: "w-1",
			ownerId: MAIN_AGENT_ID,
			usage: usage(130, 30),
		});
		expect(aggregateVibeWorkerUsage(MAIN_AGENT_ID)).toEqual(usage(130, 30));
	});
});
