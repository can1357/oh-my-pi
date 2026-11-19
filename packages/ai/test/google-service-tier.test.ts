import { describe, expect, it } from "bun:test";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

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

interface Captured {
	headers: Headers;
	body: Record<string, unknown>;
}

function capturingFetch(): { fetch: FetchImpl; captured: () => Captured } {
	let cap: Captured | undefined;
	const fetch: FetchImpl = async (_url, init) => {
		cap = {
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body ?? "{}")),
		};
		return sseStop();
	};
	return {
		fetch,
		captured: () => {
			if (!cap) throw new Error("fetch was not called");
			return cap;
		},
	};
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

const vertexModel: Model<"google-vertex"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Vertex)",
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

describe("Google service tier wire encoding", () => {
	it("Gemini API sends the tier in the request body, not a header", async () => {
		const { fetch, captured } = capturingFetch();
		await drain(streamGoogle(geminiModel, context, { apiKey: "k", serviceTier: "priority", fetch }));
		const { headers, body } = captured();
		expect(body.serviceTier).toBe("priority");
		expect(headers.get("X-Vertex-AI-LLM-Shared-Request-Type")).toBeNull();
	});

	it("Gemini API omits human-readable thought summaries when requested", async () => {
		const { fetch, captured } = capturingFetch();
		await drain(
			streamGoogle(geminiModel, context, {
				apiKey: "k",
				fetch,
				thinking: { enabled: true, level: "HIGH" },
				hideThinkingSummary: true,
			}),
		);

		expect((captured().body.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig).toEqual({
			includeThoughts: false,
			thinkingLevel: "HIGH",
		});
	});

	it("Vertex sends priority via header and omits the body tier field", async () => {
		const { fetch, captured } = capturingFetch();
		await drain(streamGoogleVertex(vertexModel, context, { apiKey: "k", serviceTier: "priority", fetch }));
		const { headers, body } = captured();
		expect(headers.get("X-Vertex-AI-LLM-Shared-Request-Type")).toBe("priority");
		expect(body.serviceTier).toBeUndefined();
	});

	it("Vertex omits both header and body for flex (no documented control)", async () => {
		const { fetch, captured } = capturingFetch();
		await drain(streamGoogleVertex(vertexModel, context, { apiKey: "k", serviceTier: "flex", fetch }));
		const { headers, body } = captured();
		expect(headers.get("X-Vertex-AI-LLM-Shared-Request-Type")).toBeNull();
		expect(body.serviceTier).toBeUndefined();
	});

	it("omits the tier entirely when unset", async () => {
		const { fetch, captured } = capturingFetch();
		await drain(streamGoogle(geminiModel, context, { apiKey: "k", fetch }));
		expect(captured().body.serviceTier).toBeUndefined();
	});
});
