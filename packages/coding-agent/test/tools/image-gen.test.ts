import { afterAll, describe, expect, it } from "bun:test";
import { type Api, type FetchImpl, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext, CustomToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	getImageGenTools,
	getImageGenToolsWithRegistry,
	imageGenTool,
} from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const generatedImagePaths: string[] = [];
const PNG_DATA = Buffer.from("catalog-image").toString("base64");
const WEBP_DATA = Buffer.from("hosted-image").toString("base64");

afterAll(async () => {
	await Promise.all(generatedImagePaths.map(imagePath => removeWithRetries(imagePath)));
});

function catalogModel(provider: string, id: string, api: Api, kind: "chat" | "image" = "image"): Model<Api> {
	return buildModel({
		id,
		name: `${provider}/${id}`,
		api,
		provider,
		baseUrl: `https://${provider}.example/v1`,
		kind,
		reasoning: false,
		input: kind === "image" ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

function createRegistry(models: Model<Api>[], credentials: Record<string, string | undefined> = {}): ModelRegistry {
	const authStorage = createInMemoryAuthStorage();
	for (const model of models) {
		const credential = credentials[model.provider];
		if (credential !== undefined) authStorage.keys.setRuntime(model.provider, credential);
		else if (!(model.provider in credentials)) authStorage.keys.setRuntime(model.provider, `key-${model.provider}`);
	}
	const registry = new ModelRegistry(authStorage);
	registry.getAvailable = (kind = "chat") =>
		kind === "all" ? [...models] : models.filter(model => modelKind(model) === kind);
	registry.getAll = () => [...models];
	registry.find = (provider, modelId) => models.find(model => model.provider === provider && model.id === modelId);
	return registry;
}

function createContext(options: {
	models: Model<Api>[];
	settings: Settings;
	fetch: FetchImpl;
	activeModel?: Model<Api>;
	credentials?: Record<string, string | undefined>;
}): CustomToolContext {
	return {
		fetch: options.fetch,
		sessionManager: SessionManager.inMemory("/tmp"),
		modelRegistry: createRegistry(options.models, options.credentials),
		model: options.activeModel,
		settings: options.settings,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
}

function imageResponse(mediaType = "image/png"): Response {
	return new Response(JSON.stringify({ data: [{ b64_json: PNG_DATA, media_type: mediaType }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function hostedResponse(): Response {
	return new Response(
		JSON.stringify({
			output: [
				{
					type: "image_generation_call",
					result: WEBP_DATA,
					revised_prompt: "catalog-hosted prompt",
					status: "completed",
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function collectPaths(result: CustomToolResult<{ imagePaths: string[] }>): void {
	generatedImagePaths.push(...(result.details?.imagePaths ?? []));
}

describe("imageGenTool catalog routing", () => {
	it("registers without resolving credentials", async () => {
		const registry = createRegistry([]);
		expect(await getImageGenTools(registry)).toEqual([imageGenTool]);
		expect(await getImageGenToolsWithRegistry(registry)).toEqual([imageGenTool]);
		const schema = JSON.stringify(imageGenTool.parameters.toJsonSchema());
		expect(schema).toContain('"model"');
		expect(schema).not.toContain('"provider"');
	});

	it("uses a request model override as a single explicit candidate", async () => {
		const configured = catalogModel("deepinfra", "configured-image", "openai-images");
		const requested = catalogModel("openrouter", "requested-image", "openrouter-images");
		const urls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			urls.push(input.toString());
			return imageResponse();
		};
		const settings = Settings.isolated({
			modelRoles: { image: "deepinfra/configured-image" },
			"retry.fallbackChains": { image: ["openrouter/requested-image"] },
		});
		const ctx = createContext({ models: [configured, requested], settings, fetch: fetchMock });

		const result = await imageGenTool.execute(
			"override",
			{ subject: "a catalog override", model: "openrouter/requested-image" },
			undefined,
			ctx,
		);
		collectPaths(result);

		expect(urls).toEqual(["https://openrouter.example/v1/images"]);
		expect(result.details?.model).toBe("requested-image");
	});

	it("hoists the active provider only within the non-explicit default image chain", async () => {
		const openai = catalogModel("openai", "gpt-image-1", "openai-responses");
		const xai = catalogModel("xai", "grok-imagine-image", "openai-images");
		const active = catalogModel("xai", "grok-chat", "openai-responses", "chat");
		const urls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			urls.push(input.toString());
			return imageResponse();
		};
		const ctx = createContext({
			models: [openai, xai, active],
			settings: Settings.isolated(),
			fetch: fetchMock,
			activeModel: active,
		});

		const result = await imageGenTool.execute("hoist", { subject: "active provider" }, undefined, ctx);
		collectPaths(result);

		expect(urls).toEqual(["https://xai.example/v1/images/generations"]);
		expect(result.details?.provider).toBe("xai");
	});

	it("skips a candidate whose configured authentication is unavailable", async () => {
		const unavailable = catalogModel("deepinfra", "first-image", "openai-images");
		const fallback = catalogModel("openrouter", "fallback-image", "openrouter-images");
		const urls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			urls.push(input.toString());
			return imageResponse();
		};
		const settings = Settings.isolated({
			modelRoles: { image: "deepinfra/first-image" },
			"retry.fallbackChains": { image: ["openrouter/fallback-image"] },
		});
		const ctx = createContext({
			models: [unavailable, fallback],
			settings,
			fetch: fetchMock,
			credentials: { deepinfra: undefined },
		});

		const result = await imageGenTool.execute("auth-skip", { subject: "fallback" }, undefined, ctx);
		collectPaths(result);

		expect(urls).toEqual(["https://openrouter.example/v1/images"]);
		expect(result.details?.model).toBe("fallback-image");
	});

	it("skips unsupported image APIs and continues the resolved chain", async () => {
		const unsupported = catalogModel("custom", "unsupported-image", "openai-completions");
		const fallback = catalogModel("openrouter", "fallback-image", "openrouter-images");
		const settings = Settings.isolated({
			modelRoles: { image: "custom/unsupported-image" },
			"retry.fallbackChains": { image: ["openrouter/fallback-image"] },
		});
		const urls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			urls.push(input.toString());
			return imageResponse();
		};
		const ctx = createContext({ models: [unsupported, fallback], settings, fetch: fetchMock });

		const result = await imageGenTool.execute("unsupported", { subject: "fallback" }, undefined, ctx);
		collectPaths(result);

		expect(urls).toEqual(["https://openrouter.example/v1/images"]);
		expect(result.details?.model).toBe("fallback-image");
	});

	it("advances after provider HTTP failures and aggregates an exhausted chain", async () => {
		const first = catalogModel("deepinfra", "first-image", "openai-images");
		const second = catalogModel("openrouter", "second-image", "openrouter-images");
		const settings = Settings.isolated({
			modelRoles: { image: "deepinfra/first-image" },
			"retry.fallbackChains": { image: ["openrouter/second-image"] },
		});
		let calls = 0;
		const succeedingFetch: FetchImpl = async () => {
			calls++;
			if (calls === 1) return new Response(JSON.stringify({ error: { message: "first failed" } }), { status: 503 });
			return imageResponse();
		};
		const successContext = createContext({ models: [first, second], settings, fetch: succeedingFetch });
		const result = await imageGenTool.execute("http-fallback", { subject: "fallback" }, undefined, successContext);
		collectPaths(result);
		expect(result.details?.model).toBe("second-image");

		const failingFetch: FetchImpl = async () =>
			new Response(JSON.stringify({ error: { message: "failed" } }), { status: 503 });
		const failingContext = createContext({ models: [first, second], settings, fetch: failingFetch });
		await expect(
			imageGenTool.execute("aggregate", { subject: "fails" }, undefined, failingContext),
		).rejects.toBeInstanceOf(AggregateError);
	});

	it("propagates transport I/O failures without trying the next model", async () => {
		const first = catalogModel("deepinfra", "first-image", "openai-images");
		const second = catalogModel("openrouter", "second-image", "openrouter-images");
		const settings = Settings.isolated({
			modelRoles: { image: "deepinfra/first-image" },
			"retry.fallbackChains": { image: ["openrouter/second-image"] },
		});
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls++;
			throw new TypeError("socket closed");
		};
		const ctx = createContext({ models: [first, second], settings, fetch: fetchMock });

		await expect(imageGenTool.execute("io", { subject: "network" }, undefined, ctx)).rejects.toThrow("socket closed");
		expect(calls).toBe(1);
	});

	it("uses the selected openai-images model and falls back from missing edits to generations", async () => {
		const model = catalogModel("deepinfra", "flux-selected", "openai-images");
		const urls: string[] = [];
		const bodies: Array<Record<string, unknown>> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			urls.push(input.toString());
			bodies.push(JSON.parse(String(init?.body)));
			if (urls.length === 1) return new Response("missing edits", { status: 404 });
			return imageResponse();
		};
		const settings = Settings.isolated({ modelRoles: { image: "deepinfra/flux-selected" } });
		const ctx = createContext({ models: [model], settings, fetch: fetchMock });

		const result = await imageGenTool.execute(
			"openai-images",
			{
				subject: "edit reference",
				input: [{ data: PNG_DATA, mime_type: "image/png" }],
			},
			undefined,
			ctx,
		);
		collectPaths(result);

		expect(urls).toEqual([
			"https://deepinfra.example/v1/images/edits",
			"https://deepinfra.example/v1/images/generations",
		]);
		expect(bodies[0]).toMatchObject({ model: "flux-selected", input_references: [{ type: "image_url" }] });
		expect(bodies[1]).toMatchObject({ model: "flux-selected", input_references: [{ type: "image_url" }] });
	});

	it("uses OpenRouter native images with edit references and response media types", async () => {
		const model = catalogModel("openrouter", "native-image", "openrouter-images");
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			return imageResponse("image/webp");
		};
		const settings = Settings.isolated({ modelRoles: { image: "openrouter/native-image" } });
		const ctx = createContext({ models: [model], settings, fetch: fetchMock });

		const result = await imageGenTool.execute(
			"openrouter",
			{
				subject: "native edit",
				aspect_ratio: "16:9",
				input: [{ data: PNG_DATA, mime_type: "image/png" }],
			},
			undefined,
			ctx,
		);
		collectPaths(result);

		expect(requestBody).toMatchObject({
			model: "native-image",
			n: 1,
			aspect_ratio: "16:9",
			input_references: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_DATA}` } }],
		});
		expect(result.details?.images[0]?.mimeType).toBe("image/webp");
	});

	it("uses the selected Gemini catalog id and base URL", async () => {
		const model = catalogModel("google", "gemini-selected-image", "google-generative-ai");
		let requestUrl: string | undefined;
		const fetchMock: FetchImpl = async input => {
			requestUrl = input.toString();
			return new Response(
				JSON.stringify({
					candidates: [{ content: { parts: [{ inlineData: { data: PNG_DATA, mimeType: "image/png" } }] } }],
				}),
				{ status: 200 },
			);
		};
		const settings = Settings.isolated({ modelRoles: { image: "google/gemini-selected-image" } });
		const ctx = createContext({ models: [model], settings, fetch: fetchMock });

		const result = await imageGenTool.execute("gemini", { subject: "gemini" }, undefined, ctx);
		collectPaths(result);

		expect(requestUrl).toBe("https://google.example/v1/models/gemini-selected-image:generateContent");
		expect(result.details?.model).toBe("gemini-selected-image");
	});

	it("falls back to the selected Antigravity id when discovery advertises no image model", async () => {
		const model = catalogModel("google-antigravity", "gemini-selected-image", "google-gemini-cli");
		const requestBodies: Array<Record<string, unknown>> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = input.toString();
			if (url.endsWith("/v1internal:fetchAvailableModels")) {
				return new Response(JSON.stringify({ imageGenerationModelIds: [] }), { status: 200 });
			}
			requestBodies.push(JSON.parse(String(init?.body)));
			return new Response(
				`data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ inlineData: { data: PNG_DATA, mimeType: "image/png" } }] } }] } })}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		};
		const credentials = JSON.stringify({ token: "antigravity-token", projectId: "catalog-project" });
		const settings = Settings.isolated({ modelRoles: { image: "google-antigravity/gemini-selected-image" } });
		const ctx = createContext({
			models: [model],
			settings,
			fetch: fetchMock,
			credentials: { "google-antigravity": credentials },
		});

		const result = await imageGenTool.execute("antigravity", { subject: "fallback id" }, undefined, ctx);
		collectPaths(result);

		expect(requestBodies[0]).toMatchObject({ model: "gemini-selected-image", project: "catalog-project" });
		expect(result.details?.model).toBe("gemini-selected-image");
	});

	it("uses a same-provider hosted chat carrier and places the selected OpenAI image id on the tool", async () => {
		const image = catalogModel("openai", "gpt-image-selected", "openai-responses");
		const activeCarrier = catalogModel("openai", "gpt-5.5", "openai-responses", "chat");
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			return hostedResponse();
		};
		const settings = Settings.isolated({ modelRoles: { image: "openai/gpt-image-selected" } });
		const ctx = createContext({
			models: [image, activeCarrier],
			settings,
			fetch: fetchMock,
			activeModel: activeCarrier,
		});

		const result = await imageGenTool.execute("hosted", { subject: "hosted" }, undefined, ctx);
		collectPaths(result);

		expect(requestBody).toMatchObject({
			model: "gpt-5.5",
			tools: [{ type: "image_generation", model: "gpt-image-selected" }],
		});
		expect(result.details?.model).toBe("gpt-image-selected");
	});

	it("omits the image tool model for Codex hosted image requests", async () => {
		const image = catalogModel("openai-codex", "gpt-image-selected", "openai-codex-responses");
		const carrier = catalogModel("openai-codex", "gpt-5.5", "openai-codex-responses", "chat");
		let requestBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			const event = {
				type: "response.completed",
				response: { output: [{ type: "image_generation_call", result: WEBP_DATA }] },
			};
			return new Response(`data: ${JSON.stringify(event)}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
		const settings = Settings.isolated({ modelRoles: { image: "openai-codex/gpt-image-selected" } });
		const ctx = createContext({ models: [image, carrier], settings, fetch: fetchMock });

		const result = await imageGenTool.execute("codex-hosted", { subject: "codex" }, undefined, ctx);
		collectPaths(result);

		expect(requestBody?.model).toBe("gpt-5.5");
		const tools = requestBody?.tools;
		if (!Array.isArray(tools)) throw new Error("Expected hosted image tools");
		expect(tools[0]).toMatchObject({ type: "image_generation" });
		expect(tools[0]).not.toHaveProperty("model");
	});
});
