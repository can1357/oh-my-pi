#!/usr/bin/env bun
/** Gate report for results/depth1.jsonl */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.join(import.meta.dir, "results", "depth1.jsonl");
if (!fs.existsSync(OUT)) {
	console.error(`missing ${OUT} — run bun evals/rlm/depth1-orchestrate.ts`);
	process.exit(1);
}

type Row = {
	arm: string;
	pass_multi_hop: boolean;
	promptHasA: boolean;
	promptHasB: boolean;
	promptHasSecret: boolean;
	answer: string;
};

const rows = fs
	.readFileSync(OUT, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map(l => JSON.parse(l) as Row);

let failed = 0;
for (const r of rows) {
	console.log(
		`${r.arm.padEnd(8)} multi=${r.pass_multi_hop} A=${r.promptHasA} B=${r.promptHasB} secret=${r.promptHasSecret} ans=${r.answer.slice(0, 40)}`,
	);
}
const d0 = rows.find(r => r.arm === "depth0");
const d1 = rows.find(r => r.arm === "depth1");
if (!d0 || d0.pass_multi_hop || d0.promptHasB) {
	console.error("FAIL depth0");
	failed++;
}
if (!d1 || !d1.pass_multi_hop || d1.promptHasSecret || !d1.promptHasA || !d1.promptHasB) {
	console.error("FAIL depth1");
	failed++;
}
if (failed) process.exit(1);
console.log("all depth1 gates passed");
