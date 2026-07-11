import { afterEach, describe, expect, it } from "bun:test";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import type { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import type { CustomToolContext } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import {
	getImageGenTools,
	getImageGenToolsWithRegistry,
	imageGenTool,
	setPreferredImageProvider,
} from "@pk-nerdsaver-ai/pi-coding-agent/tools/image-gen";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

const originalOpenRouterKey = Bun.env.OPENROUTER_API_KEY;
const generatedImagePaths: string[] = [];

afterEach(async () => {
	await Promise.all(generatedImagePaths.splice(0).map(imagePath => removeWithRetries(imagePath)));
	if (originalOpenRouterKey === undefined) {
		delete Bun.env.OPENROUTER_API_KEY;
	} else {
		Bun.env.OPENROUTER_API_KEY = originalOpenRouterKey;
	}
	setPreferredImageProvider("auto");
});

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
		setPreferredImageProvider("antigravity");
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

	it("routes xAI image generation with xAI-only aspect ratios", async () => {
		setPreferredImageProvider("xai");
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
		expect(captured.userAgent).toBe("oh-my-pi/xai");
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
});
