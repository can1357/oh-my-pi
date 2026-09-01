import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectMemoryStore } from "./project-memory";

function candidate(i: number) {
	return {
		type: (i % 2 ? "TOOLING" : "ARCHITECTURE") as "TOOLING" | "ARCHITECTURE",
		content: i % 2 ? `Tests use Vitest in package ${i % 8}.` : `Service boundary ${i % 12} owns authentication state.`,
		source: "benchmark fixture",
		scope: "PROJECT" as const,
		confidence: 0.9,
		trust: "VERIFIED" as const,
		relevance: 0.8,
		repositoryFingerprint: "bench-fingerprint",
		verified: true,
	};
}

export async function runProjectMemoryBenchmark(iterations = 128) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-bench-"));
	const file = path.join(root, "project-memory.json");
	const store = new ProjectMemoryStore(file, root, { maxItems: iterations + 8, maxItemsPerCategory: iterations + 8 });
	const storageStart = performance.now();
	for (let i = 0; i < iterations; i++) await store.addCandidate(candidate(i));
	const storageMs = performance.now() - storageStart;
	const lookupStart = performance.now();
	const result = await store.query("fix authentication tests with Vitest", "bench-fingerprint", { limit: 8, budgetTokens: 800 });
	const lookupMs = performance.now() - lookupStart;
	await fs.rm(root, { recursive: true, force: true });
	return { entriesWritten: iterations, storageMs, avgStorageMs: storageMs / iterations, lookupMs, retrieved: result.items.length, memoryContextTokens: result.telemetry.memoryContextTokens };
}

if (import.meta.main) console.log(JSON.stringify(await runProjectMemoryBenchmark(), null, 2));
