#!/usr/bin/env bun
/**
 * Post-P0.2 experiment: when is the Groq evidence codec worth invoking?
 *
 * Frozen checkpoint: P02_CODEC_SHA (0db7f4a0e)
 * Arms (identical grants per fixture):
 *   C — grants → prose worker → root
 *   D — grants → Groq evidence_packet codec → root
 *
 *   ~/.omp/bin/omp-with-secrets bun evals/rlm/codec-invocation-orchestrate.ts
 *   bun evals/rlm/codec-invocation-report.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CODEC_INVOCATION_FIXTURES } from "./lib/codec-invocation-fixtures";
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

async function main(): Promise<void> {
	mkdirp(OUT);
	if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

	const host = await createLiveGroqHost({ sessionSuffix: "codec-invocation" });
	try {
		append({
			phase: "meta",
			experiment: "codec-invocation-threshold",
			p02_sha: P02_CODEC_SHA,
			model: `${host.model.provider}/${host.model.id}`,
			reasoning: host.reasoning,
			d1: "forced evidence_packet tool via runRlmWorkerCompletion",
			d2: d2StructuredOutputAvailable(),
			fixtureCount: CODEC_INVOCATION_FIXTURES.length,
			ts: Date.now(),
		});

		for (const fixture of CODEC_INVOCATION_FIXTURES) {
			console.log(
				`C vs D ${fixture.id} (bucket=${fixture.bucket ?? "?"} cap=${fixture.grantCapTarget ?? "default"})...`,
			);
			const { c, d } = await runCvDPair(host, fixture);
			append(c);
			append(d);
			const cCost = (c.usage as { costUsd?: number } | null)?.costUsd ?? 0;
			const dCost = (d.usage as { costUsd?: number } | null)?.costUsd ?? 0;
			console.log(
				`  grantB=${c.grantedBytes} C=${c.evidenceLabel}(${c.atomRecall}/${c.relationRecall}) ` +
					`root=${c.rootTokensEst} ${Math.round(c.e2eLatencyMs as number)}ms $${cCost.toFixed(5)} | ` +
					`D=${d.evidenceLabel}(${d.atomRecall}/${d.relationRecall}) root=${d.rootTokensEst} ` +
					`compress=${(d.compressionRatio as number)?.toFixed?.(1) ?? d.compressionRatio} ` +
					`${Math.round(d.e2eLatencyMs as number)}ms $${dCost.toFixed(5)}`,
			);
		}

		const summary = host.tokenomics.summary();
		append({
			phase: "tokenomics",
			traceId: host.tokenomics.traceId,
			summary,
			reconciliationDelta: summary?.reconciliation_delta ?? null,
			ts: Date.now(),
		});
	} finally {
		host.close();
	}

	console.log(`wrote ${OUT}`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
