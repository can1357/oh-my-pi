#!/usr/bin/env bun
/**
 * Scorecard + hard gates for evals/rlm/results/results.jsonl
 *
 * Arms: off | on (RLM) | shake | soft | snapcompact
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

type Arm = "off" | "on" | "shake" | "soft" | "snapcompact";

type Cell = {
	arm: Arm;
	workload: string;
	originalBytes: number;
	rootCorpusBytes: number;
	contextTokens: number;
	M1_reduction: number;
	pass_C3: boolean;
	pass_M5: boolean;
	spilled: number;
	needleRecoverable: boolean;
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

console.log("workload          arm          origB      rootB     tok    M1%   C3   M5  spilled");
console.log("-".repeat(90));

let failed = 0;
const workloads = [...new Set(cells.map(c => c.workload))];
const NATIVE_ARMS: Arm[] = ["shake", "soft", "snapcompact"];

for (const workload of workloads) {
	const off = byKey.get(`${workload}:off`);
	const on = byKey.get(`${workload}:on`);
	const natives = NATIVE_ARMS.map(a => byKey.get(`${workload}:${a}`));

	for (const cell of [off, on, ...natives]) {
		if (!cell) continue;
		console.log(
			`${cell.workload.padEnd(16)} ${cell.arm.padEnd(12)} ${String(cell.originalBytes).padStart(8)} ${String(cell.rootCorpusBytes).padStart(8)} ${String(cell.contextTokens).padStart(7)} ${(cell.M1_reduction * 100).toFixed(1).padStart(6)} ${cell.pass_C3 ? "ok" : "NO"} ${cell.pass_M5 ? "ok" : "NO"} ${String(cell.spilled).padStart(7)}`,
		);
	}

	if (!off || !on) {
		console.error(`missing arm for ${workload}`);
		failed++;
		continue;
	}
	if (workload === "W0-smoke") continue;

	if (WORKLOADS.gates.C3_no_needle_in_stub && !on.pass_C3) {
		console.error(`FAIL ${workload}: C3 needle leaked into stub`);
		failed++;
	}
	if (!on.pass_M5) {
		console.error(`FAIL ${workload}: M5 needle not recoverable via rlm search`);
		failed++;
	}

	if (on.originalBytes > WORKLOADS.gates.M1_spill_body_reduction_min) {
		if (on.M1_reduction < WORKLOADS.gates.M1_spill_body_reduction_min) {
			console.error(
				`FAIL ${workload}: M1 reduction ${(on.M1_reduction * 100).toFixed(1)}% < ${(WORKLOADS.gates.M1_spill_body_reduction_min * 100).toFixed(0)}%`,
			);
			failed++;
		}
	}

	if (workload === "W1-single-fat" || workload === "W2-multi-fat" || workload === "W3-mixed") {
		if (off.contextTokens <= 0) {
			console.error(`FAIL ${workload}: off arm contextTokens=0`);
			failed++;
		} else {
			const drop = 1 - on.contextTokens / off.contextTokens;
			console.log(
				`  M2 ${workload}: rlm vs full token drop ${(drop * 100).toFixed(1)}% (on ${on.contextTokens} vs off ${off.contextTokens})`,
			);
			if (drop < WORKLOADS.gates.M2_context_token_reduction_min) {
				console.error(
					`FAIL ${workload}: M2 drop ${(drop * 100).toFixed(1)}% < ${(WORKLOADS.gates.M2_context_token_reduction_min * 100).toFixed(0)}%`,
				);
				failed++;
			}
		}

		for (const native of natives) {
			if (!native) {
				console.error(`FAIL ${workload}: missing native arm`);
				failed++;
				continue;
			}
			console.log(
				`  ${native.arm} ${workload}: tok=${native.contextTokens} M5=${native.pass_M5} (rlm M5=${on.pass_M5})`,
			);
			// RLM must recover midpoint when lossy native arms drop it
			if (!native.pass_M5 && !on.pass_M5) {
				console.error(`FAIL ${workload}: rlm failed M5 alongside ${native.arm}`);
				failed++;
			}
			if (!native.pass_M5 && on.pass_M5) {
				console.log(`  OK ${workload}: rlm recovers needle; ${native.arm} does not`);
			}
		}
	}
}

if (failed > 0) {
	console.error(`\n${failed} gate failure(s)`);
	process.exit(1);
}
console.log("\nall gates passed");
