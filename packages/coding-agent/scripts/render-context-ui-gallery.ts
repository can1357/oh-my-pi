#!/usr/bin/env bun
/** Render context UI surfaces for visual QA. */
import * as fs from "node:fs";
import * as path from "node:path";
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { type ContextBreakdown, renderContextUsage } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { renderContextUsagePage } from "../src/context-flow/format";
import { contextFlowBeginTurn } from "../src/context-flow/hooks";
import {
	contextFlowRlmGrants,
	contextFlowRlmWorkerBegin,
	contextFlowRlmWorkerComplete,
	contextFlowRootBegin,
	FLOW_KEYS,
} from "../src/context-flow/rlm-flow";
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
		{ id: "systemContext", label: "System context", tokens: 9400, color: "success", glyph: "⛁" },
		{ id: "skills", label: "Skills", tokens: 3600, color: "customMessageLabel", glyph: "⛁" },
		{ id: "messages", label: "Messages", tokens: 1200, color: "userMessageText", glyph: "⛃" },
	],
	usedTokens: 33_000,
	autoCompactBufferTokens: 30_000,
	freeTokens: 137_000,
};

function writeSurfaces(name: string, body: string) {
	fs.writeFileSync(path.join(outDir, `${name}.ansi`), body + "\n");
}

const outDir = path.resolve("artifacts/context-ui-gallery");
fs.mkdirSync(outDir, { recursive: true });

// 1. Plain OMP, no RLM
{
	const owner = {};
	contextFlowBeginTurn(owner, "hello");
	const flow = buildContextFlowSnapshot({ registry: getContextFlowRegistry(owner), breakdown });
	writeSurfaces("01-original-context-usage", renderContextUsage(breakdown, theme));
	writeSurfaces("02-context-no-rlm", renderContextUsagePage(breakdown, theme, flow));
}

// 2. RLM active
{
	const owner = {};
	const store = new RlmStore();
	contextFlowBeginTurn(owner, "fix bug");
	contextFlowRlmGrants(owner, { grantedBytes: 4200, grantCount: 2, grantedTokens: 4200 }, store);
	getContextFlowRegistry(owner).updateOffload({
		externalBytes: 184_000,
		reintroducedTokens: 318,
		grantedTokens: 4200,
		active: true,
	});
	const flow = buildContextFlowSnapshot({ registry: getContextFlowRegistry(owner), breakdown, rlmMetrics: store.metrics });
	writeSurfaces("03-context-rlm-active", renderContextUsagePage(breakdown, theme, flow));
}

// 3. RLM + Groq pipeline
{
	const owner = {};
	const store = new RlmStore();
	contextFlowBeginTurn(owner, "query evidence");
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
		{ component: FLOW_KEYS.RLM_CODEC, inputTokens: 4200, outputTokens: 318, durationMs: 812, provider: "groq", model: "gpt-oss-20b" },
		store,
	);
	contextFlowRootBegin(owner, "groq", "gpt-oss-20b");
	const flow = buildContextFlowSnapshot({ registry: getContextFlowRegistry(owner), breakdown, rlmMetrics: store.metrics });
	writeSurfaces("04-context-rlm-groq", renderContextUsagePage(breakdown, theme, flow));
}

console.log(`Wrote gallery surfaces to ${outDir}`);
