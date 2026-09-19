/**
 * Grant size / complexity ladder for "when is the codec worth invoking?" (post P0.2).
 *
 * Buckets:
 *   small/simple           — single-region fact lookup
 *   medium/multi_region    — causal chain across distant corpus regions
 *   large/dense/contradictory — contradictions + dense log excerpts
 */
import type { LiveFixture } from "./live-groq-common";
import { LIVE_FIXTURES } from "./live-groq-common";

function cloneFixture(base: LiveFixture, overrides: Partial<LiveFixture> & { id: string }): LiveFixture {
	return { ...base, ...overrides, patterns: overrides.patterns ?? base.patterns };
}

const s1 = LIVE_FIXTURES.find(f => f.id === "S1_sufficient_causal")!;
const s2 = LIVE_FIXTURES.find(f => f.id === "S2_contradictory")!;
const coding = LIVE_FIXTURES.find(f => f.id === "coding_log_diagnosis")!;

/** Minimal corpus: one fact + tight padding — grant cap drives bytes. */
const simpleFact: LiveFixture = {
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

export const CODEC_INVOCATION_FIXTURES: LiveFixture[] = [
	// --- small / simple ---
	simpleFact,
	cloneFixture(simpleFact, {
		id: "size_small_simple_1400",
		grantCapTarget: 1400,
		selectPolicy: { maxMatches: 1, contextChars: 256, maxTotalBytes: 1400 },
	}),

	// --- medium / multi-region (S1 causal at rising grant caps) ---
	cloneFixture(s1, {
		id: "size_medium_causal_2200",
		bucket: "medium",
		complexity: "multi_region",
		grantCapTarget: 2200,
		selectPolicy: { maxMatches: 2, contextChars: 256, maxTotalBytes: 2200 },
	}),
	cloneFixture(s1, {
		id: "size_medium_causal_4500",
		bucket: "medium",
		complexity: "multi_region",
		grantCapTarget: 4500,
		selectPolicy: { maxMatches: 3, contextChars: 384, maxTotalBytes: 4500 },
	}),
	cloneFixture(s1, {
		id: "size_medium_causal_7500",
		bucket: "medium",
		complexity: "multi_region",
		grantCapTarget: 7500,
		selectPolicy: { maxMatches: 3, contextChars: 512, maxTotalBytes: 7500 },
	}),

	// --- large / dense / contradictory ---
	cloneFixture(s2, {
		id: "size_large_contradict_5500",
		bucket: "large",
		complexity: "dense_contradictory",
		grantCapTarget: 5500,
		selectPolicy: { maxMatches: 2, contextChars: 384, maxTotalBytes: 5500 },
	}),
	cloneFixture(s2, {
		id: "size_large_contradict_10000",
		bucket: "large",
		complexity: "dense_contradictory",
		grantCapTarget: 10000,
		selectPolicy: { maxMatches: 3, contextChars: 512, maxTotalBytes: 10_000 },
	}),
	cloneFixture(coding, {
		id: "size_large_dense_log_12000",
		bucket: "large",
		complexity: "dense_contradictory",
		grantCapTarget: 12_000,
		selectPolicy: { maxMatches: 4, contextChars: 512, maxTotalBytes: 12_000 },
	}),

	// Reference anchors from P0.2 smoke (default 8192 cap)
	cloneFixture(s1, {
		id: "ref_S1_default_cap",
		bucket: "medium",
		complexity: "multi_region",
		grantCapTarget: 8192,
	}),
	cloneFixture(s2, {
		id: "ref_S2_default_cap",
		bucket: "large",
		complexity: "dense_contradictory",
		grantCapTarget: 8192,
	}),
	cloneFixture(coding, {
		id: "ref_coding_log_default_cap",
		bucket: "large",
		complexity: "dense_contradictory",
		grantCapTarget: 8192,
	}),
];
