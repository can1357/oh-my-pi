import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	getImageGenTools,
	getImageGenToolsWithRegistry,
	imageGenTool,
	type ImageGenParams,
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
		settings: Settings.isolated({}),
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
			find: () => undefined,
			getProviderHeaders: async () => undefined,
			resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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

const OPENROUTER_IMAGE_MODEL = "openai/gpt-image-2.5-flare";
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_REFERENCE = { data: RED_1X1_PNG_BASE64, mime_type: "image/png" };

interface ImageApiRequest {
	url: string;
	method: string;
	body?: Record<string, unknown>;
}

function createOpenRouterImageContext(
	options: {
		model?: string;
		settings?: Settings;
		credentials?: boolean;
		metadata?: unknown;
		discoveryResponse?: () => Response;
		imageResponse?: () => Response;
	} = {},
): { ctx: CustomToolContext; requests: ImageApiRequest[]; credentialReads: string[] } {
	const model = options.model ?? OPENROUTER_IMAGE_MODEL;
	const discoveryUrl = `https://openrouter.ai/api/v1/images/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`;
	const requests: ImageApiRequest[] = [];
	const credentialReads: string[] = [];
	const ctx: CustomToolContext = {
		fetch: (async (input, init) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			requests.push({
				url,
				method,
				body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>),
			});
			if (url === discoveryUrl && method === "GET") {
				expect(init?.body).toBeUndefined();
				return (
					options.discoveryResponse?.() ??
					Response.json(
						options.metadata === undefined
							? { id: model, endpoints: [{ provider_tag: "openai", supported_parameters: {} }] }
							: options.metadata,
					)
				);
			}
			if (url === "https://openrouter.ai/api/v1/images" && method === "POST") {
				return options.imageResponse?.() ?? Response.json({ data: [] });
			}
			if (url === "https://api.x.ai/v1/images/generations" && method === "POST") {
				return Response.json({ data: [] });
			}
			throw new Error(`Unexpected image request: ${method} ${url}`);
		}) as typeof fetch,
		settings: options.settings ?? Settings.isolated({}),
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "test-openrouter-images",
		} as unknown as ReadonlySessionManager,
		modelRegistry: {
			getApiKey: async () => undefined,
			getApiKeyForProvider: async (provider: string) => {
				credentialReads.push(provider);
				if (provider === "openrouter" && options.credentials !== false) return "test-openrouter-key";
				if (provider === "xai-oauth") return "test-xai-key";
				return undefined;
			},
			getProviderBaseUrl: () => undefined,
			find: () => undefined,
			getProviderHeaders: async () => undefined,
			resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
			getAll: () => [],
			authStorage: {
				hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
				rotateSessionCredential: async () => false,
			},
			resolver: (provider: string) => async () =>
				provider === "openrouter" ? "test-openrouter-key" : "test-xai-key",
		} as unknown as ModelRegistry,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
	return { ctx, requests, credentialReads };
}

describe("imageGenTool", () => {
	it("dispatches a per-call OpenRouter model instead of the active chat provider", async () => {
		const requests: string[] = [];
		const ctx = createAntigravityXAIContext(
			{ api: "openai-completions", provider: "xai", id: "grok-4" } as Model,
			(async (input, init) => {
				const url = String(input);
				requests.push(url);
				if (url.endsWith("/endpoints")) {
					return Response.json({
						id: "openai/gpt-image-2.5-flare",
						endpoints: [{ provider_tag: "openai", supported_parameters: {} }],
					});
				}
				expect(url).toBe("https://openrouter.ai/api/v1/images");
				expect(JSON.parse(String(init?.body)).model).toBe("openai/gpt-image-2.5-flare");
				return Response.json({ data: [] });
			}) as typeof fetch,
		);
		ctx.settings = Settings.isolated({ "providers.imageOpenRouterModel": "configured/model-a" });
		ctx.modelRegistry.getApiKeyForProvider = async provider =>
			provider === "openrouter" || provider === "xai-oauth" ? "test-key" : undefined;
		const params = { subject: "a red circle", model: "openai/gpt-image-2.5-flare" };
		const result = await imageGenTool.execute("override-model", params, undefined, ctx);
		expect(result.details?.provider).toBe("openrouter");
		expect(result.details?.model).toBe(params.model);
		expect(requests).toEqual([
			"https://openrouter.ai/api/v1/images/models/openai/gpt-image-2.5-flare/endpoints",
			"https://openrouter.ai/api/v1/images",
		]);
	});

	describe("OpenRouter image models", () => {
		it.each([
			{
				name: "blank model",
				params: { model: " \t\n " },
				error: /model.*non-empty.*OpenRouter/,
			},
			{
				name: "model with a conflicting provider",
				params: { model: OPENROUTER_IMAGE_MODEL, provider: "xai" as const },
				error: /model.*OpenRouter.*provider "xai"/,
			},
		])("rejects $name before credentials or input access", async ({ params, error }) => {
			const { ctx, requests, credentialReads } = createOpenRouterImageContext();
			await expect(
				imageGenTool.execute(
					"invalid-model",
					{
						subject: "a cat",
						...params,
						input: [
							{
								get path(): string {
									throw new Error("Input image accessed before model validation");
								},
							},
						],
					},
					undefined,
					ctx,
				),
			).rejects.toThrow(error);
			expect(credentialReads).toEqual([]);
			expect(requests).toEqual([]);
		});

		it("uses the existing default after the configured model is cleared", async () => {
			const model = "google/gemini-3-pro-image-preview";
			const { ctx, requests } = createOpenRouterImageContext({
				model,
				settings: Settings.isolated({ "providers.imageOpenRouterModel": " \t " }),
			});
			await imageGenTool.execute("cleared-model", { subject: "a cat", provider: "openrouter" }, undefined, ctx);
			expect(requests.at(-1)?.body?.model).toBe(model);
		});

		it("trims literal model IDs without adding a vendor prefix", async () => {
			const model = "unqualified-model:preview";
			const { ctx, requests } = createOpenRouterImageContext({ model });
			await imageGenTool.execute(
				"literal-model",
				{ subject: "a cat", model: ` \t${model} `, provider: "auto" },
				undefined,
				ctx,
			);
			expect(requests.map(request => request.url)).toEqual([
				"https://openrouter.ai/api/v1/images/models/unqualified-model%3Apreview/endpoints",
				"https://openrouter.ai/api/v1/images",
			]);
			expect(requests.at(-1)?.body?.model).toBe(model);
		});

		it("keeps an explicit provider ahead of the configured OpenRouter model", async () => {
			setImageProviderOrder(["openrouter", "xai"]);
			const { ctx, requests } = createOpenRouterImageContext({
				settings: Settings.isolated({ "providers.imageOpenRouterModel": OPENROUTER_IMAGE_MODEL }),
			});
			const result = await imageGenTool.execute(
				"other-provider",
				{ subject: "a cat", provider: "xai" },
				undefined,
				ctx,
			);
			expect(requests.map(request => request.url)).toEqual(["https://api.x.ai/v1/images/generations"]);
			expect(result.details?.provider).toBe("xai");
		});

		it("generates a WebP and sends its saved bytes back as an edit reference", async () => {
			const bytes = await new Bun.Image(Buffer.from(RED_1X1_PNG_BASE64, "base64"))
				.resize(3, 2, { filter: "nearest" })
				.webp({ quality: 90 })
				.bytes();
			const imageData = Buffer.from(bytes).toString("base64");
			const { ctx, requests } = createOpenRouterImageContext({
				metadata: {
					id: OPENROUTER_IMAGE_MODEL,
					endpoints: [
						{
							provider_tag: "bounded",
							supported_parameters: {
								aspect_ratio: { type: "enum", values: ["3:2"] },
								input_references: { type: "range", min: 0, max: 16 },
							},
						},
						{
							provider_tag: "unbounded",
							supported_parameters: {
								aspect_ratio: { type: "boolean" },
								input_references: { type: "boolean" },
							},
						},
					],
				},
				imageResponse: () => Response.json({ data: [{ b64_json: imageData }] }),
			});
			const params: ImageGenParams = {
				subject: "a red rectangle",
				model: OPENROUTER_IMAGE_MODEL,
				provider: "openrouter",
				aspect_ratio: "3:2",
			};
			const generated = await imageGenTool.execute("generate-webp", params, undefined, ctx);
			generatedImagePaths.push(...(generated.details?.imagePaths ?? []));
			const savedPath = generated.details?.imagePaths[0];
			if (!savedPath) throw new Error("Expected generated WebP path");
			expect(generated.details?.images[0]?.mimeType).toBe("image/webp");
			expect(savedPath.endsWith(".webp")).toBe(true);
			expect<Uint8Array>(await Bun.file(savedPath).bytes()).toEqual(bytes);

			const changes = "Make the red rectangle blue";
			const edited = await imageGenTool.execute(
				"edit-webp",
				{ ...params, input: [{ path: savedPath }], changes: [changes] },
				undefined,
				ctx,
			);
			generatedImagePaths.push(...(edited.details?.imagePaths ?? []));
			expect(requests.map(request => request.method)).toEqual(["GET", "POST", "GET", "POST"]);
			const generationBody = requests[1]?.body;
			expect(generationBody).toMatchObject({ model: OPENROUTER_IMAGE_MODEL, aspect_ratio: "3:2" });
			expect(generationBody).not.toHaveProperty("input_references");
			expect(generationBody).not.toHaveProperty("provider");
			const editBody = requests[3]?.body;
			expect(editBody).toMatchObject({
				model: OPENROUTER_IMAGE_MODEL,
				aspect_ratio: "3:2",
				input_references: [{ type: "image_url", image_url: { url: `data:image/webp;base64,${imageData}` } }],
			});
			expect(editBody?.prompt).toContain(changes);
			expect(editBody).not.toHaveProperty("messages");
			expect(editBody).not.toHaveProperty("provider");
		});

		for (const source of ["per-call", "configured"] as const) {
			it(`does not replace a ${source} model when OpenRouter credentials are missing`, async () => {
				setImageProviderOrder(["openrouter", "xai"]);
				const { ctx, requests } = createOpenRouterImageContext({
					credentials: false,
					settings: Settings.isolated(
						source === "configured" ? { "providers.imageOpenRouterModel": ` ${OPENROUTER_IMAGE_MODEL} ` } : {},
					),
				});
				await expect(
					imageGenTool.execute(
						"missing-credentials",
						{ subject: "a cat", ...(source === "per-call" ? { model: OPENROUTER_IMAGE_MODEL } : {}) },
						undefined,
						ctx,
					),
				).rejects.toThrow(/OpenRouter credentials.*"openai\/gpt-image-2\.5-flare"/);
				expect(requests).toEqual([]);
			});

			it(`does not replace a ${source} model after discovery fails`, async () => {
				setImageProviderOrder(["openrouter", "xai"]);
				const { ctx, requests } = createOpenRouterImageContext({
					settings: Settings.isolated(
						source === "configured" ? { "providers.imageOpenRouterModel": OPENROUTER_IMAGE_MODEL } : {},
					),
					discoveryResponse: () =>
						Response.json({ error: { message: "image model was removed" } }, { status: 404 }),
				});
				await expect(
					imageGenTool.execute(
						"failed-discovery",
						{ subject: "a cat", ...(source === "per-call" ? { model: OPENROUTER_IMAGE_MODEL } : {}) },
						undefined,
						ctx,
					),
				).rejects.toThrow(/OpenRouter.*openai\/gpt-image-2\.5-flare.*404.*image model was removed/);
				expect(requests.map(request => request.method)).toEqual(["GET"]);
			});

			it(`does not replace a ${source} model after generation fails`, async () => {
				setImageProviderOrder(["openrouter", "xai"]);
				const { ctx, requests } = createOpenRouterImageContext({
					settings: Settings.isolated(
						source === "configured" ? { "providers.imageOpenRouterModel": OPENROUTER_IMAGE_MODEL } : {},
					),
					imageResponse: () => Response.json({ error: { message: "image provider is offline" } }, { status: 503 }),
				});
				await expect(
					imageGenTool.execute(
						"failed-generation",
						{ subject: "a cat", ...(source === "per-call" ? { model: OPENROUTER_IMAGE_MODEL } : {}) },
						undefined,
						ctx,
					),
				).rejects.toThrow(/OpenRouter.*openai\/gpt-image-2\.5-flare.*503.*image provider is offline/);
				expect(requests.map(request => request.method)).toEqual(["GET", "POST"]);
			});
		}

		it("keeps HTTP fallback when no OpenRouter model is selected", async () => {
			setImageProviderOrder(["openrouter", "xai"]);
			const { ctx, requests } = createOpenRouterImageContext({
				model: "google/gemini-3-pro-image-preview",
				imageResponse: () => Response.json({ error: { message: "image provider is offline" } }, { status: 503 }),
			});
			const result = await imageGenTool.execute("automatic-fallback", { subject: "a cat" }, undefined, ctx);
			expect(requests.map(request => request.url)).toEqual([
				"https://openrouter.ai/api/v1/images/models/google/gemini-3-pro-image-preview/endpoints",
				"https://openrouter.ai/api/v1/images",
				"https://api.x.ai/v1/images/generations",
			]);
			expect(result.details?.provider).toBe("xai");
		});

		const unsupportedRequests: Array<{
			name: string;
			endpoints: unknown[];
			params: Partial<ImageGenParams>;
			diagnostics: Array<string | RegExp>;
		}> = [
			{
				name: "references on a text-only endpoint",
				endpoints: [{ provider_tag: "text-only", supported_parameters: {} }],
				params: { input: [PNG_REFERENCE] },
				diagnostics: ["input_references=1", "input_references 0"],
			},
			{
				name: "a reference count above the endpoint limit",
				endpoints: [
					{
						provider_tag: "one-reference",
						supported_parameters: { input_references: { type: "range", min: 0, max: 1 } },
					},
				],
				params: { input: [PNG_REFERENCE, PNG_REFERENCE] },
				diagnostics: ["input_references=2", "0..1"],
			},
			{
				name: "a reference count above the Image API limit",
				endpoints: [{ provider_tag: "unbounded", supported_parameters: { input_references: { type: "boolean" } } }],
				params: { input: Array.from({ length: 17 }, () => PNG_REFERENCE) },
				diagnostics: ["input_references=17", /maximum.*16/],
			},
			{
				name: "zero references on an edit-only endpoint",
				endpoints: [
					{
						provider_tag: "edit-only",
						supported_parameters: { input_references: { type: "range", min: 1, max: 2 } },
					},
				],
				params: {},
				diagnostics: ["input_references=0", "1..2"],
			},
			{
				name: "an unadvertised aspect ratio",
				endpoints: [{ provider_tag: "no-ratio", supported_parameters: {} }],
				params: { aspect_ratio: "16:9" },
				diagnostics: ["aspect_ratio=16:9", "aspect_ratio [none]"],
			},
			{
				name: "an aspect ratio outside the advertised values",
				endpoints: [
					{
						provider_tag: "square",
						supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1"] } },
					},
				],
				params: { aspect_ratio: "16:9" },
				diagnostics: ["aspect_ratio=16:9", "1:1"],
			},
			{
				name: "options that no single endpoint supports together",
				endpoints: [
					{
						provider_tag: "wide-generation",
						supported_parameters: {
							aspect_ratio: { type: "enum", values: ["16:9"] },
							input_references: { type: "range", min: 0, max: 0 },
						},
					},
					{
						provider_tag: "square-edit",
						supported_parameters: {
							aspect_ratio: { type: "enum", values: ["1:1"] },
							input_references: { type: "range", min: 0, max: 16 },
						},
					},
				],
				params: { aspect_ratio: "16:9", input: [PNG_REFERENCE] },
				diagnostics: ["aspect_ratio=16:9", "input_references=1", "1:1", "0..0"],
			},
		];

		it.each(unsupportedRequests)("rejects $name before generation", async ({ endpoints, params, diagnostics }) => {
			const { ctx, requests } = createOpenRouterImageContext({
				metadata: { id: OPENROUTER_IMAGE_MODEL, endpoints },
			});
			const execution = imageGenTool.execute(
				"unsupported-options",
				{ subject: "a cat", model: OPENROUTER_IMAGE_MODEL, ...params },
				undefined,
				ctx,
			);
			await expect(execution).rejects.toThrow(/OpenRouter.*openai\/gpt-image-2\.5-flare.*cannot satisfy/);
			for (const diagnostic of diagnostics) {
				await expect(execution).rejects.toThrow(diagnostic);
			}
			expect(requests.map(request => request.method)).toEqual(["GET"]);
		});

		it("reports a model with no available image endpoints", async () => {
			const { ctx, requests } = createOpenRouterImageContext({
				metadata: { id: OPENROUTER_IMAGE_MODEL, endpoints: [] },
			});
			await expect(
				imageGenTool.execute("no-endpoints", { subject: "a cat", model: OPENROUTER_IMAGE_MODEL }, undefined, ctx),
			).rejects.toThrow(/openai\/gpt-image-2\.5-flare.*no available image endpoints/);
			expect(requests.map(request => request.method)).toEqual(["GET"]);
		});

		it("restricts routing to endpoints that support every requested option", async () => {
			const { ctx, requests } = createOpenRouterImageContext({
				metadata: {
					id: OPENROUTER_IMAGE_MODEL,
					endpoints: [
						{
							provider_tag: "eligible",
							supported_parameters: {
								aspect_ratio: { type: "enum", values: ["16:9"] },
								input_references: { type: "range", min: 1, max: 1 },
							},
						},
						{
							provider_tag: "text-only",
							supported_parameters: { aspect_ratio: { type: "enum", values: ["16:9"] } },
						},
					],
				},
			});
			await imageGenTool.execute(
				"eligible-routing",
				{ subject: "a cat", model: OPENROUTER_IMAGE_MODEL, aspect_ratio: "16:9", input: [PNG_REFERENCE] },
				undefined,
				ctx,
			);
			expect(requests.at(-1)?.body?.provider).toEqual({ only: ["eligible"] });
		});

		it("deduplicates routing tags and excludes tags shared with rejected endpoints", async () => {
			const { ctx, requests } = createOpenRouterImageContext({
				metadata: {
					id: OPENROUTER_IMAGE_MODEL,
					endpoints: [
						{ provider_tag: "shared", supported_parameters: { aspect_ratio: { type: "boolean" } } },
						{ provider_tag: "eligible", supported_parameters: { aspect_ratio: { type: "boolean" } } },
						{ provider_tag: "eligible", supported_parameters: { aspect_ratio: { type: "boolean" } } },
						{
							provider_tag: "shared",
							supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1"] } },
						},
					],
				},
			});
			await imageGenTool.execute(
				"exclusive-routing",
				{ subject: "a cat", model: OPENROUTER_IMAGE_MODEL, aspect_ratio: "16:9" },
				undefined,
				ctx,
			);
			expect(requests.at(-1)?.body?.provider).toEqual({ only: ["eligible"] });
		});

		it.each([
			{ name: "untagged", tag: null },
			{ name: "shared-tag", tag: "incompatible" },
		])("rejects routing when only a $name endpoint qualifies", async ({ tag }) => {
			const { ctx, requests } = createOpenRouterImageContext({
				metadata: {
					id: OPENROUTER_IMAGE_MODEL,
					endpoints: [
						{ provider_tag: tag, supported_parameters: { aspect_ratio: { type: "boolean" } } },
						{
							provider_tag: "incompatible",
							supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1"] } },
						},
					],
				},
			});
			await expect(
				imageGenTool.execute(
					"unrestricted-routing",
					{ subject: "a cat", model: OPENROUTER_IMAGE_MODEL, aspect_ratio: "16:9" },
					undefined,
					ctx,
				),
			).rejects.toThrow(/cannot restrict routing.*requested options/);
			expect(requests.map(request => request.method)).toEqual(["GET"]);
		});

		it.each([
			{ name: "missing endpoint list", metadata: { id: OPENROUTER_IMAGE_MODEL } },
			{ name: "non-array endpoint list", metadata: { id: OPENROUTER_IMAGE_MODEL, endpoints: {} } },
			{
				name: "invalid supported-parameter map",
				metadata: {
					id: OPENROUTER_IMAGE_MODEL,
					endpoints: [{ provider_tag: "openai", supported_parameters: [] }],
				},
			},
			{
				name: "non-string aspect ratio enum",
				metadata: {
					id: OPENROUTER_IMAGE_MODEL,
					endpoints: [
						{
							provider_tag: "openai",
							supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", 2] } },
						},
					],
				},
			},
			{
				name: "range descriptor for an aspect ratio",
				metadata: {
					id: OPENROUTER_IMAGE_MODEL,
					endpoints: [
						{
							provider_tag: "openai",
							supported_parameters: { aspect_ratio: { type: "range", min: 0, max: 16 } },
						},
					],
				},
			},
			{
				name: "enum descriptor for a reference count",
				metadata: {
					id: OPENROUTER_IMAGE_MODEL,
					endpoints: [
						{
							provider_tag: "openai",
							supported_parameters: { input_references: { type: "enum", values: ["0", "1"] } },
						},
					],
				},
			},
			{
				name: "reversed reference-count bounds",
				metadata: {
					id: OPENROUTER_IMAGE_MODEL,
					endpoints: [
						{
							provider_tag: "openai",
							supported_parameters: { input_references: { type: "range", min: 2, max: 1 } },
						},
					],
				},
			},
		])("rejects capability metadata with a $name", async ({ metadata }) => {
			const { ctx, requests } = createOpenRouterImageContext({ metadata });
			await expect(
				imageGenTool.execute(
					"invalid-capabilities",
					{ subject: "a cat", model: OPENROUTER_IMAGE_MODEL, aspect_ratio: "1:1", input: [PNG_REFERENCE] },
					undefined,
					ctx,
				),
			).rejects.toThrow(/openai\/gpt-image-2\.5-flare.*invalid capability metadata/);
			expect(requests.map(request => request.method)).toEqual(["GET"]);
		});

		it("forwards image_size without requiring a size capability", async () => {
			const { ctx, requests } = createOpenRouterImageContext();
			await imageGenTool.execute(
				"explicit-size",
				{ subject: "a cat", model: OPENROUTER_IMAGE_MODEL, image_size: "1536x1024" },
				undefined,
				ctx,
			);
			expect(requests.at(-1)?.body).toEqual({
				model: OPENROUTER_IMAGE_MODEL,
				prompt: expect.any(String),
				size: "1536x1024",
			});
		});

		it("preserves explicit dimensions and exposes an upstream ratio conflict", async () => {
			const { ctx, requests } = createOpenRouterImageContext({
				metadata: {
					id: OPENROUTER_IMAGE_MODEL,
					endpoints: [{ provider_tag: "openai", supported_parameters: { aspect_ratio: { type: "boolean" } } }],
				},
				imageResponse: () =>
					Response.json({ error: { message: "size conflicts with aspect_ratio" } }, { status: 400 }),
			});
			await expect(
				imageGenTool.execute(
					"dimension-conflict",
					{
						subject: "a cat",
						model: OPENROUTER_IMAGE_MODEL,
						image_size: "1536x1024",
						aspect_ratio: "1:1",
					},
					undefined,
					ctx,
				),
			).rejects.toThrow(/openai\/gpt-image-2\.5-flare.*400.*size conflicts with aspect_ratio/);
			expect(requests.map(request => request.method)).toEqual(["GET", "POST"]);
			expect(requests.at(-1)?.body).toMatchObject({ size: "1536x1024", aspect_ratio: "1:1" });
		});

		it("saves declared SVG output without changing its bytes", async () => {
			const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1H0z"/></svg>';
			const { ctx } = createOpenRouterImageContext({
				imageResponse: () =>
					Response.json({
						data: [{ b64_json: Buffer.from(svg).toString("base64"), media_type: "image/svg+xml" }],
					}),
			});
			const result = await imageGenTool.execute(
				"generate-svg",
				{ subject: "a black square", model: OPENROUTER_IMAGE_MODEL },
				undefined,
				ctx,
			);
			generatedImagePaths.push(...(result.details?.imagePaths ?? []));
			const savedPath = result.details?.imagePaths[0];
			if (!savedPath) throw new Error("Expected generated SVG path");
			expect(result.details?.images[0]?.mimeType).toBe("image/svg+xml");
			expect(savedPath.endsWith(".svg")).toBe(true);
			expect(await Bun.file(savedPath).bytes()).toEqual(Buffer.from(svg));
		});

		it.each([
			{ name: "malformed JSON", response: () => new Response("{") },
			{ name: "non-array data", response: () => Response.json({ data: "not-an-image-array" }) },
			{ name: "null data", response: () => Response.json({ data: null }) },
			{ name: "a non-object entry", response: () => Response.json({ data: [null] }) },
			{ name: "non-string base64 data", response: () => Response.json({ data: [{ b64_json: 123 }] }) },
			{
				name: "a non-image media type",
				response: () => Response.json({ data: [{ b64_json: RED_1X1_PNG_BASE64, media_type: "text/plain" }] }),
			},
		])("rejects image responses containing $name without fallback", async ({ response }) => {
			const { ctx, requests } = createOpenRouterImageContext({ imageResponse: response });
			await expect(
				imageGenTool.execute(
					"malformed-image-response",
					{ subject: "a cat", model: OPENROUTER_IMAGE_MODEL },
					undefined,
					ctx,
				),
			).rejects.toThrow();
			expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
				"GET https://openrouter.ai/api/v1/images/models/openai/gpt-image-2.5-flare/endpoints",
				"POST https://openrouter.ai/api/v1/images",
			]);
		});

		it("preserves the zero-image result for a valid empty data array", async () => {
			const { ctx } = createOpenRouterImageContext();
			const result = await imageGenTool.execute(
				"empty-images",
				{ subject: "a cat", model: OPENROUTER_IMAGE_MODEL },
				undefined,
				ctx,
			);
			expect(result.details).toMatchObject({
				provider: "openrouter",
				model: OPENROUTER_IMAGE_MODEL,
				imageCount: 0,
				imagePaths: [],
				images: [],
			});
		});
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
			settings: Settings.isolated({}),
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
			settings: Settings.isolated({}),
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async () => undefined,
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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
			settings: Settings.isolated({}),
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async (provider: string) => (provider === "openai" ? "test-openai-key" : undefined),
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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
			settings: Settings.isolated({}),
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
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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
			settings: Settings.isolated({}),
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
			settings: Settings.isolated({}),
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
				find: () => undefined,
				getProviderHeaders: async () => undefined,
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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
			settings: Settings.isolated({}),
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
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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
			settings: Settings.isolated({}),
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => codexJwt,
				getApiKeyForProvider: async () => undefined,
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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
			settings: Settings.isolated({}),
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKeyForProvider: async (provider: string) => (provider === "xai-oauth" ? "test-xai-token" : undefined),
				getProviderBaseUrl: () => undefined,
				find: () => undefined,
				getProviderHeaders: async () => undefined,
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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
			settings: Settings.isolated({}),
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => "test-openai-key",
				getApiKeyForProvider: async (provider: string) => (provider === "xai-oauth" ? "test-xai-token" : undefined),
				getProviderBaseUrl: () => undefined,
				find: () => undefined,
				getProviderHeaders: async () => undefined,
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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

	it("uses the Antigravity image model advertised for the account", async () => {
		setImageProviderOrder(["antigravity", "xai"]);
		const requestUrls: string[] = [];
		const requestedModels: string[] = [];
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url.includes(":fetchAvailableModels")) {
				return new Response(JSON.stringify({ imageGenerationModelIds: ["gemini-3.1-flash-image"] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("streamGenerateContent")) {
				const request = JSON.parse(String(init?.body)) as { model?: string };
				if (request.model) requestedModels.push(request.model);
				if (request.model !== "gemini-3.1-flash-image") {
					return new Response(JSON.stringify({ error: { message: "Requested entity was not found." } }), {
						status: 404,
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
													data: Buffer.from("advertised-antigravity-image").toString("base64"),
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
			return new Response(
				JSON.stringify({ data: [{ b64_json: Buffer.from("unexpected-xai-fallback").toString("base64") }] }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const ctx = createAntigravityXAIContext(undefined, fetchMock);

		const result = await imageGenTool.execute(
			"call-advertised-antigravity-model",
			{ subject: "a cat" },
			undefined,
			ctx,
		);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		]);
		expect(requestedModels).toEqual(["gemini-3.1-flash-image"]);
		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.model).toBe("gemini-3.1-flash-image");
	});

	it("fails over to the sandbox endpoint in auto mode after a production 5xx", async () => {
		setImageProviderOrder(["antigravity"]);
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.includes(":fetchAvailableModels")) {
				requestUrls.push(url);
				return new Response(JSON.stringify({ imageGenerationModelIds: ["gemini-3.1-flash-image"] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("streamGenerateContent")) {
				requestUrls.push(url);
				if (url.startsWith("https://daily-cloudcode-pa.googleapis.com/")) {
					return new Response(JSON.stringify({ error: { message: "backend unavailable" } }), {
						status: 503,
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
													data: Buffer.from("sandbox-antigravity-image").toString("base64"),
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

		const result = await imageGenTool.execute("call-antigravity-failover", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(requestUrls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
		]);
		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.model).toBe("gemini-3.1-flash-image");
	});

	it("re-discovers the image model when withAuth rotates to a sibling Antigravity account", async () => {
		setImageProviderOrder(["antigravity", "xai"]);
		const credsA = JSON.stringify({ token: "token-A", projectId: "proj-A" });
		const credsB = JSON.stringify({ token: "token-B", projectId: "proj-B" });
		const streamAttempts: Array<{ token: string; model: string }> = [];
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const auth = new Headers(init?.headers).get("authorization");
			if (url.includes(":fetchAvailableModels")) {
				// Account A still carries the legacy pro model; the rotated sibling B
				// only advertises the flash model.
				const modelId = auth === "Bearer token-B" ? "gemini-3.1-flash-image" : "gemini-3-pro-image";
				return new Response(JSON.stringify({ imageGenerationModelIds: [modelId] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("streamGenerateContent")) {
				const token = auth?.replace("Bearer ", "") ?? "";
				const request = JSON.parse(String(init?.body)) as { model?: string };
				streamAttempts.push({ token, model: request.model ?? "" });
				// Account A is out of quota, forcing withAuth to rotate to sibling B.
				if (token === "token-A") {
					return new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
						status: 403,
						headers: { "content-type": "application/json" },
					});
				}
				// Sibling B only serves its advertised model.
				if (request.model !== "gemini-3.1-flash-image") {
					return new Response(JSON.stringify({ error: { message: "Requested entity was not found." } }), {
						status: 404,
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
													data: Buffer.from("sibling-antigravity-image").toString("base64"),
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
		const ctx: CustomToolContext = {
			settings: Settings.isolated({}),
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKey: async () => undefined,
				getApiKeyForProvider: async (provider: string) => (provider === "google-antigravity" ? credsA : undefined),
				getProviderBaseUrl: () => undefined,
				find: () => undefined,
				getProviderHeaders: async () => undefined,
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
				getAll: () => [],
				authStorage: {
					hasNonEnvCredential: () => false,
					rotateSessionCredential: async () => false,
				},
				resolver: (provider: string) =>
					provider === "google-antigravity"
						? (rctx: { lastChance?: boolean }) => (rctx.lastChance ? credsB : credsA)
						: () => "test-xai-token",
			} as unknown as ModelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await imageGenTool.execute("call-antigravity-rotation", { subject: "a cat" }, undefined, ctx);
		generatedImagePaths.push(...(result.details?.imagePaths ?? []));

		expect(streamAttempts).toEqual([
			{ token: "token-A", model: "gemini-3-pro-image" },
			{ token: "token-B", model: "gemini-3.1-flash-image" },
		]);
		expect(result.details?.provider).toBe("antigravity");
		expect(result.details?.model).toBe("gemini-3.1-flash-image");
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
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
			"https://api.x.ai/v1/images/generations",
		]);
		expect(result.details?.provider).toBe("xai");
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
			settings: Settings.isolated({}),
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
				find: () => undefined,
				getProviderHeaders: async () => undefined,
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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
			settings: Settings.isolated({}),
			fetch: fetchMock,
			sessionManager: {
				getCwd: () => "/tmp",
				getSessionId: () => "test-session",
			} as unknown as ReadonlySessionManager,
			modelRegistry: {
				getApiKeyForProvider: async (provider: string) =>
					provider === "deepinfra" ? "test-deepinfra-key" : undefined,
				getProviderBaseUrl: () => undefined,
				find: () => undefined,
				getProviderHeaders: async () => undefined,
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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
			settings: Settings.isolated({}),
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
				find: () => undefined,
				getProviderHeaders: async () => undefined,
				resolveModelHeaders: ModelRegistry.prototype.resolveModelHeaders,
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
