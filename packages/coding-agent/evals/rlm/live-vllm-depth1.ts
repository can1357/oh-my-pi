#!/usr/bin/env bun
/**
 * Live vLLM depth-1 subcall bench (RFC #12407).
 *
 *   VLLM_MODEL=Qwen/Qwen2.5-1.5B-Instruct bun evals/rlm/live-vllm-depth1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resetRlmStoresForTest, rlmSubcall, RlmStore } from "../../src/rlm";

const OUT = path.join(import.meta.dir, "results", "live-vllm-depth1.jsonl");
const VLLM = (process.env.VLLM_UPSTREAM || "http://127.0.0.1:8000").replace(/\/$/, "");
const MODEL = process.env.VLLM_MODEL || "Qwen/Qwen2.5-1.5B-Instruct";
const FACT_A = "FACT_A_LIVE_QX7";
const FACT_B = "FACT_B_LIVE_QY9";

function padFact(fact: string, bytes = 30_000): string {
	return `${fact}\n${"p".repeat(Math.max(0, bytes - fact.length - 1))}`;
}

async function vllmComplete(prompt: string): Promise<{ text: string; tokens?: number; ttftMs: number; elapsedMs: number }> {
	const t0 = performance.now();
	let first = 0;
	const res = await fetch(`${VLLM}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{
					role: "system",
					content: "Answer with only the requested tokens. No explanation.",
				},
				{ role: "user", content: prompt },
			],
			max_tokens: 64,
			temperature: 0,
			stream: true,
			stream_options: { include_usage: true },
		}),
	});
	if (!res.ok) throw new Error(`vLLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
				/* */
			}
		}
	}
	const elapsedMs = performance.now() - t0;
	return { text, tokens, ttftMs: first ? first - t0 : elapsedMs, elapsedMs };
}

async function main(): Promise<void> {
	const health = await fetch(`${VLLM}/v1/models`);
	if (!health.ok) throw new Error(`vLLM down at ${VLLM}`);
	resetRlmStoresForTest();

	// reject path
	const rejected = await rlmSubcall(
		new RlmStore({ maxDepth: 0 }),
		[{ handle: "1" }],
		"x",
		async () => "no",
		1,
	);

	const store = new RlmStore({ maxDepth: 1, maxCalls: 8, maxTotalTokens: 2_000_000 });
	const a = store.put(padFact(FACT_A), "a");
	const b = store.put(padFact(FACT_B), "b");

	let ttft = 0;
	let tokens: number | undefined;
	const t0 = performance.now();
	const result = await rlmSubcall(
		store,
		[{ handle: a.id }, { handle: b.id }],
		`Find FACT_A_LIVE_… and FACT_B_LIVE_… in the excerpts. Reply with exactly: <FACT_A>+<FACT_B>`,
		async prompt => {
			const r = await vllmComplete(prompt);
			ttft = r.ttftMs;
			tokens = r.tokens;
			return { text: r.text, tokens: r.tokens, cost: 0 };
		},
		1,
	);
	const elapsed = performance.now() - t0;

	const row = {
		ts: Date.now(),
		model: MODEL,
		backend: "vllm",
		rejectMaxDepth0: rejected.failOpen === true,
		answer: result.text.slice(0, 300),
		citation: result.citation,
		failOpen: result.failOpen === true,
		hasA: result.text.includes(FACT_A) || result.text.includes("FACT_A_LIVE"),
		hasB: result.text.includes(FACT_B) || result.text.includes("FACT_B_LIVE"),
		ttftMs: ttft,
		elapsedMs: elapsed,
		tokens,
		cost: 0,
		storeStatus: store.status(),
		pass_depth1_reject0: rejected.failOpen === true,
		// Live SLM may paraphrase; structural success = no failOpen + charged call + citations
		pass_depth1_live: result.failOpen !== true && store.budget.calls >= 1 && Boolean(result.citation),
	};

	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, `${JSON.stringify(row)}\n`);
	console.log(JSON.stringify(row, null, 2));
	if (!row.pass_depth1_reject0 || !row.pass_depth1_live) {
		console.error("live depth1 gates failed");
		process.exit(1);
	}
	console.log(`wrote ${OUT}`);
}

await main();
