/**
 * Accepted-final-result contract (#11079): once a run's final result is
 * accepted, the agent ref must reach a terminal status and the run lifecycle
 * milestones must be recorded. Milestones are run-scoped, so a ref reused by a
 * follow-up or wake turn never reports a previous run's acceptance.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** Minimal session: the registry only reads `isStreaming` for liveness corroboration. */
function sessionStub(isStreaming: boolean): AgentSession {
	return { isStreaming } as unknown as AgentSession;
}

describe("AgentRegistry final-result acceptance", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	function registerRunning(id: string, session: AgentSession | null) {
		return registry.register({ id, displayName: id, kind: "sub", session, status: "running" });
	}

	it("terminalizes a settled run and stamps response, acceptance, and terminal milestones", () => {
		const ref = registerRunning("PolicyCommand", sessionStub(false));
		const respondedAt = ref.createdAt + 5;

		expect(registry.markResultAccepted("PolicyCommand", ref, respondedAt)).toBe(true);

		const settled = registry.get("PolicyCommand");
		expect(settled?.status).toBe("idle");
		expect(settled?.lifecycle?.responseAt).toBe(respondedAt);
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeGreaterThanOrEqual(settled?.lifecycle?.acceptedAt ?? 0);
		expect(registry.staleAcceptedRuns()).toEqual([]);
	});

	it("does not report a follow-up turn that produced no accepted result", () => {
		const ref = registerRunning("PolicyCommand", sessionStub(false));
		expect(registry.markResultAccepted("PolicyCommand", ref, ref.createdAt)).toBe(true);

		// The next turn starts: run-scoped milestones rotate away.
		registry.setStatus("PolicyCommand", "running", ref);

		expect(registry.get("PolicyCommand")?.lifecycle).toBeUndefined();
		expect(registry.staleAcceptedRuns()).toEqual([]);
	});

	it("records the current run's response and acceptance when a ref is reused", () => {
		const ref = registerRunning("PolicyCommand", sessionStub(false));
		const firstResponseAt = ref.createdAt + 1;
		const secondResponseAt = ref.createdAt + 2;

		expect(registry.markResultAccepted("PolicyCommand", ref, firstResponseAt)).toBe(true);
		expect(registry.get("PolicyCommand")?.lifecycle?.responseAt).toBe(firstResponseAt);

		// Second turn on the same ref: the first run's milestones must not leak.
		registry.setStatus("PolicyCommand", "running", ref);
		expect(registry.markResultAccepted("PolicyCommand", ref, secondResponseAt)).toBe(true);

		const settled = registry.get("PolicyCommand");
		expect(settled?.status).toBe("idle");
		expect(settled?.lifecycle?.responseAt).toBe(secondResponseAt);
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	it("reports an accepted run whose turn never went idle", () => {
		let streaming = true;
		const session = {
			get isStreaming(): boolean {
				return streaming;
			},
		} as unknown as AgentSession;
		const ref = registerRunning("PolicyCommand", session);

		// Acceptance lands while a wake turn is still in flight: not terminal yet.
		expect(registry.markResultAccepted("PolicyCommand", ref, ref.createdAt)).toBe(true);
		expect(registry.get("PolicyCommand")?.status).toBe("running");
		expect(registry.staleAcceptedRuns()).toEqual([]);

		// The turn ends without the run-state mirror ever delivering `idle`.
		streaming = false;

		expect(registry.staleAcceptedRuns().map(stale => stale.id)).toEqual(["PolicyCommand"]);
		registry.setStatus("PolicyCommand", "idle", ref);
		expect(registry.staleAcceptedRuns()).toEqual([]);
	});

	it("ignores acceptance from a session the ref no longer owns", () => {
		const ref = registerRunning("PolicyCommand", sessionStub(false));

		expect(registry.markResultAccepted("PolicyCommand", sessionStub(false), ref.createdAt)).toBe(false);
		expect(registry.get("PolicyCommand")?.lifecycle?.acceptedAt).toBeUndefined();
		expect(registry.get("PolicyCommand")?.status).toBe("running");
	});
});
