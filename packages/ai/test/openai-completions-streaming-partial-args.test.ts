import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model = buildModel({
	id: "local-bash-model",
	name: "Local Bash Model",
	api: "openai-completions",
	provider: "local",
	baseUrl: "https://models.example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
} satisfies ModelSpec<"openai-completions">);

const encoder = new TextEncoder();

function sse(delta: unknown, finishReason: "tool_calls" | null = null): Uint8Array {
	const event = {
		id: "chatcmpl-parallel",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

// Two parallel bash calls, each command split across two argument fragments.
const fixture: Uint8Array[] = [
	sse({
		role: "assistant",
		tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }],
	}),
	sse({ tool_calls: [{ index: 0, function: { arguments: '{"command":"echo ' } }] }),
	sse({ tool_calls: [{ index: 0, function: { arguments: 'mark1"}' } }] }),
	sse({
		tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "bash", arguments: "" } }],
	}),
	sse({ tool_calls: [{ index: 1, function: { arguments: '{"command":"echo ' } }] }),
	sse({ tool_calls: [{ index: 1, function: { arguments: 'mark2"}' } }] }),
	sse({}, "tool_calls"),
	encoder.encode("data: [DONE]\n\n"),
];

// One chunk per read, with a macrotask gap between reads, so each argument delta is
// consumed before the next SSE chunk is parsed.
function pacedFetch(chunks: Uint8Array[]): FetchImpl {
	async function mockFetch(): Promise<Response> {
		let index = 0;
		return new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					await Bun.sleep(1);
					const next = chunks[index++];
					if (next) controller.enqueue(next);
					else controller.close();
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

describe("openai-completions streamed tool arguments", () => {
	it("publishes each call's raw argument JSON as it streams, before any toolcall_end", async () => {
		const stream = streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "echo mark1 and mark2", timestamp: 1 }] },
			{ apiKey: "test-key", fetch: pacedFetch(fixture) },
		);
		const events: [type: string, contentIndex: number, partialJson: string | undefined][] = [];
		// The replay-safe retry wrapper holds the starts and empty deltas until the first
		// argument bytes commit the stream, then flushes them late, so `partial` already
		// shows later state when they are read. Read the carrier at argument deltas, which
		// are delivered as they are pushed, and at toolcall_end.
		for await (const event of stream) {
			if (event.type === "toolcall_delta" && event.delta.length > 0) {
				const block = event.partial.content[event.contentIndex];
				events.push([event.type, event.contentIndex, getStreamingPartialJson(block)]);
			} else if (event.type === "toolcall_end") {
				events.push([event.type, event.contentIndex, getStreamingPartialJson(event.toolCall)]);
			}
		}
		const result = await stream.result();

		expect(events).toEqual([
			["toolcall_delta", 0, '{"command":"echo '],
			["toolcall_delta", 0, '{"command":"echo mark1"}'],
			["toolcall_delta", 1, '{"command":"echo '],
			["toolcall_delta", 1, '{"command":"echo mark2"}'],
			["toolcall_end", 0, undefined],
			["toolcall_end", 1, undefined],
		]);
		expect(result.content.map(block => (block.type === "toolCall" ? block.arguments : undefined))).toEqual([
			{ command: "echo mark1" },
			{ command: "echo mark2" },
		]);
	});
});
