/**
 * The advisor runs with the PRIMARY agent idle -- the default
 * `advisor.syncBacklog: "off"` lets a terminal turn's review outlive it -- so a
 * caller asking whether the session is quiescent cannot observe an active
 * review through the primary agent at all. `AgentSession`'s restart quiescence
 * predicate reads `reviewInFlight` for exactly that reason: `beginDispose()`
 * aborts the request and clears its pending deltas, and the replacement never
 * replays the terminal turn, so an accepted review and its note are lost.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

import { type AdvisorAgent, AdvisorRuntime, type AdvisorRuntimeHost } from "../../src/advisor/runtime";

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp } as AgentMessage;
}

describe("AdvisorRuntime.reviewInFlight", () => {
	it("reports a review that outlives the primary turn, and clears once it settles", async () => {
		const gate = Promise.withResolvers<void>();
		const agent: AdvisorAgent = {
			prompt: async () => {
				await gate.promise;
			},
			abort: () => {},
			reset: () => {},
			state: { messages: [] },
		};
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => [userMessage("turn one", 1)],
		};
		const runtime = new AdvisorRuntime(agent, host);

		expect(runtime.reviewInFlight).toBe(false);

		// The terminal turn ends; the review starts and keeps running.
		runtime.onTurnEnd();
		await Bun.sleep(0);

		// RED (pre-fix): nothing exposed this, so the restart quiescence check saw
		// an idle session and recycled over the running request.
		expect(runtime.reviewInFlight).toBe(true);

		gate.resolve();
		expect(await runtime.waitForCatchup(1_000, 1)).toBe(true);

		// A wait, not a ban: the refusal has to lift once the review settles.
		expect(runtime.reviewInFlight).toBe(false);
	});

	// A usage-limit hit sets #quotaExhausted, requeues the failed batch, and
	// leaves #backlog > 0 with further drains disabled until reset(). The naive
	// `#promptInFlight || #backlog > 0` predicate therefore stays true FOREVER,
	// and the restart quiescence gate refuses the very recycle that would rebuild
	// or reset the advisor — a permanent deadlock. A quota-frozen backlog is not
	// active review work: no request will ever be made for it without a reset.
	//
	// RED (pre-fix): reviewInFlight stays true after the quota pause, so a
	// restart is refused as busy forever.
	it("clears reviewInFlight once a quota-exhausted backlog freezes, but not while a review is genuinely active", async () => {
		const gate = Promise.withResolvers<void>();
		const promptStarted = Promise.withResolvers<void>();
		let shouldFail = false;
		const agent: AdvisorAgent = {
			prompt: async () => {
				promptStarted.resolve();
				if (shouldFail) throw new Error("insufficient_quota: rate limit exceeded");
				await gate.promise;
			},
			abort: () => {},
			reset: () => {},
			state: { messages: [] },
		};
		const quotaPaused = Promise.withResolvers<void>();
		const messages: AgentMessage[] = [userMessage("turn one", 1)];
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => messages.slice(),
			notifyQuotaExhausted: () => quotaPaused.resolve(),
		};
		const runtime = new AdvisorRuntime(agent, host, 0);

		// A genuinely active review still blocks: the request is in flight and
		// nothing is quota-paused, so the restart gate must refuse.
		runtime.onTurnEnd();
		await promptStarted.promise;
		expect(runtime.reviewInFlight).toBe(true);
		expect(runtime.quotaExhausted).toBe(false);

		// Let this review settle, then push a NEW turn that hits the usage limit.
		// A fresh message makes onTurnEnd render a non-empty delta and drain.
		gate.resolve();
		expect(await runtime.waitForCatchup(1_000, 1)).toBe(true);
		expect(runtime.reviewInFlight).toBe(false);

		shouldFail = true;
		messages.push(userMessage("turn two", 2));
		runtime.onTurnEnd();
		// Event-gated on the quota notification the drain fires, not a duration.
		await quotaPaused.promise;

		// The batch stays queued so reset() can replay it, so backlog is nonzero
		// even though no request will ever be made for it until a reset.
		expect(runtime.quotaExhausted).toBe(true);
		expect(runtime.backlog).toBeGreaterThan(0);

		// The frozen backlog must NOT read as an active review: otherwise the
		// restart that resets the advisor is refused forever.
		expect(runtime.reviewInFlight).toBe(false);
	});
});
