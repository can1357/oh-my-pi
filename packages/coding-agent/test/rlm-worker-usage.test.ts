import { afterEach, describe, expect, test } from "bun:test";
import {
	brokerResultUsageFields,
	extractWorkerUsageFromCompleter,
	resolveCompleterTotalTokens,
	workerUsageToQueryFields,
	resetRlmStoresForTest,
	rlmEvidenceQuery,
	RlmRuntime,
} from "../src/rlm";
import { executeLeasedCompletion, buildQueryWorkerRequest } from "../src/rlm/broker";
import { resolveRlmView } from "../src/rlm/view";
import { LIVE_FIXTURES } from "../evals/rlm/lib/live-groq-common";

afterEach(() => resetRlmStoresForTest());

describe("worker usage helpers", () => {
	test("extractWorkerUsageFromCompleter marks provider-reported output-only usage", () => {
		const usage = extractWorkerUsageFromCompleter(
			{ outputTokens: 42, provider: "openrouter", model: "openrouter/free" },
			999,
		);
		expect(usage.providerReported).toBe(true);
		expect(usage.source).toBe("provider");
		expect(usage.outputTokens).toBe(42);
		expect(workerUsageToQueryFields(usage)).toMatchObject({
			outputTokens: 42,
			workerUsageKnown: true,
			workerUsageSource: "provider",
		});
	});

	test("string completer falls back to lease estimate", () => {
		const usage = extractWorkerUsageFromCompleter("plain text", 512);
		expect(usage.providerReported).toBe(false);
		expect(usage.source).toBe("lease_estimate");
		expect(usage.totalTokens).toBe(512);
		expect(workerUsageToQueryFields(usage).workerUsageKnown).toBe(false);
	});

	test("resolveCompleterTotalTokens prefers explicit total then io sum", () => {
		expect(resolveCompleterTotalTokens({ tokens: 100, inputTokens: 1, outputTokens: 2 }, 9)).toBe(100);
		expect(resolveCompleterTotalTokens({ inputTokens: 10, outputTokens: 5 }, 9)).toBe(15);
		expect(resolveCompleterTotalTokens("x", 77)).toBe(77);
	});

	test("brokerResultUsageFields passthrough", () => {
		expect(
			brokerResultUsageFields({
				tokens: 10,
				cost: 0.01,
				inputTokens: 6,
				outputTokens: 4,
				workerUsageKnown: true,
				workerUsageSource: "provider",
			}),
		).toMatchObject({
			tokens: 10,
			cost: 0.01,
			inputTokens: 6,
			outputTokens: 4,
			workerUsageKnown: true,
			workerUsageSource: "provider",
		});
	});
});

describe("broker usage propagation", () => {
	test("executeLeasedCompletion surfaces provider usage on broker result", async () => {
		const runtime = new RlmRuntime({ maxCalls: 4 });
		const rec = runtime.store.put("needle=CAUSAL_TAIL_EVIDENCE_9f3a suffix");
		const view = resolveRlmView(runtime.store, [{ handle: rec.id, start: 0, end: 40 }]);
		const worker = buildQueryWorkerRequest({ question: "q", view });
		const result = await executeLeasedCompletion(
			runtime,
			worker,
			async () => ({
				text: "answer",
				inputTokens: 100,
				outputTokens: 25,
				tokens: 125,
				cost: 0.002,
				provider: "groq",
				model: "llama-3.3-70b",
			}),
			"query",
		);
		expect(result.workerUsageKnown).toBe(true);
		expect(result.workerUsageSource).toBe("provider");
		expect(result.inputTokens).toBe(100);
		expect(result.outputTokens).toBe(25);
		expect(result.tokens).toBe(125);
	});
});

describe("grant-repair usage attribution", () => {
	test("evidence query keeps worker usage when grant repair replaces bad packet", async () => {
		const runtime = new RlmRuntime({ maxCalls: 4 });
		const fixture = LIVE_FIXTURES.find(f => f.id === "S2_contradictory")!;
		const rec = runtime.store.put(fixture.buildCorpus(), fixture.id);
		const result = await rlmEvidenceQuery(runtime, {
			handle: rec.id,
			question: fixture.question,
			patterns: fixture.patterns,
			complete: async () => ({
				text: "not valid evidence packet json",
				inputTokens: 300,
				outputTokens: 80,
				tokens: 380,
				cost: 0.001,
				provider: "groq",
				model: "test-model",
			}),
		});
		expect(result.workerSkipped).toBe(false);
		expect(result.workerUsageKnown).toBe(true);
		expect(result.inputTokens).toBe(300);
		expect(result.outputTokens).toBe(80);
		expect(result.grantRepairUsed).toBe(true);
		expect(result.packet?.atoms.length).toBeGreaterThan(0);
	});
});
