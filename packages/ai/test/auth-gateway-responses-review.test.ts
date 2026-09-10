import { describe, expect, it } from "bun:test";
import { encodeResponse, encodeStream } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(
	responseId: string | undefined,
	timestamp: number,
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-review",
		content,
		...(responseId ? { responseId } : {}),
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp,
	};
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) return output;
		output += decoder.decode(value);
	}
}

function responseEnvelopes(raw: string): Array<Record<string, unknown>> {
	return raw
		.split("\n\n")
		.filter(chunk => chunk.includes("data: ") && !chunk.includes("data: [DONE]"))
		.map(chunk => JSON.parse(chunk.split("data: ").at(-1) ?? "{}") as Record<string, unknown>)
		.filter(frame => typeof frame.response === "object" && frame.response !== null)
		.map(frame => frame.response as Record<string, unknown>);
}

describe("auth-gateway Responses review regressions", () => {
	for (const idAtStart of [true, false]) {
		it(`keeps upstream ID and timestamp stable when the ID arrives ${idAtStart ? "at start" : "with output"}`, async () => {
			const upstreamId = "resp_upstream_review";
			const timestamp = 1_700_000_123_000;
			const start = assistant(idAtStart ? upstreamId : undefined, timestamp, []);
			const partial = assistant(upstreamId, timestamp, [{ type: "text", text: "" }]);
			const final = assistant(upstreamId, timestamp, [{ type: "text", text: "hello" }]);
			const events = new AssistantMessageEventStream();
			queueMicrotask(() => {
				events.push({ type: "start", partial: start });
				events.push({ type: "text_start", contentIndex: 0, partial });
				events.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial });
				events.push({ type: "text_end", contentIndex: 0, content: "hello", partial });
				events.push({ type: "done", reason: "stop", message: final });
			});

			const envelopes = responseEnvelopes(await collect(encodeStream(events, "gpt-review")));
			expect(envelopes.length).toBe(3);
			expect(envelopes.map(envelope => envelope.id)).toEqual([upstreamId, upstreamId, upstreamId]);
			expect(envelopes.map(envelope => envelope.created_at)).toEqual([1_700_000_123, 1_700_000_123, 1_700_000_123]);
			expect(encodeResponse(final, "gpt-review").id).toBe(upstreamId);
		});
	}

	it("uses an upstream id that appears only on the terminal event", async () => {
		const upstreamId = "resp_terminal_only_review";
		const start = assistant(undefined, 1_700_000_456_000, []);
		const final = assistant(upstreamId, 1_700_000_456_000, []);
		const events = new AssistantMessageEventStream();
		queueMicrotask(() => {
			events.push({ type: "start", partial: start });
			events.push({ type: "done", reason: "stop", message: final });
		});

		const envelopes = responseEnvelopes(await collect(encodeStream(events, "gpt-review")));
		expect(envelopes.map(envelope => envelope.id)).toEqual([upstreamId, upstreamId, upstreamId]);
	});
});
