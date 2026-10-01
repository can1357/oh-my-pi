import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Issue #9433: the openai-completions consumer threw
// `OpenAI completions stream closed before a finish_reason was received` whenever
// a stream ended after emitting content without a truthy `finish_reason`. Many
// OpenAI-compatible hosts stream content, then terminate with the `[DONE]`
// sentinel while omitting (or `null`ing) `finish_reason`. `[DONE]` is the
// streaming protocol's terminal signal, so those turns completed by server
// agreement and must finalize cleanly; only a genuine transport EOF (no `[DONE]`)
// is a truncated/incomplete stream.

const model = buildModel({
	id: "test-model",
	name: "Test",
	api: "openai-completions",
	provider: "litellm",
	baseUrl: "http://127.0.0.1:4000/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8_000,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function fetchFor(frames: readonly unknown[]): FetchImpl {
	const body = frames.map(f => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join("");
	return Object.assign(
		async (): Promise<Response> => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		{ preconnect: fetch.preconnect },
	);
}

async function run(frames: readonly unknown[]) {
	const msg = await streamOpenAICompletions(model, context, { apiKey: "k", fetch: fetchFor(frames) }).result();
	const text = msg.content.reduce((acc, block) => (block.type === "text" ? acc + block.text : acc), "");
	return { stopReason: msg.stopReason, errorMessage: msg.errorMessage, text };
}

describe("issue #9433 — [DONE]-terminated completions without finish_reason", () => {
	// Each shape is a real OpenAI-compatible host behavior that previously threw
	// incomplete-stream; all three reach `[DONE]` and must finalize as a clean stop.
	const doneTerminated: readonly (readonly [string, readonly unknown[], string])[] = [
		[
			"no terminal finish chunk, just [DONE]",
			[{ choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" } }] }, "[DONE]"],
			"Hello",
		],
		[
			"trailing finish_reason:null then [DONE]",
			[{ choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: {}, finish_reason: null }] }, "[DONE]"],
			"Hel",
		],
		[
			"trailing empty choices:[] then [DONE]",
			[{ choices: [{ delta: { content: "Hel" } }] }, { choices: [] }, "[DONE]"],
			"Hel",
		],
	];

	for (const [label, frames, expectedText] of doneTerminated) {
		it(`finalizes as a clean stop with content preserved (${label})`, async () => {
			const result = await run(frames);
			expect(result.stopReason).toBe("stop");
			expect(result.errorMessage).toBeUndefined();
			expect(result.text).toBe(expectedText);
		});
	}

	it("promotes a [DONE]-terminated tool-call turn without finish_reason to toolUse", async () => {
		const msg = await streamOpenAICompletions(model, context, {
			apiKey: "k",
			fetch: fetchFor([
				{
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, id: "call_1", function: { name: "foo", arguments: '{"a":1}' } }],
							},
						},
					],
				},
				"[DONE]",
			]),
		}).result();
		expect(msg.stopReason).toBe("toolUse");
		expect(msg.errorMessage).toBeUndefined();
		expect(msg.content.some(block => block.type === "toolCall")).toBe(true);
	});

	it("still surfaces incomplete-stream on a genuine EOF (no [DONE], no finish_reason)", async () => {
		const result = await run([
			{ choices: [{ delta: { content: "Hel" } }] },
			{ choices: [{ delta: { content: "lo" } }] },
		]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI completions stream closed before a finish_reason was received");
	});
});
