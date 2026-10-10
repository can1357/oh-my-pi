import { describe, expect, it } from "bun:test";
import { generateImage, type ImageGenerationRequest } from "@oh-my-pi/pi-ai/images";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

function imageModel(provider: string, id: string, api: Api): Model<Api> {
	return buildModel({
		id,
		name: id,
		provider,
		api,
		kind: "image",
		baseUrl: `https://${provider}.example/v1beta`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 4096,
	});
}

const image = { data: "YWJj", mimeType: "image/png" };

function googleResponse(): Response {
	return Response.json({ candidates: [{ content: { parts: [{ inlineData: image }] } }] });
}
interface CapturedRequest {
	generationConfig?: { imageConfig?: { imageSize?: string; aspectRatio?: string } };
	request?: { generationConfig?: { imageConfig?: { imageSize?: string; aspectRatio?: string } } };
	imageSize?: string;
	image_size?: string;
}

async function generateWithCapturedRequest(
	model: Model<Api>,
	request: ImageGenerationRequest,
): Promise<CapturedRequest> {
	let sent: CapturedRequest | undefined;
	const fetchStub: FetchImpl = async (url, init) => {
		const route = url.toString();
		if (route.includes("fetchAvailableModels")) return Response.json({ imageGenerationModelIds: [model.id] });
		if (!init?.body) return new Response(null, { status: 404 });
		sent = JSON.parse(String(init.body));
		const config =
			model.api === "google-gemini-cli"
				? sent?.request?.generationConfig?.imageConfig
				: model.api === "google-generative-ai"
					? sent?.generationConfig?.imageConfig
					: sent;
		if (config?.imageSize?.includes("x") || sent?.image_size?.includes("x")) {
			return Response.json({ error: { message: "Unsupported image_size" } }, { status: 400 });
		}
		if (model.api === "google-gemini-cli") {
			const payload = { response: { candidates: [{ content: { parts: [{ inlineData: image }] } }] } };
			return new Response(`data: ${JSON.stringify(payload)}\n\n`);
		}
		if (model.api === "openrouter-images") {
			return Response.json({ data: [{ b64_json: image.data, media_type: image.mimeType }] });
		}
		return googleResponse();
	};
	const result = await generateImage(model, request, {
		apiKey: model.api === "google-gemini-cli" ? JSON.stringify({ token: "fake", projectId: "demo" }) : "fake",
		fetch: fetchStub,
	});
	expect(result.images).toEqual([image]);
	if (!sent) throw new Error("No image request sent");
	return sent;
}

describe("Gemini image sizes", () => {
	const google = imageModel("google", "gemini-3.1-flash-image", "google-generative-ai");

	it("translates square and both rectangular tool sizes for the Gemini API", async () => {
		const cases: Array<[string, { aspectRatio: string; imageSize: string }]> = [
			["1024x1024", { aspectRatio: "1:1", imageSize: "1K" }],
			["1536x1024", { aspectRatio: "3:2", imageSize: "2K" }],
			["1024x1536", { aspectRatio: "2:3", imageSize: "2K" }],
		];
		for (const [imageSize, imageConfig] of cases) {
			const sent = await generateWithCapturedRequest(google, { prompt: "lighthouse", imageSize });
			expect(sent).toMatchObject({ generationConfig: { imageConfig } });
		}
	});

	it("preserves an explicit aspect ratio and does not add config without size or ratio", async () => {
		const override = await generateWithCapturedRequest(google, {
			prompt: "lighthouse",
			imageSize: "1536x1024",
			aspectRatio: "16:9",
		});
		expect(override).toMatchObject({ generationConfig: { imageConfig: { aspectRatio: "16:9", imageSize: "2K" } } });
		const omitted = await generateWithCapturedRequest(google, { prompt: "lighthouse" });
		expect(omitted).toMatchObject({ generationConfig: { responseModalities: ["IMAGE"] } });
		expect(omitted.generationConfig).not.toHaveProperty("imageConfig");
	});

	it("translates the Antigravity Gemini image payload", async () => {
		const model = imageModel("google-antigravity", "gemini-3-pro-image", "google-gemini-cli");
		const sent = await generateWithCapturedRequest(model, { prompt: "lighthouse", imageSize: "1024x1536" });
		expect(sent).toMatchObject({
			request: { generationConfig: { imageConfig: { aspectRatio: "2:3", imageSize: "2K" } } },
		});
	});

	it("sends OpenRouter Gemini resolution rather than an OpenAI image_size", async () => {
		const model = imageModel("openrouter", "google/gemini-3-pro-image", "openrouter-images");
		const sent = await generateWithCapturedRequest(model, { prompt: "lighthouse", imageSize: "1536x1024" });
		expect(sent).toMatchObject({ resolution: "2K", aspect_ratio: "3:2" });
		expect(sent).not.toHaveProperty("image_size");
	});
});
