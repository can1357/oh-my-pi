import { describe, expect, it } from "bun:test";
import { generateImage, supportsImageBackground } from "@oh-my-pi/pi-ai/images";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const IMAGE_DATA = Buffer.from("background-image").toString("base64");

function imageModel(provider: string, api: Api): Model<Api> {
	return buildModel({
		id: "background-image-test",
		name: "Background image test",
		provider,
		api,
		kind: "image",
		baseUrl: `https://${provider}.example/v1`,
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
	it("sends transparent backgrounds to the Images generation endpoint without changing output format", async () => {
		const model = imageModel("openai", "openai-images");
		const fetchStub: FetchImpl = async (input, init) => {
			expect(input.toString()).toBe("https://openai.example/v1/images/generations");
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			expect(body.background).toBe("transparent");
			expect(body.response_format).toBe("b64_json");
			expect(body).not.toHaveProperty("output_format");
			return imageResponse();
		};
		const result = await generateImage(
			model,
			{ prompt: "a sticker", background: "transparent" },
			{ apiKey: "test-key", fetch: fetchStub },
		);
		expect(result.images).toEqual([{ data: IMAGE_DATA, mimeType: "image/webp" }]);
	});
	for (const [provider, api, background] of [
		["openai", "openai-responses", "transparent"],
		["openai-codex", "openai-codex-responses", "opaque"],
	] as const) {
		it(`sends ${background} backgrounds through ${api} while preserving WebP`, async () => {
			const model = imageModel(provider, api);
			const fetchStub: FetchImpl = async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as { tools: Array<Record<string, unknown>>; stream?: boolean };
				expect(body.tools[0]).toMatchObject({ background, output_format: "webp", action: "generate" });
				const response = { output: [{ type: "image_generation_call", result: IMAGE_DATA }] };
				if (api === "openai-codex-responses") {
					expect(body.stream).toBe(true);
					return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
						headers: { "content-type": "text/event-stream" },
					});
				}
				return Response.json(response);
			};
			const result = await generateImage(
				model,
				{ prompt: "a sticker", background },
				{ apiKey: "test-key", carrier: model, fetch: fetchStub },
			);
			expect(result.images).toEqual([{ data: IMAGE_DATA, mimeType: "image/webp" }]);
		});
	}
	it("keeps opaque backgrounds in multipart edits and their 404 JSON fallback", async () => {
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
		await generateImage(
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
	it("keeps transparent backgrounds in JSON edits and their 404 fallback", async () => {
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
		const result = await generateImage(
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
	] as const) {
		it(`keeps omitted and auto backgrounds compatible with ${provider}/${api}`, async () => {
			const model = imageModel(provider, api);
			expect(supportsImageBackground(model)).toBe(provider !== "xai");
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
				expect(autoTools[0]).toMatchObject({ background: "auto", output_format: "webp" });
			} else {
				expect(omittedBody).not.toHaveProperty("background");
				if (provider === "xai") expect(autoBody).toEqual(omittedBody);
				else expect(autoBody).toEqual({ ...omittedBody, background: "auto" });
			}
		});
	}
});
