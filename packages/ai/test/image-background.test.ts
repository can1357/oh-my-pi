import { describe, expect, it } from "bun:test";
import { generateImage, generateOpenAIImage, supportsImageBackground } from "@oh-my-pi/pi-ai/images";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const IMAGE_DATA = Buffer.from("background-image").toString("base64");

function imageModel(
	provider: string,
	api: Api,
	id = "gpt-image-2",
	baseUrl = provider === "openai-codex" ? "https://chatgpt.com/backend-api" : `https://${provider}.example/v1`,
): Model<Api> {
	return buildModel({
		id,
		name: id,
		provider,
		api,
		kind: "image",
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 4096,
	});
}

function imageResponse(): Response {
	return Response.json({ data: [{ b64_json: IMAGE_DATA, media_type: "image/webp" }] });
}

describe("image background preference", () => {
	it("reads reviewed catalog metadata instead of inferring support from an API or model id", () => {
		const model = imageModel("openai-codex", "openai-codex-responses");
		expect(supportsImageBackground(model)).toBe(true);
		expect(supportsImageBackground({ ...model, imageBackground: undefined })).toBe(false);
		expect(supportsImageBackground({ ...model, imageBackground: false })).toBe(false);
		for (const overrides of [
			{ baseUrl: "https://codex-proxy.example/v1" },
			{ provider: "openai", api: "openai-responses" as const },
			{ provider: "openai", api: "openai-images" as const },
			{ provider: "custom-images", api: "openai-images" as const },
			{ api: "openai-images" as const },
			{ id: "gpt-5.4" },
			{ id: "gpt-image-1" },
		]) {
			expect(supportsImageBackground(buildModel({ ...model, ...overrides }))).toBe(false);
		}
	});

	it("rejects explicit backgrounds on a custom Codex URL before contacting it", async () => {
		const official = imageModel("openai-codex", "openai-codex-responses");
		const model = buildModel({ ...official, baseUrl: "https://codex-proxy.example/v1" });
		const carrier = buildModel({ ...model, id: "gpt-5.4", name: "GPT 5.4", kind: "chat" });
		let calls = 0;
		const fetchStub: FetchImpl = async () => {
			calls++;
			throw new Error("Unexpected custom Codex request");
		};
		for (const selected of [model, official]) {
			for (const background of ["transparent", "opaque"] as const) {
				const error = await generateImage(
					selected,
					{ prompt: "a sticker", background },
					{ apiKey: "test-key", carrier, fetch: fetchStub },
				).catch((error: unknown) => error);
				expect(error).toBeInstanceOf(AIError.ValidationError);
				expect(error).toHaveProperty(
					"message",
					`Image model openai-codex/gpt-image-2 does not support ${background} backgrounds`,
				);
			}
		}
		expect(calls).toBe(0);
	});

	it("omits automatic backgrounds on a custom Codex URL without changing the request", async () => {
		const official = imageModel("openai-codex", "openai-codex-responses");
		const model = buildModel({ ...official, baseUrl: "https://codex-proxy.example/v1" });
		const carrier = buildModel({ ...model, id: "gpt-5.4", name: "GPT 5.4", kind: "chat" });
		const bodies: Array<Record<string, unknown>> = [];
		const fetchStub: FetchImpl = async (input, init) => {
			expect(input.toString()).toBe("https://codex-proxy.example/v1/codex/responses");
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			bodies.push(body);
			const tools = body.tools as Array<Record<string, unknown>>;
			expect(tools[0]).not.toHaveProperty("background");
			const response = { output: [{ type: "image_generation_call", result: IMAGE_DATA }] };
			return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		};
		const request = Object.freeze({ prompt: "a sticker", background: "auto" as const });
		const options = { apiKey: "test-key", carrier, fetch: fetchStub };
		await generateImage(model, { prompt: "a sticker" }, options);
		const result = await generateImage(model, request, options);
		await generateImage(official, request, options);
		expect(bodies).toHaveLength(3);
		expect(bodies[1]).toEqual(bodies[0]);
		expect(bodies[2]).toEqual(bodies[0]);
		expect(result.images).toEqual([{ data: IMAGE_DATA, mimeType: "image/webp" }]);
		expect(request).toEqual({ prompt: "a sticker", background: "auto" });
	});

	it("rejects DeepInfra explicit backgrounds with a capability error before its strict endpoint is called", async () => {
		const model = imageModel("deepinfra", "openai-images", "black-forest-labs/FLUX-2-pro");
		let calls = 0;
		const fetchStub: FetchImpl = async (_input, init) => {
			calls++;
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (body.background !== undefined) {
				return Response.json({ error: { message: "DeepInfra does not accept background" } }, { status: 400 });
			}
			throw new Error("Unexpected DeepInfra network request");
		};
		for (const background of ["transparent", "opaque"] as const) {
			const error = await generateImage(
				model,
				{ prompt: "a sticker", background },
				{ apiKey: "test-key", fetch: fetchStub },
			).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(AIError.ValidationError);
			expect(error).toMatchObject({
				message: `Image model deepinfra/black-forest-labs/FLUX-2-pro does not support ${background} backgrounds`,
			});
		}
		expect(calls).toBe(0);
	});

	it("omits auto backgrounds for DeepInfra's strict endpoint without mutating the request", async () => {
		const model = imageModel("deepinfra", "openai-images", "black-forest-labs/FLUX-2-pro");
		const request = Object.freeze({ prompt: "a sticker", background: "auto" as const });
		let calls = 0;
		const fetchStub: FetchImpl = async (input, init) => {
			calls++;
			expect(input.toString()).toBe("https://deepinfra.example/v1/images/generations");
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (Object.hasOwn(body, "background")) {
				return Response.json({ error: { message: "DeepInfra does not accept background" } }, { status: 400 });
			}
			expect(body).not.toHaveProperty("background");
			return imageResponse();
		};
		const result = await generateImage(model, request, { apiKey: "test-key", fetch: fetchStub });
		expect(calls).toBe(1);
		expect(result.images).toEqual([{ data: IMAGE_DATA, mimeType: "image/webp" }]);
		expect(request).toEqual({ prompt: "a sticker", background: "auto" });
	});

	it("Images transport serializes transparent generation backgrounds without changing output format", async () => {
		const model = imageModel("openai", "openai-images");
		const fetchStub: FetchImpl = async (input, init) => {
			expect(input.toString()).toBe("https://openai.example/v1/images/generations");
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			expect(body.background).toBe("transparent");
			expect(body.response_format).toBe("b64_json");
			expect(body).not.toHaveProperty("output_format");
			return imageResponse();
		};
		const result = await generateOpenAIImage(
			model,
			{ prompt: "a sticker", background: "transparent" },
			{ apiKey: "test-key", fetch: fetchStub },
		);
		expect(result.images).toEqual([{ data: IMAGE_DATA, mimeType: "image/webp" }]);
	});
	for (const background of ["transparent", "opaque", "auto"] as const) {
		for (const action of ["generate", "edit"] as const) {
			it(`sends ${background} backgrounds through Codex ${action} while preserving WebP`, async () => {
				const model = imageModel("openai-codex", "openai-codex-responses");
				const carrier = buildModel({ ...model, id: "gpt-5.4", name: "GPT 5.4", kind: "chat" });
				expect(supportsImageBackground(model)).toBe(true);
				const fetchStub: FetchImpl = async (_input, init) => {
					const body = JSON.parse(String(init?.body)) as {
						model: string;
						tools: Array<Record<string, unknown>>;
						stream?: boolean;
					};
					expect(body.model).toBe("gpt-5.4");
					expect(body.tools[0]).toMatchObject({ background, output_format: "webp", action });
					expect(body.stream).toBe(true);
					const response = { output: [{ type: "image_generation_call", result: IMAGE_DATA }] };
					return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
						headers: { "content-type": "text/event-stream" },
					});
				};
				const result = await generateImage(
					model,
					{
						prompt: "a sticker",
						background,
						...(action === "edit" ? { inputImages: [{ data: "aW5wdXQ=", mimeType: "image/png" }] } : {}),
					},
					{ apiKey: "test-key", carrier, fetch: fetchStub },
				);
				expect(result.images).toEqual([{ data: IMAGE_DATA, mimeType: "image/webp" }]);
			});
		}
	}
	it("Images transport preserves opaque backgrounds in multipart edits and their 404 JSON fallback", async () => {
		const model = imageModel("openai", "openai-images");
		let calls = 0;
		const fetchStub: FetchImpl = async (input, init) => {
			calls++;
			if (calls === 1) {
				expect(input.toString()).toBe("https://openai.example/v1/images/edits");
				expect(init?.body).toBeInstanceOf(FormData);
				const form = init?.body as FormData;
				expect(form.get("background")).toBe("opaque");
				expect(form.has("output_format")).toBe(false);
				return Response.json({ error: { message: "edits unavailable" } }, { status: 404 });
			}
			expect(input.toString()).toBe("https://openai.example/v1/images/generations");
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			expect(body).toMatchObject({
				background: "opaque",
				input_references: [{ type: "image_url", url: "data:image/png;base64,aW5wdXQ=" }],
			});
			expect(body).not.toHaveProperty("output_format");
			return imageResponse();
		};
		await generateOpenAIImage(
			model,
			{
				prompt: "a sticker",
				background: "opaque",
				inputImages: [{ data: "aW5wdXQ=", mimeType: "image/png" }],
			},
			{ apiKey: "test-key", fetch: fetchStub },
		);
		expect(calls).toBe(2);
	});
	for (const [provider, api] of [
		["openai", "openai-images"],
		["openai", "openai-responses"],
		["openai-codex", "openai-images"],
		["custom-images", "openai-images"],
		["xai", "openai-images"],
		["xai-oauth", "openai-images"],
		["openrouter", "openrouter-images"],
		["google", "google-generative-ai"],
		["google-antigravity", "google-gemini-cli"],
		["anthropic", "anthropic-messages"],
	] as const) {
		it(`rejects non-auto backgrounds on ${provider}/${api} before contacting the provider`, async () => {
			const model = imageModel(provider, api);
			let calls = 0;
			const fetchStub: FetchImpl = async () => {
				calls++;
				return imageResponse();
			};
			expect(supportsImageBackground(model)).toBe(false);
			for (const background of ["transparent", "opaque"] as const) {
				await expect(
					generateImage(model, { prompt: "a sticker", background }, { apiKey: "test-key", fetch: fetchStub }),
				).rejects.toThrow(/does not support.*background/i);
			}
			expect(calls).toBe(0);
		});
	}
	it("Images transport preserves transparent backgrounds in JSON edits and their 404 fallback", async () => {
		const model = imageModel("custom-images", "openai-images");
		let calls = 0;
		const fetchStub: FetchImpl = async (input, init) => {
			calls++;
			expect(input.toString()).toBe(
				calls === 1
					? "https://custom-images.example/v1/images/edits"
					: "https://custom-images.example/v1/images/generations",
			);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			expect(body).toMatchObject({
				background: "transparent",
				input_references: [{ type: "image_url", url: "data:image/png;base64,aW5wdXQ=" }],
			});
			expect(body).not.toHaveProperty("output_format");
			return calls === 1
				? Response.json({ error: { message: "edits unavailable" } }, { status: 404 })
				: imageResponse();
		};
		const result = await generateOpenAIImage(
			model,
			{
				prompt: "a sticker",
				background: "transparent",
				inputImages: [{ data: "aW5wdXQ=", mimeType: "image/png" }],
			},
			{ apiKey: "test-key", fetch: fetchStub },
		);
		expect(calls).toBe(2);
		expect(result.images).toEqual([{ data: IMAGE_DATA, mimeType: "image/webp" }]);
	});

	for (const [provider, api] of [
		["openai", "openai-images"],
		["openai", "openai-responses"],
		["xai", "openai-images"],
		["deepinfra", "openai-images"],
		["custom-images", "openai-images"],
	] as const) {
		it(`keeps omitted and auto backgrounds compatible with ${provider}/${api}`, async () => {
			const model = imageModel(provider, api);
			expect(supportsImageBackground(model)).toBe(false);
			let omittedBody: Record<string, unknown> | undefined;
			let autoBody: Record<string, unknown> | undefined;
			let calls = 0;
			const fetchStub: FetchImpl = async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				if (calls++ === 0) omittedBody = body;
				else autoBody = body;
				return api === "openai-responses"
					? Response.json({ output: [{ type: "image_generation_call", result: IMAGE_DATA }] })
					: imageResponse();
			};
			const options = { apiKey: "test-key", carrier: model, fetch: fetchStub };
			await generateImage(model, { prompt: "a sticker" }, options);
			await generateImage(model, { prompt: "a sticker", background: "auto" }, options);
			expect(calls).toBe(2);
			if (api === "openai-responses") {
				const omittedTools = omittedBody?.tools as Array<Record<string, unknown>>;
				const autoTools = autoBody?.tools as Array<Record<string, unknown>>;
				expect(omittedTools[0]).not.toHaveProperty("background");
				expect(autoTools[0]).not.toHaveProperty("background");
				expect(autoTools[0]).toMatchObject({ output_format: "webp" });
			} else {
				expect(omittedBody).not.toHaveProperty("background");
				expect(autoBody).not.toHaveProperty("background");
			}
			expect(autoBody).toEqual(omittedBody);
		});
	}
});
