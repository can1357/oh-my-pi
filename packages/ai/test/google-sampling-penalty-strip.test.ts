import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Regression for #12784: the Gemini API (public, Vertex, and Cloud Code
// Assist) has no `minP`/`repetitionPenalty` fields in `generationConfig`, so
// forwarding a global `repetitionPenalty` (or `minP`) produced
// `400 Unknown name "repetitionPenalty" ... Cannot find field`. Supported
// knobs (temperature/topP/topK/presencePenalty) must still be forwarded.

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function sseStop(): Response {
	const chunk = {
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<void> {
	for await (const _ of stream) {
		// consume
	}
}

const geminiModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const geminiCliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CLI)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://cloudcode-pa.googleapis.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

const sampling = { temperature: 1.0, topP: 0.95, topK: 40, minP: 0.05, presencePenalty: 0.1, repetitionPenalty: 1.05 };

describe("Google transports drop Gemini-unsupported sampling fields (#12784)", () => {
	it("public Gemini API omits minP/repetitionPenalty but keeps supported knobs", async () => {
		let body: Record<string, unknown> = {};
		const fetch: FetchImpl = async (_url, init) => {
			body = JSON.parse(String(init?.body ?? "{}"));
			return sseStop();
		};
		await drain(streamGoogle(geminiModel, context, { apiKey: "k", fetch, ...sampling }));
		const gen = body.generationConfig as Record<string, unknown>;
		expect(gen.repetitionPenalty).toBeUndefined();
		expect(gen.minP).toBeUndefined();
		expect(gen.temperature).toBe(1.0);
		expect(gen.topP).toBe(0.95);
		expect(gen.topK).toBe(40);
		expect(gen.presencePenalty).toBe(0.1);
	});

	it("Cloud Code Assist (gemini-cli/antigravity) omits minP/repetitionPenalty", async () => {
		let body: { request?: { generationConfig?: Record<string, unknown> } } = {};
		const fetch: FetchImpl = async (_url, init) => {
			body = JSON.parse(String(init?.body ?? "{}"));
			return sseStop();
		};
		await streamSimple(geminiCliModel, context, {
			apiKey: JSON.stringify({ token: "t", projectId: "proj-123" }),
			fetch,
			...sampling,
		}).result();
		const gen = body.request?.generationConfig ?? {};
		expect(gen.repetitionPenalty).toBeUndefined();
		expect(gen.minP).toBeUndefined();
		expect(gen.temperature).toBe(1.0);
		expect(gen.topP).toBe(0.95);
		expect(gen.presencePenalty).toBe(0.1);
	});
});
