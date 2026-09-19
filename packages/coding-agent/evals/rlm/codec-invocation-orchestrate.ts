#!/usr/bin/env bun
/**
 * Post-P0.2 replicated experiment: when is the Groq evidence codec worth invoking?
 *
 * Seed plan:
 *   boundary (~400–700 B grants): 5 seeds
 *   medium / dense_log / contradiction: 3 seeds each
 *   small / reference: 1 seed
 *
 *   ~/.omp/bin/omp-with-secrets bun evals/rlm/codec-invocation-orchestrate.ts
 *   bun evals/rlm/codec-invocation-report.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CODEC_INVOCATION_FIXTURES, seedsForTier } from "./lib/codec-invocation-fixtures";
import { runCvDPair } from "./lib/live-groq-cvd";
import {
	createLiveGroqHost,
	d2StructuredOutputAvailable,
	P02_CODEC_SHA,
	RESULTS_DIR,
} from "./lib/live-groq-common";

const OUT = path.join(RESULTS_DIR, "codec-invocation.jsonl");

type Row = Record<string, unknown>;

function mkdirp(file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
}

function append(row: Row): void {
	fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

function formatCost(row: Row): string {
	if (row.usageKnown === false) return "unknown";
	const u = row.usage as { costUsd?: number } | null;
	if (!u) return row.usageSource === "worker_skipped" ? "0" : "unknown";
	return u.costUsd?.toFixed(5) ?? "unknown";
}

async function main(): Promise<void> {
	mkdirp(OUT);
	if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

	const host = await createLiveGroqHost({ sessionSuffix: "codec-invocation-replicated" });
	let totalRuns = 0;
	for (const fixture of CODEC_INVOCATION_FIXTURES) {
		totalRuns += seedsForTier(fixture.replicationTier);
	}

	try {
		append({
			phase: "meta",
			experiment: "codec-invocation-threshold-replicated",
			p02_sha: P02_CODEC_SHA,
			model: `${host.model.provider}/${host.model.id}`,
			reasoning: host.reasoning,
			d1: "forced evidence_packet tool via runRlmWorkerCompletion",
			d2: d2StructuredOutputAvailable(),
			fixtureCount: CODEC_INVOCATION_FIXTURES.length,
			totalRuns,
			seedPlan: {
				boundary: 5,
				medium: 3,
				dense_log: 3,
				contradiction: 3,
				small: 1,
				reference: 1,
			},
			armOrder: "randomized per seed (fixture+seed hash)",
			ts: Date.now(),
		});

		for (const fixture of CODEC_INVOCATION_FIXTURES) {
			const seeds = seedsForTier(fixture.replicationTier);
			for (let seed = 0; seed < seeds; seed++) {
				console.log(
					`C vs D ${fixture.id} seed=${seed}/${seeds - 1} tier=${fixture.replicationTier} cap=${fixture.grantCapTarget ?? "default"}...`,
				);
				const { c, d } = await runCvDPair(host, fixture, { seed });
				append(c);
				append(d);
				console.log(
					`  order=${c.armOrder} grantB=${c.grantedBytes} ` +
						`C=${c.evidenceLabel} root=${c.rootTokensEst} ${Math.round(c.e2eLatencyMs as number)}ms cost=${formatCost(c)} | ` +
						`D=${d.evidenceLabel} root=${d.rootTokensEst} ${Math.round(d.e2eLatencyMs as number)}ms cost=${formatCost(d)} ` +
						`usageKnown=${d.usageKnown}`,
				);
			}
		}

		append({
			phase: "tokenomics",
			traceId: host.tokenomics.traceId,
			summary: host.tokenomics.summary(),
			reconciliationDelta: host.tokenomics.summary()?.reconciliation_delta ?? null,
			ts: Date.now(),
		});
	} finally {
		host.close();
	}

	console.log(`wrote ${OUT} (${totalRuns} fixture-seeds)`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
