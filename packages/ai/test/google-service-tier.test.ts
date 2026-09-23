import { describe, expect, it } from "bun:test";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

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
	thinking: {
		mode: "google-level",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		suppressWhenOff: true,
	},
});

const geminiBudgetModel: Model<"google-generative-ai"> = buildModel({
	id: "gemini-2.5-flash",
	name: "Gemini 2.5 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com/v1beta",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
	thinking: {
		mode: "budget",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		effortBudgets: { [Effort.Low]: 2_048 },
	},
});

const vertexBudgetModel: Model<"google-vertex"> = buildModel({
	id: "gemini-2.5-flash",
	name: "Gemini 2.5 Flash (Vertex)",
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
	thinking: {
		mode: "budget",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
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
	thinking: {
		mode: "google-level",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		suppressWhenOff: true,
	},
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

	it.each([
		["Gemini API", geminiModel],
		["Vertex", vertexModel],
	] as const)("suppresses baked-in thinking on %s when no effort is requested", async (_name, model) => {
		const { fetch, captured } = capturingFetch();
		await streamSimple(model, context, { apiKey: "k", fetch }).result();

		expect((captured().body.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig).toEqual({
			includeThoughts: false,
			thinkingLevel: "MINIMAL",
		});
	});
	it.each([
		["Gemini API", geminiBudgetModel, {}],
		["Gemini API explicit off", geminiBudgetModel, { disableReasoning: true }],
		["Vertex", vertexBudgetModel, {}],
		["Vertex explicit off", vertexBudgetModel, { disableReasoning: true }],
	] as const)("sends zero budget for thinking off on %s budget models", async (_name, model, options) => {
		const { fetch, captured } = capturingFetch();
		await streamSimple(model, context, { apiKey: "k", fetch, ...options }).result();

		expect((captured().body.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig).toEqual({
			includeThoughts: false,
			thinkingBudget: 0,
		});
	});

	it("Gemini API keeps service tier with budget thinking requests", async () => {
		const { fetch, captured } = capturingFetch();
		await streamSimple(geminiBudgetModel, context, {
			apiKey: "k",
			fetch,
			reasoning: Effort.Low,
			serviceTier: "priority",
		}).result();

		const body = captured().body;
		expect(body.serviceTier).toBe("priority");
		expect((body.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 2_048,
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
