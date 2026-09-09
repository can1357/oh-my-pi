/**
 * Fuzzy-filter performance harness.
 *
 * Models the realistic interactive cost: a user TYPES a query one keystroke at
 * a time, and every keystroke re-filters the SAME stable candidate list (the
 * model selector / settings selector / file-tree selector scenario). The warm
 * session is the primary metric because that is the user-facing latency.
 *
 * `fuzzyMatch` rebuilds a `SearchIndex` (normalize + index) per item per call
 * with no cross-call reuse, so the warm session currently pays N index rebuilds
 * on EVERY keystroke. The optimization target is to memoize that pure build.
 *
 * Guards:
 *   - Golden ranking checksums for a fixed corpus + queries. Any scoring drift
 *     (e.g. a bad cache) fails the harness with a non-zero exit.
 *   - A cold/unique-text pass with no possible reuse, so cache overhead can't
 *     hide a cold-path regression.
 */

import { fuzzyFilter, fuzzyRank, resetFuzzyIndexCache } from "../src/fuzzy";

// ─── Deterministic corpus ───────────────────────────────────────────────────
// Base model IDs × variant tags (real catalogs look exactly like this), plus a
// spread of repo file paths for length/structure variety. Built identically on
// every run so the golden checksums stay valid.

const BASES = [
	"openai/gpt-4o",
	"openai/gpt-4o-mini",
	"openai/gpt-4.1",
	"openai/gpt-4.1-mini",
	"openai/gpt-4-turbo",
	"openai/gpt-5",
	"openai/gpt-5-mini",
	"openai/o3",
	"openai/o3-mini",
	"openai/o4-mini",
	"anthropic/claude-3.5-sonnet",
	"anthropic/claude-3.5-haiku",
	"anthropic/claude-3-7-sonnet",
	"anthropic/claude-3-opus",
	"anthropic/claude-4-sonnet",
	"anthropic/claude-4-opus",
	"anthropic/claude-4.5-sonnet",
	"google/gemini-2.0-flash",
	"google/gemini-2.5-pro",
	"google/gemini-2.5-flash",
	"google/gemini-1.5-pro",
	"meta/llama-3.3-70b",
	"meta/llama-3.1-405b",
	"meta/llama-4-scout",
	"meta/llama-4-maverick",
	"mistral/mistral-large",
	"mistral/codestral",
	"deepseek/deepseek-v3",
	"deepseek/deepseek-r1",
	"xai/grok-3",
	"xai/grok-4",
	"qwen/qwen3-coder",
	"qwen/qwen3-235b",
	"qwen/qwen-max",
	"amazon/nova-pro",
];
const VARIANTS = [
	"",
	"-2024-06-01",
	"-2025-03-01",
	"-latest",
	"-preview",
	"-0513",
	"-0806",
	"-fp8",
	"-q4-k-m",
	"-32k",
	"-128k",
];
const FILES = [
	"src/components/markdown.ts",
	"src/tools/read.ts",
	"src/tools/grep.ts",
	"src/utils/git.ts",
	"src/modes/theme/theme.ts",
	"src/system-prompt.ts",
	"src/workspace-tree.ts",
	"packages/tui/src/fuzzy.ts",
	"packages/tui/src/autocomplete.ts",
	"packages/tui/src/utils.ts",
	"crates/pi-natives/src/grep.rs",
	"crates/pi-ast/src/summary.rs",
	"crates/pi-shell/src/shell.rs",
	"packages/coding-agent/src/tools/write.ts",
	"packages/coding-agent/src/tools/bash.ts",
];

function buildCorpus(): string[] {
	const out: string[] = [];
	for (const b of BASES) for (const v of VARIANTS) out.push(b + v);
	for (const f of FILES) out.push(f);
	return out;
}

// ─── Golden ranking checksums (ranking-drift guard) ─────────────────────────
// FNV-1a/32 over the joined ranked output for each query. Any scoring change
// — including an incorrect cache — fails the harness.

function fnv1a(str: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

const GOLDENS: Record<string, string> = {
	gpt4: "907188d2",
	claude: "a424a682",
	rs: "d6922083",
	src: "f82e2f7e",
	"deepseek r1": "6f6aad2d",
	son: "79c9d65f",
	o3: "edf71867",
	"4o": "84ede5df",
	"0513": "563822f3",
};

function assertGolden(corpus: string[]): void {
	let failed = false;
	for (const [query, golden] of Object.entries(GOLDENS)) {
		const out = fuzzyRank(corpus, query, t => t)
			.map(r => r.item)
			.join("\n");
		const hash = fnv1a(out);
		if (hash !== golden) {
			console.error(`GOLDEN MISMATCH for "${query}": expected ${golden}, got ${hash}`);
			failed = true;
		}
	}
	if (failed) {
		console.error("Ranking drifted — aborting. The harness results must stay byte-identical.");
		process.exit(1);
	}
}

// ─── Timing helpers ─────────────────────────────────────────────────────────

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function timeFn(reps: number, fn: () => void): number[] {
	const samples: number[] = [];
	for (let r = 0; r < reps; r++) {
		const t0 = performance.now();
		fn();
		samples.push(performance.now() - t0);
	}
	return samples;
}

// Deterministic PRNG so the cold corpus is identical every run (no time-of-day).
function makeLcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return state / 0x100000000;
	};
}

// ─── Workloads ──────────────────────────────────────────────────────────────

// A user typing "gpt4o-mini" one keystroke at a time, re-filtering the whole
// list each step. Stable corpus => the same indices are queried every keystroke.
const KEYSTROKES = ["g", "gp", "gpt", "gpt4", "gpt4o", "gpt4o-", "gpt4o-m", "gpt4o-mini"];

function warmSession(corpus: string[]): void {
	for (const q of KEYSTROKES) fuzzyFilter(corpus, q, t => t);
}

// All-unique texts per round: the index can never be reused, so this isolates
// the pure index-build + scoring cost (the cold path a cache must not regress).
function coldUniqueCorpus(rng: () => number): string[] {
	const out: string[] = [];
	for (let i = 0; i < 400; i++) {
		out.push(`model-${(rng() * 1e9) | 0}-${i}-v${(i * 7) % 13}`);
	}
	return out;
}

// ─── Main ───────────────────────────────────────────────────────────────────

const corpus = buildCorpus();
assertGolden(corpus);

const WARM_REPS = 21;
const COLD_REPS = 21;
const COLD_SEED = 0xc0ffee;

// Warm the JIT on a DISJOINT corpus — never the measured one — so a future
// per-text index cache stays cold for the first measured keystroke. (Until that
// cache exists this is just JIT warm-up; the reset below is a no-op.)
const JIT_WARMUP_CORPUS: string[] = Array.from({ length: 400 }, (_, i) => `jit-warmup-entry-${i}-alpha-beta-gamma`);
for (let i = 0; i < 5; i++) for (const q of ["jit", "warmup", "entry"]) fuzzyFilter(JIT_WARMUP_CORPUS, q, t => t);

// Each sample is a fresh cold-start typing session: the index cache is reset so
// the first keystroke pays the cold build and keystrokes 2..N reuse it. The
// baseline has no cache, so the reset is a no-op and every keystroke rebuilds —
// measured identically before and after the optimization.
const warmSamples = timeFn(WARM_REPS, () => {
	resetFuzzyIndexCache();
	warmSession(corpus);
});
const warmMedian = median(warmSamples);

// Cold path: a fresh unique corpus per sample.
const coldRng = makeLcg(COLD_SEED);
for (let i = 0; i < 3; i++) {
	fuzzyFilter(coldUniqueCorpus(coldRng), "model", t => t);
}
const coldSamples: number[] = [];
const coldRng2 = makeLcg(COLD_SEED + 1);
for (let r = 0; r < COLD_REPS; r++) {
	const c = coldUniqueCorpus(coldRng2);
	const t0 = performance.now();
	fuzzyFilter(c, "model", t => t);
	coldSamples.push(performance.now() - t0);
}
const coldMedian = median(coldSamples);

// Single-keystroke latency over the stable corpus is dominated by the same
// per-item index build the cold path above isolates; it is not reported
// separately to avoid duplicating that signal.

console.log(`fuzzy benchmark — corpus ${corpus.length} items, ${KEYSTROKES.length} keystrokes\n`);
console.log(`warm incremental-typing session: ${warmMedian.toFixed(4)}ms (median of ${WARM_REPS})`);
console.log(`cold unique-text single filter:   ${coldMedian.toFixed(4)}ms (median of ${COLD_REPS})`);
console.log("");
console.log(`METRIC fuzzy_warm_ms=${warmMedian.toFixed(4)}`);
console.log(`METRIC fuzzy_cold_ms=${coldMedian.toFixed(4)}`);
