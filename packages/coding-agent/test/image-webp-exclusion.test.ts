import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Api, Message, Model } from "@oh-my-pi/pi-ai";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionProviderBoundary } from "@oh-my-pi/pi-coding-agent/session/session-provider-boundary";
import {
	modelLacksWebpSupport,
	normalizeModelContextImages,
	normalizeModelContextMessages,
	webpExclusionForModel,
} from "@oh-my-pi/pi-coding-agent/utils/image-loading";

// 1x1 red PNG seed, upscaled + re-encoded as WebP at test time so no binary
// fixture is checked in. Bun.Image sniffs format from bytes.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function makeRedWebP(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed)
		.resize(width, height, { filter: "nearest" })
		.webp({ quality: 90 })
		.bytes();
	return Buffer.from(upscaled).toBase64();
}

function buildLocalVisionModel(provider: string, api: Api = "openai-completions"): Model {
	return buildModel({
		id: "local-vision",
		name: "Local vision",
		api,
		provider,
		baseUrl: "http://localhost:8001/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

function buildStbVisionModel(provider: string, api: Api = "openai-completions"): Model {
	return buildModel({
		...buildLocalVisionModel(provider, api),
		imageInputDecoder: "stb",
	});
}

describe("modelLacksWebpSupport", () => {
	test("flags the local + cloud Ollama providers", () => {
		expect(modelLacksWebpSupport({ provider: "ollama", api: "openai-responses" })).toBe(true);
		expect(modelLacksWebpSupport({ provider: "ollama-cloud", api: "ollama-chat" })).toBe(true);
	});

	test("flags the ollama-chat api even behind a custom provider id", () => {
		// A proxy/custom provider still routes images through Ollama's STB decoder.
		expect(modelLacksWebpSupport({ provider: "my-local-ollama", api: "ollama-chat" })).toBe(true);
	});

	test("flags local model provider ids", () => {
		for (const provider of ["llama.cpp", "lm-studio", "local-server"]) {
			expect(modelLacksWebpSupport({ provider, api: "openai-completions" })).toBe(true);
		}
	});

	test("flags discovered STB-backed models even behind a custom provider id", () => {
		expect(
			modelLacksWebpSupport({
				provider: "my-renamed-llama",
				api: "openai-completions",
				imageInputDecoder: "stb",
			}),
		).toBe(true);
	});

	test("leaves WebP-capable providers and undefined untouched", () => {
		expect(modelLacksWebpSupport({ provider: "anthropic", api: "anthropic-messages" })).toBe(false);
		expect(modelLacksWebpSupport({ provider: "openai", api: "openai-responses" })).toBe(false);
		expect(modelLacksWebpSupport(undefined)).toBe(false);
	});

	test("webpExclusionForModel yields true|undefined so the OMP_NO_WEBP fallback survives", () => {
		// `true` forces exclusion for Ollama...
		expect(webpExclusionForModel({ provider: "ollama", api: "openai-responses" })).toBe(true);
		// ...but a capable model returns `undefined` (NOT `false`), so resizeImage's
		// env fallback still applies instead of being overridden off.
		expect(webpExclusionForModel({ provider: "openai", api: "openai-responses" })).toBeUndefined();
	});
});

describe("normalizeModelContextImages model-aware WebP exclusion", () => {
	const prior = Bun.env.OMP_NO_WEBP;

	beforeEach(() => {
		delete (Bun.env as Record<string, string | undefined>).OMP_NO_WEBP;
	});

	afterEach(() => {
		if (prior === undefined) delete (Bun.env as Record<string, string | undefined>).OMP_NO_WEBP;
		else Bun.env.OMP_NO_WEBP = prior;
	});

	test("re-encodes a WebP image out of WebP for an Ollama-family model", async () => {
		const [ollama] = getBundledModels("ollama-cloud");
		expect(ollama).toBeDefined();
		const webp = { type: "image" as const, data: await makeRedWebP(200, 200), mimeType: "image/webp" };

		const result = await normalizeModelContextImages([webp], { model: ollama });
		expect(result).toHaveLength(1);
		const mime = result![0]!.mimeType;
		expect(mime).not.toBe("image/webp");
		expect(["image/png", "image/jpeg"]).toContain(mime);
	});

	test("re-encodes a WebP image out of WebP for local model provider ids", async () => {
		for (const provider of ["llama.cpp", "lm-studio", "local-server"]) {
			const webp = { type: "image" as const, data: await makeRedWebP(200, 200), mimeType: "image/webp" };

			const result = await normalizeModelContextImages([webp], { model: buildLocalVisionModel(provider) });

			expect(result).toHaveLength(1);
			const mime = result![0]!.mimeType;
			expect(mime).not.toBe("image/webp");
			expect(["image/png", "image/jpeg"]).toContain(mime);
		}
	});

	test("re-encodes a WebP image out of WebP for renamed STB-backed local providers", async () => {
		const webp = { type: "image" as const, data: await makeRedWebP(200, 200), mimeType: "image/webp" };

		const result = await normalizeModelContextImages([webp], {
			model: buildStbVisionModel("my-renamed-llama"),
		});

		expect(result).toHaveLength(1);
		const mime = result![0]!.mimeType;
		expect(mime).not.toBe("image/webp");
		expect(["image/png", "image/jpeg"]).toContain(mime);
	});

	test("keeps WebP for a WebP-capable model when OMP_NO_WEBP is unset", async () => {
		const [anthropic] = getBundledModels("anthropic");
		expect(anthropic).toBeDefined();
		const webp = { type: "image" as const, data: await makeRedWebP(200, 200), mimeType: "image/webp" };

		const result = await normalizeModelContextImages([webp], { model: anthropic });

		expect(result?.[0]?.mimeType).toBe("image/webp");
	});

	test("honors resize options when caching STB image normalization", async () => {
		const webp = { type: "image" as const, data: await makeRedWebP(400, 400), mimeType: "image/webp" };
		const model = buildStbVisionModel("managed-primary");

		const first = await normalizeModelContextImages([webp], {
			model,
			resize: { maxWidth: 120, maxHeight: 120, minDimension: 1 },
		});
		const second = await normalizeModelContextImages([webp], {
			model,
			resize: { maxWidth: 60, maxHeight: 60, minDimension: 1 },
		});
		const firstMetadata = await new Bun.Image(Buffer.from(first![0]!.data, "base64")).metadata();
		const secondMetadata = await new Bun.Image(Buffer.from(second![0]!.data, "base64")).metadata();

		expect(firstMetadata.width).toBe(120);
		expect(secondMetadata.width).toBe(60);
	});

	test("preserves an undecodable WebP attachment slot for provider-boundary omission", async () => {
		const corrupt = {
			type: "image" as const,
			data: Buffer.from("RIFF0000WEBPcorrupt").toBase64(),
			mimeType: "image/webp",
		};

		const result = await normalizeModelContextImages([corrupt], {
			model: buildStbVisionModel("managed-primary"),
		});

		expect(result).toEqual([corrupt]);
	});

	test("keeps custom-message image slots aligned when one WebP is undecodable", async () => {
		const corrupt = {
			type: "image" as const,
			data: Buffer.from("RIFF0000WEBPbad-custom-message").toBase64(),
			mimeType: "image/webp",
		};
		const validPng = {
			type: "image" as const,
			data: RED_1X1_PNG_BASE64,
			mimeType: "image/png",
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "image-audit",
			content: [corrupt, { type: "text", text: "between images" }, validPng],
			display: false,
			timestamp: 1,
		};
		const boundary = new SessionProviderBoundary({
			model: () => buildStbVisionModel("managed-primary"),
		} as never);

		const normalized = await boundary.normalizeAgentMessageImages(message);

		expect(normalized.content).not.toBeString();
		if (typeof normalized.content === "string") throw new Error("Expected block content");
		expect(normalized.content.map(part => part?.type)).toEqual(["image", "text", "image"]);
		expect(normalized.content[0]).toBe(corrupt);
	});

	test("rewrites resumed tool-result WebP blocks at the STB provider boundary", async () => {
		const original = {
			type: "image" as const,
			data: await makeRedWebP(200, 200),
			// Exercise byte sniffing as well as declared-MIME handling.
			mimeType: "image/png",
			detail: "original" as const,
		};
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text" as const, text: "screenshot" }, original],
				isError: false,
				timestamp: 1,
			},
		];

		const result = await normalizeModelContextMessages(messages, buildStbVisionModel("managed-primary"));
		const resultMessage = result[0]!;
		expect(resultMessage.role).toBe("toolResult");
		if (resultMessage.role !== "toolResult") throw new Error("Expected tool result message");
		const image = resultMessage.content[1]!;

		expect(image.type).toBe("image");
		if (image.type !== "image") throw new Error("Expected normalized image block");
		expect(image.mimeType).not.toBe("image/webp");
		expect(["image/png", "image/jpeg"]).toContain(image.mimeType);
		expect(Buffer.from(image.data.slice(0, 16), "base64").toString("ascii", 8, 12)).not.toBe("WEBP");
		expect(image.detail).toBe("original");
		// Provider-boundary normalization is ephemeral; persisted history is not mutated.
		expect(messages[0]!.content[1]).toBe(original);
	});

	test("rewrites native Responses history alongside generic image content", async () => {
		const model = buildStbVisionModel("managed-primary", "openai-responses");
		const original = {
			type: "image" as const,
			data: await makeRedWebP(200, 200),
			mimeType: "image/webp",
		};
		const providerPayload = {
			type: "openaiResponsesHistory" as const,
			provider: model.provider,
			dt: true,
			items: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_image", image_url: `data:image/webp;base64,${original.data}` }],
				},
			],
		};
		const message: Message = {
			role: "user",
			content: [{ type: "text", text: "inspect" }, original],
			providerPayload,
			timestamp: 1,
		};

		const messages = await normalizeModelContextMessages([message], model);
		const normalizedMessage = messages[0]!;
		expect(normalizedMessage.role).toBe("user");
		if (normalizedMessage.role !== "user") throw new Error("Expected user message");
		expect(normalizedMessage.providerPayload).not.toBe(providerPayload);
		expect(JSON.stringify(normalizedMessage.providerPayload)).not.toContain("image/webp");
		expect(JSON.stringify(normalizedMessage.providerPayload)).not.toContain(original.data);
		expect(message.providerPayload).toBe(providerPayload);

		const wire = buildResponsesInput({
			model,
			context: { messages },
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		const serializedWire = JSON.stringify(wire);
		expect(serializedWire).toContain("input_image");
		expect(serializedWire).not.toContain("image/webp");
		expect(serializedWire).not.toContain(original.data);
	});

	test("rewrites WebP retained only in native Responses history", async () => {
		const model = buildStbVisionModel("managed-primary", "openai-responses");
		const webp = await makeRedWebP(200, 200);
		const providerPayload = {
			type: "openaiResponsesHistory" as const,
			provider: model.provider,
			dt: true,
			items: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_image", image_url: `data:image/webp;base64,${webp}` }],
				},
			],
		};
		const message: Message = { role: "user", content: "inspect native image", providerPayload, timestamp: 1 };

		const messages = await normalizeModelContextMessages([message], model);
		const normalizedMessage = messages[0]!;
		expect(normalizedMessage.role).toBe("user");
		if (normalizedMessage.role !== "user") throw new Error("Expected user message");
		expect(normalizedMessage.content).toBe("inspect native image");
		expect(normalizedMessage.providerPayload).not.toBe(providerPayload);
		expect(message.providerPayload).toBe(providerPayload);

		const wire = buildResponsesInput({
			model,
			context: { messages },
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		const serializedWire = JSON.stringify(wire);
		expect(serializedWire).toContain("input_image");
		expect(serializedWire).not.toContain("image/webp");
		expect(serializedWire).not.toContain(webp);
	});

	test("replaces an undecodable historical WebP with an omission note", async () => {
		const corrupt = {
			type: "image" as const,
			data: Buffer.from("RIFF0000WEBPbad-history").toBase64(),
			mimeType: "image/webp",
		};
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "read-corrupt",
				toolName: "read",
				content: [corrupt],
				isError: false,
				timestamp: 1,
			},
		];

		const result = await normalizeModelContextMessages(messages, buildStbVisionModel("managed-primary"));
		const resultMessage = result[0]!;
		expect(resultMessage.role).toBe("toolResult");
		if (resultMessage.role !== "toolResult") throw new Error("Expected tool result message");

		expect(resultMessage.content).toEqual([
			{ type: "text", text: "[image omitted: WebP could not be decoded for this model]" },
		]);
		expect(messages[0]!.content[0]).toBe(corrupt);
	});

	test("normalizes persisted WebP blocks with malformed MIME metadata", async () => {
		for (const mimeType of [undefined, null, 42]) {
			const malformedImage = {
				type: "image",
				data: Buffer.from("RIFF0000WEBPbad-persisted-image").toBase64(),
				...(mimeType === undefined ? {} : { mimeType }),
			};
			const messages = [
				{
					role: "toolResult",
					toolCallId: "read-malformed",
					toolName: "read",
					content: [malformedImage],
					isError: false,
					timestamp: 1,
				},
			] as unknown as Message[];

			const result = await normalizeModelContextMessages(messages, buildStbVisionModel("managed-primary"));
			const resultMessage = result[0]!;
			expect(resultMessage.role).toBe("toolResult");
			if (resultMessage.role !== "toolResult") throw new Error("Expected tool result message");
			expect(resultMessage.content).toEqual([
				{ type: "text", text: "[image omitted: WebP could not be decoded for this model]" },
			]);
		}
	});

	test("does not throw on persisted image blocks with malformed data", async () => {
		for (const data of [undefined, null, 42]) {
			const malformedImage = {
				type: "image",
				mimeType: "image/webp",
				...(data === undefined ? {} : { data }),
			};
			const messages = [
				{
					role: "toolResult",
					toolCallId: "read-malformed-data",
					toolName: "read",
					content: [malformedImage],
					isError: false,
					timestamp: 1,
				},
			] as unknown as Message[];

			const result = await normalizeModelContextMessages(messages, buildStbVisionModel("managed-primary"));
			expect(result).toBe(messages);
			expect((result[0]!.content as unknown[])[0]).toBe(malformedImage);
		}
	});
});
