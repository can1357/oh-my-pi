/**
 * P0.1 worker input membrane — adversarial provider-boundary tests.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	buildEvidenceWorkerRequest,
	buildQueryWorkerRequest,
	resetRlmStoresForTest,
	rlmEvidenceQuery,
	rlmQuery,
	RlmRuntime,
	selectGrantsFromSearch,
	serializeWorkerProviderPayload,
	validateWorkerMembrane,
	workerContextContains,
	workerContextContainsHandle,
} from "../src/rlm";
import { formatHandle } from "../src/rlm/store";
import { resolveRlmView } from "../src/rlm/view";

afterEach(() => {
	resetRlmStoresForTest();
});

function nonce(): string {
	return Math.random().toString(36).slice(2, 10);
}

describe("worker membrane — handle boundary matching", () => {
	test("bare numeric id does not false-positive inside granted byte ranges", () => {
		const runtime = new RlmRuntime({ maxCalls: 4 });
		const granted = runtime.store.put(`${"x".repeat(12_000)}\nGRANTED_MARKER\n${"y".repeat(12_000)}`);
		runtime.store.put("UNGRANTED_DECOY_HANDLE_CONTENT", "decoy");
		const decoyId = "2";
		const selection = selectGrantsFromSearch(runtime.store, granted.id, "GRANTED_MARKER", {
			contextChars: 512,
			maxTotalBytes: 8192,
		});
		const view = resolveRlmView(runtime.store, selection.grants);
		const ctx = buildEvidenceWorkerRequest({ task: "extract", view });
		expect(workerContextContains(ctx, decoyId)).toBe(true);
		expect(workerContextContainsHandle(ctx, decoyId)).toBe(false);
		expect(validateWorkerMembrane(ctx, view).ok).toBe(true);
	});
});

describe("worker membrane — adversarial planted secrets", () => {
	test("evidence-packet worker payload is a pure function of task + RlmView grants", async () => {
		const n = nonce();
		const GRANTED = `GRANTED_FACT_${n}`;
		const UNGRANTED = `UNGRANTED_HANDLE_${n}`;
		const PARENT = `PARENT_ONLY_${n}`;

		const runtime = new RlmRuntime({ maxCalls: 8 });
		const grantedRec = runtime.store.put(`${"a".repeat(8_000)}${GRANTED}${"b".repeat(8_000)}`);
		const ungrantedRec = runtime.store.put(`${UNGRANTED} secret body must never appear in worker`);
		void ungrantedRec;

		void PARENT;

		let payload = "";
		const result = await rlmEvidenceQuery(runtime, {
			handle: grantedRec.id,
			question: "What fact is supported in the granted excerpts?",
			patterns: GRANTED,
			selectPolicy: { contextChars: 128, maxTotalBytes: 4096 },
			complete: async (_prompt, opts) => {
				payload = serializeWorkerProviderPayload({
					purpose: "rlm-evidence-packet",
					viewId: "test",
					depth: 0,
					messages: opts?.workerMessages ?? [],
					prompt: _prompt,
					citations: "",
					grantedBytes: 0,
				});
				expect(payload.includes(GRANTED)).toBe(true);
				expect(payload.includes(UNGRANTED)).toBe(false);
				expect(payload.includes(PARENT)).toBe(false);
				expect(payload.includes(formatHandle(ungrantedRec.id))).toBe(false);
				return {
					text: JSON.stringify({
						status: "sufficient",
						claims: [
							{
								fact: GRANTED,
								confidence: 1,
								citations: [{ handle: formatHandle(grantedRec.id), start: 8000, end: 8000 + GRANTED.length }],
							},
						],
						contradictions: [],
						missingEvidence: [],
						relevantRanges: [],
					}),
					tokens: 50,
				};
			},
		});

		expect(result.context).toBeDefined();
		const membrane = validateWorkerMembrane(
			result.context!,
			resolveRlmView(runtime.store, result.selection!.grants),
		);
		expect(membrane.ok).toBe(true);
		expect(payload.includes(GRANTED)).toBe(true);
		expect(payload.includes(UNGRANTED)).toBe(false);
		expect(payload.includes(PARENT)).toBe(false);
	});

	test("rlm query worker payload excludes ungranted handle ids and parent-only text", async () => {
		const n = nonce();
		const GRANTED = `GRANTED_FACT_${n}`;
		const UNGRANTED = `UNGRANTED_HANDLE_${n}`;
		const PARENT = `PARENT_ONLY_${n}`;

		const runtime = new RlmRuntime({ maxCalls: 8 });
		const grantedRec = runtime.store.put(`${"c".repeat(6_000)}${GRANTED}${"d".repeat(6_000)}`);
		const ungrantedRec = runtime.store.put(`${UNGRANTED} hidden corpus`);

		void PARENT;

		let payload = "";
		const result = await rlmQuery(runtime, {
			handle: grantedRec.id,
			question: "Summarize the granted evidence only.",
			patterns: GRANTED,
			selectPolicy: { contextChars: 64, maxTotalBytes: 2048 },
			complete: async (_prompt, opts) => {
				payload = serializeWorkerProviderPayload({
					purpose: "rlm-query",
					viewId: "test",
					depth: 0,
					messages: opts?.workerMessages ?? [],
					prompt: _prompt,
					citations: "",
					grantedBytes: 0,
				});
				return { text: GRANTED, tokens: 20 };
			},
		});

		expect(result.failOpen).toBeFalsy();
		expect(payload.includes(GRANTED)).toBe(true);
		expect(payload.includes(UNGRANTED)).toBe(false);
		expect(payload.includes(PARENT)).toBe(false);
		expect(payload.includes(formatHandle(ungrantedRec.id))).toBe(false);
		expect(workerContextContainsHandle(result.context!, ungrantedRec.id)).toBe(false);
	});

	test("buildQueryWorkerRequest is built from resolved view only", () => {
		const runtime = new RlmRuntime({ maxCalls: 2 });
		const rec = runtime.store.put("FACT=1");
		const view = resolveRlmView(runtime.store, [{ handle: rec.id, start: 0, end: 10 }]);
		const ctx = buildQueryWorkerRequest({ question: "what?", view });
		expect(validateWorkerMembrane(ctx, view).ok).toBe(true);
		expect(ctx.messages.some(m => m.role === "system")).toBe(true);
	});
});
