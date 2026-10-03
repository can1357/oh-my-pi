/**
 * Benchmark: SessionEntryIndex.pathTo branch memo (coding-agent finding F4).
 *
 * getBranch() used to allocate a fresh array + Set + reverse per call on
 * per-frame/per-turn paths. The leaf walk is now memoized per
 * (leaf, generation) with a stack-only cycle guard; the hit path copies the
 * cached array (callers may mutate the result), so per-call cost is one
 * array copy instead of a full walk + Set + reverse.
 *
 * Run: bun packages/coding-agent/bench/session-branch.bench.ts
 */
import { SessionManager } from "../src/session/session-manager";

const N = 5000;
const manager = SessionManager.inMemory();
for (let i = 0; i < N; i++) {
	manager.appendModelChange(`model-${i}`, `role-${i}`);
}
const depth = manager.getBranch().length;
if (depth < N) throw new Error(`expected branch depth >= ${N}, got ${depth}`);

const ITERS = 1000;
const start = Bun.nanoseconds();
for (let i = 0; i < ITERS; i++) manager.getBranch();
const ms = (Bun.nanoseconds() - start) / 1e6;
console.log(
	`getBranch x${ITERS} (${depth}-entry branch): ${ms.toFixed(1)}ms total (${((ms / ITERS) * 1000).toFixed(1)}us/op)`,
);
