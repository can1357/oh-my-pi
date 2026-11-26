/**
 * Benchmark: embedded direnv preflight overhead versus `.envrc` discovery alone.
 *
 * Run: bun packages/coding-agent/bench/direnv-prefetch.bench.ts
 */
import { findEnvrc, loadDirenvEnv } from "../src/exec/direnv";

const dir = process.cwd();

const N = 200;
let start = Bun.nanoseconds();
for (let i = 0; i < N; i++) await loadDirenvEnv(dir);
const loadMs = (Bun.nanoseconds() - start) / 1e6;

start = Bun.nanoseconds();
for (let i = 0; i < N; i++) await findEnvrc(dir, true);
const walkMs = (Bun.nanoseconds() - start) / 1e6;

console.log(
	`loadDirenvEnv x${N} (config, discovery, trust, and environment): ${loadMs.toFixed(1)}ms total (${(loadMs / N).toFixed(3)}ms/op)`,
);
console.log(`findEnvrc x${N} (discovery only): ${walkMs.toFixed(1)}ms total (${(walkMs / N).toFixed(3)}ms/op)`);
