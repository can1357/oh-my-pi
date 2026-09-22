/**
 * Microbench: RLM spill wrap overhead.
 *
 *   bun run packages/coding-agent/bench/rlm-spill.bench.ts
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { RlmStore, wrapToolWithRlmSpill } from "../src/rlm";

const SAMPLES = 200;
const WARMUP = 20;

function stats(samples: number[]): { median: number; p99: number } {
	const sorted = [...samples].sort((a, b) => a - b);
	const median = sorted[sorted.length >> 1]!;
	const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!;
	return { median, p99 };
}

function timeUs(fn: () => void | Promise<void>): Promise<number> {
	return (async () => {
		const t0 = Bun.nanoseconds();
		await fn();
		return (Bun.nanoseconds() - t0) / 1000;
	})();
}

const small = "hello world ".repeat(10);
const large = "x".repeat(40_000) + "NEEDLE_MID" + "y".repeat(40_000);
const store = new RlmStore();

const base = {
	name: "read",
	execute: async (_id: string, params: { text: string }) => ({
		content: [{ type: "text" as const, text: params.text }],
		details: {},
	}),
} as unknown as AgentTool;

const wrapped = wrapToolWithRlmSpill(base, store, 20_480, { enabled: () => true });

async function sample(label: string, text: string): Promise<void> {
	const times: number[] = [];
	for (let i = 0; i < WARMUP; i++) await wrapped.execute("w", { text });
	for (let i = 0; i < SAMPLES; i++) {
		times.push(await timeUs(() => wrapped.execute("s", { text })));
	}
	const s = stats(times);
	console.log(`${label}: median=${s.median.toFixed(1)}µs p99=${s.p99.toFixed(1)}µs n=${SAMPLES}`);
}

console.log("RLM spill microbench\n");
await sample("under-threshold (no spill)", small);
await sample("over-threshold (spill)", large);

const t0 = Bun.nanoseconds();
for (let i = 0; i < 50; i++) store.search("rlm://h/1", "NEEDLE_MID", 4);
const searchUs = (Bun.nanoseconds() - t0) / 1000 / 50;
console.log(`search needle on spilled store: ~${searchUs.toFixed(1)}µs/call`);
