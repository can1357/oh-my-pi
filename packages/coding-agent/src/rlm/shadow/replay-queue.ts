/**
 * Durable index of shadow traces worth counterfactual replay.
 * Stores Tokenomics trace references + priority metadata only — no new event schema.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ShadowReplayCandidate {
	schema: "omp.shadow.replay_candidate.v1";
	ts: number;
	trace_id: string;
	pair_id: string;
	capability_id: string;
	backend_id: string;
	priority: number;
	reasons: string[];
	shadow_prediction?: string;
	actual_policy?: string;
	confidence?: number;
	/** Opaque WorkerNeededReplayV1 snapshot id when frozen. */
	replay_snapshot_id?: string;
	expected_worker_cost?: number;
	capability_evidence_gap?: number;
}

export function defaultReplayQueuePath(): string {
	const home = process.env.HOME ?? "/tmp";
	return join(home, ".omp", "tokenomics", "shadow-replay-queue.jsonl");
}

/**
 * Priority ∝ disagreement × uncertainty × expected worker cost × evidence gap / replay cost.
 * Higher = replay first (not FIFO).
 */
export function scoreReplayPriority(input: {
	disagrees: boolean;
	confidence?: number;
	grantedBytes: number;
	goldUnknown: boolean;
	/** Rough expected worker token/cost proxy (bytes-based if unknown). */
	expectedWorkerCost?: number;
	/** 0..1 — higher when capability gold is sparse. */
	capabilityEvidenceGap?: number;
	/** Relative replay cost; defaults to 1. */
	replayCost?: number;
	/** Bootstrap / frontier instability signal 0..1. */
	frontierInstability?: number;
}): { priority: number; reasons: string[] } {
	const reasons: string[] = [];
	let disagreementValue = 0;
	if (input.disagrees) {
		disagreementValue = 1;
		reasons.push("shadow_disagrees_with_policy");
	}

	let decisionUncertainty = 0.25;
	if (input.confidence !== undefined) {
		// Highest near the authority threshold band.
		const c = input.confidence;
		decisionUncertainty = 1 - Math.abs(c - 0.55) / 0.55;
		decisionUncertainty = Math.max(0, Math.min(1, decisionUncertainty));
		if (c >= 0.45 && c <= 0.7) reasons.push("near_threshold_confidence");
		else if (input.disagrees && c >= 0.75) reasons.push("high_confidence_disagreement");
	}

	const expectedWorkerCost =
		input.expectedWorkerCost ??
		Math.min(1, Math.max(0.05, input.grantedBytes / 16_384));
	if (input.grantedBytes >= 4096) reasons.push("high_grant_bytes");

	const capabilityEvidenceGap = input.capabilityEvidenceGap ?? (input.goldUnknown ? 0.8 : 0.2);
	if (input.goldUnknown) reasons.push("unknown_gold");

	const frontierInstability = input.frontierInstability ?? 0.3;
	const replayCost = Math.max(0.05, input.replayCost ?? 1);

	const raw =
		(0.35 * disagreementValue +
			0.2 * decisionUncertainty +
			0.15 * expectedWorkerCost +
			0.2 * capabilityEvidenceGap +
			0.1 * frontierInstability) /
		replayCost;

	const priority = Math.round(raw * 100);
	return { priority, reasons };
}

export async function enqueueShadowReplayCandidate(
	candidate: ShadowReplayCandidate,
	path = defaultReplayQueuePath(),
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(candidate)}\n`, "utf8");
}

/** Highest-priority first; skips already-replayed rows when result filter provided. */
export async function loadReplayCandidatesSorted(
	path = defaultReplayQueuePath(),
): Promise<ShadowReplayCandidate[]> {
	try {
		const text = await readFile(path, "utf8");
		const rows = text
			.split("\n")
			.map(l => l.trim())
			.filter(Boolean)
			.map(l => JSON.parse(l) as ShadowReplayCandidate);
		return rows.sort((a, b) => b.priority - a.priority || b.ts - a.ts);
	} catch {
		return [];
	}
}
