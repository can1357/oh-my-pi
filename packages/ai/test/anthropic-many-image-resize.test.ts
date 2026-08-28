import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, ImageContent, Model, TextContent, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const model: Model<"anthropic-messages"> = buildModel({
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
});

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type AnthropicImageBlock = {
	type: "image";
	source: { type: "base64"; media_type: string; data: string };
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

function capturePayload(context: Context): Promise<AnthropicPayload> {
	const { promise, resolve } = Promise.withResolvers<AnthropicPayload>();
	void streamAnthropic(model, context, {
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

function isAnthropicImageBlock(value: unknown): value is AnthropicImageBlock {
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

function extractToolResultImages(payload: AnthropicPayload): AnthropicImageBlock[] {
	const lastMessage = payload.messages.at(-1);
	expect(lastMessage).toBeDefined();
	expect(Array.isArray(lastMessage?.content)).toBe(true);
	const content = lastMessage?.content;
	if (!Array.isArray(content)) throw new Error("Expected final Anthropic message content array");
	const toolResult = content.find(block => block.type === "tool_result") as AnthropicToolResultBlock | undefined;
	expect(toolResult).toBeDefined();
	if (!toolResult || !Array.isArray(toolResult.content))
		throw new Error("Expected Anthropic tool_result content array");
	return toolResult.content.filter(isAnthropicImageBlock);
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

	it("leaves oversized images untouched below the many-image threshold", async () => {
		const largeData = await makeRedPng(2400, 1200);
		const largeImage: ImageContent = { type: "image", data: largeData, mimeType: "image/png" };
		const smallImage: ImageContent = { type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const context = makeToolResultContext([largeImage, ...Array.from({ length: 19 }, () => smallImage)]);

		const payload = await capturePayload(context);

		const images = extractToolResultImages(payload);
		expect(images).toHaveLength(20);
		expect(images[0].source.data).toBe(largeData);
	});
});
