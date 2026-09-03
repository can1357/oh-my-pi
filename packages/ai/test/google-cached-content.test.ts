import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import type { GoogleGeminiCliOptions } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { buildGoogleGenerateContentParams } from "@oh-my-pi/pi-ai/providers/google-shared";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import { parseRequest as parsePiNativeRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { ApiOptionsMap, AssistantMessageEvent, Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const CACHE_NAME = "cachedContents/caller-owned-corpus-abc";
const VERTEX_CACHE_NAME = "projects/demo-project/locations/us-central1/cachedContents/caller-owned-corpus-abc";

const tool: Tool = {
	name: "lookup",
	description: "Lookup a fact",
	parameters: { type: "object", properties: {}, additionalProperties: false } as never,
};

const contextWithSystemAndTools: Context = {
	systemPrompt: ["stable system instruction"],
	messages: [{ role: "user", content: "use the cache", timestamp: 1 }],
	tools: [tool],
};

const cacheOnlyContext: Context = {
	messages: [{ role: "user", content: "use the cache", timestamp: 1 }],
};

const geminiModel: Model<"google-generative-ai"> = buildModel({
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
});

const vertexModel: Model<"google-vertex"> = buildModel({
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
});

const openAiModel: Model<"openai-completions"> = buildModel({
	id: "gpt-4.1-mini",
	name: "OpenAI test model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
});

function sseStop(usage?: Record<string, number>): Response {
	const chunk = {
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: {
			promptTokenCount: usage?.promptTokenCount ?? 100,
			candidatesTokenCount: usage?.candidatesTokenCount ?? 4,
			totalTokenCount: usage?.totalTokenCount ?? 104,
			...(usage?.cachedContentTokenCount !== undefined
				? { cachedContentTokenCount: usage.cachedContentTokenCount }
				: {}),
		},
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function piNativeSseStop(): Response {
	const message = {
		role: "assistant",
		content: [],
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-2.5-flash",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	return new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", message })}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function piNativeGatewayModel<T extends "google-generative-ai" | "google-vertex">(model: Model<T>): Model<T> {
	return { ...model, baseUrl: "http://pi-native-gateway.test", transport: "pi-native" };
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

interface Captured {
	url: string;
	body: Record<string, unknown>;
}

function capturingFetch(response: Response = sseStop()): {
	fetch: FetchImpl;
	calls: () => Captured[];
} {
	const calls: Captured[] = [];
	const fetch: FetchImpl = async (input, init) => {
		calls.push({
			url: input instanceof Request ? input.url : String(input),
			body: JSON.parse(String(init?.body ?? "{}")),
		});
		return response;
	};
	return { fetch, calls: () => calls };
}

// Compile-time: cachedContent is only on GenerateContent / Vertex options, not Gemini CLI /
// Antigravity (google-gemini-cli) or any other Google transport registration.
type _GeminiCliLacksCachedContent = "cachedContent" extends keyof GoogleGeminiCliOptions ? never : true;
true satisfies _GeminiCliLacksCachedContent;
type _CliApiLacksCachedContent = "cachedContent" extends keyof ApiOptionsMap["google-gemini-cli"] ? never : true;
true satisfies _CliApiLacksCachedContent;
type _GenerativeAiHasCachedContent = "cachedContent" extends keyof ApiOptionsMap["google-generative-ai"] ? true : never;
true satisfies _GenerativeAiHasCachedContent;
type _VertexHasCachedContent = "cachedContent" extends keyof ApiOptionsMap["google-vertex"] ? true : never;
true satisfies _VertexHasCachedContent;

describe("Google caller-owned cachedContent", () => {
	it("sets exact cachedContent on the direct Gemini GenerateContent wire body", async () => {
		const { fetch, calls } = capturingFetch();
		await drain(
			streamGoogle(geminiModel, cacheOnlyContext, {
				apiKey: "k",
				cachedContent: CACHE_NAME,
				fetch,
			}),
		);

		expect(calls()).toHaveLength(1);
		const { url, body } = calls()[0]!;
		expect(url).toContain(":streamGenerateContent");
		expect(url).not.toContain("/cachedContents");
		expect(body.cachedContent).toBe(CACHE_NAME);
		expect(body.systemInstruction).toBeUndefined();
		expect(body.tools).toBeUndefined();
		expect(body.toolConfig).toBeUndefined();
	});

	it("sets exact cachedContent on the Vertex GenerateContent wire body", async () => {
		const { fetch, calls } = capturingFetch();
		await drain(
			streamGoogleVertex(vertexModel, cacheOnlyContext, {
				apiKey: "k",
				project: "demo-project",
				location: "us-central1",
				cachedContent: VERTEX_CACHE_NAME,
				fetch,
			}),
		);

		expect(calls()).toHaveLength(1);
		const { url, body } = calls()[0]!;
		expect(url).toContain(":streamGenerateContent");
		expect(url).not.toMatch(/\/cachedContents(?:\/|$|\?)/);
		expect(body.cachedContent).toBe(VERTEX_CACHE_NAME);
		expect(body.systemInstruction).toBeUndefined();
		expect(body.tools).toBeUndefined();
		expect(body.toolConfig).toBeUndefined();
	});

	it("forwards cachedContent through public dispatch only to direct Google APIs", async () => {
		const gemini = capturingFetch();
		await drain(
			streamSimple(geminiModel, cacheOnlyContext, {
				apiKey: "k",
				cachedContent: CACHE_NAME,
				fetch: gemini.fetch,
			}),
		);
		expect(gemini.calls()).toHaveLength(1);
		expect(gemini.calls()[0]?.body.cachedContent).toBe(CACHE_NAME);

		const vertex = capturingFetch();
		await drain(
			streamSimple(vertexModel, cacheOnlyContext, {
				apiKey: "k",
				cachedContent: VERTEX_CACHE_NAME,
				fetch: vertex.fetch,
			}),
		);
		expect(vertex.calls()).toHaveLength(1);
		expect(vertex.calls()[0]?.body.cachedContent).toBe(VERTEX_CACHE_NAME);

		const nonGoogle = capturingFetch(
			new Response('{"error":{"message":"expected test rejection"}}', { status: 400 }),
		);
		await drain(
			streamSimple(openAiModel, cacheOnlyContext, {
				apiKey: "k",
				cachedContent: CACHE_NAME,
				fetch: nonGoogle.fetch,
			}),
		);
		expect(nonGoogle.calls()).toHaveLength(1);
		expect(nonGoogle.calls()[0]?.body.cachedContent).toBeUndefined();
	});

	it("round-trips cachedContent through the pi-native gateway for Gemini and Vertex", async () => {
		const requests: unknown[] = [];
		const fetch: FetchImpl = async (_input, init) => {
			requests.push(JSON.parse(String(init?.body ?? "{}")));
			return piNativeSseStop();
		};

		for (const [model, cachedContent] of [
			[piNativeGatewayModel(geminiModel), CACHE_NAME],
			[piNativeGatewayModel(vertexModel), VERTEX_CACHE_NAME],
		] as const) {
			await drain(
				streamSimple(model, cacheOnlyContext, {
					apiKey: "gateway-bearer",
					cachedContent,
					fetch,
				}),
			);
		}

		expect(requests).toHaveLength(2);
		expect(requests.map(request => parsePiNativeRequest(request).options.cachedContent)).toEqual([
			CACHE_NAME,
			VERTEX_CACHE_NAME,
		]);
	});

	it("rejects blank cachedContent in the shared builder before transport", () => {
		for (const blank of ["", "   ", "\t\n"]) {
			expect(() =>
				buildGoogleGenerateContentParams(geminiModel, cacheOnlyContext, {
					apiKey: "k",
					cachedContent: blank,
				}),
			).toThrow(AIError.ValidationError);
		}
	});

	it("rejects blank cachedContent in the stream before any fetch", async () => {
		const { fetch, calls } = capturingFetch();
		const events = await drain(
			streamGoogle(geminiModel, cacheOnlyContext, {
				apiKey: "k",
				cachedContent: "  ",
				fetch,
			}),
		);
		expect(calls()).toHaveLength(0);
		const error = events.find(e => e.type === "error");
		expect(error).toBeDefined();
		if (error?.type === "error") {
			expect(error.error.errorMessage).toContain("cachedContent must not be blank");
		}
	});

	it("omits cachedContent when the option is unset", () => {
		const params = buildGoogleGenerateContentParams(geminiModel, contextWithSystemAndTools, { apiKey: "k" });
		expect(params.config?.cachedContent).toBeUndefined();
	});

	it("rejects cachedContent with request-level systemInstruction", () => {
		expect(() =>
			buildGoogleGenerateContentParams(
				geminiModel,
				{ ...cacheOnlyContext, systemPrompt: ["stable system instruction"] },
				{ apiKey: "k", cachedContent: CACHE_NAME },
			),
		).toThrow("cachedContent cannot be combined with request-level systemInstruction");
	});

	it("rejects cachedContent with request-level tools", () => {
		expect(() =>
			buildGoogleGenerateContentParams(
				geminiModel,
				{ ...cacheOnlyContext, tools: [tool] },
				{
					apiKey: "k",
					cachedContent: CACHE_NAME,
				},
			),
		).toThrow("cachedContent cannot be combined with request-level tools");
	});

	it("rejects cachedContent with request-level toolConfig", () => {
		expect(() =>
			buildGoogleGenerateContentParams(
				geminiModel,
				{ ...cacheOnlyContext, tools: [tool] },
				{
					apiKey: "k",
					cachedContent: CACHE_NAME,
					toolChoice: "none",
				},
			),
		).toThrow("cachedContent cannot be combined with request-level tools, toolConfig");
	});

	it("normalizes cachedContentTokenCount into Usage.cacheRead without double-counting input", async () => {
		const { fetch } = capturingFetch(
			sseStop({
				promptTokenCount: 100,
				cachedContentTokenCount: 80,
				candidatesTokenCount: 5,
				totalTokenCount: 105,
			}),
		);
		const events = await drain(
			streamGoogle(geminiModel, cacheOnlyContext, {
				apiKey: "k",
				cachedContent: CACHE_NAME,
				fetch,
			}),
		);
		const done = events.find(e => e.type === "done");
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.message.usage.input).toBe(20);
			expect(done.message.usage.cacheRead).toBe(80);
			expect(done.message.usage.cacheWrite).toBe(0);
			expect(done.message.usage.output).toBe(5);
			expect(done.message.usage.totalTokens).toBe(105);
		}
	});

	it("does not invoke Google cache lifecycle endpoints when referencing cached content", async () => {
		const { fetch, calls } = capturingFetch();
		await drain(
			streamGoogle(geminiModel, cacheOnlyContext, {
				apiKey: "k",
				cachedContent: CACHE_NAME,
				fetch,
			}),
		);
		const urls = calls().map(c => c.url);
		expect(urls).toHaveLength(1);
		expect(urls[0]).toMatch(/models\/gemini-2\.5-flash:streamGenerateContent/);
		for (const url of urls) {
			expect(url).not.toMatch(/\/cachedContents(?:\/[^:]*)?(?:\?|$)/);
			expect(url).not.toMatch(/cachedContents.*:(?:create|delete|patch)/i);
		}
	});
});
