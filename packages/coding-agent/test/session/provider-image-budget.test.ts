import { describe, expect, it } from "bun:test";
import type { Context, ImageContent, ModelSpec, TextContent } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { decorateContextImages } from "@oh-my-pi/pi-coding-agent/blob-broker/context-images";
import {
	clampProviderContextImageBytes,
	clampProviderContextImages,
} from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";

const UMANS_MODEL = buildModel({
	id: "umans-glm-5.2",
	name: "umans-glm-5.2",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const OPENAI_RESPONSES_MODEL = buildModel({
	id: "gpt-5.2",
	name: "gpt-5.2",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

const ANTHROPIC_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-test",
	name: "claude-test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 4096,
};
const ANTHROPIC_MODEL = buildModel(ANTHROPIC_SPEC);
const ANTHROPIC_PROXY_MODEL = buildModel({ ...ANTHROPIC_SPEC, baseUrl: "https://anthropic-proxy.example.com" });
// A base64 character occupies one byte in Anthropic's JSON request body.
const HALF_ANTHROPIC_IMAGE_BUDGET = "A".repeat(12_000_000);

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

function textData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			data.push(message.content);
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") data.push(part.text);
		}
	}
	return data;
}

function screenshotContext(count: number, data: (index: number) => string): Context {
	return {
		systemPrompt: [],
		tools: [],
		messages: Array.from({ length: count }, (_, index) => ({
			role: "toolResult",
			toolCallId: `call-${index}`,
			toolName: "screenshot",
			content: [text(`result-${index}`), image(data(index))],
			isError: false,
			timestamp: index,
		})),
	};
}

describe("provider context image budgets", () => {
	it("drops oldest images above the active provider cap while preserving text", () => {
		const context: Context = {
			systemPrompt: ["system"],
			tools: [],
			messages: Array.from({ length: 31 }, (_, index) => ({
				role: "user",
				content: [text(`text-${index}`), image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 21}`));
		expect(textData(clamped)).toEqual(Array.from({ length: 31 }, (_, index) => `text-${index}`));
		expect(clamped).not.toBe(context);
		expect(imageData(context)).toEqual(Array.from({ length: 31 }, (_, index) => `image-${index}`));
	});

	it("keeps image-only tool results meaningful when every image block is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [image(`image-${index}`)],
				isError: false,
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const firstMessage = clamped.messages[0];

		// One image over UMANS' 10 evicts a whole step of ceil(10 / 4) = 3.
		expect(imageData(clamped)).toEqual(Array.from({ length: 8 }, (_, index) => `image-${index + 3}`));
		expect(firstMessage?.role).toBe("toolResult");
		expect(firstMessage?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("invalidates native replay payloads when user or developer images are clamped", () => {
		const userPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "user-native" }] }],
		};
		const developerPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "developer", content: [{ type: "input_image", image_url: "dev-native" }] }],
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [image("user-image")], providerPayload: userPayload, timestamp: 0 },
				{ role: "developer", content: [image("developer-image")], providerPayload: developerPayload, timestamp: 1 },
				...Array.from({ length: 10 }, (_, index) => ({
					role: "user" as const,
					content: [image(`kept-image-${index}`)],
					timestamp: index + 2,
				})),
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const clampedUser = clamped.messages[0];
		const clampedDeveloper = clamped.messages[1];
		const originalUser = context.messages[0];
		const originalDeveloper = context.messages[1];

		expect(clampedUser?.role).toBe("user");
		expect(clampedDeveloper?.role).toBe("developer");
		if (
			clampedUser?.role !== "user" ||
			clampedDeveloper?.role !== "developer" ||
			originalUser?.role !== "user" ||
			originalDeveloper?.role !== "developer"
		) {
			throw new Error("Expected clamped user and developer messages");
		}
		expect(clampedUser.providerPayload).toBeUndefined();
		expect(clampedDeveloper.providerPayload).toBeUndefined();
		expect(originalUser.providerPayload).toBe(userPayload);
		expect(originalDeveloper.providerPayload).toBe(developerPayload);
		expect(imageData(clamped)).toEqual(Array.from({ length: 9 }, (_, index) => `kept-image-${index + 1}`));
	});

	it("does not charge assistant images against the budget user and tool result images pay", () => {
		// OpenAI budgets 200 input images per request. A Responses turn that ran
		// the image generation tool carries one `ImageContent` per
		// `image_generation_call`, and none of those are re-read as input images
		// on the next turn, so they must not consume the budget.
		const generated = Array.from({ length: 202 }, (_, index) => image(`generated-${index}`));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("draw 202 of them"), image("user-image")], timestamp: 0 },
				{
					role: "assistant",
					content: [text("here they are"), ...generated],
					api: "openai-responses",
					provider: "openai",
					model: OPENAI_RESPONSES_MODEL.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "screenshot",
					content: [image("tool-image")],
					isError: false,
					timestamp: 2,
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_RESPONSES_MODEL);

		// 204 images total, 2 of them inputs. The clamp must leave both inputs in
		// place instead of evicting them to pay for 202 model outputs.
		expect(imageData(clamped)).toEqual(["user-image", ...generated.map(part => part.data), "tool-image"]);
		expect(clamped.messages[0]).toBe(context.messages[0]);
		expect(clamped.messages[2]).toBe(context.messages[2]);
	});

	it("still clamps user and tool result images that genuinely exceed the cap", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("all of these"), ...Array.from({ length: 202 }, (_, index) => image(`input-${index}`))],
					timestamp: 0,
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_RESPONSES_MODEL);

		// Two over OpenAI's 200 rounds up to one eviction step of 50.
		expect(imageData(clamped)).toEqual(Array.from({ length: 152 }, (_, index) => `input-${index + 50}`));
	});

	it("keeps the evicted prefix identical while new images arrive within one eviction step", () => {
		// Anthropic budgets 90 images, so evictions advance in steps of 23.
		const sent = (count: number) =>
			clampProviderContextImages(
				screenshotContext(count, index => `image-${index}`),
				ANTHROPIC_MODEL,
			).messages;

		for (let count = 92; count <= 113; count++) {
			// Every earlier message goes out byte-identical; only the new tail is appended.
			expect(sent(count).slice(0, count - 1)).toEqual(sent(count - 1));
		}
		expect(imageData({ systemPrompt: [], tools: [], messages: sent(113) })[0]).toBe("image-23");
		// Crossing the step moves the boundary once, by a whole step.
		expect(sent(114)[23]).not.toEqual(sent(113)[23]);
		expect(imageData({ systemPrompt: [], tools: [], messages: sent(114) })[0]).toBe("image-46");
	});

	it("retains exactly the configured inline byte budget, then drops oldest images without mutating the context", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("old"), image(HALF_ANTHROPIC_IMAGE_BUDGET)],
					providerPayload: {
						type: "openaiResponsesHistory",
						items: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "native" }] }],
					},
					timestamp: 0,
				},
				{ role: "developer", content: [text("middle"), image(HALF_ANTHROPIC_IMAGE_BUDGET)], timestamp: 1 },
			],
		};
		expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);

		const overBudget: Context = {
			...context,
			messages: [...context.messages, { role: "user", content: [text("new"), image("AAAA")], timestamp: 2 }],
		};
		const clamped = clampProviderContextImageBytes(overBudget, ANTHROPIC_MODEL);
		expect(clamped).not.toBe(overBudget);
		expect(clamped.messages[0]).toEqual({ role: "user", content: [text("old")], timestamp: 0 });
		expect(clamped.messages[1]).toBe(overBudget.messages[1]);
		expect(clamped.messages[2]).toBe(overBudget.messages[2]);
		expect(imageData(clamped)).toEqual([HALF_ANTHROPIC_IMAGE_BUDGET, "AAAA"]);
		expect(textData(clamped)).toEqual(["old", "middle", "new"]);
		expect(imageData(overBudget)).toHaveLength(3);
		expect(overBudget.messages[0]).toBe(context.messages[0]);
	});

	it("removes oldest live screenshots before Anthropic's 32 MB request cap", () => {
		const screenshot = "A".repeat(534_000);
		const context = screenshotContext(62, () => screenshot);
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		const keptImages = imageData(clamped);
		// 9.1 MB over the 24 MB budget rounds up to two 6 MB eviction steps.
		expect(keptImages).toHaveLength(39);
		expect(keptImages.reduce((size, data) => size + data.length, 0)).toBe(20_826_000);
		expect(clamped.messages.slice(0, 23).every(message => message.content.length === 1)).toBe(true);
		expect(clamped.messages.slice(23).every(message => message.content.length === 2)).toBe(true);
		expect(textData(clamped)).toEqual(Array.from({ length: 62 }, (_, index) => `result-${index}`));
		expect(imageData(context)).toHaveLength(62);
	});

	it("keeps the byte-evicted prefix identical while new screenshots arrive within one eviction step", () => {
		const sent = (count: number) =>
			clampProviderContextImageBytes(
				screenshotContext(count, index => `${index}`.padEnd(534_000, "A")),
				ANTHROPIC_MODEL,
			).messages;

		// 57..67 screenshots exceed the 24 MB budget by 6–12 MB: one fixed 12 MB eviction.
		for (let count = 58; count <= 67; count++) {
			const messages = sent(count);
			expect(messages.slice(0, count - 1)).toEqual(sent(count - 1));
			expect(imageData({ systemPrompt: [], tools: [], messages })[0]).toBe("23".padEnd(534_000, "A"));
		}
	});

	it("removes an oversized single tool image but keeps its tool result meaningful", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "screenshot",
					content: [image("A".repeat(24_000_004))],
					isError: false,
					timestamp: 0,
				},
			],
		};
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
		expect(imageData(context)).toHaveLength(1);
	});

	it("leaves an omission marker when an oversized image-only prompt is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [image("A".repeat(28_000_000))], timestamp: 0 }],
		};
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("does not charge URL or Anthropic file references for inline bytes", () => {
		const referenceData = "A".repeat(25_000_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [
						{ ...image(referenceData), url: "https://example.com/picture.png" },
						{ ...image(referenceData), providerFile: { provider: "anthropic", id: "file_123" } },
					],
					timestamp: 0,
				},
			],
		};
		expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);
	});

	it("keeps older external references while removing later inline bytes, but still counts references", () => {
		const reference = { ...image(""), url: "https://example.com/old.png" };
		const oversized = image("A".repeat(24_000_004));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("old"), reference], timestamp: 0 },
				{ role: "user", content: [text("new"), oversized], timestamp: 1 },
			],
		};
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		expect(clamped.messages[0]).toBe(context.messages[0]);
		expect(clamped.messages[1]?.content).toEqual([text("new")]);
		expect(textData(clamped)).toEqual(["old", "new"]);
		expect(imageData(clamped)).toEqual([""]);
		expect(imageData(context)).toEqual(["", oversized.data]);

		const countLimited: Context = {
			...context,
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "user",
				content: [text(`ref-${index}`), { ...reference, url: `https://example.com/${index}.png` }],
				timestamp: index,
			})),
		};
		const countClamped = clampProviderContextImages(countLimited, UMANS_MODEL);
		expect(countClamped.messages[0]?.content).toEqual([text("ref-0")]);
		expect(imageData(countClamped)).toHaveLength(8);
		expect(textData(countClamped)).toEqual(Array.from({ length: 11 }, (_, index) => `ref-${index}`));
	});

	it("does not charge assistant output images against the inline byte budget", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [image(HALF_ANTHROPIC_IMAGE_BUDGET), image(HALF_ANTHROPIC_IMAGE_BUDGET)],
					api: "anthropic-messages",
					provider: "anthropic",
					model: ANTHROPIC_MODEL.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
				{ role: "user", content: [text("look"), image("AAAA")], timestamp: 1 },
			],
		};
		expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);
	});

	it("does not apply Anthropic's byte policy to other providers, proxies, APIs, or text-only models", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [image(HALF_ANTHROPIC_IMAGE_BUDGET), image(HALF_ANTHROPIC_IMAGE_BUDGET), image("AAAA")],
					timestamp: 0,
				},
			],
		};
		expect(clampProviderContextImageBytes(context, UMANS_MODEL)).toBe(context);
		expect(clampProviderContextImageBytes(context, ANTHROPIC_PROXY_MODEL)).toBe(context);
		expect(clampProviderContextImageBytes(context, { ...ANTHROPIC_MODEL, api: "openai-responses" })).toBe(context);
		expect(clampProviderContextImageBytes(context, { ...ANTHROPIC_MODEL, input: ["text"] })).toBe(context);
	});

	it("keeps images that URL decoration moved off the inline wire", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 62 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [image("A".repeat(534_000))],
				isError: false,
				timestamp: index,
			})),
		};
		const decorated = decorateContextImages(context, () => "https://images.example/frame.png");

		expect(imageData(clampProviderContextImageBytes(context, ANTHROPIC_MODEL))).toHaveLength(39);
		expect(clampProviderContextImageBytes(decorated, ANTHROPIC_MODEL)).toBe(decorated);
	});

	it("preserves context identity when the provider cap is not exceeded", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("ok"), ...Array.from({ length: 10 }, (_, index) => image(`image-${index}`))],
					timestamp: 1,
				},
			],
		};

		expect(clampProviderContextImages(context, UMANS_MODEL)).toBe(context);
	});
});
