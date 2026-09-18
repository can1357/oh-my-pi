#!/usr/bin/env bun
/**
 * Offline A/B/C/D for RLM evidence addressing + Groq coprocessor arm D.
 *
 *   bun evals/rlm/groq-coprocessor-orchestrate.ts
 *   bun evals/rlm/groq-coprocessor-report.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	resetRlmStoresForTest,
	rlmEvidenceQuery,
	rlmQuery,
	RlmRuntime,
} from "../../src/rlm";
import type { EvidencePacketV1 } from "../../src/rlm/evidence-packet";

const OUT = path.join(import.meta.dir, "results", "groq-coprocessor.jsonl");
const TAIL = "CAUSAL_TAIL_EVIDENCE_9f3a";

function corpus(): string {
	return `${"x".repeat(20_000)}\nERROR root_cause=${TAIL} detail=disk_full\n${"y".repeat(2_000)}`;
}

type Arm = "A-native" | "B-fixed-grant" | "C-search-prose" | "D-search-packet";

type Row = {
	ts: number;
	arm: Arm;
	task: string;
	verified: boolean;
	evidenceLabel: "SUPPORTED" | "MISSED_EVIDENCE" | "UNSUPPORTED";
	grantedBytes: number;
	workerCalls: number;
	workerTokens: number;
	workerInputTokens: number;
	workerOutputTokens: number;
	cachedInputTokens: number;
	rootTokens: number;
	packetBytes: number;
	answerBytes: number;
	workerLatencyMs: number;
	foundNeedle: boolean;
	packetStatus?: string;
};

function mkdirp(file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
}

function mockWorkerTokens(input = 800, output = 180, cacheRead = 400) {
	return { tokens: input + output, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead };
}

async function runArm(arm: Arm): Promise<Row> {
	resetRlmStoresForTest();
	const runtime = new RlmRuntime({ maxCalls: 8, maxTotalTokens: 200_000 });
	const rec = runtime.store.put(corpus(), "log");
	const handle = rec.id;
	const question =
		arm === "C-search-prose" || arm === "D-search-packet"
			? "Summarize the ERROR block for disk failure diagnosis"
			: "What is root_cause?";
	let workerCalls = 0;
	let workerTokens = 0;
	let workerInputTokens = 0;
	let workerOutputTokens = 0;
	let cachedInputTokens = 0;
	let grantedBytes = 0;
	let answerBytes = 0;
	let packetBytes = 0;
	let packetStatus: string | undefined;
	let text = "";
	const t0 = performance.now();

	if (arm === "A-native") {
		text = corpus().slice(0, 4096);
		grantedBytes = Buffer.byteLength(text, "utf8");
	} else if (arm === "B-fixed-grant") {
		const result = await rlmQuery(runtime, {
			handle,
			question,
			complete: async prompt => {
				workerCalls += 1;
				const u = mockWorkerTokens(700, 120, 0);
				workerTokens += u.tokens;
				workerInputTokens += u.inputTokens;
				workerOutputTokens += u.outputTokens;
				const found = prompt.includes(TAIL);
				return { text: found ? TAIL : "unknown", ...u };
			},
		});
		text = result.text;
		grantedBytes = result.grantedBytes ?? 8192;
	} else if (arm === "C-search-prose") {
		const result = await rlmQuery(runtime, {
			handle,
			question,
			patterns: "root_cause=",
			complete: async prompt => {
				workerCalls += 1;
				const u = mockWorkerTokens(900, 140, 350);
				workerTokens += u.tokens;
				workerInputTokens += u.inputTokens;
				workerOutputTokens += u.outputTokens;
				cachedInputTokens += u.cacheReadTokens;
				const found = prompt.includes(TAIL);
				return { text: found ? TAIL : "unknown", ...u };
			},
		});
		text = result.text;
		grantedBytes = result.grantedBytes ?? 0;
	} else {
		const packet: EvidencePacketV1 = {
			status: "sufficient",
			claims: [
				{
					fact: TAIL,
					confidence: 1,
					citations: [{ handle: `rlm://h/${handle}`, start: 20_010, end: 20_010 + TAIL.length }],
				},
			],
			contradictions: [],
			missingEvidence: [],
			relevantRanges: [],
		};
		const result = await rlmEvidenceQuery(runtime, {
			handle,
			question,
			patterns: "root_cause=",
			complete: async () => {
				workerCalls += 1;
				const u = mockWorkerTokens(950, 200, 480);
				workerTokens += u.tokens;
				workerInputTokens += u.inputTokens;
				workerOutputTokens += u.outputTokens;
				cachedInputTokens += u.cacheReadTokens;
				return { text: JSON.stringify(packet), structured: packet, ...u };
			},
		});
		text = result.text;
		grantedBytes = result.grantedBytes ?? 0;
		packetBytes = result.packetBytes ?? 0;
		packetStatus = result.packet?.status;
	}

	answerBytes = Buffer.byteLength(text, "utf8");
	const workerLatencyMs = performance.now() - t0;
	const foundNeedle = text.includes(TAIL);
	const verified = foundNeedle;
	const evidenceLabel: Row["evidenceLabel"] = foundNeedle ? "SUPPORTED" : "MISSED_EVIDENCE";

	return {
		ts: Date.now(),
		arm,
		task: "tail-root-cause",
		verified,
		evidenceLabel,
		grantedBytes,
		workerCalls,
		workerTokens,
		workerInputTokens,
		workerOutputTokens,
		cachedInputTokens,
		rootTokens: arm === "A-native" ? Math.ceil(grantedBytes / 4) : Math.ceil(answerBytes / 4),
		packetBytes,
		answerBytes,
		workerLatencyMs,
		foundNeedle,
		packetStatus,
	};
}

async function main(): Promise<void> {
	mkdirp(OUT);
	fs.writeFileSync(OUT, "");
	for (const arm of ["A-native", "B-fixed-grant", "C-search-prose", "D-search-packet"] as Arm[]) {
		const row = await runArm(arm);
		fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`);
	}
	console.log(`wrote ${OUT}`);
}

await main();
