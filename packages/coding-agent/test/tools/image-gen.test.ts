import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { DEFAULT_ANTIGRAVITY_IMAGE_MODEL } from "@oh-my-pi/pi-catalog/discovery/antigravity";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	getImageGenTools,
	getImageGenToolsWithRegistry,
	imageGenTool,
	setImageProviderOrder,
} from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { removeWithRetries, USER_AGENT } from "@oh-my-pi/pi-utils";

const originalOpenRouterKey = Bun.env.OPENROUTER_API_KEY;
const generatedImagePaths: string[] = [];

afterAll(async () => {
	await Promise.all(generatedImagePaths.map(imagePath => removeWithRetries(imagePath)));
});

afterEach(() => {
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

describe("imageGenTool", () => {
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
			tools: [{ type: "image_generation", output_format: "webp", size: "1536x1024", action: "generate" }],
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
			tools: [{ type: "image_generation", output_format: "webp", action: "edit" }],
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
			tools: [{ type: "image_generation", output_format: "webp", size: "1024x1024", action: "generate" }],
			stream: true,
		});
		expect(result.details?.provider).toBe("openai-codex");
		expect(result.details?.model).toBe("gpt-5.5");
		expect(result.details?.imageCount).toBe(1);
		const savedPath = result.details?.imagePaths[0];
		if (!savedPath) throw new Error("Expected generated image path");
		expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from("codex-webp"));
	});

	it("falls back when an openai-codex API key lacks a subscription account claim", async () => {
		const antigravityCredentials = JSON.stringify({ token: "test-antigravity-token", projectId: "test-project" });
		const codexModel = {
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.5",
			name: "GPT-5.5",
			baseUrl: "HTTPS://CHATGPT.COM/ignored/../backend-api/",
		} as Model;
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
				find: (provider: string, id: string) =>
					provider === "openai-codex" && id === "gpt-5.5" ? codexModel : undefined,
				getAll: () => [codexModel],
				getApiKey: async () => "plain-openai-key",
				getApiKeyForProvider: async (provider: string) => {
					if (provider === "openai-codex") return "plain-openai-key";
					if (provider === "google-antigravity") return antigravityCredentials;
					return undefined;
				},
				authStorage: { rotateSessionCredential: async () => false },
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
	it("uses opaque Codex proxy credentials when the active model is not OpenAI", async () => {
		let requestUrl: string | undefined;
		let requestHeaders: Headers | undefined;

		const fetchMock: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestUrl = input.toString();
			requestHeaders = new Headers(init?.headers);
			return new Response(
				[
					"event: response.output_item.done",
					`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "image_generation_call",
							result: Buffer.from("fake-codex-webp").toString("base64"),
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
					provider === "openai-codex" && id === "gpt-5.5-codex" ? model : undefined,
				getAll: () => [model],
				getApiKey: async () => "opaque-proxy-key",
				getApiKeyForProvider: async (provider: string) =>
					provider === "openai-codex" ? "opaque-proxy-key" : undefined,
				authStorage: {
					hasNonEnvCredential: () => false,
					rotateSessionCredential: async () => false,
				},
				resolver: () => async () => "opaque-proxy-key",
			} as unknown as ModelRegistry,
			model: activeModel,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-codex-opaque", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrl).toBe("https://example-proxy.invalid/backend-api/codex/responses");
		expect(requestHeaders?.get("authorization")).toBe("Bearer opaque-proxy-key");
		expect(requestHeaders?.has("chatgpt-account-id")).toBe(false);
		expect(requestHeaders?.has("x-openai-internal-codex-residency")).toBe(false);
		expect(requestHeaders?.get("OpenAI-Beta")).toBe("responses=experimental");
		expect(requestHeaders?.get("originator")).toBe("omp");
		expect(result.details?.provider).toBe("openai-codex");
		expect(result.details?.imageCount).toBe(1);
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
				getApiKey: async () => codexJwt,
				getApiKeyForProvider: async () => undefined,
				authStorage: { rotateSessionCredential: async () => false },
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

		// Neither endpoint advertises an image roster here, so discovery probes
		// both looking for one before generation settles on the fallback.
		expect(requestUrls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			"https://api.x.ai/v1/images/generations",
		]);
		expect(result.details?.provider).toBe("xai");
	});
	it("generates with the image model the Antigravity account actually serves", async () => {
		// This account serves gemini-3.1-flash-image; the historical default wire
		// id is not an entity on the project, so assuming it 404s and the image
		// silently comes from a different provider instead.
		setImageProviderOrder(["antigravity", "xai"]);
		const requestUrls: string[] = [];
		let generationModel: string | undefined;
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url.includes(":fetchAvailableModels")) {
				return Response.json({ imageGenerationModelIds: ["gemini-3.1-flash-image"] });
			}
			if (url.includes("streamGenerateContent")) {
				generationModel = (JSON.parse(String(init?.body)) as { model?: string }).model;
				if (generationModel !== "gemini-3.1-flash-image") {
					return Response.json({ error: { message: "Requested entity was not found." } }, { status: 404 });
				}
				return new Response(
					`data: ${JSON.stringify({
						response: {
							candidates: [
								{
									content: {
										parts: [
											{
												inlineData: {
													data: Buffer.from("antigravity-image").toString("base64"),
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
			}
			throw new Error(`Unexpected provider request: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createAntigravityXAIContext(undefined, fetchMock);

		const result = await imageGenTool.execute("call-ag-served-model", { subject: "a fox" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(generationModel).toBe("gemini-3.1-flash-image");
		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.model).toBe("gemini-3.1-flash-image");
		expect(result.details?.imageCount).toBe(1);
		// Antigravity served it, so xAI is never asked.
		expect(requestUrls.some(url => url.startsWith("https://api.x.ai/"))).toBe(false);
	});

	it("keeps the default Antigravity image model when discovery is unavailable", async () => {
		setImageProviderOrder(["antigravity"]);
		let generationModel: string | undefined;
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url.includes(":fetchAvailableModels")) {
				return new Response("Forbidden", { status: 403 });
			}
			if (url.includes("streamGenerateContent")) {
				generationModel = (JSON.parse(String(init?.body)) as { model?: string }).model;
				return new Response(
					`data: ${JSON.stringify({
						response: {
							candidates: [
								{
									content: {
										parts: [
											{
												inlineData: {
													data: Buffer.from("default-model-image").toString("base64"),
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
			}
			throw new Error(`Unexpected provider request: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createAntigravityXAIContext(undefined, fetchMock);

		const result = await imageGenTool.execute("call-ag-default-model", { subject: "a fox" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(generationModel).toBe("gemini-3-pro-image");
		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.model).toBe("gemini-3-pro-image");
	});

	it("falls over to the sandbox generation endpoint when production answers 403 in auto mode", async () => {
		setImageProviderOrder(["antigravity"]);
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request, _init?: RequestInit) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url.includes(":fetchAvailableModels")) {
				if (url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) {
					return new Response(JSON.stringify({ error: { message: "forbidden on prod" } }), {
						status: 403,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(JSON.stringify({ imageGenerationModelIds: ["gemini-3.1-flash-image"] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("streamGenerateContent")) {
				if (url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) {
					return new Response(JSON.stringify({ error: { message: "forbidden on prod generation" } }), {
						status: 403,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(
					`data: ${JSON.stringify({
						response: {
							candidates: [
								{
									content: {
										parts: [
											{
												inlineData: {
													data: Buffer.from("sandbox-image").toString("base64"),
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
			}
			throw new Error(`Unexpected provider request: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createAntigravityXAIContext(undefined, fetchMock);

		const result = await imageGenTool.execute("call-ag-prod-403-sandbox", { subject: "a fox" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.model).toBe("gemini-3.1-flash-image");
		expect(requestUrls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		]);
	});

	it("rediscovers the model when generation fails over to another endpoint", async () => {
		setImageProviderOrder(["antigravity"]);
		const requestUrls: string[] = [];
		const generationModels: Record<string, string> = {};
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			requestUrls.push(url);
			const isProd = url.startsWith("https://daily-cloudcode-pa.googleapis.com/");
			if (url.includes(":fetchAvailableModels")) {
				// Each endpoint advertises its own roster; production is tried
				// first and answers, so its model is the one pinned initially.
				return Response.json({
					imageGenerationModelIds: [isProd ? "gemini-3-prod-image" : "gemini-3-sandbox-image"],
				});
			}
			if (url.includes("streamGenerateContent")) {
				const body = JSON.parse(String(init?.body)) as { model?: string };
				generationModels[isProd ? "prod" : "sandbox"] = body.model ?? "";
				if (isProd) {
					// Retryable, so generation fails over to the next endpoint.
					return Response.json({ error: { message: "slow down" } }, { status: 429 });
				}
				if (body.model !== "gemini-3-sandbox-image") {
					return Response.json({ error: { message: `unknown model ${body.model}` } }, { status: 404 });
				}
				return new Response(
					`data: ${JSON.stringify({
						response: {
							candidates: [
								{
									content: {
										parts: [
											{
												inlineData: {
													data: Buffer.from("sandbox-failover-image").toString("base64"),
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
			}
			throw new Error(`Unexpected provider request: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createAntigravityXAIContext(undefined, fetchMock);

		const result = await imageGenTool.execute("call-ag-failover-model", { subject: "a fox" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(result.details?.provider).toBe("antigravity");
		// The failover generated with sandbox's own advertised model, not
		// production's, and the reported model is the one that served.
		expect(generationModels.prod).toBe("gemini-3-prod-image");
		expect(generationModels.sandbox).toBe("gemini-3-sandbox-image");
		expect(result.details?.model).toBe("gemini-3-sandbox-image");
		expect(requestUrls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		]);
	});

	it("keeps probing when an endpoint answers with no image roster and prefers the sibling that has one", async () => {
		setImageProviderOrder(["antigravity"]);
		const requestUrls: string[] = [];
		let generationModel: string | undefined;
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			requestUrls.push(url);
			const isProd = url.startsWith("https://daily-cloudcode-pa.googleapis.com/");
			if (url.includes(":fetchAvailableModels")) {
				// Production answers, but this account has no image roster there.
				return isProd ? Response.json({}) : Response.json({ imageGenerationModelIds: ["gemini-3-sandbox-image"] });
			}
			if (url.includes("streamGenerateContent")) {
				const body = JSON.parse(String(init?.body)) as { model?: string };
				generationModel = body.model;
				if (isProd) {
					// An unadvertised model 404s, and the generation loop does not
					// fail over on 404, so stopping the walk at production would
					// have stranded the request here.
					return Response.json({ error: { message: `unknown model ${body.model}` } }, { status: 404 });
				}
				return new Response(
					`data: ${JSON.stringify({
						response: {
							candidates: [
								{
									content: {
										parts: [
											{
												inlineData: {
													data: Buffer.from("sibling-roster-image").toString("base64"),
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
			}
			throw new Error(`Unexpected provider request: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createAntigravityXAIContext(undefined, fetchMock);

		const result = await imageGenTool.execute("call-ag-sibling-roster", { subject: "a fox" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(result.details?.provider).toBe("antigravity");
		expect(generationModel).toBe("gemini-3-sandbox-image");
		expect(result.details?.model).toBe("gemini-3-sandbox-image");
		// Generation went straight to the endpoint that advertised a roster.
		expect(requestUrls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		]);
	});

	it("pins the default model without re-probing when all endpoints answer with an empty roster", async () => {
		setImageProviderOrder(["antigravity"]);
		const requestUrls: string[] = [];
		const generationModels: Record<string, string> = {};
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			requestUrls.push(url);
			const isProd = url.startsWith("https://daily-cloudcode-pa.googleapis.com/");
			if (url.includes(":fetchAvailableModels")) {
				// Both endpoints answer with an empty roster.
				return Response.json({});
			}
			if (url.includes("streamGenerateContent")) {
				const body = JSON.parse(String(init?.body)) as { model?: string };
				generationModels[isProd ? "prod" : "sandbox"] = body.model ?? "";
				if (isProd) {
					// Production generation fails with a retryable rate limit.
					return Response.json({ error: { message: "rate limited" } }, { status: 429 });
				}
				return new Response(
					`data: ${JSON.stringify({
						response: {
							candidates: [
								{
									content: {
										parts: [
											{
												inlineData: {
													data: Buffer.from("empty-roster-image").toString("base64"),
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
			}
			throw new Error(`Unexpected provider request: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createAntigravityXAIContext(undefined, fetchMock);

		const result = await imageGenTool.execute("call-ag-all-empty", { subject: "a fox" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(generationModels.prod).toBe(DEFAULT_ANTIGRAVITY_IMAGE_MODEL);
		expect(generationModels.sandbox).toBe(DEFAULT_ANTIGRAVITY_IMAGE_MODEL);
		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.model).toBe(DEFAULT_ANTIGRAVITY_IMAGE_MODEL);
		// Preflight probed both endpoints; neither re-probed on generation or failover.
		expect(requestUrls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		]);
	});

	it("leaves an endpoint whose discovery failed unresolved so failover rediscovers it", async () => {
		setImageProviderOrder(["antigravity"]);
		const requestUrls: string[] = [];
		const generationModels: Record<string, string> = {};
		let prodDiscoveryAttempts = 0;
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			requestUrls.push(url);
			const isProd = url.startsWith("https://daily-cloudcode-pa.googleapis.com/");
			if (url.includes(":fetchAvailableModels")) {
				if (isProd) {
					prodDiscoveryAttempts++;
					if (prodDiscoveryAttempts === 1) {
						// Transient failure on production discovery.
						return Response.json({ error: { message: "internal error" } }, { status: 500 });
					}
					// Once healthy, production advertises its own image model.
					return Response.json({ imageGenerationModelIds: ["gemini-3-prod-image"] });
				}
				// Sandbox discovery succeeds during the initial walk.
				return Response.json({ imageGenerationModelIds: ["gemini-3-sandbox-image"] });
			}
			if (url.includes("streamGenerateContent")) {
				const body = JSON.parse(String(init?.body)) as { model?: string };
				generationModels[isProd ? "prod" : "sandbox"] = body.model ?? "";
				if (!isProd) {
					// Sandbox generation hits a retryable rate limit.
					return Response.json({ error: { message: "rate limited" } }, { status: 429 });
				}
				// Production serves only its advertised model; the default model 404s.
				if (body.model !== "gemini-3-prod-image") {
					return Response.json({ error: { message: `unknown model ${body.model}` } }, { status: 404 });
				}
				return new Response(
					`data: ${JSON.stringify({
						response: {
							candidates: [
								{
									content: {
										parts: [
											{
												inlineData: {
													data: Buffer.from("rediscovered-prod-image").toString("base64"),
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
			}
			throw new Error(`Unexpected provider request: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createAntigravityXAIContext(undefined, fetchMock);

		const result = await imageGenTool.execute(
			"call-ag-failed-discovery-failover",
			{ subject: "a fox" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(generationModels.sandbox).toBe("gemini-3-sandbox-image");
		expect(generationModels.prod).toBe("gemini-3-prod-image");
		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.model).toBe("gemini-3-prod-image");
		expect(requestUrls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		]);
	});

	it("leaves an endpoint the timed-out walk never probed discoverable at failover", async () => {
		setImageProviderOrder(["antigravity"]);
		const requestUrls: string[] = [];
		const generationModels: Record<string, string> = {};
		let prodDiscoveryAttempts = 0;
		// One deadline covers the whole discovery walk, so a stall on the first
		// endpoint cuts it short before the second is ever asked anything.
		const walkDeadline = new AbortController();
		const nativeTimeout = AbortSignal.timeout;
		let firstWalkProbe = true;
		const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
			if (ms !== 10_000) return nativeTimeout(ms);
			if (firstWalkProbe) {
				firstWalkProbe = false;
				queueMicrotask(() => walkDeadline.abort(new DOMException("The operation timed out.", "TimeoutError")));
				return walkDeadline.signal;
			}
			// The per-endpoint probe a failover makes gets a live budget again.
			return nativeTimeout(ms);
		});

		try {
			const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				requestUrls.push(url);
				const isProd = url.startsWith("https://daily-cloudcode-pa.googleapis.com/");
				if (url.includes(":fetchAvailableModels")) {
					if (isProd) {
						prodDiscoveryAttempts++;
						// Stalls until the walk deadline fires.
						const { promise, reject } = Promise.withResolvers<Response>();
						init?.signal?.addEventListener("abort", () => {
							reject(init.signal?.reason ?? new DOMException("The operation timed out.", "TimeoutError"));
						});
						return promise;
					}
					return Response.json({ imageGenerationModelIds: ["gemini-3-sandbox-image"] });
				}
				if (url.includes("streamGenerateContent")) {
					const body = JSON.parse(String(init?.body)) as { model?: string };
					generationModels[isProd ? "prod" : "sandbox"] = body.model ?? "";
					if (isProd) {
						return Response.json({ error: { message: "slow down" } }, { status: 429 });
					}
					if (body.model !== "gemini-3-sandbox-image") {
						return Response.json({ error: { message: `unknown model ${body.model}` } }, { status: 404 });
					}
					return new Response(
						`data: ${JSON.stringify({
							response: {
								candidates: [
									{
										content: {
											parts: [
												{
													inlineData: {
														data: Buffer.from("unprobed-failover-image").toString("base64"),
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
				}
				throw new Error(`Unexpected provider request: ${url}`);
			}) as unknown as typeof fetch;
			const ctx = createAntigravityXAIContext(undefined, fetchMock);

			const result = await imageGenTool.execute("call-ag-unprobed", { subject: "a fox" }, undefined, ctx);
			generatedImagePaths.push(...(result.details?.imagePaths ?? []));

			// Production stalled so it generates with the fallback, and sandbox
			// was never probed by the walk, so the failover discovers its roster
			// instead of reusing production's guess.
			expect(generationModels.prod).toBe(DEFAULT_ANTIGRAVITY_IMAGE_MODEL);
			expect(generationModels.sandbox).toBe("gemini-3-sandbox-image");
			expect(result.details?.provider).toBe("antigravity");
			expect(result.details?.model).toBe("gemini-3-sandbox-image");
			expect(prodDiscoveryAttempts).toBe(1);
			expect(requestUrls.filter(url => url.includes(":fetchAvailableModels"))).toEqual([
				"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
				"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
			]);
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	it("falls through to the fallback model when discovery preflight times out", async () => {
		setImageProviderOrder(["antigravity"]);
		let generationModel: string | undefined;
		const timeoutController = new AbortController();
		const nativeTimeout = AbortSignal.timeout;
		let sawDiscoveryTimeout = false;
		const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
			if (ms !== 10_000) return nativeTimeout(ms);
			sawDiscoveryTimeout = true;
			queueMicrotask(() => timeoutController.abort(new DOMException("The operation timed out.", "TimeoutError")));
			return timeoutController.signal;
		});

		try {
			const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				if (url.includes(":fetchAvailableModels")) {
					const { promise, reject } = Promise.withResolvers<Response>();
					init?.signal?.addEventListener("abort", () => {
						reject(init.signal?.reason ?? new DOMException("The operation timed out.", "TimeoutError"));
					});
					return promise;
				}
				if (url.includes("streamGenerateContent")) {
					generationModel = (JSON.parse(String(init?.body)) as { model?: string }).model;
					return new Response(
						`data: ${JSON.stringify({
							response: {
								candidates: [
									{
										content: {
											parts: [
												{
													inlineData: {
														data: Buffer.from("timeout-fallback-image").toString("base64"),
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
				}
				throw new Error(`Unexpected provider request: ${url}`);
			}) as unknown as typeof fetch;
			const ctx = createAntigravityXAIContext(undefined, fetchMock);

			const result = await imageGenTool.execute("call-ag-timeout-fallback", { subject: "a fox" }, undefined, ctx);
			generatedImagePaths.push(...(result.details?.imagePaths ?? []));

			expect(sawDiscoveryTimeout).toBe(true);
			// Asserted against the catalog constant, not a literal: the fallback
			// and the discovery preference are the same value by construction,
			// so they cannot drift apart when the catalog default changes.
			expect(generationModel).toBe(DEFAULT_ANTIGRAVITY_IMAGE_MODEL);
			expect(result.details?.provider).toBe("antigravity");
			expect(result.details?.model).toBe(DEFAULT_ANTIGRAVITY_IMAGE_MODEL);
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	it("uses the fallback model on the first generation attempt without a second discovery request when preflight times out", async () => {
		setImageProviderOrder(["antigravity"]);
		const requestUrls: string[] = [];
		let generationModel: string | undefined;
		const walkDeadline = new AbortController();
		const secondDeadline = new AbortController();
		const nativeTimeout = AbortSignal.timeout;
		let firstWalkProbe = true;
		const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
			if (ms !== 10_000) return nativeTimeout(ms);
			if (firstWalkProbe) {
				firstWalkProbe = false;
				queueMicrotask(() => walkDeadline.abort(new DOMException("The operation timed out.", "TimeoutError")));
				return walkDeadline.signal;
			}
			queueMicrotask(() => secondDeadline.abort(new DOMException("The operation timed out.", "TimeoutError")));
			return secondDeadline.signal;
		});

		try {
			const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				requestUrls.push(url);
				if (url.includes(":fetchAvailableModels")) {
					const { promise, reject } = Promise.withResolvers<Response>();
					init?.signal?.addEventListener("abort", () => {
						reject(init.signal?.reason ?? new DOMException("The operation timed out.", "TimeoutError"));
					});
					return promise;
				}
				if (url.includes("streamGenerateContent")) {
					generationModel = (JSON.parse(String(init?.body)) as { model?: string }).model;
					return new Response(
						`data: ${JSON.stringify({
							response: {
								candidates: [
									{
										content: {
											parts: [
												{
													inlineData: {
														data: Buffer.from("timeout-no-reprobe-image").toString("base64"),
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
				}
				throw new Error(`Unexpected provider request: ${url}`);
			}) as unknown as typeof fetch;
			const ctx = createAntigravityXAIContext(undefined, fetchMock);

			const result = await imageGenTool.execute("call-ag-timeout-no-reprobe", { subject: "a fox" }, undefined, ctx);
			generatedImagePaths.push(...(result.details?.imagePaths ?? []));

			expect(generationModel).toBe(DEFAULT_ANTIGRAVITY_IMAGE_MODEL);
			expect(result.details?.provider).toBe("antigravity");
			expect(result.details?.model).toBe(DEFAULT_ANTIGRAVITY_IMAGE_MODEL);
			expect(requestUrls).toEqual([
				"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
				"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			]);
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	it("propagates caller cancellation during discovery preflight", async () => {
		setImageProviderOrder(["antigravity"]);
		const callerController = new AbortController();
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url.includes(":fetchAvailableModels")) {
				const { promise, reject } = Promise.withResolvers<Response>();
				init?.signal?.addEventListener("abort", () => {
					reject(init.signal?.reason ?? new DOMException("The user aborted a request.", "AbortError"));
				});
				queueMicrotask(() => callerController.abort(new DOMException("Operation cancelled by user", "AbortError")));
				return promise;
			}
			throw new Error(`Unexpected request after abort: ${url}`);
		}) as unknown as typeof fetch;
		const ctx = createAntigravityXAIContext(undefined, fetchMock);

		await expect(
			imageGenTool.execute("call-ag-caller-abort", { subject: "a fox" }, undefined, ctx, callerController.signal),
		).rejects.toThrow();
	});

	it("skips active providers that do not support the requested aspect ratio", async () => {
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (!url.startsWith("https://api.x.ai/")) {
				throw new Error(`Unexpected provider request: ${url}`);
			}
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("xai-aspect-ratio-image").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
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

		const result = await imageGenTool.execute(
			"call-gemini-aspect-ratio-fallback",
			{ subject: "a cat", aspect_ratio: "3:2" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual(["https://api.x.ai/v1/images/generations"]);
		expect(result.details?.provider).toBe("xai");
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
