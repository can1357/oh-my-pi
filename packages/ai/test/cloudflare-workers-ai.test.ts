/** Cloudflare Workers AI (direct): login and credential unwrapping, wire policy, usage accounting over a recorded stream, and the Cloudflare error envelope. */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	CLOUDFLARE_WORKERS_AI_BASE_URL,
	parseCloudflareWorkersAiCredential,
	serializeCloudflareWorkersAiCredential,
} from "@oh-my-pi/pi-catalog/wire/cloudflare-workers-ai";
import { withEnv } from "./helpers";

const WORKERS_MODEL = buildModel({
	id: "@cf/zai-org/glm-4.7-flash",
	name: "GLM 4.7 Flash",
	api: "openai-completions",
	provider: "cloudflare-workers-ai",
	baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
	reasoning: true,
	input: ["text"],
	cost: { input: 0.0605, output: 0.4, cacheRead: 0.03, cacheWrite: 0 },
	contextWindow: 131_072,
	maxTokens: 32_768,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
});

const WORKERS_VISION_MODEL = buildModel({
	id: "@cf/meta/llama-4-scout-17b-16e-instruct",
	name: "Llama 4 Scout",
	api: "openai-completions",
	provider: "cloudflare-workers-ai",
	baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0.27, output: 0.85, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131_072,
	maxTokens: 32_768,
});

/** Control: same SKUs behind a different provider id. */
const GATEWAY_MODEL = buildModel({
	id: "workers-ai/@cf/zai-org/glm-4.7-flash",
	name: "GLM 4.7 Flash (gateway)",
	api: "openai-completions",
	provider: "cloudflare-ai-gateway",
	baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-test/my-gateway/workers-ai",
	reasoning: false,
	input: ["text"],
	cost: { input: 0.0605, output: 0.4, cacheRead: 0.03, cacheWrite: 0 },
	contextWindow: 131_072,
	maxTokens: 32_768,
});

const CONTEXT = { messages: [{ role: "user" as const, content: "What is the weather in Paris?", timestamp: 0 }] };

const ACCOUNT_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts/acct-test/ai/v1";
const TEST_CREDENTIAL = serializeCloudflareWorkersAiCredential("wai-test-token", "acct-test");

/** Keep the developer shell out of the tests. */
const NO_CLOUDFLARE_ENV = {
	CLOUDFLARE_WORKERS_AI_API_KEY: undefined,
	CLOUDFLARE_API_TOKEN: undefined,
	CLOUDFLARE_ACCOUNT_ID: undefined,
};

// ─────────────────────────────────────────────────────────────────────────────
// Recorded stream fixture (@cf/zai-org/glm-4.7-flash)
// ─────────────────────────────────────────────────────────────────────────────

const SSE_ID = "id-1789770950290";
const SSE_CREATED = 1789770950;
const REASONING_DELTAS = ["The", " user is", " asking for", " the weather"] as const;
const REASONING_TEXT = REASONING_DELTAS.join("");

function sseBody(chunks: readonly unknown[]): string {
	return `${chunks.map(chunk => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`).join("\n\n")}\n\n`;
}

/** Intermediate chunks carry per-chunk usage deltas. */
function deltaUsage(promptTokens: number, completionTokens: number, neurons: number): Record<string, unknown> {
	return {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: promptTokens + completionTokens,
		prompt_tokens_details: { cached_tokens: 0 },
		neurons,
	};
}

function workersAiChunk(choice: Record<string, unknown>, usage: Record<string, unknown>): Record<string, unknown> {
	return {
		id: SSE_ID,
		created: SSE_CREATED,
		model: WORKERS_MODEL.id,
		object: "chat.completion.chunk",
		choices: [{ index: 0, ...choice }],
		usage,
	};
}

/** Recorded shape: duplicated reasoning aliases, one-delta tool call, and `finish_reason` emitted twice (zeroed usage, then totals). */
function workersAiStream(finalUsage: Record<string, unknown>): string {
	return sseBody([
		workersAiChunk(
			{ delta: { role: "assistant", content: "", reasoning_content: null }, logprobs: null, finish_reason: null },
			deltaUsage(170, 0, 0.9349999999999999),
		),
		...REASONING_DELTAS.map(text =>
			workersAiChunk(
				{
					delta: { reasoning: text, reasoning_content: text },
					logprobs: null,
					finish_reason: null,
					token_ids: null,
				},
				deltaUsage(0, 2, 0.0728),
			),
		),
		workersAiChunk(
			{
				delta: {
					reasoning_content: null,
					tool_calls: [
						{
							id: "chatcmpl-tool-a22c6140cd0c89bf",
							type: "function",
							index: 0,
							function: { name: "get_weather", arguments: '{"city": "Paris"}' },
						},
					],
				},
				logprobs: null,
				finish_reason: null,
				stop_reason: 154_829,
				token_ids: null,
			},
			deltaUsage(0, 2, 0.0728),
		),
		workersAiChunk({ delta: {}, finish_reason: "tool_calls" }, deltaUsage(0, 0, 0)),
		workersAiChunk({ delta: {}, finish_reason: "tool_calls" }, finalUsage),
		"[DONE]",
	]);
}

const WORKERS_AI_SSE = workersAiStream({
	prompt_tokens: 170,
	completion_tokens: 67,
	total_tokens: 237,
	prompt_tokens_details: { cached_tokens: 0 },
	neurons: 3.3737999999999992,
});

/** Same turn from a warm prompt cache. */
const WORKERS_AI_SSE_CACHED = workersAiStream({
	prompt_tokens: 26_034,
	completion_tokens: 20,
	total_tokens: 26_054,
	prompt_tokens_details: { cached_tokens: 25_984 },
	neurons: 72,
});

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

interface CapturedRequest {
	url?: string;
	headers?: Headers;
	body?: string;
}

interface BodyMessage {
	role: string;
	content: unknown;
	tool_calls?: Array<{ function: { name: string } }>;
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function captureRequest(captured: CapturedRequest, sse?: string): FetchImpl {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			captured.url = String(input instanceof Request ? input.url : input);
			captured.headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			captured.body = typeof init?.body === "string" ? init.body : undefined;
			if (sse === undefined) return Response.json({ error: { message: "captured" } }, { status: 400 });
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		},
		{ preconnect: fetch.preconnect },
	);
}

function workersAiProvider() {
	const provider = getProviderDefinition("cloudflare-workers-ai");
	if (!provider) throw new Error("Cloudflare Workers AI is not registered");
	return provider;
}

function prepareWorkersAiRequest(model: Model, apiKey?: string) {
	const provider = workersAiProvider();
	const providerModel = provider.prepareModel?.(model) ?? model;
	return provider.prepareRequest?.(providerModel, { apiKey });
}

async function loginCloudflareWorkersAi(options: OAuthController): Promise<string> {
	const login = workersAiProvider().login;
	if (!login) throw new Error("Cloudflare Workers AI login is not registered");
	const result = await login(options);
	if (typeof result !== "string") throw new Error("Expected a Cloudflare Workers AI API-key credential");
	return result;
}

function thinkingText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is ThinkingContent => block.type === "thinking")
		.map(block => block.thinking)
		.join("");
}

function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

async function streamWorkersAiTurn(sse: string): Promise<AssistantMessage> {
	const captured: CapturedRequest = {};
	return await stream(WORKERS_MODEL, CONTEXT, {
		apiKey: TEST_CREDENTIAL,
		sessionId: "sess-abc",
		fetch: captureRequest(captured, sse),
	}).result();
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Cloudflare Workers AI login and request shaping", () => {
	test("login collects the API token and the account id", async () => {
		const prompts = ["wai-test-token", "acct-test"];
		const promptMessages: string[] = [];
		const result = await loginCloudflareWorkersAi({
			onAuth: () => {},
			onPrompt: async prompt => {
				promptMessages.push(prompt.message);
				return prompts.shift() ?? "";
			},
		});

		expect(promptMessages).toEqual([
			"Paste your Cloudflare Workers AI API token",
			"Enter your Cloudflare account ID",
		]);
		expect(parseCloudflareWorkersAiCredential(result)).toEqual({ token: "wai-test-token", accountId: "acct-test" });
	});

	test("login refuses empty input and an aborted prompt", async () => {
		const controller = (answers: string[], signal?: AbortSignal): OAuthController => ({
			onAuth: () => {},
			onPrompt: async () => answers.shift() ?? "",
			...(signal ? { signal } : {}),
		});

		await expect(loginCloudflareWorkersAi(controller(["   "]))).rejects.toBeInstanceOf(AIError.ApiKeyRequiredError);
		await expect(loginCloudflareWorkersAi(controller(["wai-test-token", "  "]))).rejects.toBeInstanceOf(
			AIError.ConfigurationError,
		);
		await expect(loginCloudflareWorkersAi({ onAuth: () => {} })).rejects.toBeInstanceOf(
			AIError.OnPromptRequiredError,
		);
		await expect(
			loginCloudflareWorkersAi(controller(["wai-test-token", "acct-test"], AbortSignal.abort())),
		).rejects.toBeInstanceOf(AIError.LoginCancelledError);
	});

	test("a stored credential materializes the account endpoint and a bare bearer", () => {
		const prepared = prepareWorkersAiRequest(WORKERS_MODEL, TEST_CREDENTIAL);
		expect(prepared?.model.baseUrl).toBe(ACCOUNT_ENDPOINT);
		expect(prepared?.options.apiKey).toBe("wai-test-token");
	});

	test("a bare token pairs with the account id from the environment", async () => {
		await withEnv({ ...NO_CLOUDFLARE_ENV, CLOUDFLARE_ACCOUNT_ID: "env-account" }, () => {
			const prepared = prepareWorkersAiRequest(WORKERS_MODEL, "wai-test-token");
			expect(prepared?.model.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/env-account/ai/v1");
			expect(prepared?.options.apiKey).toBe("wai-test-token");
		});
	});

	test("a token without an account id is rejected before the request", async () => {
		await withEnv(NO_CLOUDFLARE_ENV, () => {
			expect(() => prepareWorkersAiRequest(WORKERS_MODEL, "wai-test-token")).toThrow(AIError.ConfigurationError);
		});
	});

	test("environment-only configuration materializes the endpoint", async () => {
		await withEnv(
			{
				...NO_CLOUDFLARE_ENV,
				CLOUDFLARE_API_TOKEN: "env-token",
				CLOUDFLARE_ACCOUNT_ID: "env-account",
			},
			() => {
				const prepared = prepareWorkersAiRequest(WORKERS_MODEL);
				expect(prepared?.model.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/env-account/ai/v1");
				expect(prepared?.options.apiKey).toBe("env-token");
			},
		);

		await withEnv(
			{
				...NO_CLOUDFLARE_ENV,
				CLOUDFLARE_WORKERS_AI_API_KEY: "preferred",
				CLOUDFLARE_API_TOKEN: "env-token",
				CLOUDFLARE_ACCOUNT_ID: "env-account",
			},
			() => {
				expect(prepareWorkersAiRequest(WORKERS_MODEL)?.options.apiKey).toBe("preferred");
			},
		);
	});

	test("an explicit empty apiKey falls back to the environment rather than silently no-opping", async () => {
		// `""` is not a credential.
		await withEnv(
			{
				...NO_CLOUDFLARE_ENV,
				CLOUDFLARE_WORKERS_AI_API_KEY: "env-token",
				CLOUDFLARE_ACCOUNT_ID: "env-account",
			},
			() => {
				const prepared = prepareWorkersAiRequest(WORKERS_MODEL, "");
				expect(prepared?.model.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/env-account/ai/v1");
				expect(prepared?.options.apiKey).toBe("env-token");
			},
		);

		await withEnv({ ...NO_CLOUDFLARE_ENV, CLOUDFLARE_WORKERS_AI_API_KEY: "env-token" }, () => {
			expect(() => prepareWorkersAiRequest(WORKERS_MODEL, "")).toThrow(AIError.ConfigurationError);
		});
	});

	test("an explicit non-template base URL is left alone", () => {
		const selfHosted = { ...WORKERS_MODEL, baseUrl: "https://workers-ai.internal.example/v1" };
		const prepared = prepareWorkersAiRequest(selfHosted, TEST_CREDENTIAL);
		expect(prepared?.model.baseUrl).toBe("https://workers-ai.internal.example/v1");
		expect(prepared?.options.apiKey).toBe("wai-test-token");
	});

	test("model discovery is authenticated only with an account id", async () => {
		const provider = workersAiProvider();
		const discovery = provider.prepareModelDiscovery?.({ apiKey: TEST_CREDENTIAL });
		expect(discovery?.apiKey).toBe("wai-test-token");
		expect(discovery?.baseUrl).toBe(ACCOUNT_ENDPOINT);
		expect(discovery?.authenticated).toBe(true);

		await withEnv(NO_CLOUDFLARE_ENV, () => {
			const bare = provider.prepareModelDiscovery?.({ apiKey: "wai-test-token" });
			expect(bare?.authenticated).toBe(false);
			expect(bare?.apiKey).toBeUndefined();
		});
	});
});

describe("Cloudflare Workers AI streamed turns", () => {
	test("a streamed turn sends session affinity and an explicit output cap", async () => {
		const captured: CapturedRequest = {};
		await stream(WORKERS_MODEL, CONTEXT, {
			apiKey: TEST_CREDENTIAL,
			sessionId: "sess-abc",
			fetch: captureRequest(captured),
		}).result();

		expect(captured.url).toBe(`${ACCOUNT_ENDPOINT}/chat/completions`);
		expect(captured.headers?.get("authorization")).toBe("Bearer wai-test-token");
		expect(captured.headers?.get("x-session-affinity")).toBe("sess-abc");
		// The credential reaches only the URL and the bearer.
		const leaked = [...(captured.headers?.entries() ?? [])].filter(
			([name, value]) => name !== "authorization" && (value.includes("acct-test") || value.includes("{")),
		);
		expect(leaked).toEqual([]);
		const body = JSON.parse(captured.body ?? "{}");
		const outputCap = body.max_completion_tokens ?? body.max_tokens;
		expect(outputCap).toBe(32_768);
	});

	test("session affinity is withheld when caching is disabled", async () => {
		const captured: CapturedRequest = {};
		await stream(WORKERS_MODEL, CONTEXT, {
			apiKey: TEST_CREDENTIAL,
			sessionId: "sess-abc",
			cacheRetention: "none",
			fetch: captureRequest(captured),
		}).result();

		expect(captured.url).toBe(`${ACCOUNT_ENDPOINT}/chat/completions`);
		expect(captured.headers?.get("x-session-affinity")).toBeNull();
	});

	test("the last usage chunk wins over the per-chunk deltas", async () => {
		const message = await streamWorkersAiTurn(WORKERS_AI_SSE);

		expect(message.usage.input).toBe(170);
		expect(message.usage.output).toBe(67);
		expect(message.usage.cacheRead).toBe(0);

		const calls = toolCalls(message);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("get_weather");
		expect(calls[0]?.arguments).toEqual({ city: "Paris" });
		expect(message.stopReason).toBe("toolUse");
	});

	test("duplicated reasoning aliases are not concatenated", async () => {
		const message = await streamWorkersAiTurn(WORKERS_AI_SSE);
		expect(thinkingText(message)).toBe(REASONING_TEXT);
	});

	test("cached prompt tokens are billed at the cached-input rate", async () => {
		const message = await streamWorkersAiTurn(WORKERS_AI_SSE_CACHED);

		expect(message.usage.cacheRead).toBe(25_984);
		// `prompt_tokens` includes cached tokens.
		expect(message.usage.input).toBe(50);
		expect(message.usage.cost.cacheRead).toBeCloseTo((25_984 / 1e6) * 0.03, 10);
		expect(message.usage.cost.input).toBeCloseTo((50 / 1e6) * 0.0605, 10);
	});
});

describe("Cloudflare Workers AI message-content shape", () => {
	// Some models 400 (code 5006) on a content array with two or more parts.

	async function capturedBody(model: Model, context: Context): Promise<{ messages: BodyMessage[] }> {
		const captured: CapturedRequest = {};
		await stream(model, context, { apiKey: TEST_CREDENTIAL, fetch: captureRequest(captured) }).result();
		return JSON.parse(captured.body ?? "{}");
	}

	test("a system prompt and a multi-block user turn both ride as plain strings", async () => {
		const body = await capturedBody(WORKERS_MODEL, {
			systemPrompt: ["You are omp."],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Environment: /repo" },
						{ type: "text", text: "What is the weather in Paris?" },
					],
					timestamp: 0,
				},
			],
		});

		expect(body.messages.map(message => message.role)).toEqual(["system", "user"]);
		for (const message of body.messages) expect(typeof message.content).toBe("string");
		expect(body.messages[0]?.content).toBe("You are omp.");
		expect(body.messages[1]?.content).toBe("Environment: /repo\nWhat is the weather in Paris?");
	});

	test("a tool-call round trip stays string-shaped end to end", async () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_abc123", name: "get_weather", arguments: { city: "Paris" } }],
			api: "openai-completions",
			provider: "cloudflare-workers-ai",
			model: WORKERS_MODEL.id,
			usage: EMPTY_USAGE,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const body = await capturedBody(WORKERS_MODEL, {
			systemPrompt: ["You are omp."],
			messages: [
				{ role: "user", content: [{ type: "text", text: "Weather in Paris?" }], timestamp: 0 },
				assistant,
				{
					role: "toolResult",
					toolCallId: "call_abc123",
					toolName: "get_weather",
					content: [{ type: "text", text: "18C sunny" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: [{ type: "text", text: "Thanks." }], timestamp: 3 },
			],
		});

		expect(body.messages.map(message => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
		for (const message of body.messages) expect(typeof message.content).toBe("string");
		// The strict models also reject `content: null`.
		expect(body.messages[2]?.content).toBe("");
		expect(body.messages[2]?.tool_calls?.[0]?.function.name).toBe("get_weather");
		expect(body.messages[3]?.content).toBe("18C sunny");
	});

	test("an image part keeps its array beside a string system prompt", async () => {
		const body = await capturedBody(WORKERS_VISION_MODEL, {
			systemPrompt: ["You are omp."],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "What colour is this?" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
					],
					timestamp: 0,
				},
			],
		});

		// Image content keeps its array.
		expect(body.messages[0]?.content).toBe("You are omp.");
		expect(body.messages[1]?.content).toEqual([
			{ type: "text", text: "What colour is this?" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } },
		]);
	});

	test("the gateway mirror of the same SKU still sends a parts array", async () => {
		expect(GATEWAY_MODEL.compat.requiresStringMessageContent).toBe(false);
		const body = await capturedBody(GATEWAY_MODEL, {
			systemPrompt: ["You are omp."],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Environment: /repo" },
						{ type: "text", text: "What is the weather in Paris?" },
					],
					timestamp: 0,
				},
			],
		});

		expect(body.messages[1]?.content).toEqual([
			{ type: "text", text: "Environment: /repo" },
			{ type: "text", text: "What is the weather in Paris?" },
		]);
	});
});

describe("Cloudflare Workers AI credential storage", () => {
	test("re-login replaces the account id for the same token", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authStorage = new AuthStorage(store);
		const prompts = ["wai-test-token", "acct-test", "wai-test-token", "acct-second"];
		try {
			const controller = {
				onAuth: () => {},
				onPrompt: async () => prompts.shift() ?? "",
			};
			await authStorage.login("cloudflare-workers-ai", controller);
			await authStorage.login("cloudflare-workers-ai", controller);

			const credentials = store.listAuthCredentials("cloudflare-workers-ai");
			expect(credentials).toHaveLength(1);
			const stored = credentials[0]?.credential;
			expect(stored?.type).toBe("api_key");
			expect(parseCloudflareWorkersAiCredential(stored?.type === "api_key" ? stored.key : "")).toEqual({
				token: "wai-test-token",
				accountId: "acct-second",
			});
		} finally {
			store.close();
		}
	});
});

describe("Cloudflare error envelope", () => {
	test("the Cloudflare error envelope surfaces its message and code", () => {
		const body = { success: false, errors: [{ code: 5007, message: "AiError: No such model: @cf/nope" }] };
		expect(AIError.OpenAIHttpError.parseEnvelope(body, JSON.stringify(body))).toEqual({
			detail: "AiError: No such model: @cf/nope",
			code: "5007",
		});
	});

	test("the OpenAI envelope is unchanged", () => {
		const body = { error: { message: "boom", code: "x" } };
		expect(AIError.OpenAIHttpError.parseEnvelope(body, JSON.stringify(body))).toEqual({
			detail: "boom",
			code: "x",
		});
	});
});
