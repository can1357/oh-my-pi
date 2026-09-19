// OpenRouter judgment client — the verification seam behind the browser lane.
//
// A cheap, fast model (default google/gemini-3.5-flash-lite, ~$0.30/Mtok,
// ~0.6–1.1s on real DOM snapshots) answers yes/no questions about captured
// browser state and returns per-question probabilities. Used by the
// ix_bridge `verify` action and by evals/typesafe-jev/run.mjs — keep the
// prompt and parsing here so the eval measures exactly what the tool ships.
//
// This is a judgment primitive, not a chat lane: no streaming, no tools, one
// bounded request. State is untrusted page data — the prompt frames it as
// evidence to judge, never as instructions to follow.

import { $env } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_JUDGE_MODEL = "google/gemini-3.5-flash-lite";

export interface JudgeQuestion {
	instructions: string;
}

export interface JudgeAnswer {
	/** Probability that the answer to the question is yes, 0–1. */
	noul: number;
}

export interface JudgeResult {
	answers: Record<string, JudgeAnswer>;
	inputTokens: number;
	model: string;
	latencyMs: number;
}

const chatCompletionResponse = type({
	choices: [{ message: { content: "string" } }, "[]"],
	"usage?": { "prompt_tokens?": "number" },
});

/**
 * Parse a judge reply into per-question probabilities. Tolerates prose around
 * the JSON object; throws when any question lacks a finite numeric answer.
 */
export function parseJudgeJson(text: string): Record<string, JudgeAnswer> {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) throw new Error("judge reply contained no JSON object");
	const parsed: unknown = JSON.parse(match[0]);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("judge reply JSON was not an object");
	}
	const answers: Record<string, JudgeAnswer> = {};
	for (const [qid, value] of Object.entries(parsed)) {
		const noul =
			typeof value === "number"
				? value
				: typeof value === "object" && value !== null && "noul" in value && typeof value.noul === "number"
					? value.noul
					: undefined;
		if (noul === undefined || !Number.isFinite(noul)) {
			throw new Error(`judge reply missing numeric probability for "${qid}"`);
		}
		answers[qid] = { noul };
	}
	return answers;
}

export interface JudgeStateOptions {
	goal: string;
	/** Captured browser state (snapshot text/JSON). Treated as untrusted evidence. */
	state: string;
	questions: Record<string, JudgeQuestion>;
	/** Defaults to OPENROUTER_DEFAULT_JUDGE_MODEL. */
	model?: string;
	signal?: AbortSignal;
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Judge whether `state` satisfies `goal` by asking each question of a fast
 * OpenRouter model. Throws when OPENROUTER_API_KEY is unset, the API errors,
 * or the reply cannot be parsed — callers decide how to surface that.
 */
export async function judgeState(options: JudgeStateOptions): Promise<JudgeResult> {
	const apiKey = $env.OPENROUTER_API_KEY;
	if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
	const model = options.model ?? OPENROUTER_DEFAULT_JUDGE_MODEL;
	const prompt =
		"You are a strict verifier. Answer each yes/no question about the browser page state below. " +
		"Reply with ONLY a JSON object mapping each question id to a probability between 0 and 1 " +
		"that the answer is yes. No prose, no markdown. " +
		"When the evidence is ambiguous or the question is under-specified, answer near 0.5 " +
		"rather than guessing confidently — a mid-range probability signals 'cannot tell'.\n\n" +
		`GOAL: ${options.goal}\n\n` +
		`QUESTIONS:\n${Object.entries(options.questions)
			.map(([qid, q]) => `- ${qid}: ${q.instructions}`)
			.join("\n")}\n\n` +
		`STATE:\n${options.state}`;

	const start = performance.now();
	const res = await (options.fetchImpl ?? fetch)(
		`${$env.OPENROUTER_BASE_URL || OPENROUTER_DEFAULT_BASE_URL}/chat/completions`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0,
			}),
			signal: options.signal,
		},
	);
	if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);

	const parsed = chatCompletionResponse(await res.json());
	if (parsed instanceof type.errors) {
		throw new Error(`OpenRouter response malformed: ${parsed.summary}`);
	}
	return {
		answers: parseJudgeJson(parsed.choices[0]?.message.content ?? ""),
		inputTokens: parsed.usage?.prompt_tokens ?? 0,
		model,
		latencyMs: performance.now() - start,
	};
}
