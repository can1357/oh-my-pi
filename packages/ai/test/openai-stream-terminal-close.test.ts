// Regression coverage for providers that deliver a terminal SSE frame but
// never send `[DONE]` nor close the connection. Before the client-side
// terminal break (mirroring the Codex websocket loop), the consumer parked on
// `iterator.next()` until the idle watchdog (120s) converted the
// already-successful turn into a timeout error.
//
// 1. openai-completions: `finish_reason` + trailing usage chunk → break
//    immediately, well before the post-finish grace window.
// 2. openai-completions: `finish_reason` with no usage chunk ever → end
//    cleanly when the grace window elapses instead of erroring.
// 3. openai-responses: `response.completed` → `processResponsesStream`
//    breaks immediately; no grace window involved.
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;
const responsesModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

/** SSE response that delivers `events` and then holds the connection open forever. */
function createNeverClosingSseResponse(events: unknown[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				const data = typeof event === "string" ? event : JSON.stringify(event);
				controller.enqueue(encoder.encode(`data: ${data}\n\n`));
			}
			// Intentionally never controller.close(): the server keeps the
			// socket open after the terminal frame.
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createNeverClosingFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createNeverClosingSseResponse(events);
	}
	return mockFetch as typeof fetch;
}

function completionChunk(extra: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-terminal",
		object: "chat.completion.chunk",
		created: 0,
		model: completionsModel.id,
		...extra,
	};
}

describe("terminal frame without connection close", () => {
	it("openai-completions: breaks immediately once finish_reason and usage arrived", async () => {
		const fetchMock = createNeverClosingFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
			completionChunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
		]);

		const startedAt = Date.now();
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(5);
		// Immediate break path: must finish well inside the 2.5s post-finish
		// grace window (the pre-fix behavior was a 120s idle-watchdog error).
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	}, 10_000);

	it("openai-completions: ignores zero cache placeholder until trailing positive cache details arrive", async () => {
		const fetchMock = createNeverClosingFetch([
			completionChunk({
				choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
					prompt_tokens_details: { cached_tokens: 0 },
				},
			}),
			completionChunk({
				choices: [],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
					prompt_tokens_details: { cached_tokens: 4 },
				},
			}),
		]);

		const startedAt = Date.now();
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(result.usage.input).toBe(6);
		expect(result.usage.cacheRead).toBe(4);
		expect(result.usage.output).toBe(5);
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	}, 10_000);

	it("openai-completions: ends cleanly via the grace window when no usage chunk ever arrives", async () => {
		const fetchMock = createNeverClosingFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	}, 10_000);

	it("openai-responses: breaks immediately on response.completed", async () => {
		const fetchMock = createNeverClosingFetch([
			{ type: "response.created", response: { id: "resp_terminal" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.content_part.added",
				output_index: 0,
				item_id: "msg_1",
				part: { type: "output_text", text: "", annotations: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "Hello" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello", annotations: [] }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_terminal",
					status: "completed",
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				},
			},
		]);

		const startedAt = Date.now();
		const result = await streamOpenAIResponses(responsesModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: "Hello" }) as unknown as (typeof result.content)[number],
		]);
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(5);
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	}, 10_000);
});
