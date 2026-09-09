/**
 * Contracts: vibe worker tok/s aggregation.
 *
 * 1. Returns null when the owner has no vibe worker sessions.
 * 2. Sums the tok/s of every live worker the owner has registered, reading
 *    each worker's last assistant message through the same calculator the
 *    main status line uses.
 * 3. Returns null when workers exist but none are streaming (no live rate to
 *    aggregate) — so the caller's own rate shines through unchanged.
 * 4. Skips workers whose AgentRegistry session is detached (parked/reviving),
 *    so a stale roster entry can't contribute a phantom zero.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { aggregateVibeWorkerTokensPerSecond, VibeSessionRegistry } from "../../src/vibe/runtime";

const OWNER = "test-owner";

/** Minimal fake AgentSession: just the messages + isStreaming the aggregator reads. */
function fakeSession(messages: unknown[], isStreaming: boolean): AgentSession {
	return { state: { messages }, isStreaming } as unknown as AgentSession;
}

/** A finalized assistant message with a known duration → deterministic tok/s. */
function assistantMessage(output: number, durationMs: number, timestamp = 1000) {
	return { role: "assistant", timestamp, duration: durationMs, usage: { output } };
}

function registerWorker(id: string, session: AgentSession | null, ownerId = OWNER) {
	VibeSessionRegistry.global().registerRecordForTests({ id, ownerId });
	if (session) {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			status: "running",
		});
	}
}

describe("aggregateVibeWorkerTokensPerSecond", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
	});

	it("returns null when the owner has no worker sessions", () => {
		expect(aggregateVibeWorkerTokensPerSecond(OWNER)).toBeNull();
	});

	it("sums tok/s across every live streaming worker", () => {
		// 100 tokens in 1000ms → 100 tok/s.
		registerWorker("w1", fakeSession([assistantMessage(100, 1000)], true));
		// 50 tokens in 500ms → 100 tok/s.
		registerWorker("w2", fakeSession([assistantMessage(50, 500)], true));
		expect(aggregateVibeWorkerTokensPerSecond(OWNER)).toBe(200);
	});

	it("returns null when workers exist but none have a live rate", () => {
		// Not streaming, no duration → calculateTokensPerSecond returns null.
		registerWorker("w1", fakeSession([assistantMessage(100, 0)], false));
		expect(aggregateVibeWorkerTokensPerSecond(OWNER)).toBeNull();
	});

	it("ignores idle workers whose last turn finished — a finalized duration must not contribute a stale rate", () => {
		// Finalized message (duration set) but the worker is no longer
		// streaming: its completed tok/s must not stick to the badge forever.
		registerWorker("w1", fakeSession([assistantMessage(100, 1000)], false));
		expect(aggregateVibeWorkerTokensPerSecond(OWNER)).toBeNull();
	});

	it("streaming workers still count while an idle sibling is skipped", () => {
		registerWorker("w1", fakeSession([assistantMessage(100, 1000)], true));
		registerWorker("w2", fakeSession([assistantMessage(50, 500)], false));
		expect(aggregateVibeWorkerTokensPerSecond(OWNER)).toBe(100);
	});

	it("ignores workers whose AgentRegistry session is detached", () => {
		registerWorker("w1", fakeSession([assistantMessage(100, 1000)], true));
		// w2 is in the vibe roster but has no live AgentRegistry session.
		registerWorker("w2", null);
		expect(aggregateVibeWorkerTokensPerSecond(OWNER)).toBe(100);
	});

	it("scopes to the requesting owner — other owners' workers don't count", () => {
		registerWorker("w1", fakeSession([assistantMessage(100, 1000)], true), OWNER);
		registerWorker("w2", fakeSession([assistantMessage(50, 500)], true), "other-owner");
		expect(aggregateVibeWorkerTokensPerSecond(OWNER)).toBe(100);
	});

	it("returns null for the main-agent owner id when no workers are registered", () => {
		expect(aggregateVibeWorkerTokensPerSecond(MAIN_AGENT_ID)).toBeNull();
	});
});
