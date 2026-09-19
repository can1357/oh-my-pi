/**
 * Deterministic complexity classifier for rlm.workerMode=auto (pre-Kerdoios).
 *
 * Gate order: complexity first, granted bytes second (telemetry only).
 */
import type { RlmGrantSelectResult } from "./select-grants";

export type RlmWorkerModeSetting = "prose" | "evidence-packet" | "auto";
export type RlmWorkerModeEffective = "prose" | "evidence-packet";
export type RlmWorkerModeOverride = "prose" | "evidence-packet" | "";

export type GrantComplexityClass =
	| "simple_single_fact"
	| "multi_region_causal"
	| "dense_log_extraction"
	| "contradictory_evidence"
	| "unknown";

export interface WorkerModePolicyInput {
	grantedBytes: number;
	grantCount: number;
	patternCount: number;
	patterns: readonly string[];
	question: string;
	grantTextSample?: string;
}

export interface WorkerModeAutoDecision {
	mode: RlmWorkerModeEffective;
	complexity: GrantComplexityClass;
	reason: string;
	grantedBytes: number;
	override: RlmWorkerModeOverride | "none";
	setting: RlmWorkerModeSetting;
}

const CONTRADICTION_PAIR = [/max_connections/i, /pool_limit/i];
const LOG_MARKERS = [/\bERROR\b/, /\bWARN\b/, /\bINFO\b/, /timeout/i, /checkout/i];
const CAUSAL_MARKERS = [/causal/i, /cascade/i, /downstream/i, /before.*error/i, /first.*condition/i];

export function classifyGrantComplexity(input: WorkerModePolicyInput): {
	complexity: GrantComplexityClass;
	signals: string[];
} {
	const signals: string[] = [];
	const q = input.question.toLowerCase();
	const sample = `${input.grantTextSample ?? ""}\n${input.patterns.join(" ")}`.toLowerCase();

	if (CONTRADICTION_PAIR.every(re => re.test(sample)) || /\beffective\b.*\blimit\b/i.test(q)) {
		signals.push("contradiction_markers");
		return { complexity: "contradictory_evidence", signals };
	}

	const logHits = LOG_MARKERS.filter(re => re.test(sample)).length;
	if (logHits >= 2 || (logHits >= 1 && /\blog\b|\berror lines\b|\bdiagnos/i.test(q))) {
		signals.push("dense_log_markers");
		return { complexity: "dense_log_extraction", signals };
	}

	const multiRegion =
		input.grantCount >= 2 ||
		input.patternCount >= 2 ||
		CAUSAL_MARKERS.some(re => re.test(q)) ||
		/active_connections/i.test(sample);
	if (multiRegion) {
		signals.push("multi_region_or_causal");
		return { complexity: "multi_region_causal", signals };
	}

	if (input.grantCount <= 1 && input.patternCount <= 1 && input.grantedBytes < 700) {
		signals.push("single_fact_small_grant");
		return { complexity: "simple_single_fact", signals };
	}

	signals.push("unclassified");
	return { complexity: "unknown", signals };
}

export function resolveAutoWorkerMode(
	input: WorkerModePolicyInput,
	options?: { override?: RlmWorkerModeOverride | null },
): WorkerModeAutoDecision {
	const overrideRaw = options?.override ?? "";
	const override: RlmWorkerModeOverride | "none" =
		overrideRaw === "prose" || overrideRaw === "evidence-packet" ? overrideRaw : "none";

	if (override !== "none") {
		return {
			mode: override,
			complexity: classifyGrantComplexity(input).complexity,
			reason: `override:${override}`,
			grantedBytes: input.grantedBytes,
			override,
			setting: "auto",
		};
	}

	const { complexity, signals } = classifyGrantComplexity(input);
	const sizeNote = `${input.grantedBytes}B grants`;

	switch (complexity) {
		case "simple_single_fact":
			return {
				mode: "prose",
				complexity,
				reason: `simple_single_fact + ${sizeNote}`,
				grantedBytes: input.grantedBytes,
				override: "none",
				setting: "auto",
			};
		case "multi_region_causal":
			return {
				mode: "evidence-packet",
				complexity,
				reason: `multi_region_causal + ${sizeNote} (${signals.join(",")})`,
				grantedBytes: input.grantedBytes,
				override: "none",
				setting: "auto",
			};
		case "dense_log_extraction":
			return {
				mode: "evidence-packet",
				complexity,
				reason: `dense_log_extraction + ${sizeNote}`,
				grantedBytes: input.grantedBytes,
				override: "none",
				setting: "auto",
			};
		case "contradictory_evidence":
			return {
				mode: "evidence-packet",
				complexity,
				reason: `contradictory_evidence + ${sizeNote} (quality gate)`,
				grantedBytes: input.grantedBytes,
				override: "none",
				setting: "auto",
			};
		default:
			return {
				mode: "prose",
				complexity,
				reason: `default_prose + ${sizeNote}`,
				grantedBytes: input.grantedBytes,
				override: "none",
				setting: "auto",
			};
	}
}

export function resolveEffectiveWorkerMode(
	setting: RlmWorkerModeSetting,
	policyInput: WorkerModePolicyInput,
	override?: RlmWorkerModeOverride | null,
): WorkerModeAutoDecision {
	if (setting === "prose") {
		return {
			mode: "prose",
			complexity: classifyGrantComplexity(policyInput).complexity,
			reason: "setting:prose",
			grantedBytes: policyInput.grantedBytes,
			override: "none",
			setting,
		};
	}
	if (setting === "evidence-packet") {
		return {
			mode: "evidence-packet",
			complexity: classifyGrantComplexity(policyInput).complexity,
			reason: "setting:evidence-packet",
			grantedBytes: policyInput.grantedBytes,
			override: "none",
			setting,
		};
	}
	return resolveAutoWorkerMode(policyInput, { override });
}

export function workerModeInputFromSelection(
	selection: Pick<RlmGrantSelectResult, "grants" | "grantedBytes" | "hits">,
	question: string,
	patterns: readonly string[],
	grantTextSample?: string,
): WorkerModePolicyInput {
	return {
		grantedBytes: selection.grantedBytes,
		grantCount: selection.grants.length,
		patternCount: patterns.length,
		patterns,
		question,
		grantTextSample,
	};
}

export function formatWorkerModeDecisionLine(decision: WorkerModeAutoDecision): string {
	const arm = decision.mode === "evidence-packet" ? "D" : "C";
	return (
		`auto decision: ${arm}\n` +
		`reason: ${decision.reason}\n` +
		`override: ${decision.override}\n` +
		`complexity: ${decision.complexity}`
	);
}
