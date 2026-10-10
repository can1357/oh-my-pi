/**
 * Benchmark: direnv preflight per-bash-call cost (coding-agent finding F1).
 *
 * loadDirenvEnv used to walk up to the filesystem root (one throwing stat per
 * level) and rebuild the filtered parent env on every bash call. The walk-up
 * result is now cached per directory (±) and the env baseline memoized, so a
 * repo without `.envrc` pays syscalls exactly once per directory.
 *
 * Run: bun packages/coding-agent/bench/direnv-prefetch.bench.ts
 */
import { findEnvrc, loadDirenvEnv } from "../src/exec/direnv";

const dir = await Bun.file(".")
	.stat()
	.then(() => process.cwd());

const N = 200;
let start = Bun.nanoseconds();
for (let i = 0; i < N; i++) await loadDirenvEnv(dir);
const loadMs = (Bun.nanoseconds() - start) / 1e6;

start = Bun.nanoseconds();
for (let i = 0; i < N; i++) await findEnvrc(dir);
const walkMs = (Bun.nanoseconds() - start) / 1e6;

console.log(`loadDirenvEnv x${N} (cached walk+env): ${loadMs.toFixed(1)}ms total (${(loadMs / N).toFixed(3)}ms/op)`);
console.log(`findEnvrc x${N} (uncached walk): ${walkMs.toFixed(1)}ms total (${(walkMs / N).toFixed(3)}ms/op)`);
