import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	getImageGenTools,
	getImageGenToolsWithRegistry,
	imageGenSchema,
	imageGenTool,
	setImageProviderOrder,
} from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { ImageCapabilityError, resetImageDiscoveryCachesForTests } from "@oh-my-pi/pi-coding-agent/tools/image-targets";
import { removeWithRetries, USER_AGENT } from "@oh-my-pi/pi-utils";

const originalOpenRouterKey = Bun.env.OPENROUTER_API_KEY;
const generatedImagePaths: string[] = [];

afterAll(async () => {
	await Promise.all(generatedImagePaths.map(imagePath => removeWithRetries(imagePath)));
});

afterEach(() => {
	resetImageDiscoveryCachesForTests();
	if (originalOpenRouterKey === undefined) {
		delete Bun.env.OPENROUTER_API_KEY;
	} else {
		Bun.env.OPENROUTER_API_KEY = originalOpenRouterKey;
	}
	setImageProviderOrder([]);
});

function createAntigravityXAIContext(model: Model | undefined, fetchMock: typeof fetch): CustomToolContext {
	const antigravityCredentials = JSON.stringify({ token: "test-antigravity-token", projectId: "test-project" });
	return {
		fetch: fetchMock,
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry: {
			getApiKey: async () => undefined,
			getApiKeyForProvider: async (provider: string) => {
				if (provider === "google-antigravity") return antigravityCredentials;
				if (provider === "xai-oauth") return "test-xai-token";
				return undefined;
			},
			getProviderBaseUrl: () => undefined,
			getAll: () => [],
			authStorage: {
				hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
				rotateSessionCredential: async () => false,
			},
			resolver: (provider: string) => async () =>
				provider === "google-antigravity" ? antigravityCredentials : "test-xai-token",
		} as unknown as ModelRegistry,
		model,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

function createFalContext(fetchMock: typeof fetch, withOpenRouterCreds = false): CustomToolContext {
	return {
		fetch: fetchMock,
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry: {
			getApiKey: async () => undefined,
			getApiKeyForProvider: async (provider: string) => {
				if (provider === "fal") return "test-fal-key";
				if (withOpenRouterCreds && provider === "openrouter") return "test-or-key";
				return undefined;
			},
			getAll: () => [],
			authStorage: { rotateSessionCredential: async () => false },
			resolver: () => async () => "test-fal-key",
		} as unknown as ModelRegistry,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

function createOpenRouterContext(fetchMock: typeof fetch): CustomToolContext {
	return {
		fetch: fetchMock,
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry: {
			getApiKey: async () => undefined,
			getApiKeyForProvider: async (provider: string) => (provider === "openrouter" ? "test-or-key" : undefined),
			getAll: () => [],
			authStorage: { rotateSessionCredential: async () => false },
			resolver: () => async () => "test-or-key",
		} as unknown as ModelRegistry,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

describe("imageGenTool", () => {
	it("validates documented decimal aspect ratios and rejects undeclared ratios", () => {
		const accepted = imageGenSchema({
			subject: "a wide cinematic landscape",
			model: "grok-imagine",
			aspect_ratio: "9:20",
		});
		expect("aspect_ratio" in accepted).toBe(true);
		if (!("aspect_ratio" in accepted)) throw new Error("Expected a valid image-generation schema result");
		expect(accepted.aspect_ratio).toBe("9:20");

		const rejected = imageGenSchema({
			subject: "an unsupported ratio",
			model: "grok-imagine",
			aspect_ratio: "4:1",
		});
		expect(rejected).toHaveProperty("summary");
		if (!("summary" in rejected)) throw new Error("Expected an aspect-ratio validation error");
		expect(String(rejected.summary)).toContain("aspect_ratio");
	});
	it("registers without resolving image provider credentials", async () => {
		const modelRegistry = {
			getApiKey: async () => {
				throw new Error("active model credentials should not be resolved during registration");
			},
			getApiKeyForProvider: async () => {
				throw new Error("provider credentials should not be resolved during registration");
			},
		} as unknown as ModelRegistry;

		expect(await getImageGenTools(modelRegistry, undefined)).toEqual([imageGenTool]);
		expect(await getImageGenToolsWithRegistry(modelRegistry, undefined)).toEqual([imageGenTool]);
	});

	it("resolves image provider credentials on execution", async () => {
		setImageProviderOrder(["antigravity"]);
		const ctx: CustomToolContext = {
			fetch: async () => new Response(null),
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => undefined,
				getApiKeyForProvider: async () => {
					throw new Error("provider credentials resolved during execution");
				},
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		await expect(imageGenTool.execute("call-registration", { subject: "a cat" }, undefined, ctx)).rejects.toThrow(
			"provider credentials resolved during execution",
		);
	});

	it("e2e writes OpenAI Responses image_generation WebP output to a temp file", async () => {
		let requestUrl: string | undefined;
		let requestBody: unknown;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("fake-webp").toString("base64"),
							revised_prompt: "A crisp tabby cat portrait.",
							status: "completed",
						},
					],
					usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async () => undefined,
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => "test-openai-key",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-1", { subject: "a cat", aspect_ratio: "16:9" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.openai.com/v1/responses");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [
				{
					type: "image_generation",
					model: "gpt-image-2",
					output_format: "webp",
					size: "1536x1024",
					action: "generate",
				},
			],
			tool_choice: { type: "image_generation" },
			store: false,
		});
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.imageCount).toBe(1);
		expect(result.details?.images[0]?.mimeType).toBe("image/webp");
		expect(result.details?.revisedPrompt).toBe("A crisp tabby cat portrait.");
		expect(result.details?.imagePaths).toHaveLength(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(savedPath.endsWith(".webp")).toBe(true);
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-webp"));
	});

	it("routes OpenAI Images edits through the Responses image tool", async () => {
		setImageProviderOrder(["openai"]);
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("edited-webp").toString("base64"),
							status: "completed",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async (provider: string) => (provider === "openai" ? "test-openai-key" : undefined),
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => "test-openai-key",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute(
			"call-openai-edit",
			{
				subject: "a cat",
				changes: ["make the reference noir"],
				input: [{ data: Buffer.from("reference").toString("base64"), mime_type: "image/png" }],
			},
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.openai.com/v1/responses");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [{ type: "image_generation", model: "gpt-image-2", output_format: "webp", action: "edit" }],
		});
		const input = requestBody?.input as Array<{ content?: Array<Record<string, unknown>> }> | undefined;
		const content = input?.[0]?.content ?? [];
		expect(content.some(part => part.type === "input_image")).toBe(true);
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.imageCount).toBe(1);
	});

	it("routes image generation through a connected Codex (ChatGPT) subscription when the active model is not OpenAI", async () => {
		setImageProviderOrder(["openai-codex"]);
		let requestUrl: string | undefined;
		let accountHeader: string | null | undefined;
		let requestBody: Record<string, unknown> | undefined;

		// A fake Codex JWT (header.payload.signature) so getCodexAccountId can read
		// chatgpt_account_id from the base64 payload claim.
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-codex-1" } }),
		).toString("base64");
		const codexToken = `header.${payload}.signature`;

		const sse = `data: ${JSON.stringify({
			type: "response.completed",
			response: {
				output: [
					{
						type: "image_generation_call",
						result: Buffer.from("codex-webp").toString("base64"),
						revised_prompt: "A neon skyline.",
						status: "completed",
					},
				],
				usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
			},
		})}\n\n`;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			accountHeader = new Headers(init?.headers).get("chatgpt-account-id");
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;

		const codexModel = {
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.5",
			name: "GPT-5.5",
			baseUrl: "https://chatgpt.com/backend-api",
		} as Model;
		// Active model is Claude — proves the codex subscription path is independent of it.
		const activeModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-opus-4",
			name: "Claude",
		} as Model;

		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === "openai-codex" && id === "gpt-5.5" ? codexModel : undefined,
				getAll: () => [codexModel],
				getApiKey: async () => codexToken,
				getApiKeyForProvider: async (provider: string) => (provider === "openai-codex" ? codexToken : undefined),
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => codexToken,
			} as unknown as ModelRegistry,
			model: activeModel,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute(
			"call-codex",
			{ subject: "a neon skyline", aspect_ratio: "1:1" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(accountHeader).toBe("acct-codex-1");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [
				{
					type: "image_generation",
					model: "gpt-image-2",
					output_format: "webp",
					size: "1024x1024",
					action: "generate",
				},
			],
			stream: true,
		});
		expect(result.details?.provider).toBe("openai-codex");
		expect(result.details?.model).toBe("gpt-5.5");
		expect(result.details?.imageCount).toBe(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("codex-webp"));
	});

	it("uses a registry OpenAI hosted model for an explicit image model with an active Anthropic model", async () => {
		setImageProviderOrder(["openai"]);
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("registry-openai-image").toString("base64"),
							status: "completed",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const openaiModel = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT-5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const activeModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-opus-4",
			name: "Claude Opus 4",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getAll: () => [openaiModel],
				getApiKey: async (model: Model) => (model.provider === "openai" ? "test-openai-key" : undefined),
				getApiKeyForProvider: async () => undefined,
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => "test-openai-key",
			} as unknown as ModelRegistry,
			model: activeModel,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute(
			"call-openai-inactive-active-model",
			{
				subject: "a red fox",
				model: "gpt-image-2",
				quality: "high",
				background: "opaque",
			},
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.openai.com/v1/responses");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [{ model: "gpt-image-2", quality: "high", background: "opaque" }],
		});
		expect(result.details?.provider).toBe("openai");
		expect(result.details?.model).toBe("gpt-5.5");
		expect(result.details?.imageCount).toBe(1);
	});

	it("routes an explicit openai-codex image model through Codex when the active model is Codex", async () => {
		setImageProviderOrder(["openai-codex"]);
		let requestUrl: string | undefined;
		let accountHeader: string | null | undefined;
		let requestBody: Record<string, unknown> | undefined;

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-codex-active" } }),
		).toString("base64");
		const codexToken = `header.${payload}.signature`;
		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			const headers = new Headers(init?.headers);
			accountHeader = headers.get("chatgpt-account-id");
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const sse = `data: ${JSON.stringify({
				type: "response.completed",
				response: {
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("active-codex-image").toString("base64"),
							status: "completed",
						},
					],
				},
			})}\n\n`;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;

		const codexModel = {
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.5",
			name: "GPT-5.5",
			baseUrl: "https://chatgpt.com/backend-api",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === "openai-codex" && id === "gpt-5.5" ? codexModel : undefined,
				getAll: () => [codexModel],
				getApiKey: async () => codexToken,
				getApiKeyForProvider: async (provider: string) => (provider === "openai-codex" ? codexToken : undefined),
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => codexToken,
			} as unknown as ModelRegistry,
			model: codexModel,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute(
			"call-codex-active-model",
			{ subject: "a neon skyline", model: "gpt-image-2", provider: "openai-codex" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(accountHeader).toBe("acct-codex-active");
		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [{ model: "gpt-image-2" }],
		});
		expect(result.details?.provider).toBe("openai-codex");
		expect(result.details?.model).toBe("gpt-5.5");
		expect(result.details?.imageCount).toBe(1);
	});

	it("prefers the active Codex subscription over a metered OpenAI key", async () => {
		setImageProviderOrder([]);
		const requestUrls: string[] = [];
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-codex-priority" } }),
		).toString("base64");
		const codexToken = `header.${payload}.signature`;
		const openaiModel = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT-5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const codexModel = {
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.5",
			name: "GPT-5.5",
			baseUrl: "https://chatgpt.com/backend-api",
		} as Model;
		const sse = `data: ${JSON.stringify({
			type: "response.completed",
			response: {
				output: [
					{
						type: "image_generation_call",
						result: Buffer.from("codex-priority-image").toString("base64"),
						status: "completed",
					},
				],
			},
		})}\n\n`;
		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url === "https://api.openai.com/v1/responses") {
				return new Response(JSON.stringify({ error: { message: "metered path must not win" } }), { status: 503 });
			}
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof fetch;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === "openai-codex" && id === "gpt-5.5" ? codexModel : undefined,
				getAll: () => [openaiModel, codexModel],
				getApiKey: async (model: Model) => (model.provider === "openai" ? "metered-openai-key" : codexToken),
				getApiKeyForProvider: async (provider: string) =>
					provider === "openai-codex" ? codexToken : provider === "openai" ? "metered-openai-key" : undefined,
				authStorage: { rotateSessionCredential: async () => false },
				resolver: (model: Model) => async () => (model.provider === "openai" ? "metered-openai-key" : codexToken),
			} as unknown as ModelRegistry,
			model: codexModel,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-codex-priority", { subject: "a skyline" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual(["https://chatgpt.com/backend-api/codex/responses"]);
		expect(result.details?.provider).toBe("openai-codex");
		expect(result.details?.imageCount).toBe(1);
	});

	it("falls back when an openai-codex API key lacks a subscription account claim", async () => {
		const antigravityCredentials = JSON.stringify({ token: "test-antigravity-token", projectId: "test-project" });
		let requestUrl: string | undefined;
		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			requestUrl = input.toString();
			return new Response(
				`data: ${JSON.stringify({
					response: {
						candidates: [
							{
								content: {
									parts: [
										{
											inlineData: {
												data: Buffer.from("fallback-image").toString("base64"),
												mimeType: "image/png",
											},
										},
									],
								},
							},
						],
					},
				})}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "plain-openai-key",
				getApiKeyForProvider: async (provider: string) => {
					if (provider === "openai-codex") return "plain-openai-key";
					if (provider === "google-antigravity") return antigravityCredentials;
					return undefined;
				},
				authStorage: { hasNonEnvCredential: () => false, rotateSessionCredential: async () => false },
				resolver: (provider: string) => async () =>
					provider === "google-antigravity" ? antigravityCredentials : "plain-openai-key",
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-codex-key-fallback", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.imageCount).toBe(1);
	});

	it("honors a per-request provider override over the providers.imageOrder setting", async () => {
		// Setting selects Codex and a Codex subscription IS connected...
		setImageProviderOrder(["openai-codex"]);
		let requestUrl: string | undefined;
		const captured: { authorization: string | null } = { authorization: null };

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			captured.authorization = new Headers(init?.headers).get("authorization");
			return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("override-xai").toString("base64") }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				// Both Codex (the setting) and xAI credentials exist; the per-request
				// `provider: "xai"` override must still win over the setting.
				getApiKeyForProvider: async (provider: string) =>
					provider === "xai-oauth" || provider === "openai-codex" ? "test-token" : undefined,
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
					rotateSessionCredential: async () => false,
				},
				resolver: () => async () => "test-xai-token",
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-override", { subject: "a cat", provider: "xai" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		// Routed to xAI (the override), NOT the Codex subscription the setting selects.
		expect(requestUrl).toBe("https://api.x.ai/v1/images/generations");
		expect(captured.authorization).toBe("Bearer test-xai-token");
		expect(result.details?.provider).toBe("xai");
	});
	it("rejects opaque Codex bearer keys without a subscription account claim", async () => {
		let requestCount = 0;
		const fetchMock: typeof fetch = (async () => {
			requestCount += 1;
			throw new Error("unexpected image request");
		}) as unknown as typeof fetch;

		const model = {
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.5-codex",
			name: "GPT Codex",
			baseUrl: "https://example-proxy.invalid/backend-api",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getAll: () => [model],
				getApiKey: async () => "opaque-proxy-key",
				getApiKeyForProvider: async () => undefined,
				authStorage: { hasNonEnvCredential: () => false, rotateSessionCredential: async () => false },
				resolver: () => async () => "opaque-proxy-key",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		await expect(
			imageGenTool.execute("call-codex-opaque", { subject: "a cat", provider: "openai-codex" }, undefined, ctx),
		).rejects.toThrow("No image API credentials found");
		expect(requestCount).toBe(0);
	});

	it("adds Codex account and residency headers from bearer token claims", async () => {
		let requestHeaders: Headers | undefined;
		const tokenPayload = Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": {
					chatgpt_account_id: "acc_test",
					chatgpt_data_residency: "us",
				},
			}),
		).toString("base64");
		const codexJwt = `header.${tokenPayload}.signature`;

		const fetchMock: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			requestHeaders = new Headers(init?.headers);
			return new Response(
				[
					"event: response.output_item.done",
					`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "image_generation_call",
							result: Buffer.from("fake-codex-jwt-webp").toString("base64"),
							status: "completed",
						},
					})}`,
					"",
					"event: response.completed",
					`data: ${JSON.stringify({
						type: "response.completed",
						response: { output: [], status: "completed", error: null },
					})}`,
					"",
				].join("\n"),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;

		const model = {
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.5-codex",
			name: "GPT Codex",
			baseUrl: "https://example-proxy.invalid/backend-api",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === "openai-codex" && id === "gpt-5.5" ? model : undefined,
				getAll: () => [model],
				getApiKey: async () => codexJwt,
				getApiKeyForProvider: async (provider: string) => (provider === "openai-codex" ? codexJwt : undefined),
				authStorage: { hasNonEnvCredential: () => false, rotateSessionCredential: async () => false },
				resolver: () => async () => codexJwt,
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-codex-jwt", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestHeaders?.get("authorization")).toBe(`Bearer ${codexJwt}`);
		expect(requestHeaders?.get("chatgpt-account-id")).toBe("acc_test");
		expect(requestHeaders?.get("x-openai-internal-codex-residency")).toBe("us");
		expect(result.details?.imageCount).toBe(1);
	});
	it("routes xAI image generation with xAI-only aspect ratios", async () => {
		setImageProviderOrder(["xai"]);
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;
		const captured: { authorization: string | null; userAgent: string | null } = {
			authorization: null,
			userAgent: null,
		};

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const headers = new Headers(init?.headers);
			captured.authorization = headers.get("authorization");
			captured.userAgent = headers.get("user-agent");
			return new Response(
				JSON.stringify({
					data: [{ b64_json: Buffer.from("fake-xai-image").toString("base64") }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKeyForProvider: async (provider: string) => (provider === "xai-oauth" ? "test-xai-token" : undefined),
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
					rotateSessionCredential: async () => false,
				},
				resolver: () => async () => "test-xai-token",
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-xai", { subject: "a cat", aspect_ratio: "3:2" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.x.ai/v1/images/generations");
		expect(captured.authorization).toBe("Bearer test-xai-token");
		expect(captured.userAgent).toBe(USER_AGENT);
		expect(requestBody).toMatchObject({
			model: "grok-imagine-image",
			prompt: "a cat.",
			aspect_ratio: "3:2",
			resolution: "1k",
			n: 1,
			response_format: "b64_json",
		});
		expect(result.details?.provider).toBe("xai");
		expect(result.details?.model).toBe("grok-imagine-image");
		expect(result.details?.imageCount).toBe(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-xai-image"));
	});

	it("prefers the active xAI provider over unrelated credentialed providers", async () => {
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (!url.startsWith("https://api.x.ai/")) {
				throw new Error(`Unexpected provider request: ${url}`);
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("active-xai-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const model = {
			api: "openai-completions",
			provider: "xai-oauth",
			id: "grok-4.5",
			name: "Grok 4.5",
			baseUrl: "https://api.x.ai/v1",
		} as Model;
		const ctx = createAntigravityXAIContext(model, fetchMock);

		const result = await imageGenTool.execute("call-active-xai", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual(["https://api.x.ai/v1/images/generations"]);
		expect(result.details?.provider).toBe("xai");
	});

	it("falls back to xAI after the active OpenAI provider HTTP failure", async () => {
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url.startsWith("https://api.openai.com/")) {
				return new Response(JSON.stringify({ error: { message: "model unavailable" } }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("openai-fallback-xai-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async (provider: string) => (provider === "xai-oauth" ? "test-xai-token" : undefined),
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
					rotateSessionCredential: async () => false,
				},
				resolver: () => async () => "test-openai-key",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-openai-fallback-xai", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual(["https://api.openai.com/v1/responses", "https://api.x.ai/v1/images/generations"]);
		expect(result.details?.provider).toBe("xai");
	});

	it("falls back to xAI after an earlier provider HTTP failure", async () => {
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url.includes("streamGenerateContent")) {
				return new Response(JSON.stringify({ error: { message: "image endpoint unavailable" } }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("fallback-xai-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const ctx = createAntigravityXAIContext(undefined, fetchMock);

		const result = await imageGenTool.execute("call-fallback-xai", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			"https://api.x.ai/v1/images/generations",
		]);
		expect(result.details?.provider).toBe("xai");
	});
	it("fails closed when the requested aspect ratio is unsupported, with no HTTP call", async () => {
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			requestUrls.push(input.toString());
			return new Response("{}", { status: 500 });
		}) as unknown as typeof fetch;
		const model = {
			api: "google-generative-ai",
			provider: "google",
			id: "gemini-3-pro-image-preview",
			name: "Gemini 3 Pro Image",
			baseUrl: "https://generativelanguage.googleapis.com",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => undefined,
				getApiKeyForProvider: async (provider: string) => {
					if (provider === "google") return "test-gemini-token";
					if (provider === "xai-oauth") return "test-xai-token";
					return undefined;
				},
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
					rotateSessionCredential: async () => false,
				},
				resolver: (provider: string) => async () =>
					provider === "google" ? "test-gemini-token" : "test-xai-token",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		// 9:21 is canonical but outside the Gemini binding's aspect-ratio set; the
		// active gemini provider is first in the order, so this must fail closed
		// before any backend is contacted — no silent substitution to xAI.
		await expect(
			imageGenTool.execute(
				"call-gemini-aspect-unsupported",
				{ subject: "a cat", aspect_ratio: "9:21" },
				undefined,
				ctx,
			),
		).rejects.toThrow(ImageCapabilityError);
		expect(requestUrls).toEqual([]);
	});

	it("FAL generation wires aspect_ratio+resolution, polls the queue, and saves results", async () => {
		setImageProviderOrder(["fal"]);
		let submitUrl: string | undefined;
		let submitHeaders: Headers | undefined;
		let submitBody: Record<string, unknown> | undefined;
		let statusCalls = 0;

		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/nano-banana-pro")) {
				submitUrl = url;
				submitHeaders = new Headers(init?.headers);
				submitBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						request_id: "job-1",
						status_url: "https://fal.invalid/status/1",
						response_url: "https://fal.invalid/response/1",
						cancel_url: "https://fal.invalid/cancel/1",
						queue_position: 2,
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/status/1") {
				statusCalls += 1;
				return new Response(
					JSON.stringify(
						statusCalls === 1
							? { status: "IN_QUEUE", queue_position: 2 }
							: statusCalls === 2
								? { status: "IN_PROGRESS" }
								: { status: "COMPLETED" },
					),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/response/1") {
				return new Response(
					JSON.stringify({
						images: [{ url: "https://fal.invalid/img/a.png" }, { url: "https://fal.invalid/img/b.png" }],
					}),
					{ status: 200 },
				);
			}
			if (url.startsWith("https://fal.invalid/img/")) {
				return new Response(Buffer.from("fal-img"), { status: 200, headers: { "content-type": "image/png" } });
			}
			throw new Error(`Unexpected FAL call: ${url}`);
		}) as unknown as typeof fetch;

		const ctx = createFalContext(fetchMock);
		const result = await imageGenTool.execute(
			"call-fal-gen",
			{ subject: "a cat", model: "nano-banana-pro", aspect_ratio: "21:9", resolution: "2K", n: 2 },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(submitUrl).toBe("https://queue.fal.run/fal-ai/nano-banana-pro");
		expect(submitHeaders?.get("authorization")).toBe("Key test-fal-key");
		expect(submitHeaders?.get("x-fal-store-io")).toBe("0");
		expect(submitHeaders?.get("x-fal-object-lifecycle-preference")).toBe('{"expiration_duration_seconds":3600}');
		expect(submitBody).toMatchObject({
			prompt: "a cat.",
			aspect_ratio: "21:9",
			resolution: "2K",
			num_images: 2,
		});
		expect(submitBody?.image_size).toBeUndefined();
		expect(result.details?.provider).toBe("fal");
		expect(result.details?.model).toBe("fal-ai/nano-banana-pro");
		expect(result.details?.imageCount).toBe(2);
		expect(result.details?.images).toHaveLength(2);
		expect(result.details?.imagePaths).toHaveLength(2);
	});
	it("surfaces a provider error from a completed FAL result", async () => {
		setImageProviderOrder(["fal"]);
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/nano-banana-pro")) {
				return new Response(
					JSON.stringify({
						request_id: "job-provider-error",
						status_url: "https://fal.invalid/status/provider-error",
						response_url: "https://fal.invalid/response/provider-error",
						cancel_url: "https://fal.invalid/cancel/provider-error",
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/status/provider-error") {
				return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
			}
			if (url === "https://fal.invalid/response/provider-error") {
				return new Response(JSON.stringify({ error: { message: "moderation rejected the prompt" } }), {
					status: 200,
				});
			}
			if (url === "https://fal.invalid/cancel/provider-error") {
				return new Response(null, { status: 200 });
			}
			throw new Error(`Unexpected FAL call: ${url}`);
		}) as unknown as typeof fetch;

		await expect(
			imageGenTool.execute("call-fal-provider-error", { subject: "a cat" }, undefined, createFalContext(fetchMock)),
		).rejects.toThrow("moderation rejected the prompt");
	});

	it("surfaces the resolved provider/model in FAL queue-progress updates", async () => {
		setImageProviderOrder(["fal"]);
		const updates: string[] = [];
		const onUpdate = (r: { content?: Array<{ type: string; text?: string }> }): void => {
			updates.push((r.content ?? []).map(c => c.text ?? "").join(" "));
		};
		let statusCalls = 0;
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/nano-banana-pro")) {
				return new Response(
					JSON.stringify({
						request_id: "job-progress",
						status_url: "https://fal.invalid/status/p",
						response_url: "https://fal.invalid/response/p",
						cancel_url: "https://fal.invalid/cancel/p",
						queue_position: 4,
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/status/p") {
				statusCalls += 1;
				return new Response(
					JSON.stringify(statusCalls === 1 ? { status: "IN_QUEUE", queue_position: 4 } : { status: "COMPLETED" }),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/response/p") {
				return new Response(JSON.stringify({ images: [{ url: "https://fal.invalid/img/prog.png" }] }), {
					status: 200,
				});
			}
			if (url.startsWith("https://fal.invalid/img/")) {
				return new Response(Buffer.from("prog"), { status: 200, headers: { "content-type": "image/png" } });
			}
			throw new Error(`Unexpected FAL call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock);

		const result = await imageGenTool.execute(
			"call-progress",
			{ subject: "a cat", model: "nano-banana-pro", resolution: "2K" },
			onUpdate,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		// Both the pre-dispatch target line and the queue-status update carry provider + model.
		expect(updates).toHaveLength(2);
		expect(updates[0]).toContain("via fal");
		expect(updates[0]).toContain("fal-ai/nano-banana-pro");
		expect(updates[1]).toContain("via fal");
		expect(updates[1]).toContain("fal-ai/nano-banana-pro");
		expect(updates[1]).toMatch(/queued|generating/i);
	});

	it("surfaces the resolved provider/model for the hosted (OpenAI) path via onUpdate", async () => {
		setImageProviderOrder(["openai"]);
		const updates: string[] = [];
		const onUpdate = (r: { content?: Array<{ type: string; text?: string }> }): void => {
			updates.push((r.content ?? []).map(c => c.text ?? "").join(" "));
		};
		const fetchMock = (async () =>
			new Response(
				JSON.stringify({
					output: [
						{
							type: "image_generation_call",
							result: Buffer.from("hosted-progress").toString("base64"),
							status: "completed",
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;
		const model = {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.5",
			name: "GPT 5.5",
			baseUrl: "https://api.openai.com/v1",
		} as Model;
		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async () => undefined,
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => "test-openai-key",
			} as unknown as ModelRegistry,
			model,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute(
			"call-hosted-progress",
			{ subject: "a cat", model: "gpt-image-2" },
			onUpdate,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		// The hosted path has no per-status progress, but the pre-dispatch target line
		// must still name the resolved provider and model.
		expect(updates.some(t => t.includes("via openai") && t.includes("gpt-5.5"))).toBe(true);
	});

	it("surfaces per-image dimensions and size in details and the summary text", async () => {
		setImageProviderOrder(["fal"]);
		// 1x1 red PNG (70 bytes) — parseImageMetadata reads width/height from the header.
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
			"base64",
		);
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/flux/schnell")) {
				return new Response(
					JSON.stringify({
						request_id: "job-stats",
						status_url: "https://fal.invalid/status/s",
						response_url: "https://fal.invalid/response/s",
						cancel_url: "https://fal.invalid/cancel/s",
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/status/s") {
				return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
			}
			if (url === "https://fal.invalid/response/s") {
				return new Response(JSON.stringify({ images: [{ url: "https://fal.invalid/img/s.png" }] }), {
					status: 200,
				});
			}
			if (url.startsWith("https://fal.invalid/img/")) {
				return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
			}
			throw new Error(`Unexpected FAL call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock);

		const result = await imageGenTool.execute(
			"call-stats",
			{ subject: "a cat", model: "flux-schnell", resolution: "1K" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(result.details?.imageStats?.[0]).toMatchObject({
			width: 1,
			height: 1,
			sizeBytes: 70,
			mimeType: "image/png",
		});
		// The block text names the path plus dimensions and size.
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("(1x1");
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("70B");
	});
	it("bounds hosted FAL result downloads before buffering oversized bodies", async () => {
		setImageProviderOrder(["fal"]);
		let cancelCalls = 0;
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/flux/schnell")) {
				return new Response(
					JSON.stringify({
						request_id: "job-large",
						status_url: "https://fal.invalid/status/large",
						response_url: "https://fal.invalid/response/large",
						cancel_url: "https://fal.invalid/cancel/large",
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/status/large") {
				return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
			}
			if (url === "https://fal.invalid/response/large") {
				return new Response(JSON.stringify({ images: [{ url: "https://fal.invalid/img/large.png" }] }), {
					status: 200,
				});
			}
			if (url === "https://fal.invalid/img/large.png") {
				return new Response("small body", {
					status: 200,
					headers: {
						"content-type": "image/png",
						"content-length": String(35 * 1024 * 1024 + 1),
					},
				});
			}
			if (url === "https://fal.invalid/cancel/large") {
				cancelCalls += 1;
				return new Response(null, { status: 204 });
			}
			throw new Error(`Unexpected FAL call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock);

		await expect(
			imageGenTool.execute("call-large-result", { subject: "a cat", model: "flux-schnell" }, undefined, ctx),
		).rejects.toThrow(/Image download exceeds/i);
		expect(cancelCalls).toBe(1);
	});

	it("FAL computes image_size preserving the aspect ratio (scale-to-fit, not axis clamp)", async () => {
		setImageProviderOrder(["fal"]);
		const bodies: Array<Record<string, unknown>> = [];
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/flux-2-pro")) {
				bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return new Response(
					JSON.stringify({
						request_id: "job-flux",
						status_url: "https://fal.invalid/status/flux",
						response_url: "https://fal.invalid/response/flux",
						cancel_url: "https://fal.invalid/cancel/flux",
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/status/flux") {
				return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
			}
			if (url === "https://fal.invalid/response/flux") {
				return new Response(JSON.stringify({ images: [{ url: "https://fal.invalid/img/f.png" }] }), {
					status: 200,
				});
			}
			if (url.startsWith("https://fal.invalid/img/")) {
				return new Response(Buffer.from("flux-img"), { status: 200, headers: { "content-type": "image/png" } });
			}
			throw new Error(`Unexpected FAL call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock);

		const first = await imageGenTool.execute(
			"call-flux-169",
			{ subject: "a cat", model: "flux-2-pro", aspect_ratio: "16:9", resolution: "2K" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(first.details?.imagePaths ?? []));
		const second = await imageGenTool.execute(
			"call-flux-219",
			{ subject: "a cat", model: "flux-2-pro", aspect_ratio: "21:9", resolution: "2K" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(second.details?.imagePaths ?? []));

		expect(bodies[0]).toMatchObject({ image_size: { width: 2560, height: 1440 } });
		expect(bodies[0]?.aspect_ratio).toBeUndefined();
		expect(bodies[1]).toMatchObject({ image_size: { width: 2560, height: 1104 } });
	});

	it("fails closed on an unsupported resolution tier with no HTTP call", async () => {
		setImageProviderOrder(["fal"]);
		let calls = 0;
		const fetchMock = (async () => {
			calls += 1;
			return new Response("{}", { status: 500 });
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock);

		await expect(
			imageGenTool.execute(
				"call-flux-4k",
				{ subject: "a cat", model: "flux-2-pro", resolution: "4K" },
				undefined,
				ctx,
			),
		).rejects.toThrow(/supports up to|Unsupported resolution/i);
		expect(calls).toBe(0);
	});

	it("fails closed on an unsupported image count with no HTTP call", async () => {
		setImageProviderOrder(["fal"]);
		let calls = 0;
		const fetchMock = (async () => {
			calls += 1;
			return new Response("{}", { status: 500 });
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock);

		await expect(
			imageGenTool.execute("call-flux-n3", { subject: "a cat", model: "flux-2-pro", n: 3 }, undefined, ctx),
		).rejects.toThrow(/up to 1 image/i);
		expect(calls).toBe(0);
	});

	it("fails closed on background handling for FAL without any queue HTTP call", async () => {
		setImageProviderOrder(["fal"]);
		let calls = 0;
		const fetchMock = (async () => {
			calls += 1;
			return new Response("{}", { status: 500 });
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock);

		// FAL's GPT Image endpoint supports quality but not background handling.
		await expect(
			imageGenTool.execute(
				"call-fal-background",
				{ subject: "a cat", model: "gpt-image-2", background: "opaque" },
				undefined,
				ctx,
			),
		).rejects.toThrow(/background handling is not supported/i);
		expect(calls).toBe(0);
	});

	it("FAL edits upload inputs to the CDN and send file_urls, not data: URIs", async () => {
		setImageProviderOrder(["fal"]);
		const uploads: Array<{ url: string; init?: RequestInit }> = [];
		let submitBody: Record<string, unknown> | undefined;

		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url.startsWith("https://rest.fal.ai/storage/upload/initiate")) {
				uploads.push({ url, init });
				return new Response(
					JSON.stringify({
						upload_url: "https://fal.invalid/presign",
						file_url: "https://fal-internal.s3/input.png",
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/presign") {
				uploads.push({ url, init });
				return new Response(null, { status: 200 });
			}
			if (url === "https://queue.fal.run/fal-ai/nano-banana-pro/edit") {
				submitBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						request_id: "job-edit",
						status_url: "https://fal.invalid/status/e",
						response_url: "https://fal.invalid/response/e",
						cancel_url: "https://fal.invalid/cancel/e",
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/status/e") {
				return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
			}
			if (url === "https://fal.invalid/response/e") {
				return new Response(JSON.stringify({ images: [{ url: "https://fal.invalid/img/out.png" }] }), {
					status: 200,
				});
			}
			if (url.startsWith("https://fal.invalid/img/")) {
				return new Response(Buffer.from("edited"), { status: 200, headers: { "content-type": "image/png" } });
			}
			throw new Error(`Unexpected FAL call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock);

		const result = await imageGenTool.execute(
			"call-fal-edit",
			{
				subject: "a cat",
				model: "nano-banana-pro",
				changes: ["make it noir"],
				input: [{ data: Buffer.from("ref").toString("base64"), mime_type: "image/png" }],
			},
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		// Upload initiate then PUT of the raw bytes.
		expect(uploads[0]?.url).toContain("rest.fal.ai/storage/upload/initiate");
		expect(JSON.parse(String(uploads[0]?.init?.body))).toEqual({
			content_type: "image/png",
			file_name: expect.stringMatching(/^.+\.png$/),
		});
		expect(uploads[1]?.url).toBe("https://fal.invalid/presign");
		expect(submitBody).toMatchObject({ image_urls: ["https://fal-internal.s3/input.png"] });
		const urls = submitBody?.image_urls as string[];
		expect(urls.every(u => !u.startsWith("data:"))).toBe(true);
		expect(result.details?.provider).toBe("fal");
	});

	it("cancels a FAL job and surfaces the error when aborted mid-poll", async () => {
		setImageProviderOrder(["fal"]);
		const controller = new AbortController();
		let cancelCalls = 0;
		// Abort while the queue poll is sleeping.
		setTimeout(() => controller.abort(new Error("test abort")), 50);
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/flux/schnell")) {
				return new Response(
					JSON.stringify({
						request_id: "job-cancel",
						status_url: "https://fal.invalid/status/c",
						response_url: "https://fal.invalid/response/c",
						cancel_url: "https://fal.invalid/cancel/c",
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/cancel/c") {
				cancelCalls += 1;
				return new Response(null, { status: 200 });
			}
			throw new Error(`Unexpected FAL call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock);

		await expect(
			imageGenTool.execute(
				"call-cancel",
				{ subject: "a cat", model: "flux-schnell" },
				undefined,
				ctx,
				controller.signal,
			),
		).rejects.toThrow(/test abort/i);
		expect(cancelCalls).toBe(1);
	});

	it("stops the fallback ladder once a FAL job is accepted", async () => {
		setImageProviderOrder(["fal", "openrouter"]);
		const openRouterCalls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/nano-banana-pro")) {
				return new Response(
					JSON.stringify({
						request_id: "job-accepted",
						status_url: "https://fal.invalid/status/a",
						response_url: "https://fal.invalid/response/a",
						cancel_url: "https://fal.invalid/cancel/a",
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/status/a") {
				return new Response("{}", { status: 500 });
			}
			if (url === "https://fal.invalid/cancel/a") {
				return new Response(null, { status: 200 });
			}
			if (url.startsWith("https://openrouter.ai/")) {
				openRouterCalls.push(url);
				return new Response("{}", { status: 500 });
			}
			throw new Error(`Unexpected call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock, true);

		await expect(
			imageGenTool.execute("call-accepted", { subject: "a cat", model: "nano-banana-pro" }, undefined, ctx),
		).rejects.toThrow(/FAL job job-accepted/i);
		expect(openRouterCalls).toEqual([]);
	});
	it("does not retry FAL authentication after a job is accepted", async () => {
		setImageProviderOrder(["fal", "openrouter"]);
		let submitCalls = 0;
		let statusCalls = 0;
		let cancelCalls = 0;
		let openRouterCalls = 0;
		let resolverCalls = 0;
		let rotateCalls = 0;
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/nano-banana-pro")) {
				submitCalls += 1;
				expect(new Headers(init?.headers).get("authorization")).toBe("Key initial-fal-key");
				return new Response(
					JSON.stringify({
						request_id: "job-auth-safe",
						status_url: "https://fal.invalid/status/auth-safe",
						response_url: "https://fal.invalid/response/auth-safe",
						cancel_url: "https://fal.invalid/cancel/auth-safe",
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/status/auth-safe") {
				statusCalls += 1;
				return new Response("expired", { status: 401 });
			}
			if (url === "https://fal.invalid/cancel/auth-safe") {
				cancelCalls += 1;
				return new Response(null, { status: 204 });
			}
			if (url.startsWith("https://openrouter.ai/")) {
				openRouterCalls += 1;
				return new Response("{}", { status: 500 });
			}
			throw new Error(`Unexpected FAL call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock, true);
		ctx.modelRegistry = {
			getApiKey: async () => undefined,
			getApiKeyForProvider: async (provider: string) => {
				if (provider === "fal") return "initial-fal-key";
				if (provider === "openrouter") return "test-openrouter-key";
				return undefined;
			},
			getAll: () => [],
			authStorage: {
				rotateSessionCredential: async () => {
					rotateCalls += 1;
					return true;
				},
			},
			resolver: () => {
				resolverCalls += 1;
				return async () => {
					resolverCalls += 1;
					return "rotated-fal-key";
				};
			},
		} as unknown as ModelRegistry;

		await expect(
			imageGenTool.execute("call-auth-safe", { subject: "a cat", model: "nano-banana-pro" }, undefined, ctx),
		).rejects.toThrow(/FAL job job-auth-safe/i);
		expect(submitCalls).toBe(1);
		expect(statusCalls).toBe(1);
		expect(cancelCalls).toBe(1);
		expect(resolverCalls).toBe(0);
		expect(rotateCalls).toBe(0);
		expect(openRouterCalls).toBe(0);
	});
	it("does not fall back after an ambiguous FAL submit outcome", async () => {
		setImageProviderOrder(["fal", "openrouter"]);
		let openRouterCalls = 0;
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/nano-banana-pro")) {
				throw new Error("socket reset after request write");
			}
			if (url.startsWith("https://openrouter.ai/")) {
				openRouterCalls += 1;
				return new Response("{}", { status: 500 });
			}
			throw new Error(`Unexpected call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock, true);

		await expect(
			imageGenTool.execute("call-ambiguous-submit", { subject: "a cat", model: "nano-banana-pro" }, undefined, ctx),
		).rejects.toThrow(/FAL request outcome is ambiguous/i);
		expect(openRouterCalls).toBe(0);
	});
	it("does not fall back after a FAL input upload failure", async () => {
		setImageProviderOrder(["fal", "openrouter"]);
		let openRouterCalls = 0;
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://rest.fal.ai/storage/upload/initiate")) {
				return new Response("upload unavailable", { status: 503 });
			}
			if (url.startsWith("https://openrouter.ai/")) {
				openRouterCalls += 1;
				return new Response("{}", { status: 500 });
			}
			throw new Error(`Unexpected call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock, true);

		await expect(
			imageGenTool.execute(
				"call-upload-failure",
				{
					subject: "a cat",
					model: "nano-banana-pro",
					input: [{ data: "ref", mime_type: "image/png" }],
				},
				undefined,
				ctx,
			),
		).rejects.toThrow(/FAL upload initiate failed/i);
		expect(openRouterCalls).toBe(0);
	});
	it("rejects incomplete FAL upload metadata before PUT or queue submission", async () => {
		setImageProviderOrder(["fal"]);
		const calls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			calls.push(url);
			if (url.startsWith("https://rest.fal.ai/storage/upload/initiate")) {
				return new Response(JSON.stringify({ upload_url: "https://fal.invalid/presign" }), { status: 200 });
			}
			throw new Error(`Unexpected FAL call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock);

		await expect(
			imageGenTool.execute(
				"call-incomplete-upload",
				{ subject: "a cat", model: "nano-banana-pro", input: [{ data: "ref", mime_type: "image/png" }] },
				undefined,
				ctx,
			),
		).rejects.toThrow(/incomplete upload metadata/i);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("storage/upload/initiate");
	});

	it("does not fall back after an accepted FAL response omits request_id", async () => {
		setImageProviderOrder(["fal", "openrouter"]);
		let openRouterCalls = 0;
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/nano-banana-pro")) {
				return new Response(JSON.stringify({ status_url: "https://fal.invalid/status/missing-id" }), {
					status: 200,
				});
			}
			if (url.startsWith("https://openrouter.ai/")) {
				openRouterCalls += 1;
				return new Response("{}", { status: 500 });
			}
			throw new Error(`Unexpected call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock, true);

		await expect(
			imageGenTool.execute(
				"call-missing-request-id",
				{ subject: "a cat", model: "nano-banana-pro" },
				undefined,
				ctx,
			),
		).rejects.toThrow(/without a request_id/i);
		expect(openRouterCalls).toBe(0);
	});
	it("cancels an accepted FAL job with incomplete metadata", async () => {
		setImageProviderOrder(["fal", "openrouter"]);
		let cancelCalls = 0;
		let openRouterCalls = 0;
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/nano-banana-pro")) {
				return new Response(
					JSON.stringify({
						request_id: "job-incomplete",
						status_url: "https://fal.invalid/status/incomplete",
						cancel_url: "https://fal.invalid/cancel/incomplete",
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/cancel/incomplete") {
				cancelCalls += 1;
				return new Response(null, { status: 204 });
			}
			if (url.startsWith("https://openrouter.ai/")) {
				openRouterCalls += 1;
				return new Response("{}", { status: 500 });
			}
			throw new Error(`Unexpected call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock, true);

		await expect(
			imageGenTool.execute(
				"call-incomplete-metadata",
				{ subject: "a cat", model: "nano-banana-pro" },
				undefined,
				ctx,
			),
		).rejects.toThrow(/malformed job metadata/i);
		expect(cancelCalls).toBe(1);
		expect(openRouterCalls).toBe(0);
	});

	it("falls back to the same model's OpenRouter binding on a FAL 503", async () => {
		setImageProviderOrder(["fal", "openrouter"]);
		const openRouterBodies: Array<Record<string, unknown>> = [];
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/fal-ai/flux-2-pro")) {
				return new Response("service unavailable", { status: 503 });
			}
			if (url.startsWith("https://openrouter.ai/api/v1/images")) {
				openRouterBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return new Response(
					JSON.stringify({
						data: [{ b64_json: Buffer.from("or-flux").toString("base64"), media_type: "image/png" }],
					}),
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock, true);

		const result = await imageGenTool.execute(
			"call-flux-fallback",
			{ subject: "a cat", model: "flux-2-pro" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(openRouterBodies[0]?.model).toBe("black-forest-labs/flux.2-pro");
		expect(result.details?.provider).toBe("openrouter");
	});

	it("pins to the requested provider with a single failure and no other provider", async () => {
		setImageProviderOrder(["openrouter"]);
		let falCalls = 0;
		let openRouterCalls = 0;
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://queue.fal.run/")) {
				falCalls += 1;
				return new Response("boom", { status: 500 });
			}
			if (url.startsWith("https://openrouter.ai/")) {
				openRouterCalls += 1;
				return new Response("{}", { status: 500 });
			}
			throw new Error(`Unexpected call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock, true);

		await expect(
			imageGenTool.execute("call-pinned", { subject: "a cat", provider: "fal" }, undefined, ctx),
		).rejects.toThrow();
		expect(falCalls).toBe(1);
		expect(openRouterCalls).toBe(0);
	});

	it("OpenRouter Images API sends declared knobs, input_references, and surfaces cost", async () => {
		setImageProviderOrder(["openrouter"]);
		let body: Record<string, unknown> | undefined;
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url.startsWith("https://openrouter.ai/api/v1/images")) {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						data: [{ b64_json: Buffer.from("or-webp").toString("base64"), media_type: "image/webp" }],
						usage: { cost: 0.0123 },
					}),
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createOpenRouterContext(fetchMock);

		const result = await imageGenTool.execute(
			"call-or",
			{
				subject: "a cat",
				model: "nano-banana-2",
				aspect_ratio: "16:9",
				resolution: "2K",
				changes: ["make it brighter"],
				input: [{ data: Buffer.from("ref").toString("base64"), mime_type: "image/png" }],
			},
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(body?.model).toBe("google/gemini-3.1-flash-image");
		expect(body?.aspect_ratio).toBe("16:9");
		expect(body?.resolution).toBe("2K");
		const refs = body?.input_references as Array<{ type: string; image_url?: { url: string } }>;
		expect(refs[0]?.type).toBe("image_url");
		expect(refs[0]?.image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
		const savedPath = result.details?.imagePaths[0];
		expect(savedPath?.endsWith(".webp")).toBe(true);
		expect(result.details?.costUsd).toBe(0.0123);
		expect(result.details?.images?.[0]?.mimeType).toBe("image/webp");
	});
	it("retains OpenRouter cost when no image data is returned", async () => {
		setImageProviderOrder(["openrouter"]);
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://openrouter.ai/api/v1/images")) {
				return new Response(JSON.stringify({ data: [], usage: { cost: 0.0042 } }), { status: 200 });
			}
			throw new Error(`Unexpected call: ${url}`);
		}) as unknown as typeof fetch;

		const result = await imageGenTool.execute(
			"call-or-empty",
			{ subject: "a cat", model: "nano-banana-2" },
			undefined,
			createOpenRouterContext(fetchMock),
		);

		expect(result.details?.imageCount).toBe(0);
		expect(result.details?.entryId).toBe("nano-banana-2");
		expect(result.details?.costUsd).toBe(0.0042);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("No image data returned");
	});

	it("raw fal: passthrough maps the endpoint once and caches discovery", async () => {
		setImageProviderOrder(["fal"]);
		const schemaFetches: string[] = [];
		let submitBody: Record<string, unknown> | undefined;
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url.startsWith("https://fal.ai/api/openapi/queue/openapi.json")) {
				schemaFetches.push(url);
				return new Response(
					JSON.stringify({
						components: {
							schemas: {
								QwenImage3Input: {
									properties: {
										prompt: { type: "string" },
										image_size: { type: "object" },
										num_images: { type: "integer" },
										output_format: { type: "string", enum: ["jpeg", "png", "webp"] },
									},
								},
							},
						},
					}),
					{ status: 200 },
				);
			}
			if (url.startsWith("https://queue.fal.run/alibaba/qwen-image-3/text-to-image")) {
				submitBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						request_id: "job-qwen",
						status_url: "https://fal.invalid/status/q",
						response_url: "https://fal.invalid/response/q",
						cancel_url: "https://fal.invalid/cancel/q",
					}),
					{ status: 200 },
				);
			}
			if (url === "https://fal.invalid/status/q") {
				return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
			}
			if (url === "https://fal.invalid/response/q") {
				return new Response(JSON.stringify({ images: [{ url: "https://fal.invalid/img/q.png" }] }), {
					status: 200,
				});
			}
			if (url.startsWith("https://fal.invalid/img/")) {
				return new Response(Buffer.from("qwen"), { status: 200, headers: { "content-type": "image/png" } });
			}
			throw new Error(`Unexpected call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock);

		const result = await imageGenTool.execute(
			"call-raw-1",
			{ subject: "a cat", model: "fal:alibaba/qwen-image-3/text-to-image", resolution: "1K" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(submitBody).toMatchObject({ image_size: { width: 1024, height: 1024 } });
		expect(schemaFetches).toHaveLength(1);

		// Second identical call reuses the in-memory cache — schema fetched once.
		const result2 = await imageGenTool.execute(
			"call-raw-2",
			{ subject: "a cat", model: "fal:alibaba/qwen-image-3/text-to-image", resolution: "1K" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result2.details?.imagePaths ?? []));
		expect(schemaFetches).toHaveLength(1);
	});

	it("rejects a raw FAL endpoint without a prompt before any queue call", async () => {
		setImageProviderOrder(["fal"]);
		let queueCalls = 0;
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.startsWith("https://fal.ai/api/openapi/queue/openapi.json")) {
				return new Response(
					JSON.stringify({
						components: { schemas: { FooInput: { properties: { image_size: { type: "object" } } } } },
					}),
					{ status: 200 },
				);
			}
			if (url.startsWith("https://queue.fal.run/")) {
				queueCalls += 1;
				return new Response("{}", { status: 500 });
			}
			throw new Error(`Unexpected call: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createFalContext(fetchMock, true);

		await expect(
			imageGenTool.execute(
				"call-raw-noprompt",
				{ subject: "a cat", model: "fal:fal-ai/not-prompt" },
				undefined,
				ctx,
				new AbortController().signal,
			),
		).rejects.toThrow(/not a prompt-driven image endpoint/);
		expect(queueCalls).toBe(0);
	});

	it("routes DeepInfra image generation through the OpenAI-compatible images endpoint", async () => {
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;
		const captured: { authorization: string | null } = { authorization: null };

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			captured.authorization = new Headers(init?.headers).get("authorization");
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("fake-deepinfra-image").toString("base64"), url: null }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKeyForProvider: async (provider: string) =>
					provider === "deepinfra" ? "test-deepinfra-key" : undefined,
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => "test-deepinfra-key",
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute(
			"call-deepinfra",
			{ subject: "a cat", aspect_ratio: "16:9", provider: "deepinfra" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://api.deepinfra.com/v1/openai/images/generations");
		expect(captured.authorization).toBe("Bearer test-deepinfra-key");
		expect(requestBody).toMatchObject({
			model: "black-forest-labs/FLUX-2-pro",
			prompt: "a cat.",
			n: 1,
			response_format: "b64_json",
			size: "1536x1024",
		});
		expect(result.details?.provider).toBe("deepinfra");
		expect(result.details?.model).toBe("black-forest-labs/FLUX-2-pro");
		expect(result.details?.imageCount).toBe(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("fake-deepinfra-image"));
	});

	it("skips DeepInfra for edit requests so an edit-capable provider can serve them", async () => {
		const requestUrls: string[] = [];
		const fetchMock: typeof fetch = (async (input: string | URL | Request) => {
			requestUrls.push(input.toString());
			throw new Error(`Unexpected provider request: ${input.toString()}`);
		}) as unknown as typeof fetch;

		const ctx: CustomToolContext = {
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => undefined,
				getApiKeyForProvider: async (provider: string) =>
					provider === "deepinfra" ? "test-deepinfra-key" : undefined,
				getProviderBaseUrl: () => undefined,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: () => false,
					rotateSessionCredential: async () => false,
				},
				resolver: () => async () => "test-deepinfra-key",
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		await expect(
			imageGenTool.execute(
				"call-deepinfra-edit",
				{
					subject: "a cat",
					changes: ["make it noir"],
					input: [{ data: Buffer.from("reference").toString("base64"), mime_type: "image/png" }],
				},
				undefined,
				ctx,
			),
		).rejects.toThrow("deepinfra image generation is text-to-image only and cannot edit input images");
		// DeepInfra was credentialed but must not receive the edit request.
		expect(requestUrls).toEqual([]);
	});
});
