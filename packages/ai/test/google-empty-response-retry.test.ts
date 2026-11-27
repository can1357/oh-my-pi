import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// A Gemini turn that finishes with `finishReason: STOP` but carries only an empty text part —
// the well-known "empty response" failure. Delivered as-is, the agent receives a blank message
// and silently halts, so the provider must retry instead of surfacing it.

function sse(...chunks: unknown[]): Response {
	const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Top-level `candidates` shape (public Generative Language + Vertex). */
function genaiChunk(text: string): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: text ? 5 : 0, totalTokenCount: 15 },
	};
}

/** A Gemini finish the SDK's enum lacks: the backend failed to produce a response. */
function malformedResponseChunk(): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text: "Partial" }] }, finishReason: "MALFORMED_RESPONSE" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
	};
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, starts: events.filter(e => e.type === "start").length };
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter(b => b.type === "text")
		.map(b => b.text ?? "")
		.join("");
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const genaiModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const vertexModel: Model<"google-vertex"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Vertex)",
	api: "google-vertex",
	provider: "google",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

describe("Google empty-response retry (public + Vertex path)", () => {
	it("retries a STOP-with-empty-text response and delivers the real follow-up content", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return calls === 1 ? sse(genaiChunk("")) : sse(genaiChunk("Hello!"));
		};

		const stream = streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock });
		const { events, starts } = await drain(stream);
		const result = await stream.result();

		expect(calls).toBe(2); // one empty attempt + one successful retry
		expect(starts).toBe(1); // exactly one start across the retry — no duplicate partials
		expect(result.stopReason).toBe("stop");
		expect(textOf(result)).toBe("Hello!");
		void events;
	});

	it("surfaces an error after exhausting retries when every attempt is empty", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return sse(genaiChunk(""));
		};

		const stream = streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock });
		const result = await stream.result();

		expect(calls).toBe(3); // MAX_EMPTY_STREAM_RETRIES (2) + 1 initial attempt
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("empty response");
	});

	it("ends a MALFORMED_RESPONSE finish as a transient error that keeps the turn's usage", async () => {
		const fetchMock: FetchImpl = async () => sse(malformedResponseChunk());

		const result = await streamGoogle(genaiModel, context, { apiKey: "k", fetch: fetchMock }).result();

		expect(result.stopReason).toBe("error");
		expect(result.usage.input).toBe(10);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
	});

	it("accepts an empty STOP when silence is a valid caller result", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return sse(genaiChunk(""));
		};

		const stream = streamGoogle(genaiModel, context, {
			apiKey: "k",
			fetch: fetchMock,
			acceptEmptyResponse: true,
		});
		const result = await stream.result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("filters out empty text parts at stream end but preserves terminal thought signatures", async () => {
		const chunks = [
			{ candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
			{
				candidates: [
					{ content: { parts: [{ text: "", thoughtSignature: "terminal-sig" }] }, finishReason: "STOP" },
				],
			},
		];

		const fetchMock: FetchImpl = async input => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("oauth2.googleapis.com/token") || url.includes("metadata.google.internal")) {
				return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
			}
			return sse(...chunks);
		};

		const stream = streamGoogleVertex(vertexModel, context, {
			project: "project",
			location: "location",
			fetch: fetchMock,
		});
		const { events } = await drain(stream);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Hello",
			textSignature: "terminal-sig",
		});

		const textStartEvents = events.filter(e => e.type === "text_start");
		expect(textStartEvents).toHaveLength(1);
		expect(textStartEvents[0].contentIndex).toBe(0);

		const textDeltaEvents = events.filter(e => e.type === "text_delta");
		expect(textDeltaEvents).toHaveLength(1);
		expect(textDeltaEvents[0].delta).toBe("Hello");

		const textEndEvents = events.filter(e => e.type === "text_end");
		expect(textEndEvents).toHaveLength(1);
		expect(textEndEvents[0].content).toBe("Hello");
	});

	it("does not coalesce function-call thought signatures into the preceding Vertex text block", async () => {
		const chunks = [
			{ candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: { name: "lookup", args: { q: "x" }, id: "call_1" },
									thoughtSignature: "function-call-sig",
								},
							],
						},
						finishReason: "STOP",
					},
				],
			},
		];

		const fetchMock: FetchImpl = async input => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.includes("oauth2.googleapis.com/token") || url.includes("metadata.google.internal")) {
				return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
			}
			return sse(...chunks);
		};

		const stream = streamGoogleVertex(vertexModel, context, {
			project: "project",
			location: "location",
			fetch: fetchMock,
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toEqual({ type: "text", text: "Hello" });
		expect(result.content[1]).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "lookup",
			arguments: { q: "x" },
			thoughtSignature: "function-call-sig",
		});
	});
});
