import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { generateOpenAIImage } from "../src/images/openai-images";
import type { FetchImpl } from "../src/types";

const IMAGE_DATA = Buffer.from("image bytes").toString("base64");
const INPUT_IMAGE = { data: IMAGE_DATA, mimeType: "image/png" };

function imageModel(provider: string, id: string, requestModelId?: string) {
	return buildModel({
		id,
		requestModelId,
		name: id,
		api: "openai-images",
		provider,
		baseUrl: `https://${provider}.example/v1`,
		kind: "image",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} satisfies ModelSpec<"openai-images">);
}

function imageResponse(status = 200): Response {
	const body =
		status === 200
			? { data: [{ b64_json: IMAGE_DATA }] }
			: { error: { message: "UnsupportedParamsError: response_format is not supported" } };
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenAI-compatible image response_format", () => {
	test("GPT Image generation uses the wire model ID and succeeds through a strict gateway", async () => {
		const model = imageModel("gateway", "local-alias", "tenant/gpt-image-2.5-2026-08-01");
		let body: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			const requestBody: Record<string, unknown> = JSON.parse(String(init?.body));
			body = requestBody;
			return imageResponse("response_format" in requestBody ? 400 : 200);
		};

		const result = await generateOpenAIImage(model, { prompt: "a cat" }, { apiKey: "test", fetch });

		expect(body?.model).toBe("tenant/gpt-image-2.5-2026-08-01");
		expect(body).not.toHaveProperty("response_format");
		expect(result.images[0]?.data).toBe(IMAGE_DATA);
	});

	test("ChatGPT Image JSON edits omit the unsupported parameter", async () => {
		const model = imageModel("gateway", "chatgpt-image-latest");
		let body: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			const requestBody: Record<string, unknown> = JSON.parse(String(init?.body));
			body = requestBody;
			return imageResponse("response_format" in requestBody ? 400 : 200);
		};

		const result = await generateOpenAIImage(
			model,
			{ prompt: "paint this", inputImages: [INPUT_IMAGE] },
			{ apiKey: "test", fetch },
		);

		expect(body?.input_references).toEqual([{ type: "image_url", url: `data:image/png;base64,${IMAGE_DATA}` }]);
		expect(body).not.toHaveProperty("response_format");
		expect(result.images[0]?.data).toBe(IMAGE_DATA);
	});

	test("OpenAI GPT Image multipart edits omit the unsupported form field", async () => {
		const model = imageModel("openai", "gpt-image-1");
		let form: FormData | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			if (!(init?.body instanceof FormData)) throw new Error("Expected multipart image edit");
			form = init.body;
			return imageResponse(form.has("response_format") ? 400 : 200);
		};

		const result = await generateOpenAIImage(
			model,
			{ prompt: "paint this", inputImages: [INPUT_IMAGE] },
			{ apiKey: "test", fetch },
		);

		expect(form?.get("model")).toBe("gpt-image-1");
		expect(form?.get("image")).toBeInstanceOf(File);
		expect(form?.has("response_format")).toBe(false);
		expect(result.images[0]?.data).toBe(IMAGE_DATA);
	});

	test("non-GPT image generation and JSON edits retain response_format", async () => {
		const model = imageModel("gateway", "flux-1");
		const bodies: Array<Record<string, unknown>> = [];
		const fetch: FetchImpl = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return imageResponse();
		};

		await generateOpenAIImage(model, { prompt: "a cat" }, { apiKey: "test", fetch });
		await generateOpenAIImage(model, { prompt: "paint", inputImages: [INPUT_IMAGE] }, { apiKey: "test", fetch });

		expect(bodies[0]?.response_format).toBe("b64_json");
		expect(bodies[1]?.response_format).toBe("b64_json");
	});

	test("xAI image generation retains response_format", async () => {
		const model = imageModel("xai", "grok-imagine-image");
		let body: Record<string, unknown> | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			body = JSON.parse(String(init?.body));
			return imageResponse();
		};

		await generateOpenAIImage(model, { prompt: "a cat" }, { apiKey: "test", fetch });

		expect(body?.response_format).toBe("b64_json");
		expect(body?.resolution).toBe("1k");
	});

	test("DALL-E multipart edits retain response_format", async () => {
		const model = imageModel("openai", "dall-e-2");
		let form: FormData | undefined;
		const fetch: FetchImpl = async (_input, init) => {
			if (!(init?.body instanceof FormData)) throw new Error("Expected multipart image edit");
			form = init.body;
			return imageResponse();
		};

		await generateOpenAIImage(model, { prompt: "paint", inputImages: [INPUT_IMAGE] }, { apiKey: "test", fetch });

		expect(form?.get("response_format")).toBe("b64_json");
	});
});
