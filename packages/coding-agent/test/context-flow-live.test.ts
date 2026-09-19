import { describe, expect, it } from "bun:test";
import { getContextFlowRegistry } from "../src/context-flow/registry";
import {
	contextFlowRlmGrants,
	contextFlowRlmSpill,
	contextFlowRlmWorkerBegin,
	contextFlowRlmWorkerComplete,
	contextFlowRlmWorkerSkipped,
	contextFlowRootBegin,
	contextFlowRootComplete,
	FLOW_KEYS,
} from "../src/context-flow/rlm-flow";
import { contextFlowBeginTurn } from "../src/context-flow/hooks";
import { buildContextFlowSnapshot } from "../src/context-flow/snapshot";
import { RlmStore } from "../src/rlm/store";
import type { RlmRecord } from "../src/rlm/store";

const breakdown = {
	model: undefined,
	contextWindow: 200_000,
	categories: [],
	usedTokens: 1000,
	autoCompactBufferTokens: 0,
	freeTokens: 199_000,
};

function waitMicrotask(): Promise<void> {
	return new Promise(resolve => queueMicrotask(resolve));
}

describe("context-flow live transitions", () => {
	it("spill updates offload snapshot", () => {
		const owner = {};
		contextFlowBeginTurn(owner, "hello");
		contextFlowRlmSpill(owner, {
			id: "1",
			bytes: 184_000,
			sha256: "abc",
			text: "x",
			source: "grep",
		});
		const snap = buildContextFlowSnapshot({ registry: getContextFlowRegistry(owner), breakdown });
		expect(snap.nodes.some(n => n.component === FLOW_KEYS.RLM_SPILL)).toBe(true);
	});

	it("search/grant updates flow nodes", () => {
		const owner = {};
		const store = new RlmStore();
		contextFlowRlmGrants(owner, { grantedBytes: 4200, grantCount: 3, grantedTokens: 1050 }, store);
		const snap = buildContextFlowSnapshot({ registry: getContextFlowRegistry(owner), breakdown, rlmMetrics: store.metrics });
		expect(snap.nodes.some(n => n.component === FLOW_KEYS.RLM_GRANTS)).toBe(true);
		expect(snap.offload.grantedTokens).toBeGreaterThan(0);
	});

	it("worker running then complete", () => {
		const owner = {};
		const store = new RlmStore();
		contextFlowRlmWorkerBegin(owner, { component: FLOW_KEYS.RLM_CODEC, grantedBytes: 4200, inputTokens: 1050 });
		let snap = getContextFlowRegistry(owner).snapshot();
		expect(snap.nodes.some(n => n.component === FLOW_KEYS.RLM_CODEC && n.status === "running")).toBe(true);
		contextFlowRlmWorkerComplete(
			owner,
			{ component: FLOW_KEYS.RLM_CODEC, inputTokens: 4200, outputTokens: 318, durationMs: 812, provider: "groq", model: "gpt-oss-20b" },
			store,
		);
		snap = getContextFlowRegistry(owner).snapshot();
		expect(snap.nodes.some(n => n.component === FLOW_KEYS.RLM_CODEC && n.status === "complete")).toBe(true);
	});

	it("worker skipped", () => {
		const owner = {};
		const store = new RlmStore();
		contextFlowRlmWorkerSkipped(owner, FLOW_KEYS.RLM_WORKER, "no search hits", store);
		const snap = getContextFlowRegistry(owner).snapshot();
		expect(snap.nodes.some(n => n.status === "skipped")).toBe(true);
	});

	it("root running then complete", () => {
		const owner = {};
		contextFlowRootBegin(owner, "anthropic", "claude");
		let snap = getContextFlowRegistry(owner).snapshot();
		expect(snap.nodes.some(n => n.component === FLOW_KEYS.ROOT && n.status === "running")).toBe(true);
		contextFlowRootComplete(owner, { provider: "anthropic", model: "claude", inputTokens: 7800, outputTokens: 400, durationMs: 1200 });
		snap = getContextFlowRegistry(owner).snapshot();
		expect(snap.nodes.some(n => n.component === FLOW_KEYS.ROOT && n.status === "complete")).toBe(true);
	});

	it("failed worker marks failed status", () => {
		const owner = {};
		const store = new RlmStore();
		contextFlowRlmWorkerBegin(owner, { component: FLOW_KEYS.RLM_WORKER, grantedBytes: 1000 });
		contextFlowRlmWorkerComplete(owner, { component: FLOW_KEYS.RLM_WORKER, failed: true, durationMs: 10 }, store);
		const snap = getContextFlowRegistry(owner).snapshot();
		expect(snap.nodes.some(n => n.component === FLOW_KEYS.RLM_WORKER && n.status === "failed")).toBe(true);
	});

	it("rapid events coalesce listener notifications", async () => {
		const owner = {};
		const reg = getContextFlowRegistry(owner);
		let calls = 0;
		reg.subscribe(() => {
			calls += 1;
		});
		for (let i = 0; i < 20; i++) {
			reg.recordInstant({
				stage: "context_manager",
				component: `omp.rlm.tick-${i}`,
				role: "search",
				visibility: "externalized",
				durationMs: 0,
			});
		}
		expect(calls).toBe(0);
		await waitMicrotask();
		expect(calls).toBe(1);
		expect(reg.revision).toBeGreaterThan(15);
	});

	it("RLM disabled leaves registry idle without bind", () => {
		const owner = {};
		const snap = buildContextFlowSnapshot({ registry: getContextFlowRegistry(owner), breakdown });
		expect(snap.nodes.length).toBe(0);
	});

	it("store flow hook fires spill without session bind", () => {
		const owner = {};
		const store = new RlmStore();
		store.flowHooks = {
			onSpill: (record: RlmRecord) => contextFlowRlmSpill(owner, record),
		};
		store.put("x".repeat(30_000), "tool");
		expect(getContextFlowRegistry(owner).snapshot().nodes.some(n => n.component === FLOW_KEYS.RLM_SPILL)).toBe(true);
	});

	it("explorer closed: subscribe with zero listeners is cheap", () => {
		const owner = {};
		const reg = getContextFlowRegistry(owner);
		const before = reg.revision;
		reg.recordInstant({
			stage: "prompt",
			component: "omp.user",
			role: "ingress",
			visibility: "root",
			durationMs: 0,
		});
		expect(reg.revision).toBe(before + 1);
	});
});
