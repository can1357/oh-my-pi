/**
 * Benchmark: countTextLines — per-code-unit loop vs native indexOf scan.
 *
 * Run: bun packages/coding-agent/bench/count-lines.bench.ts
 */
import { countTextLines } from "../src/tools/read-format";

const text = `${"x".repeat(100)}\n`.repeat(40 * 1024).slice(0, 4 * 1024 * 1024);

function legacyCount(value: string): number {
	if (value.length === 0) return 0;
	let lines = 1;
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

const expected = legacyCount(text);
const actual = countTextLines(text);
if (expected !== actual) throw new Error(`mismatch: legacy=${expected} new=${actual}`);

const ITERS = 20;
let start = Bun.nanoseconds();
for (let i = 0; i < ITERS; i++) legacyCount(text);
const legacyMs = (Bun.nanoseconds() - start) / 1e6;

start = Bun.nanoseconds();
for (let i = 0; i < ITERS; i++) countTextLines(text);
const indexOfMs = (Bun.nanoseconds() - start) / 1e6;

console.log(`text: ${(text.length / 1024 / 1024).toFixed(2)} MiB, ${expected} lines, ${ITERS} iterations`);
console.log(`charCodeAt loop: ${legacyMs.toFixed(1)}ms total (${(legacyMs / ITERS).toFixed(2)}ms/op)`);
console.log(`indexOf scan:    ${indexOfMs.toFixed(1)}ms total (${(indexOfMs / ITERS).toFixed(2)}ms/op)`);
console.log(`speedup: ${(legacyMs / indexOfMs).toFixed(2)}x`);
