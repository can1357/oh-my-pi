import { describe, expect, it } from "bun:test";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { type ContextBreakdown, renderContextUsage } from "@oh-my-pi/pi-tui/status-line/context-usage";
import {
	renderCompactContextAugmentation,
	renderCompactContextUsage,
	renderCompactFlowBreadcrumb,
	renderCompactOffloadLine,
	renderFullContextExplorer,
} from "../src/context-flow/format";
import { contextFlowBeginTurn, contextFlowSeedResearchStack } from "../src/context-flow/hooks";
import {
	contextFlowRlmGrants,
	contextFlowRlmWorkerBegin,
	contextFlowRootBegin,
	FLOW_KEYS,
} from "../src/context-flow/rlm-flow";
import { buildContextFlowSnapshot } from "../src/context-flow/snapshot";
import { getContextFlowRegistry } from "../src/context-flow/registry";
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

describe("context-flow compact rendering", () => {
	it("RLM off: compact augmentation is empty and grid matches original renderer", () => {
		const owner = {};
		contextFlowBeginTurn(owner, "hello");
		const flow = snapshotFor(owner);
		expect(renderCompactContextAugmentation(flow)).toEqual([]);
		expect(renderCompactContextUsage(breakdown, theme, flow)).toBe(renderContextUsage(breakdown, theme));
	});

	it("RLM active: only a few augmentation lines appear", () => {
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
		const aug = renderCompactContextAugmentation(flow);
		expect(aug.length).toBeGreaterThanOrEqual(1);
		expect(aug.length).toBeLessThanOrEqual(2);
		const compact = renderCompactContextUsage(breakdown, theme, flow);
		const lineCount = compact.split("\n").length;
		const baseCount = renderContextUsage(breakdown, theme).split("\n").length;
		expect(lineCount - baseCount).toBeLessThanOrEqual(4);
		expect(renderCompactOffloadLine(flow)).toContain("RLM");
	});

	it("Groq running: compact FLOW breadcrumb updates live", () => {
		const owner = {};
		contextFlowBeginTurn(owner, "hello");
		contextFlowRlmGrants(owner, { grantedBytes: 4200, grantCount: 2, grantedTokens: 4200 });
		contextFlowRlmWorkerBegin(owner, { component: FLOW_KEYS.RLM_CODEC, grantedBytes: 4200, inputTokens: 4200 });
		const flow = snapshotFor(owner);
		const line = renderCompactFlowBreadcrumb(flow);
		expect(line).toContain("Groq");
		expect(line).toContain("◉");
	});

	it("root running: active state appears in compact flow", () => {
		const owner = {};
		contextFlowBeginTurn(owner, "hello");
		contextFlowRootBegin(owner, "anthropic", "claude");
		const flow = snapshotFor(owner);
		const line = renderCompactFlowBreadcrumb(flow);
		expect(line).toContain("root");
		expect(line).toContain("◉");
	});

	it("no NOT WIRED components appear in normal compact output", () => {
		const owner = {};
		contextFlowSeedResearchStack(owner);
		contextFlowBeginTurn(owner, "hello");
		const flow = snapshotFor(owner);
		const compact = renderCompactContextUsage(breakdown, theme, flow);
		expect(compact).not.toMatch(/NOT WIRED/i);
		expect(compact).not.toMatch(/NanoJev|OpenJev|z0int|Kerdoios|fly|mushroom/);
	});

	it("diagnostic explorer still contains full wiring information", () => {
		const owner = {};
		contextFlowSeedResearchStack(owner);
		contextFlowBeginTurn(owner, "hello");
		const flow = snapshotFor(owner);
		const debug = renderFullContextExplorer(breakdown, flow);
		expect(debug).toMatch(/NOT WIRED|NanoJev|OpenJev/);
		expect(debug).toMatch(/FLOW/);
		expect(debug).toMatch(/OFFLOAD|ECONOMICS/);
	});

	it("narrow terminals degrade flow breadcrumb cleanly", () => {
		const owner = {};
		contextFlowBeginTurn(owner, "hello");
		contextFlowRlmGrants(owner, { grantedBytes: 4200, grantCount: 2, grantedTokens: 4200 });
		contextFlowRlmWorkerBegin(owner, { component: FLOW_KEYS.RLM_CODEC, grantedBytes: 4200, inputTokens: 4200 });
		contextFlowRootBegin(owner, "anthropic", "claude");
		const flow = snapshotFor(owner);
		const line = renderCompactFlowBreadcrumb(flow, 24);
		expect(line?.length).toBeLessThanOrEqual(24);
		expect(line?.endsWith("…")).toBe(true);
	});
});
