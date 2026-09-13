import { describe, expect, it } from "bun:test";
import { isAntigravitySynthetic429, isUsageLimitOutcome, parseRateLimitReason } from "@oh-my-pi/pi-ai/error/rate-limit";
import {
	getAntigravityProviderSessionState,
	sanitizeAntigravitySystemInstruction,
	streamGoogleGeminiCli,
} from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Antigravity)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

function createSseResponse(text: string): Response {
	const body = `data: ${JSON.stringify({
		response: {
			candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		},
	})}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createSynthetic429Response(): Response {
	const body = JSON.stringify({
		error: {
			code: 429,
			message: "Resource has been exhausted (e.g. check quota).",
			status: "RESOURCE_EXHAUSTED",
		},
	});
	return new Response(body, { status: 429, headers: { "content-type": "application/json" } });
}

function createDetailsLessDailyQuota429Response(): Response {
	const body = JSON.stringify({
		error: {
			code: 429,
			message: "You have exhausted your capacity on this model. Your quota will reset after 3h6m38s.",
			status: "RESOURCE_EXHAUSTED",
		},
	});
	return new Response(body, { status: 429, headers: { "content-type": "application/json" } });
}

function createRealQuota429Response(): Response {
	const body = JSON.stringify({
		error: {
			code: 429,
			message: "Resource has been exhausted (e.g. check quota).",
			status: "RESOURCE_EXHAUSTED",
			details: [
				{
					"@type": "type.googleapis.com/google.rpc.ErrorInfo",
					reason: "QUOTA_EXHAUSTED",
					domain: "googleapis.com",
				},
			],
		},
	});
	return new Response(body, { status: 429, headers: { "content-type": "application/json" } });
}

describe("google-antigravity synthetic 429 systemInstruction fold retry", () => {
	it("folds system prompt into first user turn and retries on synthetic 429", async () => {
		const requests: Array<{ body: any }> = [];
		const sessionStateMap = new Map<string, ProviderSessionState>();

		const fetchMock: FetchImpl = async (_input, init) => {
			const bodyText = typeof init?.body === "string" ? init.body : "";
			const parsedBody = bodyText ? JSON.parse(bodyText) : undefined;
			requests.push({ body: parsedBody });

			if (requests.length === 1) {
				return createSynthetic429Response();
			}
			return createSseResponse("Hello back!");
		};

		const context: Context = {
			systemPrompt: ["You are an expert coding assistant."],
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "fake-token", projectId: "test-proj" }),
			antigravityEndpointMode: "production",
			providerSessionState: sessionStateMap,
			fetch: fetchMock,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hello back!" }]);

		// First request had systemInstruction
		expect(requests).toHaveLength(2);
		expect(requests[0].body.request.systemInstruction).toBeDefined();
		expect(requests[0].body.request.systemInstruction.parts).toEqual([
			{ text: "You are an expert coding assistant." },
		]);
		expect(requests[0].body.request.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);

		// Second request had systemInstruction stripped and folded into contents[0].parts
		expect(requests[1].body.request.systemInstruction).toBeUndefined();
		expect(requests[1].body.request.contents[0].parts).toEqual([
			{ text: "You are an expert coding assistant." },
			{ text: "hi" },
		]);

		// Session state memoizes the model
		const sessionState = getAntigravityProviderSessionState(sessionStateMap);
		expect(sessionState?.foldedModels?.has("gemini-3-flash")).toBe(true);
	});

	it("sends folded request directly on subsequent turns when memoized", async () => {
		const requests: Array<{ body: any }> = [];
		const sessionStateMap = new Map<string, ProviderSessionState>();
		const sessionState = getAntigravityProviderSessionState(sessionStateMap)!;
		sessionState.foldedModels = new Set(["gemini-3-flash"]);

		const fetchMock: FetchImpl = async (_input, init) => {
			const bodyText = typeof init?.body === "string" ? init.body : "";
			requests.push({ body: JSON.parse(bodyText) });
			return createSseResponse("Second turn response");
		};

		const context: Context = {
			systemPrompt: ["You are an expert coding assistant."],
			messages: [{ role: "user", content: "second question", timestamp: 2 }],
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "fake-token", projectId: "test-proj" }),
			antigravityEndpointMode: "production",
			providerSessionState: sessionStateMap,
			fetch: fetchMock,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].body.request.systemInstruction).toBeUndefined();
		expect(requests[0].body.request.contents[0].parts).toEqual([
			{ text: "You are an expert coding assistant." },
			{ text: "second question" },
		]);
	});

	it("clears folded memo if a folded request fails", async () => {
		const sessionStateMap = new Map<string, ProviderSessionState>();
		const sessionState = getAntigravityProviderSessionState(sessionStateMap)!;
		sessionState.foldedModels = new Set(["gemini-3-flash"]);

		const fetchMock: FetchImpl = async () => {
			return new Response(JSON.stringify({ error: { code: 500, message: "Internal error" } }), {
				status: 500,
				headers: { "content-type": "application/json" },
			});
		};

		const context: Context = {
			systemPrompt: ["You are an expert coding assistant."],
			messages: [{ role: "user", content: "failing query", timestamp: 3 }],
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "fake-token", projectId: "test-proj" }),
			antigravityEndpointMode: "production",
			providerSessionState: sessionStateMap,
			fetch: fetchMock,
			maxRetryDelayMs: 0,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		// Memo should be cleared
		expect(sessionState.foldedModels.has("gemini-3-flash")).toBe(false);
	});

	it("does not fold on real quota 429 with details", async () => {
		const requests: Array<{ body: any }> = [];
		const sessionStateMap = new Map<string, ProviderSessionState>();

		const fetchMock: FetchImpl = async (_input, init) => {
			const bodyText = typeof init?.body === "string" ? init.body : "";
			requests.push({ body: JSON.parse(bodyText) });
			return createRealQuota429Response();
		};

		const context: Context = {
			systemPrompt: ["You are an expert coding assistant."],
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "fake-token", projectId: "test-proj" }),
			antigravityEndpointMode: "production",
			providerSessionState: sessionStateMap,
			fetch: fetchMock,
			maxRetryDelayMs: 0,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		// Did not retry with folding
		expect(requests.every(r => r.body.request.systemInstruction !== undefined)).toBe(true);
		const sessionState = getAntigravityProviderSessionState(sessionStateMap);
		expect(sessionState?.foldedModels?.has("gemini-3-flash")).toBeFalsy();
	});

	it("does not fold when context has no system prompt", async () => {
		const requests: Array<{ body: any }> = [];
		const sessionStateMap = new Map<string, ProviderSessionState>();

		const fetchMock: FetchImpl = async (_input, init) => {
			const bodyText = typeof init?.body === "string" ? init.body : "";
			requests.push({ body: JSON.parse(bodyText) });
			return createSynthetic429Response();
		};

		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "fake-token", projectId: "test-proj" }),
			antigravityEndpointMode: "production",
			providerSessionState: sessionStateMap,
			fetch: fetchMock,
			maxRetryDelayMs: 0,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		const sessionState = getAntigravityProviderSessionState(sessionStateMap);
		expect(sessionState?.foldedModels?.has("gemini-3-flash")).toBeFalsy();
	});

	it("does not fold on details-less daily quota 429 with 'quota will reset' message", async () => {
		const requests: Array<{ body: any }> = [];
		const sessionStateMap = new Map<string, ProviderSessionState>();

		const fetchMock: FetchImpl = async (_input, init) => {
			const bodyText = typeof init?.body === "string" ? init.body : "";
			requests.push({ body: JSON.parse(bodyText) });
			return createDetailsLessDailyQuota429Response();
		};

		const context: Context = {
			systemPrompt: ["You are an expert coding assistant."],
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "fake-token", projectId: "test-proj" }),
			antigravityEndpointMode: "production",
			providerSessionState: sessionStateMap,
			fetch: fetchMock,
			maxRetryDelayMs: 0,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		// Did not retry with folding
		expect(requests).toHaveLength(1);
		expect(requests[0].body.request.systemInstruction).toBeDefined();
		const sessionState = getAntigravityProviderSessionState(sessionStateMap);
		expect(sessionState?.foldedModels?.has("gemini-3-flash")).toBeFalsy();
	});

	it("classifies details-less daily quota error as QUOTA_EXHAUSTED and rotates credentials", () => {
		const dailyQuotaBody = JSON.stringify({
			error: {
				code: 429,
				message: "You have exhausted your capacity on this model. Your quota will reset after 3h6m38s.",
				status: "RESOURCE_EXHAUSTED",
			},
		});
		expect(isAntigravitySynthetic429(429, dailyQuotaBody)).toBe(false);
		expect(parseRateLimitReason(dailyQuotaBody)).toBe("QUOTA_EXHAUSTED");
		expect(isUsageLimitOutcome(429, dailyQuotaBody)).toBe(true);

		const syntheticBody = JSON.stringify({
			error: {
				code: 429,
				message: "Resource has been exhausted (e.g. check quota).",
				status: "RESOURCE_EXHAUSTED",
			},
		});
		expect(isAntigravitySynthetic429(429, syntheticBody)).toBe(true);
		expect(parseRateLimitReason(syntheticBody)).toBe("RATE_LIMIT_EXCEEDED");
		expect(isUsageLimitOutcome(429, syntheticBody)).toBe(false);
	});

	it("sanitizes system conventions tag with nonce even when folded", async () => {
		const requests: Array<{ body: any }> = [];
		const sessionStateMap = new Map<string, ProviderSessionState>();
		const sessionState = getAntigravityProviderSessionState(sessionStateMap)!;
		sessionState.foldedModels = new Set(["gemini-3-flash"]);

		const fetchMock: FetchImpl = async (_input, init) => {
			const bodyText = typeof init?.body === "string" ? init.body : "";
			requests.push({ body: JSON.parse(bodyText) });
			return createSseResponse("Response");
		};

		const context: Context = {
			systemPrompt: ["<system-conventions>\nRFC 2119\n</system-conventions>"],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};

		const stream = streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "fake-token", projectId: "test-proj" }),
			antigravityEndpointMode: "production",
			providerSessionState: sessionStateMap,
			fetch: fetchMock,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		const foldedFirstPart = requests[0].body.request.contents[0].parts[0].text;
		expect(foldedFirstPart).toMatch(/<system-conventions id="[a-f0-9]{8}">\nRFC 2119\n<\/system-conventions>/);
	});

	it("randomizes system-conventions tag with 8-character hex nonce", () => {
		const text = "<system-conventions>\nRFC 2119: MUST, REQUIRED\n</system-conventions>";
		const sanitized = sanitizeAntigravitySystemInstruction(text);
		expect(sanitized).toMatch(
			/<system-conventions id="[a-f0-9]{8}">\nRFC 2119: MUST, REQUIRED\n<\/system-conventions>/,
		);
		// Plain text without tag remains unchanged
		expect(sanitizeAntigravitySystemInstruction("Plain system prompt")).toBe("Plain system prompt");
	});
});
