import { describe, expect, it } from "bun:test";
import { ValidationError } from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";
import { generateAntigravityImage } from "../src/images/google-antigravity";
import { generateGoogleImage } from "../src/images/google-generative-ai";
import { generateOpenAIImage } from "../src/images/openai-images";
import { generateHostedImage } from "../src/images/openai-hosted";
import { generateOpenRouterImage } from "../src/images/openrouter-images";
import type { ImageInput } from "../src/images/types";

const IMAGE_BYTES = Buffer.from("image input bytes");
const PADDED_IMAGE_DATA = IMAGE_BYTES.toString("base64");
const UNPADDED_IMAGE_DATA = PADDED_IMAGE_DATA.replace(/=+$/, "");
const DATA_URL_PREFIX = "data:image/png;base64,";
const API_KEY = "image-input-validation-test-key";
const ANTIGRAVITY_KEY = JSON.stringify({ token: "image-token", projectId: "test-project" });

function imageModel(provider: string, id: string, api: Api, baseUrl: string): Model<Api> {
	return buildModel({
		id,
		name: `${provider}/${id}`,
		provider,
		api,
		kind: "image",
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 4096,
	});
}

const hostedImageModel = imageModel("openai", "gpt-image-1", "openai-responses", "https://openai.test/v1");
const hostedCarrier = imageModel("openai", "gpt-5.6", "openai-responses", "https://openai.test/v1");
const openRouterModel = imageModel(
	"openrouter",
	"google/gemini-3-pro-image",
	"openrouter-images",
	"https://openrouter.test/api/v1",
);
const openAICompatibleModel = imageModel("xai", "grok-imagine-image", "openai-images", "https://xai.test/v1");
const openAIMultipartModel = imageModel("openai", "gpt-image-1", "openai-images", "https://openai.test/v1");
const geminiModel = imageModel(
	"google",
	"gemini-3.1-flash-lite-image",
	"google-generative-ai",
	"https://google.test/v1beta",
);
const antigravityModel = imageModel(
	"google-antigravity",
	"gemini-3-pro-image",
	"google-gemini-cli",
	"https://antigravity.test",
);

interface FetchCall {
	url: string;
	init?: RequestInit;
}

interface ImageClientCase {
	name: string;
	/** Whether the client sends input images as data URLs rather than raw MIME metadata. */
	dataUrl: boolean;
	invoke(input: ImageInput, fetch: FetchImpl): Promise<unknown>;
	imageRequest(calls: FetchCall[]): FetchCall | undefined;
	assertPayload(call: FetchCall, input: ImageInput): Promise<void> | void;
}

const clients: ImageClientCase[] = [
	{
		name: "hosted Responses",
		dataUrl: true,
		invoke: (input, fetch) =>
			generateHostedImage(
				hostedImageModel,
				{ prompt: "edit the image", inputImages: [input] },
				{ apiKey: API_KEY, fetch, carrier: hostedCarrier },
			),
		imageRequest: calls => calls.find(call => call.url.endsWith("/responses")),
		assertPayload: (call, input) => {
			const body = jsonBody(call) as {
				input?: Array<{ content?: Array<{ type?: string; image_url?: string }> }>;
			};
			const image = body.input?.[0]?.content?.find(part => part.type === "input_image");
			expect(image?.image_url).toBe(`${DATA_URL_PREFIX}${input.data}`);
		},
	},
	{
		name: "OpenRouter JSON",
		dataUrl: true,
		invoke: (input, fetch) =>
			generateOpenRouterImage(
				openRouterModel,
				{ prompt: "edit the image", inputImages: [input] },
				{ apiKey: API_KEY, fetch },
			),
		imageRequest: calls => calls.find(call => call.url.endsWith("/images")),
		assertPayload: (call, input) => {
			const body = jsonBody(call) as {
				input_references?: Array<{ type?: string; image_url?: { url?: string } }>;
			};
			expect(body.input_references?.[0]).toEqual({
				type: "image_url",
				image_url: { url: `${DATA_URL_PREFIX}${input.data}` },
			});
		},
	},
	{
		name: "OpenAI-compatible JSON edits",
		dataUrl: true,
		invoke: (input, fetch) =>
			generateOpenAIImage(
				openAICompatibleModel,
				{ prompt: "edit the image", inputImages: [input] },
				{ apiKey: API_KEY, fetch },
			),
		imageRequest: calls => calls.find(call => call.url.endsWith("/images/edits")),
		assertPayload: (call, input) => {
			const body = jsonBody(call) as { image?: { type?: string; url?: string } };
			expect(body.image).toEqual({ type: "image_url", url: `${DATA_URL_PREFIX}${input.data}` });
		},
	},
	{
		name: "OpenAI multipart edit",
		dataUrl: false,
		invoke: (input, fetch) =>
			generateOpenAIImage(
				openAIMultipartModel,
				{ prompt: "edit the image", inputImages: [input] },
				{ apiKey: API_KEY, fetch },
			),
		imageRequest: calls => calls.find(call => call.url.endsWith("/images/edits")),
		assertPayload: async (call, input) => {
			if (!(call.init?.body instanceof FormData)) throw new Error("Expected the first edit request to be multipart");
			const image = call.init.body.get("image");
			expect(image).toBeInstanceOf(File);
			if (!(image instanceof File)) throw new Error("Expected multipart image file");
			expect(image.type).toBe(input.mimeType);
			expect(Array.from(new Uint8Array(await image.arrayBuffer()))).toEqual(Array.from(IMAGE_BYTES));
		},
	},
	{
		name: "Gemini inlineData",
		dataUrl: false,
		invoke: (input, fetch) =>
			generateGoogleImage(
				geminiModel,
				{ prompt: "edit the image", inputImages: [input] },
				{ apiKey: API_KEY, fetch },
			),
		imageRequest: calls => calls.find(call => call.url.includes(":generateContent")),
		assertPayload: (call, input) => {
			const body = jsonBody(call) as {
				contents?: Array<{ parts?: Array<{ inlineData?: ImageInput }> }>;
			};
			expect(body.contents?.[0]?.parts?.[0]?.inlineData).toEqual(input);
		},
	},
	{
		name: "Antigravity inlineData",
		dataUrl: false,
		invoke: (input, fetch) =>
			generateAntigravityImage(
				antigravityModel,
				{ prompt: "edit the image", inputImages: [input] },
				{ apiKey: ANTIGRAVITY_KEY, fetch },
			),
		imageRequest: calls => calls.find(call => call.url.includes(":streamGenerateContent")),
		assertPayload: (call, input) => {
			const body = jsonBody(call) as {
				request?: { contents?: Array<{ parts?: Array<{ inlineData?: ImageInput }> }> };
			};
			expect(body.request?.contents?.[0]?.parts?.[0]?.inlineData).toEqual(input);
		},
	},
];

function createFetch(calls: FetchCall[]): FetchImpl {
	return async (input, init) => {
		const url = String(input);
		calls.push({ url, init });
		if (url.includes("fetchAvailableModels")) return new Response("{}", { status: 404 });
		if (url.includes(":streamGenerateContent")) {
			return new Response('data: {"response":{"candidates":[]}}\n\n', {
				headers: { "content-type": "text/event-stream" },
			});
		}
		if (url.endsWith("/responses")) {
			return new Response(JSON.stringify({ output: [] }), { headers: { "content-type": "application/json" } });
		}
		if (url.includes(":generateContent")) {
			return new Response(JSON.stringify({ candidates: [] }), { headers: { "content-type": "application/json" } });
		}
		if (url.endsWith("/images/edits") || url.endsWith("/images")) {
			return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } });
		}
		return new Response("not found", { status: 404 });
	};
}

function jsonBody(call: FetchCall): unknown {
	return JSON.parse(String(call.init?.body));
}

const invalidInputs: Array<{ name: string; input: ImageInput }> = [
	{ name: "empty data", input: { data: "", mimeType: "image/png" } },
	{ name: "non-canonical base64 padding", input: { data: "YQ===", mimeType: "image/png" } },
	{ name: "unsupported MIME type", input: { data: PADDED_IMAGE_DATA, mimeType: "text/plain" } },
	{ name: "malformed MIME syntax", input: { data: PADDED_IMAGE_DATA, mimeType: "image/x?test" } },
	{
		name: "MIME subtype over 127 characters",
		input: { data: PADDED_IMAGE_DATA, mimeType: `image/x${"a".repeat(127)}` },
	},
];

for (const client of clients) {
	describe(`${client.name} input validation`, () => {
		for (const invalid of invalidInputs) {
			it(`rejects ${invalid.name} before any fetch`, async () => {
				const calls: FetchCall[] = [];
				const error = await client.invoke(invalid.input, createFetch(calls)).catch(cause => cause);
				expect(error).toBeInstanceOf(ValidationError);
				expect(calls).toHaveLength(0);
			});
		}

		for (const data of [PADDED_IMAGE_DATA, UNPADDED_IMAGE_DATA]) {
			it(`sends valid ${data.endsWith("=") ? "padded" : "omitted-padding"} data in the expected wire shape`, async () => {
				const calls: FetchCall[] = [];
				const input = { data, mimeType: "image/png" };
				await client.invoke(input, createFetch(calls));
				const imageRequest = client.imageRequest(calls);
				expect(imageRequest).toBeDefined();
				if (!imageRequest) throw new Error("Expected the provider image request");
				await client.assertPayload(imageRequest, input);
			});
		}

		const hashInput = { data: PADDED_IMAGE_DATA, mimeType: "image/x#test" };
		if (client.dataUrl) {
			it("rejects a MIME subtype containing a URL fragment marker before any fetch", async () => {
				const calls: FetchCall[] = [];
				const error = await client.invoke(hashInput, createFetch(calls)).catch(cause => cause);
				expect(error).toBeInstanceOf(ValidationError);
				expect(calls).toHaveLength(0);
			});
		} else {
			it("delivers a MIME subtype containing '#' intact", async () => {
				const calls: FetchCall[] = [];
				await client.invoke(hashInput, createFetch(calls));
				const imageRequest = client.imageRequest(calls);
				if (!imageRequest) throw new Error("Expected the provider image request");
				await client.assertPayload(imageRequest, hashInput);
			});
		}
	});
}

it("delivers legal MIME punctuation and image bytes intact through hosted provider data URLs", async () => {
	const subtype = `x_test!$&-^_.+${"a".repeat(113)}`;
	expect(subtype).toHaveLength(127);
	const input = { data: PADDED_IMAGE_DATA, mimeType: `image/${subtype}` };
	const calls: FetchCall[] = [];
	await generateHostedImage(
		hostedImageModel,
		{ prompt: "edit the image", inputImages: [input] },
		{ apiKey: API_KEY, fetch: createFetch(calls), carrier: hostedCarrier },
	);
	const call = calls.find(item => item.url.endsWith("/responses"));
	if (!call) throw new Error("Expected the hosted image request");
	const body = jsonBody(call) as {
		input?: Array<{ content?: Array<{ type?: string; image_url?: string }> }>;
	};
	const imageUrl = body.input?.[0]?.content?.find(part => part.type === "input_image")?.image_url;
	if (!imageUrl) throw new Error("Expected the hosted input image data URL");
	// Consume the URL the way a provider's data-URL parser does.
	const consumed = await fetch(new URL(imageUrl));
	expect(consumed.headers.get("content-type")).toBe(input.mimeType);
	expect(Buffer.from(await consumed.arrayBuffer())).toEqual(IMAGE_BYTES);
});

it("does not tag Antigravity image requests with the requestType that draws false 429 quota errors", async () => {
	const calls: FetchCall[] = [];
	await generateAntigravityImage(
		antigravityModel,
		{ prompt: "draw a cat" },
		{ apiKey: ANTIGRAVITY_KEY, fetch: createFetch(calls) },
	);
	const call = calls.find(item => item.url.includes(":streamGenerateContent"));
	if (!call) throw new Error("Expected the Antigravity image request");
	const body = jsonBody(call);
	expect(body !== null && typeof body === "object" && "requestType" in body).toBe(false);
});
