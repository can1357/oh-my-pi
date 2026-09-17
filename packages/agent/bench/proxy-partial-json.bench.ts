/**
 * Benchmark: proxy toolcall_delta parse cost — unthrottled vs throttled.
 *
 * Feeds a 100KB argument buffer as 1KB deltas through processProxyEvent's
 * parse path. The old path ran parseStreamingJson per delta (O(N^2)); the new
 * path uses parseStreamingJsonThrottled with per-index last-parsed length
 * (O(N log N)), matching every native provider.
 *
 * Run: bun packages/agent/bench/proxy-partial-json.bench.ts
 */
import { parseStreamingJson, parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils";

const TOTAL = 100 * 1024;
const DELTA = 1024;
const payload = `{"content":${JSON.stringify("x".repeat(TOTAL))}}`;
const deltas: string[] = [];
for (let i = 0; i < payload.length; i += DELTA) deltas.push(payload.slice(i, i + DELTA));

function benchUnthrottled(): number {
	let acc = "";
	const start = Bun.nanoseconds();
	for (const d of deltas) {
		acc += d;
		parseStreamingJson(acc);
	}
	return (Bun.nanoseconds() - start) / 1e6;
}

function benchThrottled(): number {
	let acc = "";
	let lastLen = 0;
	const start = Bun.nanoseconds();
	for (const d of deltas) {
		acc += d;
		const parsed = parseStreamingJsonThrottled(acc, lastLen);
		if (parsed !== null) lastLen = parsed.parsedLen;
	}
	parseStreamingJson(acc);
	return (Bun.nanoseconds() - start) / 1e6;
}

benchUnthrottled(); // warmup

const RUNS = 5;
const slow: number[] = [];
const fast: number[] = [];
for (let i = 0; i < RUNS; i++) {
	slow.push(benchUnthrottled());
	fast.push(benchThrottled());
}
slow.sort((a, b) => a - b);
fast.sort((a, b) => a - b);
console.log(`payload: ${(payload.length / 1024).toFixed(0)}KB in ${deltas.length} deltas, ${RUNS} runs`);
console.log(`unthrottled: median ${slow[2]!.toFixed(1)}ms`);
console.log(`throttled:   median ${fast[2]!.toFixed(1)}ms`);
console.log(`speedup: ${((slow[2] ?? 1) / (fast[2] ?? 1)).toFixed(2)}x`);
