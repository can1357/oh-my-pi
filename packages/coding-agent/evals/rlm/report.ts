#!/usr/bin/env bun
/**
 * Scorecard + hard gates for evals/rlm/results/results.jsonl
 *
 * Exit 1 when treatment fails M1/C3/M5 or M2 context tokens do not drop enough
 * on multi-fat workloads.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = import.meta.dir;
const RESULTS = path.join(ROOT, "results", "results.jsonl");
const WORKLOADS = JSON.parse(await Bun.file(path.join(ROOT, "workloads.json")).text()) as {
	gates: {
		M1_spill_body_reduction_min: number;
		M2_context_token_reduction_min: number;
		C3_no_needle_in_stub: boolean;
		C5_fail_open: boolean;
	};
};

type Cell = {
	arm: "off" | "on";
	workload: string;
	originalBytes: number;
	rootCorpusBytes: number;
	contextTokens: number;
	M1_reduction: number;
	pass_C3: boolean;
	pass_M5: boolean;
	spilled: number;
};

function load(): Cell[] {
	if (!fs.existsSync(RESULTS)) {
		console.error(`missing ${RESULTS}; run orchestrate.ts first`);
		process.exit(2);
	}
	return fs
		.readFileSync(RESULTS, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Cell);
}

const cells = load();
const byKey = new Map<string, Cell>();
for (const cell of cells) byKey.set(`${cell.workload}:${cell.arm}`, cell);

console.log("workload          arm   origB      rootB     tok    M1%   C3   M5  spilled");
console.log("-".repeat(78));

let failed = 0;
const workloads = [...new Set(cells.map(c => c.workload))];

for (const workload of workloads) {
	const off = byKey.get(`${workload}:off`);
	const on = byKey.get(`${workload}:on`);
	for (const cell of [off, on]) {
		if (!cell) continue;
		console.log(
			`${cell.workload.padEnd(16)} ${cell.arm.padEnd(4)} ${String(cell.originalBytes).padStart(8)} ${String(cell.rootCorpusBytes).padStart(8)} ${String(cell.contextTokens).padStart(7)} ${(cell.M1_reduction * 100).toFixed(1).padStart(6)} ${cell.pass_C3 ? "ok" : "NO"} ${cell.pass_M5 ? "ok" : "NO"} ${String(cell.spilled).padStart(7)}`,
		);
	}

	if (!off || !on) {
		console.error(`missing arm for ${workload}`);
		failed++;
		continue;
	}
	if (workload === "W0-smoke") continue;

	// C3 / M5 on treatment
	if (WORKLOADS.gates.C3_no_needle_in_stub && !on.pass_C3) {
		console.error(`FAIL ${workload}: C3 needle leaked into stub`);
		failed++;
	}
	if (!on.pass_M5) {
		console.error(`FAIL ${workload}: M5 needle not recoverable via rlm search`);
		failed++;
	}

	// M1: body reduction on treatment when there was something to spill
	if (on.originalBytes > WORKLOADS.gates.M1_spill_body_reduction_min) {
		if (on.M1_reduction < WORKLOADS.gates.M1_spill_body_reduction_min) {
			console.error(
				`FAIL ${workload}: M1 reduction ${(on.M1_reduction * 100).toFixed(1)}% < ${(WORKLOADS.gates.M1_spill_body_reduction_min * 100).toFixed(0)}%`,
			);
			failed++;
		}
	}

	// M2: context tokens must drop vs off for multi-fat / single-fat
	if (workload === "W1-single-fat" || workload === "W2-multi-fat" || workload === "W3-mixed") {
		if (off.contextTokens <= 0) {
			console.error(`FAIL ${workload}: off arm contextTokens=0`);
			failed++;
		} else {
			const drop = 1 - on.contextTokens / off.contextTokens;
			console.log(`  M2 ${workload}: context token drop ${(drop * 100).toFixed(1)}% (on ${on.contextTokens} vs off ${off.contextTokens})`);
			if (drop < WORKLOADS.gates.M2_context_token_reduction_min) {
				console.error(
					`FAIL ${workload}: M2 drop ${(drop * 100).toFixed(1)}% < ${(WORKLOADS.gates.M2_context_token_reduction_min * 100).toFixed(0)}%`,
				);
				failed++;
			}
		}
	}
}

if (failed > 0) {
	console.error(`\n${failed} gate failure(s)`);
	process.exit(1);
}
console.log("\nall gates passed");
