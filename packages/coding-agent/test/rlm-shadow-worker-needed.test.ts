/**
 * Observe-only Decider shadow for rlm.worker_needed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCurrentTurnFlow } from "../src/context-flow/format";
import { contextFlowBeginTurn } from "../src/context-flow/hooks";
import { contextFlowDeciderShadow, contextFlowRlmAutoGate, FLOW_KEYS } from "../src/context-flow/rlm-flow";
import { getContextFlowRegistry } from "../src/context-flow/registry";
import { buildContextFlowSnapshot } from "../src/context-flow/snapshot";
import {
	actualPolicyToLabel,
	buildWorkerNeededFeatureState,
	createBridgeDeciderPredictor,
	createMockShadowPredictor,
	registerZ0intBridgeTransport,
	runShadowWorkerNeeded,
	setShadowPredictorForTest,
	SHADOW_EXPERIMENT_ID,
} from "../src/rlm/shadow";
import { createTokenomicsBridge } from "../src/rlm/tokenomics-bridge";
import { classifyGrantComplexity } from "../src/rlm/worker-mode-policy";

const breakdown = {
	model: undefined,
	contextWindow: 200_000,
	categories: [],
	usedTokens: 1000,
	autoCompactBufferTokens: 0,
	freeTokens: 199_000,
};

afterEach(() => {
	setShadowPredictorForTest(null);
});

describe("rlm.worker_needed shadow features", () => {
	test("feature state never embeds raw question text", () => {
		const question = "SECRET_USER_PROMPT find pool limit";
		const { complexity } = classifyGrantComplexity({
			grantedBytes: 900,
			grantCount: 2,
			patternCount: 2,
			patterns: ["max_connections", "pool_limit"],
			question,
			grantTextSample: "max_connections=10 pool_limit=5",
		});
		const state = buildWorkerNeededFeatureState({
			policyInput: {
				grantedBytes: 900,
				grantCount: 2,
				patternCount: 2,
				patterns: ["max_connections", "pool_limit"],
				question,
			},
			complexity,
		});
		const blob = JSON.stringify(state);
		expect(blob.includes("SECRET_USER_PROMPT")).toBe(false);
		expect(state.question_sha256).toHaveLength(64);
		expect(state.complexity_class).toBe("contradictory_evidence");
	});

	test("actual policy mapping", () => {
		expect(actualPolicyToLabel(false)).toBe("native");
		expect(actualPolicyToLabel(true)).toBe("worker");
	});
});

describe("shadow telemetry fail-open", () => {
	test("prediction never changes useEvidence decision (caller supplies it)", async () => {
		setShadowPredictorForTest(
			createMockShadowPredictor(() => ({
				status: "ok",
				prediction: "worker",
				probabilities: { worker: 0.9, native: 0.05, abstain: 0.05 },
				confidence: 0.9,
				latencyMs: 12,
			})),
		);
		const dir = mkdtempSync(join(tmpdir(), "omp-shadow-tm-"));
		const bridge = createTokenomicsBridge({
			sessionId: "shadow-test-1",
			dir,
			memoryOnly: true,
			contextPolicy: "rlm-search-grants",
			enabled: true,
		});
		const useEvidencePacket = false; // policy chose native
		const result = await runShadowWorkerNeeded({
			host: {
				getTokenomicsBridge: () => bridge,
				settings: { get: (p: string) => (p === "rlm.shadow.workerNeeded" ? true : undefined) },
				getSessionId: () => "shadow-test-1",
			},
			policyInput: {
				grantedBytes: 200,
				grantCount: 1,
				patternCount: 1,
				patterns: ["root_cause"],
				question: "what is root_cause",
			},
			useEvidencePacket,
			handle: "rlm://h/1",
		});
		expect(result.launched).toBe(true);
		expect(result.actualPolicy).toBe("native");
		expect(result.prediction?.prediction).toBe("worker");
		expect(result.disagreed).toBe(true);
		// Caller still owns useEvidencePacket — shadow did not mutate it.
		expect(useEvidencePacket).toBe(false);

		const kinds = bridge.events.map(e => `${e.kind}:${e.name}`);
		expect(kinds).toContain("decision:omp.shadow.rlm.worker_needed");
		expect(kinds).toContain("decision:omp.policy.rlm.worker_needed");
		expect(kinds).toContain("verification:omp.shadow.rlm.worker_needed.gold");
		const shadow = bridge.events.find(e => e.name === "omp.shadow.rlm.worker_needed");
		expect(shadow?.trace_id).toBe(bridge.traceId);
		expect(shadow?.experiment?.selection_policy).toBe("shadow");
		expect(shadow?.experiment?.experiment_id).toBe(SHADOW_EXPERIMENT_ID);
		expect(shadow?.attributes?.["decision.shadow"]).toBe(true);
		expect(JSON.stringify(shadow).includes("what is root_cause")).toBe(false);

		const gold = bridge.events.find(e => e.name === "omp.shadow.rlm.worker_needed.gold");
		expect(gold?.status).toBe("unknown");
		expect(gold?.attributes?.["decision.gold_status"]).toBe("unknown");
		rmSync(dir, { recursive: true, force: true });
	});

	test("backend failure / timeout does not throw and still records events", async () => {
		setShadowPredictorForTest(
			createMockShadowPredictor(() => ({
				status: "cancelled",
				errorClass: "Timeout",
				reason: "shadow decider exceeded 1ms",
				latencyMs: 2,
			})),
		);
		const bridge = createTokenomicsBridge({
			sessionId: "shadow-test-timeout",
			memoryOnly: true,
			enabled: true,
		});
		const result = await runShadowWorkerNeeded({
			host: {
				getTokenomicsBridge: () => bridge,
				settings: { get: () => true },
				getSessionId: () => "shadow-test-timeout",
			},
			policyInput: {
				grantedBytes: 100,
				grantCount: 1,
				patternCount: 0,
				patterns: [],
				question: "x",
			},
			useEvidencePacket: true,
			handle: "rlm://h/2",
		});
		expect(result.launched).toBe(true);
		expect(result.prediction?.status).toBe("cancelled");
		expect(result.actualPolicy).toBe("worker");
		expect(bridge.events.some(e => e.name === "omp.shadow.rlm.worker_needed")).toBe(true);
	});

	test("later gold verification joins same trace", async () => {
		setShadowPredictorForTest(
			createMockShadowPredictor(() => ({
				status: "ok",
				prediction: "native",
				confidence: 0.8,
				probabilities: { native: 0.8, worker: 0.15, abstain: 0.05 },
				latencyMs: 5,
			})),
		);
		const bridge = createTokenomicsBridge({
			sessionId: "shadow-test-gold",
			memoryOnly: true,
			enabled: true,
		});
		const first = await runShadowWorkerNeeded({
			host: {
				getTokenomicsBridge: () => bridge,
				settings: { get: () => true },
				getSessionId: () => "shadow-test-gold",
			},
			policyInput: {
				grantedBytes: 8000,
				grantCount: 1,
				patternCount: 1,
				patterns: ["needle"],
				question: "exact needle",
			},
			useEvidencePacket: false,
			handle: "rlm://h/3",
		});
		expect(first.pairId).toBeTruthy();
		await bridge.emitShadowWorkerNeededGold({
			pairId: first.pairId!,
			gold: "native",
			correct: true,
			verificationSource: "paired_replay",
		});
		const golds = bridge.events.filter(e => e.name === "omp.shadow.rlm.worker_needed.gold");
		expect(golds.length).toBeGreaterThanOrEqual(2);
		const known = golds.find(e => e.attributes?.["decision.gold_status"] === "known");
		expect(known?.trace_id).toBe(bridge.traceId);
		expect(known?.outcome?.verification_source).toBe("paired_replay");
	});
});

describe("context flow shadow rendering", () => {
	test("marks Decider node as SHADOW and does not imply authority", () => {
		const owner = {};
		contextFlowBeginTurn(owner, "hello");
		contextFlowRlmAutoGate(owner, { flowDecision: "D · multi_region", reason: "test" });
		contextFlowDeciderShadow(owner, {
			prediction: "worker",
			confidence: 0.87,
			latencyMs: 54,
			status: "ok",
			runtime: { residency: "warm", inferenceMs: 57 },
		});
		const snap = buildContextFlowSnapshot({
			registry: getContextFlowRegistry(owner),
			breakdown,
		});
		const node = snap.nodes.find(n => n.component === FLOW_KEYS.DECIDER_SHADOW);
		expect(node).toBeTruthy();
		expect(node?.visibility).toBe("shadow");
		expect(node?.decision?.startsWith("SHADOW")).toBe(true);
		const text = renderCurrentTurnFlow(snap);
		expect(text).toContain("Decider shadow");
		expect(text).toContain("SHADOW");
		expect(text).toContain("resident");
		expect(text).not.toMatch(/Decider shadow.*caused/i);
	});
});

describe("bridge transport shadow client", () => {
	test("absent bridge is unavailable without spawning python", async () => {
		registerZ0intBridgeTransport(null);
		setShadowPredictorForTest(null);
		const predictor = createBridgeDeciderPredictor();
		const pred = await predictor(
			{
				schema: "omp.shadow.rlm.worker_needed.features.v1",
				capability: "rlm.worker_needed",
				contract: "decision-capability-v1",
				state: {
					granted_bytes: 100,
					pattern_hits: 1,
					grant_count: 1,
					complexity: "low",
					complexity_class: "simple_single_fact",
					question_sha256: "a".repeat(64),
					question_chars: 3,
				},
				question: {
					id: "decision",
					type: "choice",
					instructions: "x",
					options: [
						{ id: "native", description: "n" },
						{ id: "worker", description: "w" },
						{ id: "abstain", description: "a" },
					],
				},
			},
			{ timeoutMs: 200 },
		);
		expect(pred.status).toBe("unavailable");
		expect(pred.runtime?.residency).toBe("absent");
	});

	test("warming status is fail-open and non-authoritative", async () => {
		registerZ0intBridgeTransport({
			kind: "z0int-bridge",
			request: async () => ({
				ok: false,
				status: "warming",
				backend: "decider_2b",
				error: "backend_warming",
				generation: 3,
				build_id: "deadbeef",
				runtime: { residency: "warming", queue_ms: 0 },
			}),
		});
		setShadowPredictorForTest(null);
		const bridge = createTokenomicsBridge({
			sessionId: "shadow-warm",
			memoryOnly: true,
			enabled: true,
		});
		const result = await runShadowWorkerNeeded({
			host: {
				getTokenomicsBridge: () => bridge,
				settings: { get: () => true },
				getSessionId: () => "shadow-warm",
			},
			policyInput: {
				grantedBytes: 100,
				grantCount: 1,
				patternCount: 0,
				patterns: [],
				question: "x",
			},
			useEvidencePacket: true,
			handle: "rlm://h/w",
		});
		expect(result.launched).toBe(true);
		expect(result.prediction?.status).toBe("warming");
		expect(result.actualPolicy).toBe("worker");
		const shadow = bridge.events.find(e => e.name === "omp.shadow.rlm.worker_needed");
		expect(shadow?.attributes?.["shadow.runtime"]).toBe("warming");
		registerZ0intBridgeTransport(null);
	});

	test("resident ok path records inference diagnostics", async () => {
		registerZ0intBridgeTransport({
			kind: "z0int-bridge",
			request: async () => ({
				ok: true,
				status: "ok",
				backend: "decider_2b",
				generation: 2,
				build_id: "abc123",
				result: {
					answers: [
						{
							value: "native",
							confidence: 0.81,
							probabilities: { native: 0.81, worker: 0.1, abstain: 0.09 },
						},
					],
					revision: "rev",
					diagnostics: { device: "cuda" },
				},
				runtime: {
					residency: "warm",
					backend_loaded: true,
					inference_ms: 57,
					queue_ms: 1.2,
					load_ms: 34000,
				},
			}),
		});
		setShadowPredictorForTest(null);
		const bridge = createTokenomicsBridge({
			sessionId: "shadow-resident",
			memoryOnly: true,
			enabled: true,
		});
		const result = await runShadowWorkerNeeded({
			host: {
				getTokenomicsBridge: () => bridge,
				settings: { get: () => true },
				getSessionId: () => "shadow-resident",
			},
			policyInput: {
				grantedBytes: 8000,
				grantCount: 1,
				patternCount: 1,
				patterns: ["root_cause"],
				question: "exact",
			},
			useEvidencePacket: false,
			handle: "rlm://h/r",
		});
		expect(result.prediction?.status).toBe("ok");
		expect(result.prediction?.runtime?.residency).toBe("warm");
		expect(result.prediction?.runtime?.inferenceMs).toBe(57);
		const shadow = bridge.events.find(e => e.name === "omp.shadow.rlm.worker_needed");
		expect(shadow?.attributes?.["shadow.runtime"]).toBe("resident");
		expect(shadow?.attributes?.["shadow.inference_ms"]).toBe(57);
		expect(shadow?.attributes?.["shadow.bridge_generation"]).toBe(2);
		registerZ0intBridgeTransport(null);
	});
});
