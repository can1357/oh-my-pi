#!/usr/bin/env bun
/**
 * Dogfood rlm.workerMode=auto on production RlmTool path (OpenRouter/free by default).
 *
 *   export OPENROUTER_API_KEY=...
 *   bun evals/rlm/rlm-auto-dogfood-orchestrate.ts
 *   bun evals/rlm/rlm-auto-dogfood-report.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { initThemeSync, theme } from "@oh-my-pi/pi-tui/theme";
import { type ContextBreakdown } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { renderContextUsagePage, renderCurrentTurnFlow } from "../../src/context-flow/format";
import { contextFlowBeginTurn } from "../../src/context-flow/hooks";
import { bindRlmContextFlow, contextFlowRootBegin, contextFlowRootComplete } from "../../src/context-flow/rlm-flow";
import { buildContextFlowSnapshot } from "../../src/context-flow/snapshot";
import { getContextFlowRegistry } from "../../src/context-flow/registry";
import { formatHandle } from "../../src/rlm/store";
import {
	formatAutoGateFlowDecision,
	resolveEffectiveWorkerMode,
	workerModeInputFromSelection,
} from "../../src/rlm/worker-mode-policy";
import { evidencePacketByteSize } from "../../src/rlm/evidence-packet-v2";
import { selectGrantsFromSearch } from "../../src/rlm/select-grants";
import type { ToolSession } from "../../src/tools";
import { RlmTool } from "../../src/tools/rlm";
import { getRlmRuntime, resetRlmStoresForTest } from "../../src/rlm/session";
import {
	createLiveOpenRouterHost,
	createUnifiedRlmCompleter,
	DEFAULT_OPENROUTER_MODEL,
} from "./lib/live-openrouter-common";
import { corpusForTask, RLM_AUTO_DOGFOOD_TASKS, type DogfoodTask } from "./lib/rlm-auto-dogfood-tasks";

initThemeSync();

const OUT = path.join(import.meta.dir, "results", "rlm-auto-dogfood.jsonl");
const FLOW_DIR = path.join(import.meta.dir, "results", "rlm-auto-dogfood-flow");

const breakdown: ContextBreakdown = {
	model: undefined,
	contextWindow: 200_000,
	categories: [
		{ id: "systemPrompt", label: "System prompt", tokens: 4800, color: "accent", glyph: "⛁" },
		{ id: "systemTools", label: "System tools", tokens: 15_000, color: "warning", glyph: "⛁" },
		{ id: "messages", label: "Messages", tokens: 1200, color: "userMessageText", glyph: "⛃" },
	],
	usedTokens: 20_000,
	autoCompactBufferTokens: 30_000,
	freeTokens: 150_000,
};

type Row = Record<string, unknown>;

function mkdirp(file: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
}

function append(row: Row): void {
	fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`);
}

function parseAutoDecision(text: string): { arm: string; reason?: string; complexity?: string } {
	const arm = text.match(/^auto decision: ([CD])/m)?.[1] ?? "?";
	const reason = text.match(/^reason: (.+)$/m)?.[1];
	const complexity = text.match(/^complexity: (.+)$/m)?.[1];
	return { arm, reason, complexity };
}

function tasksToRun(): DogfoodTask[] {
	const filter = process.env.RLM_AUTO_DOGFOOD_TASKS?.trim();
	if (!filter) return RLM_AUTO_DOGFOOD_TASKS;
	const ids = new Set(filter.split(",").map(s => s.trim()).filter(Boolean));
	return RLM_AUTO_DOGFOOD_TASKS.filter(t => ids.has(t.id));
}

async function runTask(
	host: Awaited<ReturnType<typeof createLiveOpenRouterHost>>,
	task: DogfoodTask,
): Promise<Row> {
	resetRlmStoresForTest();
	const session = {
		cwd: path.resolve(import.meta.dir, "../.."),
		settings: host.settings,
		rlmComplete: createUnifiedRlmCompleter(host),
		getTokenomicsBridge: () => host.tokenomics,
	} as ToolSession;

	const runtime = getRlmRuntime(session as never);
	bindRlmContextFlow(session, runtime);
	contextFlowBeginTurn(session, task.id);

	const corpus = `${corpusForTask(task)}\nPARENT_SECRET_${task.id.toUpperCase()}_DO_NOT_LEAK`;
	const rec = runtime.store.put(corpus, task.repoRelPath ? "read" : task.kind);
	const handle = formatHandle(rec.id);

	const selected = selectGrantsFromSearch(runtime.store, handle, task.patterns, {
		maxMatches: 4,
		contextChars: 512,
		maxTotalBytes: 8192,
		mode: "literal",
		...task.selectPolicy,
	});
	const sample = selected.hits.map(h => h.text).join("\n").slice(0, 4096);
	const policyInput = workerModeInputFromSelection(selected, task.question, task.patterns, sample);
	const policyDecision = resolveEffectiveWorkerMode("auto", policyInput, "");

	const tool = new RlmTool(session);
	const t0 = performance.now();
	const out = await tool.execute(`dogfood-${task.id}`, {
		op: "query",
		handle,
		question: task.question,
		pattern: task.patterns.length === 1 ? task.patterns[0] : task.patterns[0],
		limit: task.selectPolicy?.maxMatches ?? 4,
		contextChars: task.selectPolicy?.contextChars,
		maxTotalBytes: task.selectPolicy?.maxTotalBytes,
	});
	const e2eMs = performance.now() - t0;
	const body = out.content.find(p => p.type === "text");
	const text = body && body.type === "text" ? body.text : "";
	const parsed = parseAutoDecision(text);

	const packetBytesMatch = text.match(/packetBytes=(\d+)/);
	const packetBytes = packetBytesMatch ? Number(packetBytesMatch[1]) : undefined;
	const packetStatus = text.match(/packet\.status=([a-z_]+)/)?.[1];

	const reinTokens = packetBytes ? Math.round(packetBytes / 4) : Math.round((selected.grantedBytes || 0) / 16);
	contextFlowRootBegin(session, host.model.provider, host.model.id);
	contextFlowRootComplete(session, {
		provider: host.model.provider,
		model: host.model.id,
		inputTokens: 8000,
		outputTokens: reinTokens,
		durationMs: 50,
	});

	const flow = buildContextFlowSnapshot({
		registry: getContextFlowRegistry(session),
		breakdown,
		rlmMetrics: runtime.store.metrics,
	});
	const turnFlow = renderCurrentTurnFlow(flow);
	const page = renderContextUsagePage(breakdown, theme, flow);
	fs.mkdirSync(FLOW_DIR, { recursive: true });
	fs.writeFileSync(path.join(FLOW_DIR, `${task.id}.flow.txt`), turnFlow ?? "(no turn flow)");
	fs.writeFileSync(path.join(FLOW_DIR, `${task.id}.context.txt`), page);

	const flowDecision = formatAutoGateFlowDecision(policyDecision);
	const expectArm = task.expectArm;
	const armMatch = expectArm ? parsed.arm === expectArm : undefined;

	return {
		phase: "dogfood",
		task: task.id,
		kind: task.kind,
		model: `${host.model.provider}/${host.model.id}`,
		subModel: host.settings.get("rlm.subModel"),
		workerMode: "auto",
		grantedBytes: selected.grantedBytes,
		policyArm: policyDecision.mode === "evidence-packet" ? "D" : "C",
		policyFlow: flowDecision,
		policyReason: policyDecision.reason,
		toolArm: parsed.arm,
		toolReason: parsed.reason,
		expectArm,
		armMatch,
		packetStatus,
		packetBytes,
		e2eLatencyMs: e2eMs,
		failOpen: out.details?.failOpen ?? false,
		flowPreview: turnFlow?.split("\n").slice(0, 10).join("\n"),
	};
}

async function main(): Promise<void> {
	mkdirp(OUT);
	fs.writeFileSync(OUT, "");
	const host = await createLiveOpenRouterHost({ workerMode: "auto" });
	const tasks = tasksToRun();

	append({
		phase: "meta",
		experiment: "rlm-auto-dogfood",
		model: DEFAULT_OPENROUTER_MODEL,
		resolved: `${host.model.provider}/${host.model.id}`,
		taskCount: tasks.length,
		policy: "complexity-first auto gate (frozen for smoke)",
		ts: Date.now(),
	});

	console.log(`OpenRouter dogfood: ${host.model.provider}/${host.model.id} workerMode=auto (${tasks.length} tasks)`);

	for (const task of tasks) {
		console.log(`task ${task.id} (${task.kind})...`);
		try {
			const row = await runTask(host, task);
			append(row);
			const match = row.armMatch === false ? " MISMATCH" : row.armMatch ? " ok" : "";
			console.log(
				`  policy=${row.policyFlow} tool=${row.toolArm} grants=${row.grantedBytes}B${match} ${Math.round(row.e2eLatencyMs as number)}ms`,
			);
			if (row.flowPreview) console.log(String(row.flowPreview).replace(/^/gm, "    "));
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			append({ phase: "dogfood", task: task.id, error: msg, ts: Date.now() });
			console.log(`  ERROR: ${msg}`);
		}
	}

	host.close();
	console.log(`\nwrote ${OUT}`);
	console.log(`flow snapshots: ${FLOW_DIR}/`);
}

await main();
