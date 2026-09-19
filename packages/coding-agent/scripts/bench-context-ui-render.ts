#!/usr/bin/env bun
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { type ContextBreakdown, renderContextUsage } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { renderCompactContextUsage, renderFullContextExplorer } from "../src/context-flow/format";
import { contextFlowBeginTurn } from "../src/context-flow/hooks";
import { contextFlowRlmGrants, contextFlowRlmWorkerBegin, contextFlowRootBegin, FLOW_KEYS } from "../src/context-flow/rlm-flow";
import { buildContextFlowSnapshot } from "../src/context-flow/snapshot";
import { getContextFlowRegistry } from "../src/context-flow/registry";
import { RlmStore } from "../src/rlm/store";

initThemeSync();

const breakdown: ContextBreakdown = {
	model: undefined,
	contextWindow: 200_000,
	categories: [
		{ id: "systemPrompt", label: "System prompt", tokens: 4800, color: "accent", glyph: "⛁" },
		{ id: "systemTools", label: "System tools", tokens: 15_000, color: "warning", glyph: "⛁" },
		{ id: "messages", label: "Messages", tokens: 1200, color: "userMessageText", glyph: "⛃" },
	],
	usedTokens: 33_000,
	autoCompactBufferTokens: 30_000,
	freeTokens: 137_000,
};

const owner = {};
const store = new RlmStore();
contextFlowBeginTurn(owner, "bench");
contextFlowRlmGrants(owner, { grantedBytes: 4200, grantCount: 2, grantedTokens: 4200 }, store);
getContextFlowRegistry(owner).updateOffload({ externalBytes: 184_000, reintroducedTokens: 318, grantedTokens: 4200, active: true });
contextFlowRlmWorkerBegin(owner, { component: FLOW_KEYS.RLM_CODEC, grantedBytes: 4200, inputTokens: 4200 });
contextFlowRootBegin(owner, "groq", "gpt-oss-20b");
const flow = buildContextFlowSnapshot({ registry: getContextFlowRegistry(owner), breakdown, rlmMetrics: store.metrics });

const ITERS = 2000;
function bench(label: string, fn: () => void): number {
	const start = performance.now();
	for (let i = 0; i < ITERS; i++) fn();
	const ms = performance.now() - start;
	console.log(`${label}: ${(ms / ITERS * 1000).toFixed(2)} µs/op (${ms.toFixed(1)} ms total)`);
	return ms;
}

console.log(`Context UI render benchmark (${ITERS} iterations)`);
const original = bench("original grid (renderContextUsage)", () => renderContextUsage(breakdown, theme));
const compact = bench("new default (/context compact)", () => renderCompactContextUsage(breakdown, theme, flow));
const debug = bench("debug explorer (renderFullContextExplorer)", () => renderFullContextExplorer(breakdown, flow));
console.log(`compact vs original: ${(compact / original).toFixed(2)}x`);
console.log(`debug vs compact: ${(debug / compact).toFixed(2)}x`);
