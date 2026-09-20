/**
 * Feature contract for live OMP shadow predictions of `rlm.worker_needed`.
 *
 * Matches the logical offline decision-capability-v1 fixture state — without
 * leaking raw prompts or ungranted evidence into Tokenomics.
 */
import { createHash } from "node:crypto";
import type { GrantComplexityClass, WorkerModeAutoDecision, WorkerModePolicyInput } from "../worker-mode-policy";

export const WORKER_NEEDED_CAPABILITY = "rlm.worker_needed";
export const WORKER_NEEDED_FEATURE_SCHEMA = "omp.shadow.rlm.worker_needed.features.v1";
export const WORKER_NEEDED_CONTRACT = "decision-capability-v1";
export const SHADOW_EXPERIMENT_ID = "omp-shadow-rlm-worker-needed-v1";
export const SHADOW_BACKEND_ID = "decider_2b";

export type WorkerNeededLabel = "native" | "worker" | "abstain";

export interface WorkerNeededFeatureState {
	granted_bytes: number;
	pattern_hits: number;
	grant_count: number;
	complexity: "low" | "medium" | "high";
	complexity_class: GrantComplexityClass;
	single_obvious_hit?: boolean;
	contradictions?: number;
	ambiguous?: boolean;
	/** Opaque question identity — never the raw question text. */
	question_sha256: string;
	question_chars: number;
	auto_gate_mode?: "prose" | "evidence-packet";
}

export interface WorkerNeededDecisionRequest {
	schema: typeof WORKER_NEEDED_FEATURE_SCHEMA;
	capability: typeof WORKER_NEEDED_CAPABILITY;
	contract: typeof WORKER_NEEDED_CONTRACT;
	state: WorkerNeededFeatureState;
	question: {
		id: "decision";
		type: "choice";
		instructions: string;
		options: Array<{ id: WorkerNeededLabel; description: string }>;
	};
}

export const WORKER_NEEDED_QUESTION = {
	id: "decision" as const,
	type: "choice" as const,
	instructions: "Should RLM use an isolated semantic worker or answer natively from granted excerpts?",
	options: [
		{ id: "native" as const, description: "Granted excerpts are sufficient; native rlm.query prose" },
		{ id: "worker" as const, description: "Need isolated worker with structured evidence packet" },
		{ id: "abstain" as const, description: "Insufficient evidence to decide safely" },
	],
};

function complexityBand(complexity: GrantComplexityClass): "low" | "medium" | "high" {
	switch (complexity) {
		case "simple_single_fact":
			return "low";
		case "unknown":
			return "medium";
		default:
			return "high";
	}
}

export function questionSha256(question: string): string {
	return createHash("sha256").update(question).digest("hex");
}

export function buildWorkerNeededFeatureState(input: {
	policyInput: WorkerModePolicyInput;
	complexity: GrantComplexityClass;
	autoDecision?: WorkerModeAutoDecision | null;
}): WorkerNeededFeatureState {
	const { policyInput, complexity, autoDecision } = input;
	const state: WorkerNeededFeatureState = {
		granted_bytes: policyInput.grantedBytes,
		pattern_hits: Math.max(policyInput.patternCount, policyInput.grantCount),
		grant_count: policyInput.grantCount,
		complexity: complexityBand(complexity),
		complexity_class: complexity,
		question_sha256: questionSha256(policyInput.question),
		question_chars: policyInput.question.length,
		auto_gate_mode: autoDecision?.mode,
	};
	if (complexity === "simple_single_fact") state.single_obvious_hit = true;
	if (complexity === "contradictory_evidence") state.contradictions = 2;
	if (complexity === "unknown") state.ambiguous = true;
	return state;
}

export function buildWorkerNeededDecisionRequest(state: WorkerNeededFeatureState): WorkerNeededDecisionRequest {
	return {
		schema: WORKER_NEEDED_FEATURE_SCHEMA,
		capability: WORKER_NEEDED_CAPABILITY,
		contract: WORKER_NEEDED_CONTRACT,
		state,
		question: WORKER_NEEDED_QUESTION,
	};
}

/** Map OMP effective worker mode → decision-capability label. */
export function actualPolicyToLabel(useEvidencePacket: boolean): Exclude<WorkerNeededLabel, "abstain"> {
	return useEvidencePacket ? "worker" : "native";
}

export function featureStateHash(state: WorkerNeededFeatureState): string {
	return createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 32);
}

export function shadowPairId(args: {
	sessionId: string;
	handle: string;
	featureHash: string;
}): string {
	return createHash("sha256")
		.update(`worker_needed:${args.sessionId}:${args.handle}:${args.featureHash}`)
		.digest("hex")
		.slice(0, 24);
}

export function shadowTreatmentHash(args: {
	backendId: string;
	featureSchema: string;
	contract: string;
	device?: string;
	revision?: string;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				backend_id: args.backendId,
				feature_schema: args.featureSchema,
				contract: args.contract,
				device: args.device ?? null,
				revision: args.revision ?? null,
				prompt_version: "worker-needed-direct-options-v1",
			}),
		)
		.digest("hex")
		.slice(0, 16);
}
