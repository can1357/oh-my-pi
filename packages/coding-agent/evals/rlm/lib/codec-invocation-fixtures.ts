/**
 * Grant size / complexity ladder for "when is the codec worth invoking?" (post P0.2).
 */
import type { LiveFixture } from "./live-groq-common";
import { LIVE_FIXTURES } from "./live-groq-common";

export type ReplicationTier = "boundary" | "medium" | "dense_log" | "contradiction" | "small" | "reference";

export type CodecInvocationFixture = LiveFixture & {
	replicationTier: ReplicationTier;
};

function cloneFixture(
	base: LiveFixture,
	overrides: Partial<LiveFixture> & { id: string; replicationTier: ReplicationTier },
): CodecInvocationFixture {
	return { ...base, ...overrides, patterns: overrides.patterns ?? base.patterns, replicationTier: overrides.replicationTier };
}

const s1 = LIVE_FIXTURES.find(f => f.id === "S1_sufficient_causal")!;
const s2 = LIVE_FIXTURES.find(f => f.id === "S2_contradictory")!;
const coding = LIVE_FIXTURES.find(f => f.id === "coding_log_diagnosis")!;

const simpleFactBase: LiveFixture = {
	id: "size_small_simple",
	bucket: "small",
	complexity: "simple",
	grantCapTarget: 900,
	parentSecret: "PARENT_SECRET_SMALL_SIMPLE",
	buildCorpus: () => {
		const pad = `${".".repeat(4_000)}\n`;
		const fact = "metric: checkout pool_limit=50 active_connections=48 under peak load\n";
		return pad + fact + pad;
	},
	patterns: ["pool_limit"],
	selectPolicy: { maxMatches: 1, contextChars: 96, maxTotalBytes: 900 },
	question: "What is the checkout pool_limit under peak load?",
	requiredFacts: [],
	requiredAtoms: [{ key: "pool_limit", grantTextPattern: /pool_limit=50/ }],
	expectStatus: "sufficient",
	grantedNeedle: "pool_limit=50",
};

/** Seeds per replication tier (see codec-invocation-orchestrate). */
export function seedsForTier(tier: ReplicationTier): number {
	switch (tier) {
		case "boundary":
			return 5;
		case "medium":
		case "dense_log":
		case "contradiction":
			return 3;
		case "small":
		case "reference":
			return 1;
		default:
			return 1;
	}
}

export const CODEC_INVOCATION_FIXTURES: CodecInvocationFixture[] = [
	// --- small / simple (sanity, 1 seed) ---
	cloneFixture(simpleFactBase, { id: "size_small_simple", replicationTier: "small" }),
	cloneFixture(simpleFactBase, {
		id: "size_small_simple_1400",
		replicationTier: "small",
		grantCapTarget: 1400,
		selectPolicy: { maxMatches: 1, contextChars: 256, maxTotalBytes: 1400 },
	}),

	// --- boundary ~400–700 B (5 seeds each) ---
	cloneFixture(simpleFactBase, {
		id: "boundary_simple_480",
		replicationTier: "boundary",
		bucket: "small",
		grantCapTarget: 480,
		selectPolicy: { maxMatches: 1, contextChars: 128, maxTotalBytes: 480 },
	}),
	cloneFixture(s1, {
		id: "boundary_causal_550",
		replicationTier: "boundary",
		bucket: "medium",
		complexity: "multi_region",
		grantCapTarget: 2200,
		selectPolicy: { maxMatches: 2, contextChars: 256, maxTotalBytes: 2200 },
	}),
	cloneFixture(s1, {
		id: "boundary_causal_620",
		replicationTier: "boundary",
		bucket: "medium",
		complexity: "multi_region",
		grantCapTarget: 2600,
		selectPolicy: { maxMatches: 2, contextChars: 280, maxTotalBytes: 2600 },
	}),
	cloneFixture(s1, {
		id: "boundary_causal_680",
		replicationTier: "boundary",
		bucket: "medium",
		complexity: "multi_region",
		grantCapTarget: 3000,
		selectPolicy: { maxMatches: 2, contextChars: 320, maxTotalBytes: 3000 },
	}),

	// --- medium / multi-region (3 seeds) ---
	cloneFixture(s1, {
		id: "size_medium_causal_4500",
		replicationTier: "medium",
		bucket: "medium",
		complexity: "multi_region",
		grantCapTarget: 4500,
		selectPolicy: { maxMatches: 3, contextChars: 384, maxTotalBytes: 4500 },
	}),
	cloneFixture(s1, {
		id: "size_medium_causal_7500",
		replicationTier: "medium",
		bucket: "medium",
		complexity: "multi_region",
		grantCapTarget: 7500,
		selectPolicy: { maxMatches: 3, contextChars: 512, maxTotalBytes: 7500 },
	}),
	cloneFixture(s1, {
		id: "ref_S1_default_cap",
		replicationTier: "medium",
		bucket: "medium",
		complexity: "multi_region",
		grantCapTarget: 8192,
	}),

	// --- dense log (3 seeds) ---
	cloneFixture(coding, {
		id: "size_large_dense_log_12000",
		replicationTier: "dense_log",
		bucket: "large",
		complexity: "dense_contradictory",
		grantCapTarget: 12_000,
		selectPolicy: { maxMatches: 4, contextChars: 512, maxTotalBytes: 12_000 },
	}),
	cloneFixture(coding, {
		id: "ref_coding_log_default_cap",
		replicationTier: "dense_log",
		bucket: "large",
		complexity: "dense_contradictory",
		grantCapTarget: 8192,
	}),

	// --- contradiction (3 seeds) ---
	cloneFixture(s2, {
		id: "size_large_contradict_5500",
		replicationTier: "contradiction",
		bucket: "large",
		complexity: "dense_contradictory",
		grantCapTarget: 5500,
		selectPolicy: { maxMatches: 2, contextChars: 384, maxTotalBytes: 5500 },
	}),
	cloneFixture(s2, {
		id: "size_large_contradict_10000",
		replicationTier: "contradiction",
		bucket: "large",
		complexity: "dense_contradictory",
		grantCapTarget: 10000,
		selectPolicy: { maxMatches: 3, contextChars: 512, maxTotalBytes: 10_000 },
	}),
	cloneFixture(s2, {
		id: "ref_S2_default_cap",
		replicationTier: "contradiction",
		bucket: "large",
		complexity: "dense_contradictory",
		grantCapTarget: 8192,
	}),
];
