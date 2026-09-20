import { describe, expect, it } from "bun:test";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { type ContextBreakdown, renderContextUsage } from "@oh-my-pi/pi-tui/status-line/context-usage";
import {
	CONTEXT_SAVINGS_EMPTY,
	CURRENT_TURN_EMPTY,
	renderContextSavings,
	renderContextUsagePage,
	renderCurrentTurnFlow,
	renderFullContextExplorer,
} from "../src/context-flow/format";
import { contextFlowBeginTurn, contextFlowSeedResearchStack } from "../src/context-flow/hooks";
import {
	contextFlowRlmGrants,
	contextFlowRlmWorkerBegin,
	contextFlowRlmWorkerComplete,
	contextFlowRootBegin,
	FLOW_KEYS,
} from "../src/context-flow/rlm-flow";
import { buildContextFlowSnapshot } from "../src/context-flow/snapshot";
import { getContextFlowRegistry } from "../src/context-flow/registry";
import type { ContextFlowSnapshot } from "../src/context-flow/types";
import { RlmStore } from "../src/rlm/store";

initTheme();

const breakdown: ContextBreakdown = {
	model: undefined,
	contextWindow: 200_000,
	categories: [
		{ id: "systemPrompt" as const, label: "System prompt", tokens: 4800, color: "accent", glyph: "⛁" },
		{ id: "systemTools" as const, label: "System tools", tokens: 15_000, color: "warning", glyph: "⛁" },
		{ id: "systemContext" as const, label: "System context", tokens: 9400, color: "success", glyph: "⛁" },
		{ id: "skills" as const, label: "Skills", tokens: 3600, color: "customMessageLabel", glyph: "⛁" },
		{ id: "messages" as const, label: "Messages", tokens: 1200, color: "userMessageText", glyph: "⛃" },
	],
	usedTokens: 33_000,
	autoCompactBufferTokens: 30_000,
	freeTokens: 137_000,
};

function snapshotFor(owner: object, store?: RlmStore) {
	return buildContextFlowSnapshot({
		registry: getContextFlowRegistry(owner),
		breakdown,
		rlmMetrics: store?.metrics,
	});
}

/** Economics-on, savings/turn-empty — matches the failing live screenshot shape. */
function economicsOnlyFlow(): ContextFlowSnapshot {
	return {
		turn: 1,
		updatedAt: Date.now(),
		nodes: [
			{
				id: "n1",
				turn: 1,
				stage: "prompt",
				component: "omp.user",
				role: "user",
				visibility: "root",
				status: "complete",
				startedAt: Date.now(),
			},
		],
		offload: { externalBytes: 0, reintroducedTokens: 0, grantedTokens: 0, active: false },
		economics: {
			rootTokens: 61_200,
			workerTokens: 0,
			subagentTokens: 0,
			cachedTokens: 0,
			unattributedTokens: 0,
			totalIncrementalTokens: 61_200,
			costUsd: 0.12,
			tokenomicsEnabled: true,
		},
		wiring: {},
	};
}

describe("context-flow unified /context page", () => {
	it("empty live state still renders Context savings + Current turn headers", () => {
		const owner = {};
		contextFlowBeginTurn(owner, "hello");
		const flow = snapshotFor(owner);
		expect(renderContextSavings(flow)).toBe(CONTEXT_SAVINGS_EMPTY);
		expect(renderCurrentTurnFlow(flow)).toBe(CURRENT_TURN_EMPTY);
		const page = renderContextUsagePage(breakdown, theme, flow);
		expect(page).toContain("Context savings");
		expect(page).toContain(CONTEXT_SAVINGS_EMPTY);
		expect(page).toContain("Current turn");
		expect(page).toContain(CURRENT_TURN_EMPTY);
		expect(page.startsWith(renderContextUsage(breakdown, theme))).toBe(true);
	});

	it("economics-only live model still shows structural sections (screenshot shape)", () => {
		const flow = economicsOnlyFlow();
		const page = renderContextUsagePage(breakdown, theme, flow);
		expect(page).toContain("Context savings");
		expect(page).toContain(CONTEXT_SAVINGS_EMPTY);
		expect(page).toContain("Current turn");
		expect(page).toContain(CURRENT_TURN_EMPTY);
		expect(page).toContain("Session economics");
		expect(page).toContain("61.2k");
	});

	it("populated fixture renders savings lineage and current-turn pipeline", () => {
		const owner = {};
		const store = new RlmStore();
		contextFlowBeginTurn(owner, "hello");
		contextFlowRlmGrants(owner, { grantedBytes: 4200, grantCount: 2, grantedTokens: 4200 }, store);
		getContextFlowRegistry(owner).updateOffload({
			externalBytes: 184_000,
			reintroducedTokens: 318,
			grantedTokens: 4200,
			active: true,
		});
		contextFlowRlmWorkerBegin(owner, { component: FLOW_KEYS.RLM_CODEC, grantedBytes: 4200, inputTokens: 4200 });
		contextFlowRlmWorkerComplete(
			owner,
			{ component: FLOW_KEYS.RLM_CODEC, inputTokens: 4200, outputTokens: 318, durationMs: 812 },
			store,
		);
		contextFlowRootBegin(owner, "anthropic", "claude");
		const flow = snapshotFor(owner, store);
		const page = renderContextUsagePage(breakdown, theme, flow);
		expect(page).toContain("Context savings");
		expect(page).toContain("RLM");
		expect(page).toMatch(/46\.0k → 4\.2k → 318/);
		expect(page).toContain("Current turn");
		expect(page).toContain("↓");
		expect(page).not.toContain(CONTEXT_SAVINGS_EMPTY);
		expect(page).not.toContain(CURRENT_TURN_EMPTY);
	});

	it("RLM active: savings section appears below root grid", () => {
		const owner = {};
		const store = new RlmStore();
		contextFlowBeginTurn(owner, "hello");
		contextFlowRlmGrants(owner, { grantedBytes: 4200, grantCount: 2, grantedTokens: 4200 }, store);
		getContextFlowRegistry(owner).updateOffload({
			externalBytes: 184_000,
			reintroducedTokens: 318,
			grantedTokens: 4200,
			active: true,
		});
		const flow = snapshotFor(owner, store);
		const page = renderContextUsagePage(breakdown, theme, flow);
		expect(page).toContain("Context savings");
		expect(page).toContain("RLM");
		expect(page).toContain("Kept out of root");
		expect(page.startsWith(renderContextUsage(breakdown, theme))).toBe(true);
	});

	it("RLM + Groq: pipeline visible in savings and current turn", () => {
		const owner = {};
		const store = new RlmStore();
		contextFlowBeginTurn(owner, "hello");
		contextFlowRlmGrants(owner, { grantedBytes: 4200, grantCount: 2, grantedTokens: 4200 }, store);
		getContextFlowRegistry(owner).updateOffload({
			externalBytes: 184_000,
			reintroducedTokens: 318,
			grantedTokens: 4200,
			active: true,
		});
		contextFlowRlmWorkerBegin(owner, { component: FLOW_KEYS.RLM_CODEC, grantedBytes: 4200, inputTokens: 4200 });
		contextFlowRlmWorkerComplete(
			owner,
			{ component: FLOW_KEYS.RLM_CODEC, inputTokens: 4200, outputTokens: 318, durationMs: 812 },
			store,
		);
		contextFlowRootBegin(owner, "anthropic", "claude");
		const flow = snapshotFor(owner, store);
		const page = renderContextUsagePage(breakdown, theme, flow);
		expect(page).toMatch(/codec/i);
		expect(page).toContain("Pipeline");
		expect(page).toContain("Current turn");
		expect(page).toContain("↓");
		const turn = renderCurrentTurnFlow(flow);
		expect(turn).toContain("codec");
		expect(turn).toContain("4.2k → 318 t");
	});

	it("worker running: live state in current turn", () => {
		const owner = {};
		contextFlowBeginTurn(owner, "hello");
		contextFlowRlmGrants(owner, { grantedBytes: 4200, grantCount: 2, grantedTokens: 4200 });
		contextFlowRlmWorkerBegin(owner, { component: FLOW_KEYS.RLM_CODEC, grantedBytes: 4200, inputTokens: 4200 });
		const flow = snapshotFor(owner);
		const turn = renderCurrentTurnFlow(flow);
		expect(turn).toContain("◉");
	});

	it("root running: active state in current turn", () => {
		const owner = {};
		contextFlowBeginTurn(owner, "hello");
		contextFlowRootBegin(owner, "anthropic", "claude");
		const flow = snapshotFor(owner);
		const turn = renderCurrentTurnFlow(flow);
		expect(turn).toContain("Root");
		expect(turn).toContain("◉");
	});

	it("no NOT WIRED inventory in normal /context page", () => {
		const owner = {};
		contextFlowSeedResearchStack(owner);
		contextFlowBeginTurn(owner, "hello");
		const flow = snapshotFor(owner);
		const page = renderContextUsagePage(breakdown, theme, flow);
		expect(page).not.toMatch(/NOT WIRED/i);
		expect(page).not.toMatch(/NanoJev|OpenJev|z0int|Kerdoios|fly|mushroom/);
		expect(page).not.toMatch(/Research stack/i);
	});

	it("full explorer (dev) still has wiring inventory when explicitly rendered", () => {
		const owner = {};
		contextFlowSeedResearchStack(owner);
		contextFlowBeginTurn(owner, "hello");
		const flow = snapshotFor(owner);
		const debug = renderFullContextExplorer(breakdown, flow);
		expect(debug).toMatch(/NOT WIRED|NanoJev|OpenJev/);
	});

	it("narrow terminals truncate current-turn rows cleanly", () => {
		const owner = {};
		contextFlowBeginTurn(owner, "hello");
		contextFlowRlmGrants(owner, { grantedBytes: 4200, grantCount: 2, grantedTokens: 4200 });
		contextFlowRlmWorkerBegin(owner, { component: FLOW_KEYS.RLM_CODEC, grantedBytes: 4200, inputTokens: 4200 });
		contextFlowRootBegin(owner, "anthropic", "claude");
		const flow = snapshotFor(owner);
		const turn = renderCurrentTurnFlow(flow, 24);
		expect(turn).not.toBe(CURRENT_TURN_EMPTY);
		for (const line of turn.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(24);
		}
	});
});
