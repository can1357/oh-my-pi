#!/usr/bin/env bun
/**
 * One real end-to-end WorkerNeededReplayV1 artifact:
 * shadow → queue → freeze → A0/B0/A1/B1 → verifier → gold → Tokenomics join → z0int ingest
 *
 * bun evals/rlm/worker-needed-replay-e2e.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	createMockShadowPredictor,
	runShadowWorkerNeeded,
	runWorkerNeededPairedReplay,
	setShadowPredictorForTest,
} from "../../src/rlm/shadow";
import { createTokenomicsBridge } from "../../src/rlm/tokenomics-bridge";

async function main(): Promise<void> {
	const outDir = join(import.meta.dir, "results");
	mkdirSync(outDir, { recursive: true });

	const z0 = join(outDir, "z0int-home-worker-needed-replay");
	const tm = join(outDir, "tokenomics-worker-needed-replay");
	mkdirSync(z0, { recursive: true });
	mkdirSync(tm, { recursive: true });
	process.env.Z0INT_HOME = z0;

	const evidence = `${"x".repeat(1500)}\nERROR root_cause=CAUSAL_TAIL_EVIDENCE_9f3a detail=disk_full\n${"y".repeat(800)}`;
	const question = "diagnose the disk failure code from the log";
	const sessionId = `wn-replay-e2e-${Date.now()}`;

	setShadowPredictorForTest(
		createMockShadowPredictor(() => ({
			status: "ok",
			prediction: "worker",
			confidence: 0.62,
			probabilities: { worker: 0.62, native: 0.28, abstain: 0.1 },
			latencyMs: 22,
		})),
	);

	const bridge = createTokenomicsBridge({
		sessionId,
		dir: tm,
		enabled: true,
		contextPolicy: "rlm-search-grants",
	});

	const shadow = await runShadowWorkerNeeded({
		host: {
			getTokenomicsBridge: () => bridge,
			settings: { get: (p: string) => (p === "rlm.shadow.workerNeeded" ? true : undefined) },
			getSessionId: () => sessionId,
		},
		policyInput: {
			grantedBytes: Buffer.byteLength(evidence, "utf8"),
			grantCount: 1,
			patternCount: 1,
			patterns: ["root_cause"],
			question,
			grantTextSample: evidence.slice(0, 4096),
		},
		useEvidencePacket: false,
		handle: "rlm://h/e2e",
		grantedEvidence: evidence,
	});

	if (!shadow.replaySnapshotId) {
		throw new Error("expected replay snapshot freeze");
	}

	const result = await runWorkerNeededPairedReplay(shadow.replaySnapshotId, {
		bridgeFactory: () => bridge,
		joinTokenomics: true,
	});

	// z0int analytics ingest (reads results.jsonl under Z0INT_HOME)
	const ingest = spawnSync(
		"python",
		["-c", "from z0int.replay.worker_needed import ingest_worker_needed_results; import json; print(json.dumps(ingest_worker_needed_results(), indent=2))"],
		{
			env: { ...process.env, PYTHONPATH: "/home/kvn/tmp/openjev/src", Z0INT_HOME: z0 },
			encoding: "utf8",
		},
	);
	const ingestJson = ingest.stdout?.trim() ? JSON.parse(ingest.stdout) : { ok: false, stderr: ingest.stderr };

	const report = {
		ok: true,
		shadow: {
			disagreed: shadow.disagreed,
			prediction: shadow.prediction?.prediction,
			actualPolicy: shadow.actualPolicy,
			pairId: shadow.pairId,
			traceId: shadow.traceId,
			replaySnapshotId: shadow.replaySnapshotId,
			enqueuedReplay: shadow.enqueuedReplay,
		},
		replay: result,
		tokenomics_join: {
			trace_match: result.tokenomics_joined,
			gold_events: bridge.events.filter(e => e.name === "omp.shadow.rlm.worker_needed.gold").map(e => ({
				status: e.status,
				gold: e.attributes?.["decision.gold"],
				gold_status: e.attributes?.["decision.gold_status"],
				experiment_id: e.experiment?.experiment_id,
				pair_id: e.experiment?.pair_id,
				replay_snapshot_id: e.attributes?.["replay.snapshot_id"],
			})),
		},
		z0int_ingest: ingestJson,
		paths: {
			z0int_home: z0,
			tokenomics_dir: tm,
			snapshot_dir: join(z0, "replay", "rlm-worker-needed", result.snapshot_id),
			results_jsonl: result.z0int_ingest_path,
		},
	};

	const out = join(outDir, "worker-needed-replay-e2e.json");
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify({ ok: true, out, gold: result.gold, label_reason: result.label_reason, arms: result.arms.map(a => `${a.arm}:${a.pass}`), ingest: ingestJson }, null, 2));
}

await main();
