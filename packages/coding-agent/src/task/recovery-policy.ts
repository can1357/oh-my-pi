/**
 * Pure terminal assignment-recovery policy.
 *
 * This is deliberately outside inference/request retry handling. It can plan
 * a fresh child only after the existing request-level fallback chain has no
 * candidate remaining and the failed child has a typed terminal outcome.
 */

import type { AgentTier, WorkClass } from "../orchestration/agent-execution-profile";
import type { SpawnRouteCandidate } from "./spawn-plan";

export type AssignmentFailureClass =
	| "spawn_config"
	| "spawn_transport"
	| "budget"
	| "timeout"
	| "acceptance"
	| "liveness"
	| "tool_discipline";

export interface RecoveryBudgets {
	readonly maxRequests: number;
	readonly maxRuntimeMs: number;
}

export interface RecoveryAttempt {
	readonly attempt: number;
	readonly selector: string;
	readonly tier: AgentTier;
	readonly provider?: string;
	readonly modelId?: string;
	readonly budgets: RecoveryBudgets;
	/** Compatibility fields for direct SpawnRouteCandidate adaptation. */
	readonly maxRequests: number;
	readonly maxRuntimeMs: number;
	/** A terminal retry never resumes or wakes the failed child. */
	readonly freshChild: true;
}

export interface RecoveryCapsule {
	readonly contractId: string;
	readonly contractRevision: number;
	readonly contractDigest: string;
	readonly failureClass: AssignmentFailureClass;
	readonly failureMessage: string;
	readonly validatorReasons: readonly string[];
	readonly profileSnapshotRefs: readonly string[];
	readonly artifactRefs: readonly string[];
	readonly patchRefs: readonly string[];
	/** Reference only. Failed transcript bodies are never copied into capsules. */
	readonly historyRef: `history://${string}`;
}

export interface RecoveryFailureFacts {
	readonly class: AssignmentFailureClass;
	readonly message: string;
	readonly validatorReasons?: readonly string[];
	/** Wall-clock/runtime timeout observed for the failed attempt. */
	readonly timedOut?: boolean;
	/** A yield observed only after timeout settlement. */
	readonly lateYield?: boolean;
	/** Provider or endpoint identity associated with the terminal failure. */
	readonly failedProvider?: string;
}

export interface TerminalRecoveryOutcome {
	readonly terminal: true;
	readonly failedChildId: string;
	readonly failure: RecoveryFailureFacts;
}

export interface NonTerminalRecoveryOutcome {
	readonly terminal: false;
	readonly failedChildId?: string;
	readonly failure?: RecoveryFailureFacts;
}

export type RecoveryOutcome = TerminalRecoveryOutcome | NonTerminalRecoveryOutcome;

export interface RecoveryContractRef {
	readonly id: string;
	readonly revision: number;
	readonly digest: string;
}

export interface RecoveryPolicyInput {
	readonly workClass: WorkClass;
	/** Ordered, already-eligible route snapshot from spawn planning. */
	readonly eligible: readonly SpawnRouteCandidate[];
	readonly previousAttempts?: readonly RecoveryAttempt[];
	readonly suppressedProviders?: readonly string[];
	readonly outcome: RecoveryOutcome;
	/** Existing request-level fallback still has an unused candidate. */
	readonly requestFallbackRemaining: boolean;
	readonly contract: RecoveryContractRef;
	readonly profileSnapshotRefs?: readonly string[];
	readonly verifiedArtifactRefs?: readonly string[];
	readonly verifiedPatchRefs?: readonly string[];
}

export type RecoveryStopReasonCode =
	| "request_fallback_remaining"
	| "terminal_outcome_required"
	| "recovery_exhausted";

export type RecoveryDecision =
	| {
			readonly action: "retry";
			readonly attempt: RecoveryAttempt;
			readonly capsule: RecoveryCapsule;
			readonly suppressedProviders: readonly string[];
	  }
	| {
			readonly action: "stop";
			readonly reasonCode: RecoveryStopReasonCode;
			readonly capsule: RecoveryCapsule;
			readonly suppressedProviders: readonly string[];
	  };

const MAX_ATTEMPTS: Record<WorkClass, number> = {
	mechanical: 4,
	judgment: 2,
};

const TLS_LIKE_FAILURE =
	/\b(?:tls|ssl|certificate|cert|handshake|econnreset|econnrefused|socket|transport)\b/i;

function cleanProvider(value: string | undefined): string | undefined {
	const cleaned = value?.trim().toLowerCase();
	return cleaned ? cleaned : undefined;
}

function providerKey(candidate: SpawnRouteCandidate): string | undefined {
	const explicit = cleanProvider(candidate.provider);
	if (explicit) return explicit;
	const selector = candidate.selector.trim();
	const slash = selector.indexOf("/");
	return slash > 0 ? cleanProvider(selector.slice(0, slash)) : undefined;
}

function attemptProviderKey(attempt: RecoveryAttempt): string | undefined {
	const explicit = cleanProvider(attempt.provider);
	if (explicit) return explicit;
	const slash = attempt.selector.indexOf("/");
	return slash > 0 ? cleanProvider(attempt.selector.slice(0, slash)) : undefined;
}

function uniqueFrozen(values: readonly string[] | undefined): readonly string[] {
	const unique = new Set<string>();
	for (const value of values ?? []) {
		const cleaned = value.trim();
		if (cleaned) unique.add(cleaned);
	}
	return Object.freeze([...unique]);
}

/** Timeout settlement wins even if a yield arrives while teardown is running. */
export function classifyRecoveryFailure(failure: RecoveryFailureFacts): AssignmentFailureClass {
	return failure.timedOut === true ? "timeout" : failure.class;
}

function fallbackFailure(outcome: RecoveryOutcome): RecoveryFailureFacts {
	return (
		outcome.failure ?? {
			class: "liveness",
			message: "A typed terminal child outcome is required before assignment recovery.",
		}
	);
}

function buildCapsule(
	input: RecoveryPolicyInput,
	failure: RecoveryFailureFacts,
): RecoveryCapsule {
	const childId = input.outcome.failedChildId?.trim() || "unavailable";
	return Object.freeze({
		contractId: input.contract.id,
		contractRevision: input.contract.revision,
		contractDigest: input.contract.digest,
		failureClass: classifyRecoveryFailure(failure),
		failureMessage: failure.message,
		validatorReasons: uniqueFrozen(failure.validatorReasons),
		profileSnapshotRefs: uniqueFrozen(input.profileSnapshotRefs),
		artifactRefs: uniqueFrozen(input.verifiedArtifactRefs),
		patchRefs: uniqueFrozen(input.verifiedPatchRefs),
		historyRef: `history://${childId}`,
	});
}

function shouldSuppressProvider(failure: RecoveryFailureFacts): boolean {
	return failure.class === "spawn_transport" || TLS_LIKE_FAILURE.test(failure.message);
}

function nextSuppressedProviders(
	input: RecoveryPolicyInput,
	failure: RecoveryFailureFacts,
): readonly string[] {
	const suppressed = new Set<string>();
	for (const provider of input.suppressedProviders ?? []) {
		const key = cleanProvider(provider);
		if (key) suppressed.add(key);
	}
	if (shouldSuppressProvider(failure)) {
		const failedProvider = cleanProvider(failure.failedProvider);
		if (failedProvider) suppressed.add(failedProvider);
	}
	return Object.freeze([...suppressed].sort());
}

function selectNextCandidate(
	input: RecoveryPolicyInput,
	suppressedProviders: ReadonlySet<string>,
): SpawnRouteCandidate | undefined {
	const previousAttempts = input.previousAttempts ?? [];
	const usedSelectors = new Set(previousAttempts.map(attempt => attempt.selector));
	const usedLightProviders = new Set(
		previousAttempts
			.filter(attempt => attempt.tier === "light")
			.map(attemptProviderKey)
			.filter((provider): provider is string => provider !== undefined),
	);

	const canUse = (candidate: SpawnRouteCandidate): boolean => {
		if (usedSelectors.has(candidate.selector)) return false;
		const provider = providerKey(candidate);
		return provider === undefined || !suppressedProviders.has(provider);
	};
	const pick = (
		tier: AgentTier,
		options?: { distinctLightProvider?: boolean },
	): SpawnRouteCandidate | undefined =>
		input.eligible.find(candidate => {
			if (candidate.tier !== tier || !canUse(candidate)) return false;
			if (!options?.distinctLightProvider) return true;
			const provider = providerKey(candidate);
			return provider === undefined || !usedLightProviders.has(provider);
		});

	if (input.workClass === "judgment") {
		if (!previousAttempts.some(attempt => attempt.tier === "mid")) {
			return pick("mid") ?? pick("frontier");
		}
		return pick("frontier");
	}

	const lightAttempts = previousAttempts.filter(attempt => attempt.tier === "light").length;
	if (lightAttempts === 0) return pick("light") ?? pick("mid") ?? pick("frontier");
	if (lightAttempts === 1) {
		return pick("light", { distinctLightProvider: true }) ?? pick("mid") ?? pick("frontier");
	}
	if (!previousAttempts.some(attempt => attempt.tier === "mid")) {
		return pick("mid") ?? pick("frontier");
	}
	return pick("frontier");
}

function stop(
	reasonCode: RecoveryStopReasonCode,
	capsule: RecoveryCapsule,
	suppressedProviders: readonly string[],
): RecoveryDecision {
	return Object.freeze({ action: "stop", reasonCode, capsule, suppressedProviders });
}

/** Plan one deterministic fresh-child attempt without allocating or spawning. */
export function nextRecoveryAttempt(input: RecoveryPolicyInput): RecoveryDecision {
	const failure = fallbackFailure(input.outcome);
	const capsule = buildCapsule(input, failure);
	const suppressedProviders = nextSuppressedProviders(input, failure);

	if (input.requestFallbackRemaining) {
		return stop("request_fallback_remaining", capsule, suppressedProviders);
	}
	if (!input.outcome.terminal) {
		return stop("terminal_outcome_required", capsule, suppressedProviders);
	}

	const previousAttempts = input.previousAttempts ?? [];
	if (previousAttempts.length >= MAX_ATTEMPTS[input.workClass]) {
		return stop("recovery_exhausted", capsule, suppressedProviders);
	}

	const candidate = selectNextCandidate(input, new Set(suppressedProviders));
	if (!candidate) {
		return stop("recovery_exhausted", capsule, suppressedProviders);
	}

	const budgets = Object.freeze({
		maxRequests: candidate.maxRequests,
		maxRuntimeMs: candidate.maxRuntimeMs,
	});
	const attempt: RecoveryAttempt = Object.freeze({
		attempt: previousAttempts.length + 1,
		selector: candidate.selector,
		tier: candidate.tier,
		provider: candidate.provider ?? providerKey(candidate),
		modelId: candidate.modelId,
		budgets,
		maxRequests: budgets.maxRequests,
		maxRuntimeMs: budgets.maxRuntimeMs,
		freshChild: true as const,
	});

	return Object.freeze({
		action: "retry",
		attempt,
		capsule,
		suppressedProviders,
	});
}

/** Generic Fusion-facing shape; it carries no Fusion registration semantics. */
export interface FusionRecoveryRetryInput {
	readonly capsule: RecoveryCapsule;
	readonly attempt: RecoveryAttempt;
	readonly suppressedProviders: readonly string[];
}

export function toFusionRecoveryRetryInput(
	decision: Extract<RecoveryDecision, { action: "retry" }>,
): FusionRecoveryRetryInput {
	return Object.freeze({
		capsule: decision.capsule,
		attempt: decision.attempt,
		suppressedProviders: Object.freeze([...decision.suppressedProviders]),
	});
}
