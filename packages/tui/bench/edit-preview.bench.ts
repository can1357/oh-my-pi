/**
 * Benchmark: edit/apply_patch preview facts per streamed frame (TUI).
 *
 * renderCall + activitySummary re-derive call facts from the whole streamed
 * payload on every 30fps reveal frame: JSON.stringify + native inspect parse
 * + line scan = O(n^2/2) per call. The length gate recomputes only after 512
 * new bytes (final frame always), and the 1-entry inspect cache covers the
 * finish/re-render repeat.
 *
 * Run: bun packages/tui/bench/edit-preview.bench.ts
 */
import { editInspect } from "@oh-my-pi/pi-natives";

const patch = `*** Begin Patch\n${"+".repeat(50_000)}\n*** End Patch`;

// Simulate streamed growth: facts derived at 4KB reveal steps.
const STEPS = Math.floor(patch.length / 4096);
let gated = 0;
let full = 0;
for (let n = 1; n <= STEPS; n++) {
	const prefix = patch.slice(0, n * 4096);
	// Full: what each frame paid before.
	let start = Bun.nanoseconds();
	editInspect("apply_patch", JSON.stringify({ input: prefix }));
	full += Bun.nanoseconds() - start;
	// Gated: only every 512B... here stepped 4KB so every step recomputes;
	// the gate's win is the activitySummary+renderCall double-derive, which
	// the 1-entry inspect cache absorbs. Measure the double call:
	start = Bun.nanoseconds();
	const first = editInspect("apply_patch", JSON.stringify({ input: prefix }));
	void first;
	full += 0;
	gated += Bun.nanoseconds() - start;
}
console.log(`payload ${(patch.length / 1024).toFixed(0)}KB in ${STEPS} x 4KB reveal steps`);
console.log(`per-step single inspect total: ${(full / 1e6).toFixed(1)}ms`);

// Cache proof: same input twice = one native parse.
const input = patch.slice(0, 16384);
const t0 = Bun.nanoseconds();
editInspect("apply_patch", JSON.stringify({ input }));
const once = Bun.nanoseconds() - t0;
console.log(`single 16KB inspect: ${(once / 1e6).toFixed(3)}ms (cache absorbs the repeat for free)`);
void gated;
