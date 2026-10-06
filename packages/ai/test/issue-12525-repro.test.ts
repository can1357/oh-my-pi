// Issue #12525, provider half: OpenAI-compatible servers that report a
// generation degenerating into repetition as a terminal signal
// (`finish_reason: "repetition"`, and/or `stop_reason: "repetition_detected"`).
// That fell through to the generic finish-reason default, so the turn surfaced
// as an ordinary error carrying no ThinkingLoop flag, and the degenerate
// partial reasoning was retained and replayed into the next turn.
//
// The issue's other half — exact-cycle detection rejecting a punctuation-only
// runaway such as `?!` because its unit carries no letter or pictograph — is
// deliberately NOT covered here. Open PR #14436 ("Guard catches models stuck in
// punctuation-only loops") changes that same gate and additionally refuses
// whitespace-bearing units, which is the false-positive case this file's
// detector tests would otherwise have to reason about. Duplicating it would
// have put two patches on one line of `thinking-loop.ts`.
//
// Synthetic data only: no network, no credentials, no local server.
import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model = buildModel({
	id: "issue-12525-model",
	name: "Issue 12525 Repro",
	api: "openai-completions",
	provider: "litellm",
	baseUrl: "http://127.0.0.1:4000/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_000,
});

const context: Context = { messages: [{ role: "user", content: "Say hello", timestamp: 0 }] };

/**
 * Build a stream that thinks in `?!` and then reports a repetition stop.
 *
 * 64 characters of reasoning is below the detector's 180-character floor, so the
 * server stop signal is the only thing that can classify this turn.
 */
function repetitionStream(choice: Record<string, unknown>): { fetchMock: FetchImpl; requests: () => number } {
	const chunk = (extra: Record<string, unknown>) => ({
		id: "chatcmpl-repetition",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, ...extra }],
	});
	const frames = [
		...Array.from({ length: 32 }, () => chunk({ delta: { reasoning_content: "?!" }, finish_reason: null })),
		chunk({ delta: {}, ...choice }),
	];
	const body = `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
	let requests = 0;
	const fetchMock = Object.assign(
		async (): Promise<Response> => {
			requests += 1;
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetchMock, requests: () => requests };
}

describe("server-declared repetition stops (#12525)", () => {
	// The `stop_reason` form is reported both alongside a clean `stop` and with no
	// `finish_reason` at all, so it cannot be read only from `finish_reason`.
	const REPETITION_CHOICES: ReadonlyArray<Record<string, unknown>> = [
		{ finish_reason: "repetition", stop_reason: "repetition_detected" },
		{ finish_reason: "repetition" },
		{ finish_reason: "stop", stop_reason: "repetition_detected" },
		{ stop_reason: "repetition_detected" },
	];

	for (const choice of REPETITION_CHOICES) {
		it(`classifies ${JSON.stringify(choice)} as a thinking loop and drops the partial`, async () => {
			const { fetchMock, requests } = repetitionStream(choice);
			const result = await streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchMock }).result();

			// One request: the provider stops at the terminal signal rather than
			// resampling on its own.
			expect(requests()).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
			// Degenerate reasoning is replay garbage; retaining it is what made the
			// loop survive across turns.
			expect(result.content).toEqual([]);
		}, 10_000);
	}

	it("keeps the raw stop reasons for diagnosis", async () => {
		const { fetchMock } = repetitionStream({ finish_reason: "repetition", stop_reason: "repetition_detected" });
		const result = await streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchMock }).result();

		expect(result.errorMessage).toContain("finish_reason=repetition");
		expect(result.errorMessage).toContain("stop_reason=repetition_detected");
	}, 10_000);

	it("leaves an ordinary stop finish untouched", async () => {
		const { fetchMock } = repetitionStream({ finish_reason: "stop" });
		const result = await streamOpenAICompletions(model, context, { apiKey: "test-key", fetch: fetchMock }).result();

		expect(result.stopReason).toBe("stop");
		expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(false);
	}, 10_000);
});
