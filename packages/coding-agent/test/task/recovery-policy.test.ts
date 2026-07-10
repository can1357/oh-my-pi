import { describe, expect, test } from "bun:test";
import type { SpawnRouteCandidate } from "../../src/task/spawn-plan";
import {
	classifyRecoveryFailure,
	nextRecoveryAttempt,
	toFusionRecoveryRetryInput,
	type RecoveryAttempt,
	type RecoveryPolicyInput,
} from "../../src/task/recovery-policy";

function candidate(
	selector: string,
	tier: SpawnRouteCandidate["tier"],
	provider?: string,
): SpawnRouteCandidate {
	return {
		selector,
		tier,
		provider,
		maxRequests: 8,
		maxRuntimeMs: 60_000,
	};
}

function baseInput(overrides: Partial<RecoveryPolicyInput> = {}): RecoveryPolicyInput {
	return {
		workClass: "mechanical",
		eligible: [
			candidate("openai/light-a", "light", "openai"),
			candidate("anthropic/light-b", "light", "anthropic"),
			candidate("openai/mid-a", "mid", "openai"),
			candidate("anthropic/frontier-a", "frontier", "anthropic"),
		],
		previousAttempts: [],
		suppressedProviders: [],
		outcome: {
			terminal: true,
			failedChildId: "child-1",
			failure: {
				class: "acceptance",
				message: "Verifier rejected placeholder evidence",
				validatorReasons: ['Evidence summary for "review" is placeholder-only'],
			},
		},
		requestFallbackRemaining: false,
		contract: {
			id: "assign-1",
			revision: 1,
			digest: "abc123",
		},
		verifiedArtifactRefs: ["artifact://patch-1"],
		...overrides,
	};
}

describe("nextRecoveryAttempt", () => {
	test("does not start while existing request fallback remains available", () => {
		const decision = nextRecoveryAttempt(
			baseInput({ requestFallbackRemaining: true }),
		);
		expect(decision.action).toBe("stop");
		if (decision.action === "stop") {
			expect(decision.reasonCode).toBe("request_fallback_remaining");
		}
	});

	test("requires a typed terminal outcome before recovery", () => {
		const decision = nextRecoveryAttempt(
			baseInput({
				outcome: {
					terminal: false,
					failedChildId: "child-1",
				},
			}),
		);
		expect(decision.action).toBe("stop");
		if (decision.action === "stop") {
			expect(decision.reasonCode).toBe("terminal_outcome_required");
		}
	});

	test("mechanical ladder: light A → distinct light provider B → mid → frontier", () => {
		const attempts: RecoveryAttempt[] = [];
		let suppressed: readonly string[] = [];

		const first = nextRecoveryAttempt(
			baseInput({ previousAttempts: attempts, suppressedProviders: suppressed }),
		);
		expect(first.action).toBe("retry");
		if (first.action !== "retry") throw new Error("expected retry");
		expect(first.attempt.tier).toBe("light");
		expect(first.attempt.freshChild).toBe(true);
		expect(first.capsule.historyRef).toBe("history://child-1");
		expect(first.attempt.budgets).toEqual({ maxRequests: 8, maxRuntimeMs: 60_000 });
		attempts.push(first.attempt);
		suppressed = first.suppressedProviders;

		const second = nextRecoveryAttempt(
			baseInput({ previousAttempts: attempts, suppressedProviders: suppressed }),
		);
		expect(second.action).toBe("retry");
		if (second.action !== "retry") throw new Error("expected retry");
		expect(second.attempt.tier).toBe("light");
		expect(second.attempt.provider).not.toBe(first.attempt.provider);
		attempts.push(second.attempt);

		const third = nextRecoveryAttempt(
			baseInput({ previousAttempts: attempts, suppressedProviders: suppressed }),
		);
		expect(third.action).toBe("retry");
		if (third.action !== "retry") throw new Error("expected retry");
		expect(third.attempt.tier).toBe("mid");
		attempts.push(third.attempt);

		const fourth = nextRecoveryAttempt(
			baseInput({ previousAttempts: attempts, suppressedProviders: suppressed }),
		);
		expect(fourth.action).toBe("retry");
		if (fourth.action !== "retry") throw new Error("expected retry");
		expect(fourth.attempt.tier).toBe("frontier");
		attempts.push(fourth.attempt);
		const exhausted = nextRecoveryAttempt(
			baseInput({ previousAttempts: attempts, suppressedProviders: suppressed }),
		);
		expect(exhausted.action).toBe("stop");
		if (exhausted.action === "stop") {
			expect(exhausted.reasonCode).toBe("recovery_exhausted");
		}
	});

	test("judgment ladder never selects light", () => {
		const decision = nextRecoveryAttempt(
			baseInput({
				workClass: "judgment",
				eligible: [
					candidate("openai/light-a", "light", "openai"),
					candidate("openai/mid-a", "mid", "openai"),
					candidate("anthropic/frontier-a", "frontier", "anthropic"),
				],
			}),
		);
		expect(decision.action).toBe("retry");
		if (decision.action !== "retry") throw new Error("expected retry");
		expect(decision.attempt.tier).toBe("mid");
		expect(decision.attempt.tier).not.toBe("light");

		const second = nextRecoveryAttempt(
			baseInput({
				workClass: "judgment",
				previousAttempts: [decision.attempt],
				eligible: [
					candidate("openai/light-a", "light", "openai"),
					candidate("openai/mid-a", "mid", "openai"),
					candidate("anthropic/frontier-a", "frontier", "anthropic"),
				],
			}),
		);
		expect(second.action).toBe("retry");
		if (second.action !== "retry") throw new Error("expected retry");
		expect(second.attempt.tier).toBe("frontier");
	});

	test("TLS/provider failure suppresses that endpoint and chooses a distinct candidate", () => {
		const decision = nextRecoveryAttempt(
			baseInput({
				outcome: {
					terminal: true,
					failedChildId: "child-1",
					failure: {
						class: "spawn_transport",
						message: "TLS handshake failed talking to openai",
						failedProvider: "openai",
					},
				},
			}),
		);
		expect(decision.action).toBe("retry");
		if (decision.action !== "retry") throw new Error("expected retry");
		expect(decision.suppressedProviders).toContain("openai");
		expect(decision.attempt.provider?.toLowerCase()).not.toBe("openai");
		expect(decision.attempt.selector).toBe("anthropic/light-b");
	});

	test("TLS failure without failedProvider still suppresses the presumed first endpoint", () => {
		const decision = nextRecoveryAttempt(
			baseInput({
				outcome: {
					terminal: true,
					failedChildId: "child-tls-unknown",
					failure: {
						class: "spawn_transport",
						message: "TLS handshake failed talking to upstream",
					},
				},
				previousAttempts: [],
			}),
		);
		expect(decision.action).toBe("retry");
		if (decision.action !== "retry") throw new Error("expected retry");
		expect(decision.suppressedProviders).toEqual(["openai"]);
		expect(decision.attempt.selector).toBe("anthropic/light-b");
		expect(decision.attempt.provider?.toLowerCase()).not.toBe("openai");
	});

	test("TLS-like failure text suppresses provider even when the initial class is different", () => {
		const decision = nextRecoveryAttempt(
			baseInput({
				outcome: {
					terminal: true,
					failedChildId: "child-tls",
					failure: {
						class: "liveness",
						message: "SSL certificate handshake rejected",
						failedProvider: "OpenAI",
					},
				},
			}),
		);
		expect(decision.action).toBe("retry");
		if (decision.action !== "retry") throw new Error("expected retry");
		expect(decision.suppressedProviders).toEqual(["openai"]);
		expect(decision.attempt.provider).toBe("anthropic");
	});

	test("timeout beats a late yield when classifying recovery failure", () => {
		expect(
			classifyRecoveryFailure({
				class: "acceptance",
				message: "Late yield arrived after wall clock",
				timedOut: true,
				lateYield: true,
			}),
		).toBe("timeout");

		const decision = nextRecoveryAttempt(
			baseInput({
				outcome: {
					terminal: true,
					failedChildId: "child-1",
					failure: {
						class: "acceptance",
						message: "Late yield arrived after wall clock",
						timedOut: true,
						lateYield: true,
					},
				},
			}),
		);
		expect(decision.action).toBe("retry");
		if (decision.action !== "retry") throw new Error("expected retry");
		expect(decision.capsule.failureClass).toBe("timeout");
		expect(decision.capsule.historyRef).toBe("history://child-1");
		expect(JSON.stringify(decision.capsule)).not.toContain("transcript");
	});

	test("Fusion retry input stays generic and transcript-free", () => {
		const decision = nextRecoveryAttempt(baseInput());
		expect(decision.action).toBe("retry");
		if (decision.action !== "retry") throw new Error("expected retry");
		const fusion = toFusionRecoveryRetryInput(decision);
		expect(fusion.attempt.freshChild).toBe(true);
		expect(fusion.capsule.artifactRefs).toEqual(["artifact://patch-1"]);
		expect(fusion.capsule.historyRef.startsWith("history://")).toBe(true);
	});

	test("capsule carries only refs and failure facts", () => {
		const input = baseInput({
			profileSnapshotRefs: ["artifact://profile-1", "artifact://profile-1"],
			verifiedArtifactRefs: ["artifact://evidence-1"],
			verifiedPatchRefs: ["artifact://patch-1"],
		});
		const decision = nextRecoveryAttempt(input);
		expect(decision.action).toBe("retry");
		if (decision.action !== "retry") throw new Error("expected retry");
		expect(decision.capsule.profileSnapshotRefs).toEqual(["artifact://profile-1"]);
		expect(decision.capsule.artifactRefs).toEqual(["artifact://evidence-1"]);
		expect(decision.capsule.patchRefs).toEqual(["artifact://patch-1"]);
		expect(decision.capsule.failureMessage).toContain("placeholder evidence");
		expect(Object.keys(decision.capsule).sort()).toEqual(
			[
				"artifactRefs",
				"contractId",
				"digest",
				"revision",
				"failureClass",
				"failureMessage",
				"historyRef",
				"patchRefs",
				"profileSnapshotRefs",
				"validatorReasons",
			].sort(),
		);
		expect(Object.isFrozen(decision.capsule)).toBe(true);
	});
});
