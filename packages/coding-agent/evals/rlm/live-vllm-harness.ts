#!/usr/bin/env bun
/**
 * Live vLLM harness for RLM (spill + search + query TTFT).
 *
 *   VLLM_MODEL=Qwen/Qwen2.5-1.5B-Instruct bun evals/rlm/live-vllm-harness.ts
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { convertToLlm } from "../../src/session/messages";
import {
	promptContainsCorpus,
	resetRlmStoresForTest,
	rlmQuery,
	RlmStore,
	wrapToolWithRlmSpill,
} from "../../src/rlm";

const OUT = path.join(import.meta.dir, "results", "live-vllm.jsonl");
const VLLM = (process.env.VLLM_UPSTREAM || "http://127.0.0.1:8000").replace(/\/$/, "");
const MODEL = process.env.VLLM_MODEL || "Qwen/Qwen2.5-1.5B-Instruct";
const NEEDLE = `NEEDLE_LIVE_${createHash("sha256").update("vllm-harness").digest("hex").slice(0, 8)}`;
const CORPUS_BYTES = 80_000;
const SPILL = 20_480;

function fatCorpus(bytes = CORPUS_BYTES): string {
	const pad = Math.max(0, bytes - NEEDLE.length);
	const left = Math.floor(pad / 2);
	return `${"a".repeat(left)}${NEEDLE}${"b".repeat(pad - left)}`;
}

async function vllmComplete(
	prompt: string,
): Promise<{ text: string; tokens?: number; cost?: number; ttftMs: number; elapsedMs: number }> {
	const t0 = performance.now();
	let first = 0;
	const res = await fetch(`${VLLM}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: "system", content: "Answer briefly and exactly. Prefer a single token when asked." },
				{ role: "user", content: prompt },
			],
			max_tokens: 64,
			temperature: 0,
			stream: true,
			stream_options: { include_usage: true },
		}),
	});
	if (!res.ok) {
		const err = await res.text();
		throw new Error(`vLLM ${res.status}: ${err.slice(0, 300)}`);
	}
	const reader = res.body?.getReader();
	if (!reader) throw new Error("no body");
	const dec = new TextDecoder();
	let buf = "";
	let text = "";
	let tokens: number | undefined;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const parts = buf.split("\n");
		buf = parts.pop() ?? "";
		for (const line of parts) {
			const s = line.trim();
			if (!s.startsWith("data:")) continue;
			const payload = s.slice(5).trim();
			if (payload === "[DONE]") continue;
			try {
				const j = JSON.parse(payload) as {
					choices?: Array<{ delta?: { content?: string } }>;
					usage?: { total_tokens?: number };
				};
				const delta = j.choices?.[0]?.delta?.content;
				if (delta) {
					if (!first) first = performance.now();
					text += delta;
				}
				if (j.usage?.total_tokens) tokens = j.usage.total_tokens;
			} catch {
				/* skip */
			}
		}
	}
	const elapsedMs = performance.now() - t0;
	return {
		text,
		tokens,
		cost: 0,
		ttftMs: first ? first - t0 : elapsedMs,
		elapsedMs,
	};
}

async function runArm(arm: "off" | "on"): Promise<Record<string, unknown>> {
	resetRlmStoresForTest();
	const store = new RlmStore({
		maxDepth: 0,
		maxCalls: 32,
		maxTotalTokens: 1_000_000,
		maxCost: 0,
		wallClockMs: 0,
	});
	const corpus = fatCorpus();
	const enabled = arm === "on";
	const spillBytes = enabled ? SPILL : Number.MAX_SAFE_INTEGER;

	const fatTool = wrapToolWithRlmSpill(
		{
			name: "fat_read",
			label: "fat_read",
			description: "returns fat corpus",
			parameters: {} as never,
			execute: async () => ({
				content: [{ type: "text" as const, text: corpus }],
				details: {},
			}),
		} as unknown as AgentTool,
		store,
		SPILL,
		{ enabled: () => enabled, spillBytes: () => spillBytes },
	);

	const tTool0 = performance.now();
	const result = await fatTool.execute("c1", {} as never);
	const toolMs = performance.now() - tTool0;
	const toolText = result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	const messages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: "find needle" }],
			timestamp: Date.now(),
		},
		{
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id: "c1", name: "fat_read", arguments: {} }],
			api: "openai-completions",
			provider: "vllm",
			model: MODEL,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse" as const,
			timestamp: Date.now(),
		},
		{
			role: "toolResult" as const,
			toolCallId: "c1",
			toolName: "fat_read",
			content: result.content,
			isError: false,
			timestamp: Date.now(),
		},
	];

	const llm = await convertToLlm(messages as never);
	const llmBlob = JSON.stringify(llm);
	const rootHasNeedle = promptContainsCorpus(llmBlob, NEEDLE);
	const rootHasFull = promptContainsCorpus(llmBlob, corpus.slice(0, 5000));
	const spilled = toolText.includes("rlm://") || toolText.includes("spilled");
	const handleMatch = toolText.match(/rlm:\/\/h\/[A-Za-z0-9_-]+/);
	const handle = handleMatch?.[0] ?? "";
	const handleId = handle.replace(/^rlm:\/\/h\//, "");

	let searchHits = 0;
	let searchHasNeedle = false;
	if (enabled && spilled && handleId) {
		const hits = store.search(handleId, "NEEDLE_LIVE_", 8);
		searchHits = hits.length;
		searchHasNeedle = hits.some(h => h.text.includes(NEEDLE));
	}

	let queryText = "";
	let queryTtft = 0;
	let queryElapsed = 0;
	let queryTokens: number | undefined;
	let queryOk = false;

	if (enabled && spilled && handle) {
		const mid = Math.max(0, Math.floor(CORPUS_BYTES / 2) - 2048);
		const t0 = performance.now();
		const q = await rlmQuery(
			store,
			handle,
			"What is the exact NEEDLE_LIVE_… token in this excerpt? Reply with only that token.",
			async prompt => {
				const r = await vllmComplete(prompt);
				queryTtft = r.ttftMs;
				queryTokens = r.tokens;
				return { text: r.text, tokens: r.tokens, cost: 0 };
			},
			mid,
			mid + 8192,
		);
		queryElapsed = performance.now() - t0;
		queryText = q.text;
		queryOk = q.text.includes(NEEDLE);
	} else if (!enabled) {
		const r = await vllmComplete(
			`Corpus head (truncated):\n${corpus.slice(0, 4000)}\n\nIs NEEDLE_LIVE_ present near the middle of the full file? If you only see head, say UNKNOWN.`,
		);
		queryText = r.text;
		queryTtft = r.ttftMs;
		queryElapsed = r.elapsedMs;
		queryTokens = r.tokens;
	}

	return {
		ts: Date.now(),
		arm,
		model: MODEL,
		backend: "vllm",
		vllm: VLLM,
		needle: NEEDLE,
		corpusBytes: corpus.length,
		spillBytes: SPILL,
		toolMs,
		toolTextLen: toolText.length,
		spilled,
		rootHasNeedle,
		rootHasFullHead: rootHasFull,
		llmJsonBytes: llmBlob.length,
		searchHits,
		searchHasNeedle,
		queryText: queryText.slice(0, 500),
		queryTtftMs: queryTtft,
		queryElapsedMs: queryElapsed,
		queryTokens,
		queryOk,
		pass_M2_live: enabled ? spilled && !rootHasNeedle : true,
		pass_M5_live: enabled ? searchHasNeedle : true,
		pass_query_live: enabled ? queryOk : true,
		storeStatus: store.status(),
	};
}

async function main(): Promise<void> {
	const health = await fetch(`${VLLM}/v1/models`);
	if (!health.ok) throw new Error(`vLLM not healthy at ${VLLM}`);
	const models = (await health.json()) as { data?: Array<{ id: string }> };
	console.log("vLLM models", models.data?.map(m => m.id));

	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

	const rows: Record<string, unknown>[] = [];
	for (const arm of ["off", "on"] as const) {
		console.log(`\n=== arm=${arm} ===`);
		const row = await runArm(arm);
		rows.push(row);
		fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`);
		console.log(
			JSON.stringify(
				{
					arm: row.arm,
					spilled: row.spilled,
					rootHasNeedle: row.rootHasNeedle,
					llmJsonBytes: row.llmJsonBytes,
					searchHasNeedle: row.searchHasNeedle,
					queryTtftMs: row.queryTtftMs,
					queryElapsedMs: row.queryElapsedMs,
					queryTokens: row.queryTokens,
					queryText: row.queryText,
					queryOk: row.queryOk,
					pass_M2_live: row.pass_M2_live,
					pass_M5_live: row.pass_M5_live,
					pass_query_live: row.pass_query_live,
					storeStatus: row.storeStatus,
				},
				null,
				2,
			),
		);
	}

	const off = rows.find(r => r.arm === "off")!;
	const on = rows.find(r => r.arm === "on")!;
	const drop =
		typeof off.llmJsonBytes === "number" && typeof on.llmJsonBytes === "number" && off.llmJsonBytes > 0
			? (1 - (on.llmJsonBytes as number) / (off.llmJsonBytes as number)) * 100
			: 0;
	console.log(
		`\nsummary: off llmBytes=${off.llmJsonBytes} ttft=${off.queryTtftMs} | on spill=${on.spilled} M5search=${on.searchHasNeedle} queryOk=${on.queryOk} llmBytes=${on.llmJsonBytes} drop=${drop.toFixed(1)}% queryTtft=${on.queryTtftMs}ms tokens=${on.queryTokens} cost=$0`,
	);
	console.log(`wrote ${OUT}`);
}

await main();
