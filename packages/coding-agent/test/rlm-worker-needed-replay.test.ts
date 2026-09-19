/**
 * WorkerNeededReplayV1 + paired A/B counterfactual gold labeling.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assessNonInferiority,
	createMockShadowPredictor,
	freezeWorkerNeededReplaySnapshot,
	labelFromPairedArms,
	runShadowWorkerNeeded,
	runWorkerNeededPairedReplay,
	setShadowPredictorForTest,
	scoreReplayPriority,
} from "../src/rlm/shadow";
import { createTokenomicsBridge } from "../src/rlm/tokenomics-bridge";
import { buildWorkerNeededFeatureState, featureStateHash } from "../src/rlm/shadow/worker-needed-features";
import { classifyGrantComplexity } from "../src/rlm/worker-mode-policy";

afterEach(() => {
	setShadowPredictorForTest(null);
});

describe("labelFromPairedArms", () => {
	test("matching OMP policy is irrelevant — both fail → UNKNOWN", () => {
		expect(
			labelFromPairedArms({
				nativePass: false,
				workerPass: false,
				nativeNonInferior: false,
				nativeCheaperOrFaster: false,
				reproducible: true,
				verifierAvailable: true,
			}).gold,
		).toBe("UNKNOWN");
	});

	test("native fail / worker pass → worker", () => {
		expect(
			labelFromPairedArms({
				nativePass: false,
				workerPass: true,
				nativeNonInferior: false,
				nativeCheaperOrFaster: false,
				reproducible: true,
				verifierAvailable: true,
			}).gold,
		).toBe("worker");
	});

	test("both pass without non-inferiority → UNKNOWN", () => {
		expect(
			labelFromPairedArms({
				nativePass: true,
				workerPass: true,
				nativeNonInferior: false,
				nativeCheaperOrFaster: true,
				reproducible: true,
				verifierAvailable: true,
			}).gold,
		).toBe("UNKNOWN");
	});

	test("both pass + native noninferior + cheaper → native", () => {
		expect(
			labelFromPairedArms({
				nativePass: true,
				workerPass: true,
				nativeNonInferior: true,
				nativeCheaperOrFaster: true,
				reproducible: true,
				verifierAvailable: true,
			}).gold,
		).toBe("native");
	});
});

describe("scoreReplayPriority", () => {
	test("disagreement near threshold outranks FIFO agreement", () => {
		const hot = scoreReplayPriority({
			disagrees: true,
			confidence: 0.62,
			grantedBytes: 8000,
			goldUnknown: true,
			expectedWorkerCost: 0.7,
			capabilityEvidenceGap: 0.9,
		});
		const cold = scoreReplayPriority({
			disagrees: false,
			confidence: 0.95,
			grantedBytes: 200,
			goldUnknown: false,
			expectedWorkerCost: 0.1,
			capabilityEvidenceGap: 0.1,
		});
		expect(hot.priority).toBeGreaterThan(cold.priority);
		expect(hot.reasons).toContain("shadow_disagrees_with_policy");
	});
});

describe("freeze + paired replay E2E (real rlm paths)", () => {
	test("shadow disagreement → snapshot → A0/B0/A1/B1 → gold join", async () => {
		const z0home = mkdtempSync(join(tmpdir(), "wn-z0-"));
		const prevZ0 = process.env.Z0INT_HOME;
		process.env.Z0INT_HOME = z0home;
		const replayRoot = join(z0home, "replay", "rlm-worker-needed");
		const tmDir = mkdtempSync(join(tmpdir(), "wn-tm-"));
		const evidence = `${"x".repeat(400)}\nERROR root_cause=CAUSAL_TAIL_EVIDENCE_9f3a detail=disk_full\n${"y".repeat(200)}`;
		const question = "exact root_cause token";
		const policyInput = {
			grantedBytes: Buffer.byteLength(evidence, "utf8"),
			grantCount: 1,
			patternCount: 1,
			patterns: ["root_cause"],
			question,
			grantTextSample: evidence.slice(0, 4096),
		};

		setShadowPredictorForTest(
			createMockShadowPredictor(() => ({
				status: "ok",
				prediction: "worker",
				confidence: 0.62,
				probabilities: { worker: 0.62, native: 0.3, abstain: 0.08 },
				latencyMs: 18,
			})),
		);

		const sessionId = "replay-e2e-session-1";
		const bridge = createTokenomicsBridge({
			sessionId,
			dir: tmDir,
			enabled: true,
			contextPolicy: "rlm-search-grants",
		});

		const shadow = await runShadowWorkerNeeded({
			host: {
				getTokenomicsBridge: () => bridge,
				settings: { get: (p: string) => (p === "rlm.shadow.workerNeeded" ? true : undefined) },
				getSessionId: () => sessionId,
			},
			policyInput,
			useEvidencePacket: false,
			handle: "rlm://h/live",
			grantedEvidence: evidence,
		});
		expect(shadow.launched).toBe(true);
		expect(shadow.disagreed).toBe(true);
		expect(shadow.enqueuedReplay).toBe(true);
		expect(shadow.replaySnapshotId).toBeTruthy();

		const pending = bridge.events.find(e => e.name === "omp.shadow.rlm.worker_needed.gold");
		expect(pending?.attributes?.["decision.gold_status"]).toBe("unknown");

		const result = await runWorkerNeededPairedReplay(shadow.replaySnapshotId!, {
			joinTokenomics: true,
			bridgeFactory: () => bridge,
		});

		expect(result.arms.map(a => a.arm)).toEqual(["A0", "B0", "A1", "B1"]);
		expect(["native", "worker", "UNKNOWN"]).toContain(result.gold);
		expect(result.tokenomics_joined).toBe(true);
		expect(result.trace_id).toBe(bridge.traceId);
		expect(result.pair_id).toBe(shadow.pairId);

		const artifact = JSON.parse(readFileSync(join(replayRoot, result.snapshot_id, "result.json"), "utf8"));
		expect(artifact.experiment_id).toBe("rlm-worker-needed-replay-v1");
		expect(artifact.gold).toBe(result.gold);

		const golds = bridge.events.filter(e => e.name === "omp.shadow.rlm.worker_needed.gold");
		const known = golds.find(e => e.attributes?.["decision.gold"] === result.gold);
		expect(known).toBeTruthy();
		expect(known?.experiment?.pair_id).toBe(shadow.pairId);
		expect(known?.trace_id).toBe(bridge.traceId);
		expect(JSON.stringify(bridge.events).includes("CAUSAL_TAIL_EVIDENCE_9f3a")).toBe(false);
		expect(JSON.stringify(bridge.events).includes(question)).toBe(false);
		if (bridge.jsonlPath) {
			const eventsText = readFileSync(bridge.jsonlPath, "utf8");
			expect(eventsText.includes(result.snapshot_id)).toBe(true);
			expect(eventsText.includes("CAUSAL_TAIL_EVIDENCE_9f3a")).toBe(false);
		}

		rmSync(z0home, { recursive: true, force: true });
		rmSync(tmDir, { recursive: true, force: true });
		if (prevZ0 === undefined) delete process.env.Z0INT_HOME;
		else process.env.Z0INT_HOME = prevZ0;
	});

	test("contradictory grants: native fails verifier, worker passes → worker gold", async () => {
		const replayRoot = mkdtempSync(join(tmpdir(), "wn-replay-c-"));
		const evidence = "config max_connections=100\nruntime pool_limit=10\neffective should be 10\n";
		const policyInput = {
			grantedBytes: evidence.length,
			grantCount: 2,
			patternCount: 2,
			patterns: ["max_connections", "pool_limit"],
			question: "what is the effective limit",
			grantTextSample: evidence,
		};
		const { complexity } = classifyGrantComplexity(policyInput);
		const featureState = buildWorkerNeededFeatureState({ policyInput, complexity });
		const featureHash = featureStateHash(featureState);
		const snap = await freezeWorkerNeededReplaySnapshot(
			{
				pairId: "pair-contradict-1",
				traceId: "trace-contradict-1",
				sessionId: "sess-contradict-1",
				handle: "rlm://h/c",
				policyInput,
				featureState,
				featureHash,
				grantedEvidence: evidence,
				shadowPrediction: "worker",
				actualPolicy: "native",
				confidence: 0.8,
			},
			replayRoot,
		);
		expect(snap.verifier.token).toBe("10");

		const result = await runWorkerNeededPairedReplay(snap, {
			root: replayRoot,
			joinTokenomics: false,
			nativeCompleter: async () => ({ text: "max_connections=100", tokens: 10, inputTokens: 50, outputTokens: 10 }),
		});
		expect(result.native_aggregate.pass).toBe(false);
		expect(result.worker_aggregate.pass).toBe(true);
		expect(result.gold).toBe("worker");
		expect(result.label_reason).toBe("native_fail_worker_pass");
		rmSync(replayRoot, { recursive: true, force: true });
	});
});

describe("assessNonInferiority", () => {
	test("native slower beyond ratio is not non-inferior", () => {
		const spec = {
			kind: "contains_token" as const,
			token: "x",
			nonInferiority: { maxLatencyRatio: 1.25, maxTokenRatio: 1.15, minCostAdvantage: 0.05 },
		};
		const r = assessNonInferiority(
			{ pass: true, wallMs: 200, tokens: 100 },
			{ pass: true, wallMs: 100, tokens: 100 },
			spec,
		);
		expect(r.nonInferior).toBe(false);
	});
});
