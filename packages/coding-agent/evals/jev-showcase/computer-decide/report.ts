#!/usr/bin/env bun
import * as path from "node:path";
import { readJsonl } from "../../../src/jev-showcase/jsonl";

const ROOT = import.meta.dir;
const resultsPath = process.argv[2] ?? path.join(ROOT, "results", "results.jsonl");
const rows = readJsonl([resultsPath]);

console.log(`${"arm".padEnd(14)} ${"ok".padStart(7)} ${"lat_ms".padStart(8)} backends`);
console.log("-".repeat(50));

const byArm = new Map<string, typeof rows>();
for (const row of rows) {
	const arm = String(row.arm ?? "?");
	if (!byArm.has(arm)) byArm.set(arm, []);
	byArm.get(arm)!.push(row);
}

for (const [arm, armRows] of [...byArm.entries()].sort()) {
	const oks = armRows.filter(r => r.ok).length;
	const latencies = armRows.map(r => Number(r.latencyMs ?? 0));
	const meanMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
	const backends = [...new Set(armRows.map(r => String(r.backend ?? "-")))].join(",");
	console.log(`${arm.padEnd(14)} ${(oks + "/" + armRows.length).padStart(7)} ${meanMs.toFixed(0).padStart(8)} ${backends}`);
}

const errors = rows.filter(r => r.error);
if (errors.length) {
	console.log(`\nerrors: ${errors.length}`);
	for (const row of errors.slice(0, 10)) {
		console.log(`  ${row.task}/${row.arm}: ${String(row.error).slice(0, 100)}`);
	}
}
