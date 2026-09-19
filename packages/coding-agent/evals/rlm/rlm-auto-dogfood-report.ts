#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.join(import.meta.dir, "results", "rlm-auto-dogfood.jsonl");

type Row = Record<string, unknown>;

function main(): void {
	if (!fs.existsSync(OUT)) {
		console.error(`missing ${OUT} — run: bun evals/rlm/rlm-auto-dogfood-orchestrate.ts`);
		process.exit(1);
	}
	const rows = fs
		.readFileSync(OUT, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Row);
	const meta = rows.find(r => r.phase === "meta");
	const tasks = rows.filter(r => r.phase === "dogfood");

	console.log("=== RLM auto dogfood report ===\n");
	if (meta) console.log(`Model: ${meta.model} → ${meta.resolved}  tasks: ${meta.taskCount}`);

	const errors = tasks.filter(r => r.error);
	const ok = tasks.filter(r => !r.error);
	const mismatches = ok.filter(r => r.armMatch === false);

	console.log(`\nRuns: ${ok.length} ok, ${errors.length} errors, ${mismatches.length} arm mismatches`);

	console.log("\n--- Per task ---");
	console.log("task                      kind           policy      tool  grantB  match  ms");
	console.log("-".repeat(88));
	for (const r of ok) {
		console.log(
			`${String(r.task).padEnd(25)} ${String(r.kind).padEnd(14)} ${String(r.policyFlow).padEnd(11)} ${String(r.toolArm).padEnd(4)} ${String(r.grantedBytes ?? "?").padStart(6)}  ${r.armMatch === false ? "NO" : r.armMatch ? "yes" : "—"}  ${Math.round((r.e2eLatencyMs as number) ?? 0)}`,
		);
	}

	if (errors.length > 0) {
		console.log("\n--- Errors ---");
		for (const r of errors) console.log(`  ${r.task}: ${r.error}`);
	}
	console.log("\nSee results/rlm-auto-dogfood-flow/ for Context FLOW renders.");
}

main();
