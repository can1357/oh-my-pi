// Contract: a tool result whose only image is well-formed but unreplayable
// (BMP/HEIC/SVG) degrades to a text placeholder, so the serializers must not
// promise an attachment that no longer exists on the wire.
import { describe, expect, it } from "bun:test";
import { convertMessages as convertGoogleMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import { convertMessages as convertCompletionsMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	ModelSpec,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const BMP_B64 = Buffer.from("424d1e00000000000000001a0000000c000000010001000100180000000000", "hex").toString("base64");
const BMP_PLACEHOLDER = "[unsupported image: image/bmp]";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolCallTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_shot", name: "screenshot", arguments: {} }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-5-chat",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: 1,
	} as AssistantMessage;
}

function screenshotResult(images: ImageContent[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_shot",
		toolName: "screenshot",
		content: images,
		isError: false,
		timestamp: 2,
	};
}

const bmpImage: ImageContent = { type: "image", data: BMP_B64, mimeType: "image/bmp" };
const pngImage: ImageContent = { type: "image", data: PNG_B64, mimeType: "image/png" };

function makeCompletionsModel(): Model<"openai-completions"> {
	return buildModel({
		id: "gpt-5-chat",
		name: "GPT-5 Chat",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	} satisfies ModelSpec<"openai-completions">);
}

function makeGoogleModel(id: string): Model<"google-generative-ai"> {
	return buildModel({
		id,
		name: id,
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	} satisfies ModelSpec<"google-generative-ai">);
}

describe("placeholder-safe tool result images", () => {
	it("openai-completions emits the placeholder as tool text without a synthetic image turn", () => {
		const model = makeCompletionsModel();
		const params = convertCompletionsMessages(
			model,
			{ messages: [toolCallTurn(), screenshotResult([bmpImage])] },
			model.compat,
		);

		const toolMessage = params.find(param => param.role === "tool");
		expect(toolMessage?.content).toBe(BMP_PLACEHOLDER);
		expect(params.some(param => param.role === "user")).toBe(false);
	});

	it("openai-completions still attaches surviving images alongside the placeholder", () => {
		const model = makeCompletionsModel();
		const params = convertCompletionsMessages(
			model,
			{ messages: [toolCallTurn(), screenshotResult([pngImage, bmpImage])] },
			model.compat,
		);

		const toolMessage = params.find(param => param.role === "tool");
		expect(toolMessage?.content).toBe(`(see attached image)\n${BMP_PLACEHOLDER}`);
		const userMessage = params.find(param => param.role === "user");
		expect(userMessage?.content).toEqual([
			{ type: "text", text: "Attached image(s) from tool result:" },
			{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
		]);
	});

	it("google emits the placeholder as function response text without an image turn", () => {
		const context: Context = { messages: [toolCallTurn(), screenshotResult([bmpImage])] };
		const contents = convertGoogleMessages(makeGoogleModel("gemini-2.5-pro"), context);

		const response = contents
			.flatMap(content => content.parts ?? [])
			.find(part => part.functionResponse !== undefined)?.functionResponse;
		expect(response?.response).toEqual({ output: BMP_PLACEHOLDER });
		expect(response?.parts).toBeUndefined();
		expect(JSON.stringify(contents)).not.toContain("Tool result image:");
	});

	it("google keeps multimodal parts for images that survive conversion", () => {
		const context: Context = { messages: [toolCallTurn(), screenshotResult([pngImage, bmpImage])] };
		const contents = convertGoogleMessages(makeGoogleModel("gemini-3-pro"), context);

		const response = contents
			.flatMap(content => content.parts ?? [])
			.find(part => part.functionResponse !== undefined)?.functionResponse;
		expect(response?.response).toEqual({ output: `(see attached image)\n${BMP_PLACEHOLDER}` });
		expect(response?.parts).toEqual([{ inlineData: { mimeType: "image/png", data: PNG_B64 } }]);
	});
});
