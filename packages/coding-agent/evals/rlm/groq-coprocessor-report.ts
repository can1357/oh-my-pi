#!/usr/bin/env bun
/** Report for evals/rlm/results/groq-coprocessor.jsonl */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.join(import.meta.dir, "results", "groq-coprocessor.jsonl");
if (!fs.existsSync(OUT)) {
	console.error(`missing ${OUT} — run groq-coprocessor-orchestrate.ts first`);
	process.exit(2);
}

type Row = {
	arm: string;
	verified: boolean;
	evidenceLabel: string;
	grantedBytes: number;
	workerCalls: number;
	workerTokens: number;
	cachedInputTokens: number;
	rootTokens: number;
	packetBytes: number;
	answerBytes: number;
	workerLatencyMs: number;
	foundNeedle: boolean;
	packetStatus?: string;
};

const rows = fs
	.readFileSync(OUT, "utf8")
	.split("\n")
	.filter(Boolean)
	.map(line => JSON.parse(line) as Row);

console.log("arm               verified  label           grantB  wrkTok  cacheIn  rootTok  pktB  ansB  ms");
console.log("-".repeat(95));
for (const r of rows) {
	console.log(
		`${r.arm.padEnd(17)} ${String(r.verified).padEnd(8)} ${r.evidenceLabel.padEnd(15)} ${String(r.grantedBytes).padStart(6)} ${String(r.workerTokens).padStart(7)} ${String(r.cachedInputTokens).padStart(7)} ${String(r.rootTokens).padStart(7)} ${String(r.packetBytes).padStart(5)} ${String(r.answerBytes).padStart(5)} ${r.workerLatencyMs.toFixed(1).padStart(5)}`,
	);
}

const c = rows.find(r => r.arm === "C-search-prose");
const d = rows.find(r => r.arm === "D-search-packet");
if (c && d) {
	const dRootEconomy = c.rootTokens > 0 ? 1 - d.rootTokens / c.rootTokens : 0;
	const dWorkerDelta = d.workerTokens - c.workerTokens;
	console.log("\nC vs D (same search grants, same task):");
	console.log(`  root token reduction (D vs C prose): ${(dRootEconomy * 100).toFixed(1)}%`);
	console.log(`  worker token delta (D - C): ${dWorkerDelta}`);
	console.log(`  D packet bytes: ${d.packetBytes}`);
	console.log(`  D cached input tokens (mock): ${d.cachedInputTokens}`);
	console.log(
		`  hypothesis (D beats C on verified-task economics): ${d.verified && d.rootTokens <= c.rootTokens ? "SUPPORTED (offline mock)" : "NOT YET / INCONCLUSIVE"}`,
	);
}

process.exit(0);
