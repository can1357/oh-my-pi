#!/usr/bin/env bun
/**
 * Controlled dogfood for OMP Decider shadow (rlm.worker_needed).
 *
 * Default: mock predictor (proves event contract without GPU).
 * Live Decider: OMP_SHADOW_USE_LIVE_DECIDER=1 OMP_Z0INT_BIN=z0int
 *
 * bun evals/rlm/shadow-worker-needed-dogfood.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createMockShadowPredictor,
	runShadowWorkerNeeded,
	setShadowPredictorForTest,
	SHADOW_BACKEND_ID,
} from "../../src/rlm/shadow";
import { createTokenomicsBridge } from "../../src/rlm/tokenomics-bridge";

type Case = {
	id: string;
	useEvidencePacket: boolean;
	grantedBytes: number;
	grantCount: number;
	patternCount: number;
	patterns: string[];
	question: string;
	mockPrediction: "native" | "worker" | "abstain";
	confidence: number;
};

const CASES: Case[] = [
	{
		id: "native_sufficient",
		useEvidencePacket: false,
		grantedBytes: 8192,
		grantCount: 1,
		patternCount: 1,
		patterns: ["root_cause"],
		question: "exact root_cause token",
		mockPrediction: "native",
		confidence: 0.91,
	},
	{
		id: "worker_required",
		useEvidencePacket: true,
		grantedBytes: 512,
		grantCount: 3,
		patternCount: 2,
		patterns: ["max_connections", "pool_limit"],
		question: "reconcile conflicting pool limits",
		mockPrediction: "worker",
		confidence: 0.88,
	},
	{
		id: "disagree_near_threshold",
		useEvidencePacket: false,
		grantedBytes: 4200,
		grantCount: 2,
		patternCount: 2,
		patterns: ["timeout", "cascade"],
		question: "causal timeout cascade",
		mockPrediction: "worker",
		confidence: 0.62,
	},
	{
		id: "abstain_unknown",
		useEvidencePacket: true,
		grantedBytes: 2048,
		grantCount: 1,
		patternCount: 1,
		patterns: ["maybe"],
		question: "ambiguous worker boundary",
		mockPrediction: "abstain",
		confidence: 0.4,
	},
];

async function main(): Promise<void> {
	const live = process.env.OMP_SHADOW_USE_LIVE_DECIDER === "1";
	if (!live) {
		let i = 0;
		setShadowPredictorForTest(
			createMockShadowPredictor(req => {
				const c = CASES[i++ % CASES.length]!;
				return {
					status: "ok",
					prediction: c.mockPrediction,
					confidence: c.confidence,
					probabilities: {
						[c.mockPrediction]: c.confidence,
						native: c.mockPrediction === "native" ? c.confidence : (1 - c.confidence) / 2,
						worker: c.mockPrediction === "worker" ? c.confidence : (1 - c.confidence) / 2,
						abstain: c.mockPrediction === "abstain" ? c.confidence : (1 - c.confidence) / 2,
					},
					latencyMs: 8 + (i % 3) * 7,
					backendId: SHADOW_BACKEND_ID,
				};
			}),
		);
	} else {
		setShadowPredictorForTest(null);
	}

	const outDir = join(import.meta.dir, "results");
	mkdirSync(outDir, { recursive: true });
	const bridge = createTokenomicsBridge({
		sessionId: `shadow-dogfood-${Date.now()}`,
		dir: outDir,
		contextPolicy: "rlm-search-grants",
		enabled: true,
		experimentId: "omp-shadow-rlm-worker-needed-v1",
	});

	const latencies: number[] = [];
	let disagreements = 0;
	let replay = 0;
	let unknownGold = 0;

	const t0 = performance.now();
	for (const c of CASES) {
		const hotStart = performance.now();
		// Critical path: launch is async; we await only in this dogfood harness.
		const result = await runShadowWorkerNeeded({
			host: {
				getTokenomicsBridge: () => bridge,
				settings: {
					get: (path: string) => {
						if (path === "rlm.shadow.workerNeeded") return true;
						if (path === "rlm.shadow.timeoutMs") return 1500;
						return undefined;
					},
				},
				getSessionId: () => bridge.sessionId,
			},
			policyInput: {
				grantedBytes: c.grantedBytes,
				grantCount: c.grantCount,
				patternCount: c.patternCount,
				patterns: c.patterns,
				question: c.question,
			},
			useEvidencePacket: c.useEvidencePacket,
			handle: `rlm://h/${c.id}`,
		});
		const hotMs = performance.now() - hotStart;
		if (result.prediction?.latencyMs !== undefined) latencies.push(result.prediction.latencyMs);
		if (result.disagreed) disagreements += 1;
		if (result.enqueuedReplay) replay += 1;
		unknownGold += 1;
		console.log(
			JSON.stringify({
				id: c.id,
				launched: result.launched,
				actual: result.actualPolicy,
				pred: result.prediction?.prediction,
				status: result.prediction?.status,
				latencyMs: result.prediction?.latencyMs,
				awaitMs: Number(hotMs.toFixed(2)),
				disagreed: result.disagreed,
				replay: result.enqueuedReplay,
			}),
		);
	}
	const wallMs = performance.now() - t0;
	latencies.sort((a, b) => a - b);
	const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? null;
	const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? null;

	const summary = {
		schema: "omp.shadow.worker_needed.dogfood.v1",
		mode: live ? "live_decider" : "mock",
		shadow_decisions: CASES.length,
		verified_gold: 0,
		unknown_gold: unknownGold,
		disagreements,
		replay_candidates: replay,
		shadow_latency_ms_p50: p50,
		shadow_latency_ms_p95: p95,
		harness_wall_ms: Number(wallMs.toFixed(2)),
		note: "Critical-path overhead in production is ~0ms (fire-and-forget). This harness awaits for measurement.",
		trace_id: bridge.traceId,
		events: bridge.events.length,
		sample_event_names: [...new Set(bridge.events.map(e => e.name))],
	};
	const summaryPath = join(outDir, "shadow-worker-needed-dogfood.json");
	writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
	console.log(JSON.stringify(summary, null, 2));
	console.log(`wrote ${summaryPath}`);
	if (bridge.jsonlPath) console.log(`tokenomics ${bridge.jsonlPath}`);
	setShadowPredictorForTest(null);
}

await main();
