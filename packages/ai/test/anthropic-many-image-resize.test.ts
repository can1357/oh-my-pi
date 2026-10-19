import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, ImageContent, Model, TextContent, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function makeAnthropicModel(compat?: { maxImageDimension?: number }): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		compat,
	});
}

const model = makeAnthropicModel();

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type AnthropicImageSourceWire =
	| { type: "base64"; media_type: string; data: string }
	| { type: "url"; url: string }
	| { type: "file"; file_id: string };

type AnthropicImageBlock = {
	type: "image";
	source: AnthropicImageSourceWire;
};

type AnthropicBase64ImageBlock = AnthropicImageBlock & {
	source: Extract<AnthropicImageSourceWire, { type: "base64" }>;
};

type AnthropicToolResultBlock = {
	type: "tool_result";
	content: Array<TextContent | AnthropicImageBlock> | string;
};

type AnthropicPayload = {
	messages: Array<{
		role: string;
		content: string | Array<Record<string, unknown>>;
	}>;
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

async function makeRedPng(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toString("base64");
}

function makeToolResultContext(images: ImageContent[]): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		content: [{ type: "toolCall", id: "toolu_test", name: "plot", arguments: {} }],
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 2,
	};
	return {
		messages: [
			{ role: "user", content: "Render plots.", timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "toolu_test",
				toolName: "plot",
				content: [{ type: "text", text: "plots" }, ...images],
				isError: false,
				timestamp: 3,
			},
		],
	};
}

function capturePayload(
	context: Context,
	requestModel: Model<"anthropic-messages"> = model,
): Promise<AnthropicPayload> {
	const { promise, resolve } = Promise.withResolvers<AnthropicPayload>();
	void streamAnthropic(requestModel, context, {
		apiKey: "sk-ant-test",
		isOAuth: false,
		signal: abortedSignal(),
		onPayload: payload => {
			resolve(payload as AnthropicPayload);
			return undefined;
		},
	});
	return promise;
}

function isAnthropicImageBlock(value: unknown): value is AnthropicBase64ImageBlock {
	if (!value || typeof value !== "object") return false;
	const block = value as Record<string, unknown>;
	if (block.type !== "image") return false;
	const source = block.source;
	return Boolean(
		source &&
		typeof source === "object" &&
		(source as Record<string, unknown>).type === "base64" &&
		typeof (source as Record<string, unknown>).data === "string",
	);
}

function extractToolResultBlocks(payload: AnthropicPayload): Array<TextContent | AnthropicImageBlock> {
	const lastMessage = payload.messages.at(-1);
	expect(lastMessage).toBeDefined();
	expect(Array.isArray(lastMessage?.content)).toBe(true);
	const content = lastMessage?.content;
	if (!Array.isArray(content)) throw new Error("Expected final Anthropic message content array");
	const toolResult = content.find(block => block.type === "tool_result") as AnthropicToolResultBlock | undefined;
	expect(toolResult).toBeDefined();
	if (!toolResult || !Array.isArray(toolResult.content))
		throw new Error("Expected Anthropic tool_result content array");
	return toolResult.content;
}

function extractToolResultImages(payload: AnthropicPayload): AnthropicBase64ImageBlock[] {
	return extractToolResultBlocks(payload).filter(isAnthropicImageBlock);
}

describe("Anthropic many-image payload resizing", () => {
	it("downscales oversized tool-result images when the request crosses the many-image threshold", async () => {
		const largeData = await makeRedPng(2400, 1200);
		const largeImage: ImageContent = { type: "image", data: largeData, mimeType: "image/png" };
		const smallImage: ImageContent = { type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const context = makeToolResultContext([largeImage, ...Array.from({ length: 20 }, () => smallImage)]);

		const payload = await capturePayload(context);

		const images = extractToolResultImages(payload);
		expect(images).toHaveLength(21);
		expect(images[0].source.data).not.toBe(largeData);
		expect(images[1].source.data).toBe(RED_1X1_PNG_BASE64);
		expect(largeImage.data).toBe(largeData);

		const { width, height } = await new Bun.Image(Buffer.from(images[0].source.data, "base64")).metadata();
		expect(width).toBeLessThanOrEqual(2000);
		expect(height).toBeLessThanOrEqual(2000);
	});

	it("clamps a single image past Anthropic's hard 8000px limit", async () => {
		// Reproduces the 400 "At least one of the image dimensions exceed max
		// allowed size: 8000 pixels" from a full-page screenshot tool result.
		const tallData = await makeRedPng(1440, 8570);
		const tallImage: ImageContent = { type: "image", data: tallData, mimeType: "image/png" };
		const context = makeToolResultContext([tallImage]);

		const payload = await capturePayload(context);

		const images = extractToolResultImages(payload);
		expect(images).toHaveLength(1);
		expect(images[0].source.data).not.toBe(tallData);
		expect(tallImage.data).toBe(tallData);

		const { width, height } = await new Bun.Image(Buffer.from(images[0].source.data, "base64")).metadata();
		expect(height).toBe(8000);
		expect(width).toBe(1344);
	});

	it("re-encodes an image past Anthropic's 10 MB payload limit", async () => {
		// Reproduces the 400 "image exceeds 10 MB maximum: 14012300 bytes >
		// 10485760 bytes" from a dense full-page screenshot: inside the 8000px
		// cap, over the byte cap. Trailing bytes after IEND stand in for that
		// payload so the test does not spend a minute encoding noise.
		const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
		const canvas = await new Bun.Image(seed).resize(1200, 900, { filter: "nearest" }).png().bytes();
		const heavyData = Buffer.concat([Buffer.from(canvas), Buffer.alloc(8 * 1024 * 1024, 7)]).toString("base64");
		expect(heavyData.length).toBeGreaterThan(10 * 1024 * 1024);
		const heavyImage: ImageContent = { type: "image", data: heavyData, mimeType: "image/png" };
		const context = makeToolResultContext([heavyImage]);

		const payload = await capturePayload(context);

		const images = extractToolResultImages(payload);
		expect(images).toHaveLength(1);
		expect(images[0].source.data.length).toBeLessThanOrEqual(9 * 1024 * 1024);
		expect(heavyImage.data).toBe(heavyData);

		// Only the payload was over the limit, so the pixels survive intact.
		const { width, height } = await new Bun.Image(Buffer.from(images[0].source.data, "base64")).metadata();
		expect(width).toBe(1200);
		expect(height).toBe(900);
	});

	it("leaves images within the hard limit untouched below the many-image threshold", async () => {
		const largeData = await makeRedPng(2400, 1200);
		const largeImage: ImageContent = { type: "image", data: largeData, mimeType: "image/png" };
		const smallImage: ImageContent = { type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const context = makeToolResultContext([largeImage, ...Array.from({ length: 19 }, () => smallImage)]);

		const payload = await capturePayload(context);

		const images = extractToolResultImages(payload);
		expect(images).toHaveLength(20);
		expect(images[0].source.data).toBe(largeData);
	});

	it("clamps referenced images and drops the reference when the bytes change", async () => {
		// Anthropic fetches a URL mirror or file reference and then validates the
		// image, so an oversized referenced block 400s exactly like inline bytes.
		// Narrow on purpose: the assertion is the height clamp, and two
		// full-height encoder passes per image are the slow part of this file.
		const tallData = await makeRedPng(240, 8570);
		const mirrored: ImageContent = {
			type: "image",
			data: tallData,
			mimeType: "image/png",
			url: "https://blobs.test/tall.png",
		};
		const referenced: ImageContent = {
			type: "image",
			data: tallData,
			mimeType: "image/png",
			providerFile: { provider: "anthropic", id: "file_tall" },
		};

		const payload = await capturePayload(makeToolResultContext([mirrored, referenced]));

		const images = extractToolResultImages(payload);
		expect(images).toHaveLength(2);
		for (const image of images) {
			expect(image.source.data).not.toBe(tallData);
			const { height } = await new Bun.Image(Buffer.from(image.source.data, "base64")).metadata();
			expect(height).toBe(8000);
		}
		expect(mirrored.url).toBe("https://blobs.test/tall.png");
		expect(referenced.providerFile?.id).toBe("file_tall");
	});

	it("keeps the reference on a referenced image already inside the caps", async () => {
		const smallImage: ImageContent = {
			type: "image",
			data: RED_1X1_PNG_BASE64,
			mimeType: "image/png",
			url: "https://blobs.test/small.png",
		};

		const payload = await capturePayload(makeToolResultContext([smallImage]));

		const sources = extractToolResultBlocks(payload)
			.filter((block): block is AnthropicImageBlock => block.type === "image")
			.map(block => block.source);
		expect(sources).toEqual([{ type: "url", url: "https://blobs.test/small.png" }]);
	});

	it("clamps to a host image-dimension policy tighter than the API default", async () => {
		// The cap is resolved model policy (`max-image-dimension`), so a
		// deployment whose image contract differs from the canonical Anthropic
		// API overrides it instead of inheriting 8000px.
		const tightModel = makeAnthropicModel({ maxImageDimension: 4000 });
		expect(tightModel.compat.maxImageDimension).toBe(4000);
		const tallData = await makeRedPng(1440, 8570);
		const tallImage: ImageContent = { type: "image", data: tallData, mimeType: "image/png" };

		const payload = await capturePayload(makeToolResultContext([tallImage]), tightModel);

		const images = extractToolResultImages(payload);
		expect(images).toHaveLength(1);
		const { width, height } = await new Bun.Image(Buffer.from(images[0].source.data, "base64")).metadata();
		expect(height).toBe(4000);
		expect(width).toBe(672);
	});
});
