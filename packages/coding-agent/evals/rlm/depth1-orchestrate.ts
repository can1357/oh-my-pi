#!/usr/bin/env bun
/**
 * Offline RFC v2 depth-1 multi-hop arm.
 *
 * Arms:
 *   depth0 — single rlmQuery on handle A only (cannot see FACT_B)
 *   depth1 — rlmSubcall with grants A+B (sees both)
 *
 *   bun evals/rlm/depth1-orchestrate.ts
 *   bun evals/rlm/depth1-report.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { rlmQuery, rlmSubcall, RlmStore, resetRlmStoresForTest } from "../../src/rlm";

const OUT = path.join(import.meta.dir, "results", "depth1.jsonl");
const FACT_A = "FACT_A_DEPTH1_ALPHA";
const FACT_B = "FACT_B_DEPTH1_BETA";
const SECRET = "SECRET_UNGRANTED_DEPTH1";
function corpus(mid: string, pad = 40_000): string {
	// Fact at head so default depth-0/1 peeks (QUERY_SLICE) see it without mid grants.
	return `${mid}\n${"x".repeat(Math.max(0, pad - mid.length - 1))}`;
}

type Row = {
	ts: number;
	arm: "depth0" | "depth1";
	maxDepth: number;
	promptHasA: boolean;
	promptHasB: boolean;
	promptHasSecret: boolean;
	answer: string;
	pass_multi_hop: boolean;
	failOpen?: boolean;
	calls: number;
};

async function runArm(arm: "depth0" | "depth1"): Promise<Row> {
	resetRlmStoresForTest();
	const maxDepth = arm === "depth1" ? 1 : 0;
	const store = new RlmStore({ maxDepth, maxCalls: 16, maxTotalTokens: 1_000_000 });
	const a = store.put(corpus(FACT_A), "a");
	const b = store.put(corpus(FACT_B), "b");
	store.put(corpus(SECRET), "secret");

	let seen = "";
	const complete = async (prompt: string) => {
		seen = prompt;
		const hasA = prompt.includes(FACT_A);
		const hasB = prompt.includes(FACT_B);
		if (hasA && hasB) return { text: `${FACT_A}+${FACT_B}`, tokens: 12, cost: 0 };
		if (hasA) return { text: `ONLY_A:${FACT_A}`, tokens: 8, cost: 0 };
		if (hasB) return { text: `ONLY_B:${FACT_B}`, tokens: 8, cost: 0 };
		return { text: "NONE", tokens: 2, cost: 0 };
	};

	if (arm === "depth0") {
		// Depth-0 query only sees handle A (even if maxDepth were 1, this path is single-handle).
		const q = await rlmQuery(store, a.id, "Combine FACT_A and FACT_B", complete);
		return {
			ts: Date.now(),
			arm,
			maxDepth,
			promptHasA: seen.includes(FACT_A),
			promptHasB: seen.includes(FACT_B),
			promptHasSecret: seen.includes(SECRET),
			answer: q.text,
			pass_multi_hop: false, // depth0 cannot multi-hop by construction
			failOpen: q.failOpen,
			calls: store.budget.calls,
		};
	}

	const q = await rlmSubcall(
		store,
		[{ handle: a.id }, { handle: b.id }],
		"Combine FACT_A and FACT_B into A+B",
		complete,
		1,
	);
	const pass = q.text.includes(FACT_A) && q.text.includes(FACT_B) && !seen.includes(SECRET);
	return {
		ts: Date.now(),
		arm,
		maxDepth,
		promptHasA: seen.includes(FACT_A),
		promptHasB: seen.includes(FACT_B),
		promptHasSecret: seen.includes(SECRET),
		answer: q.text,
		pass_multi_hop: pass && !q.failOpen,
		failOpen: q.failOpen,
		calls: store.budget.calls,
	};
}

async function main(): Promise<void> {
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
	const rows: Row[] = [];
	for (const arm of ["depth0", "depth1"] as const) {
		const row = await runArm(arm);
		rows.push(row);
		fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`);
		console.log(JSON.stringify(row, null, 2));
	}
	const d0 = rows.find(r => r.arm === "depth0")!;
	const d1 = rows.find(r => r.arm === "depth1")!;
	if (d0.promptHasB || d0.pass_multi_hop) {
		console.error("gate fail: depth0 should not multi-hop");
		process.exit(1);
	}
	if (!d1.pass_multi_hop || d1.promptHasSecret) {
		console.error("gate fail: depth1 multi-hop");
		process.exit(1);
	}
	console.log("depth1 gates passed");
	console.log(`wrote ${OUT}`);
}

await main();
