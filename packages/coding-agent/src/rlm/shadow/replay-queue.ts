/**
 * Durable index of shadow traces worth counterfactual replay.
 * Stores Tokenomics trace references + priority metadata only — no new event schema.
 */
import { appendFile, mkdir } from "node:fs/promises";
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
}

export function defaultReplayQueuePath(): string {
	const home = process.env.HOME ?? "/tmp";
	return join(home, ".omp", "tokenomics", "shadow-replay-queue.jsonl");
}

export function scoreReplayPriority(input: {
	disagrees: boolean;
	confidence?: number;
	grantedBytes: number;
	goldUnknown: boolean;
}): { priority: number; reasons: string[] } {
	const reasons: string[] = [];
	let priority = 0;
	if (input.disagrees) {
		priority += 40;
		reasons.push("shadow_disagrees_with_policy");
	}
	if (input.confidence !== undefined && input.confidence >= 0.45 && input.confidence <= 0.7) {
		priority += 20;
		reasons.push("near_threshold_confidence");
	}
	if (input.grantedBytes >= 4096) {
		priority += 15;
		reasons.push("high_grant_bytes");
	}
	if (input.goldUnknown) {
		priority += 10;
		reasons.push("unknown_gold");
	}
	return { priority, reasons };
}

export async function enqueueShadowReplayCandidate(
	candidate: ShadowReplayCandidate,
	path = defaultReplayQueuePath(),
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(candidate)}\n`, "utf8");
}
