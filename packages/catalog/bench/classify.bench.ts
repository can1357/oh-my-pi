/**
 * Benchmark: classifyModel + globMatch memoization (catalog findings 1-3).
 *
 * Measures cold vs memoized classifyModel over representative ids, plus
 * globMatch repeat-pattern throughput with the segment cache.
 *
 * Run: bun packages/catalog/bench/classify.bench.ts
 */
import { globMatch } from "../src/compat/cascade";
import { classifyModel } from "../src/compat/taxonomy";

const IDS: Array<[string, string]> = [
	["cursor", "claude-opus-4-8"],
	["openai", "gpt-5.6-luna"],
	["anthropic", "claude-sonnet-4-5-20250929"],
	["google", "gemini-2.5-flash"],
	["openrouter", "qwen3-32b"],
];

const N = 100_000;
let start = Bun.nanoseconds();
for (let i = 0; i < N; i++) {
	const [provider, id] = IDS[i % IDS.length]!;
	classifyModel(provider, id);
}
const memoMs = (Bun.nanoseconds() - start) / 1e6;

const G = 1_000_000;
start = Bun.nanoseconds();
for (let i = 0; i < G; i++) globMatch("*claude*sonnet*", "claude-sonnet-4-5");
const globMs = (Bun.nanoseconds() - start) / 1e6;

console.log(`classifyModel x${N} (memoized, 5 ids): ${memoMs.toFixed(1)}ms (${((memoMs / N) * 1e6).toFixed(0)}ns/op)`);
console.log(`globMatch x${G} (cached segments): ${globMs.toFixed(1)}ms (${((globMs / G) * 1e6).toFixed(0)}ns/op)`);
