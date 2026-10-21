import { describe, expect, it } from "bun:test";
import type { Context, ImageContent, ModelSpec, TextContent } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { factoryDroidWireBaseUrl } from "@oh-my-pi/pi-catalog/wire/factory-droid";
import { decorateContextImages } from "@oh-my-pi/pi-coding-agent/blob-broker/context-images";
import {
	capArchiveFrameBytes,
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
const CODEX_MODEL = getBundledModel("openai-codex", "gpt-6.1-sol");
const CODEX_PROXY_MODEL = buildModel({
	...toModelSpec(CODEX_MODEL),
	baseUrl: "https://codex-proxy.example/backend-api",
});
const ANTIGRAVITY_CLAUDE_MODEL = getBundledModel("google-antigravity", "claude-sonnet-4-6");
const ANTIGRAVITY_GEMINI_MODEL = getBundledModel("google-antigravity", "gemini-3.7-flash");
const XAI_MODEL = getBundledModel("xai", "grok-4.7");
const XAI_OAUTH_MODEL = getBundledModel("xai-oauth", "grok-4.7");
const CURSOR_CLAUDE_MODEL = getBundledModel("cursor", "claude-opus-5-high");
const CURSOR_GPT_MODEL = getBundledModel("cursor", "gpt-5.5");
const CURSOR_DEFAULT_MODEL = getBundledModel("cursor", "default");

function factoryDroidModel(baseUrl: string) {
	return buildModel({
		id: "claude-haiku-4-5-20251001",
		name: "Haiku 4.5",
		api: "factory-droid-agent",
		provider: "factory-droid",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}
// Factory's hosted HTTP routes refuse request bodies over 4,500,000 bytes (HTTP 413).
const FACTORY_DROID_ROUTE_BODY_LIMIT = 4_500_000;
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

	it.each([
		["the official Anthropic API", ANTHROPIC_MODEL, 600],
		["an Anthropic proxy", ANTHROPIC_PROXY_MODEL, 90],
		["the official Codex backend", CODEX_MODEL, 2000],
		["a Codex proxy", CODEX_PROXY_MODEL, 200],
		["Claude on Antigravity", ANTIGRAVITY_CLAUDE_MODEL, 20],
		["Gemini on Antigravity", ANTIGRAVITY_GEMINI_MODEL, 60],
		["xAI", XAI_MODEL, 60],
		["xAI OAuth", XAI_OAUTH_MODEL, 60],
		["Claude on Cursor", CURSOR_CLAUDE_MODEL, 20],
		["GPT on Cursor", CURSOR_GPT_MODEL, 60],
		["Cursor's default route", CURSOR_DEFAULT_MODEL, 20],
	] as const)("keeps the newest images up to the count %s allows", (_label, model, budget) => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: budget + 1 }, (_, index) => ({
				role: "user",
				content: [image(`image-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, model);

		expect(imageData(clamped)).toEqual(Array.from({ length: budget }, (_, index) => `image-${index + 1}`));
	});

	it.each([
		// Claude's upstream message limit on Antigravity; Gemini there took 64 MB.
		["Claude on Antigravity", ANTIGRAVITY_CLAUDE_MODEL, 30_000_000],
		["Gemini on Antigravity", ANTIGRAVITY_GEMINI_MODEL, 64_000_000],
		// api.x.ai rejects a body over 50 MiB.
		["xAI", XAI_MODEL, 52_428_800],
		["xAI OAuth", XAI_OAUTH_MODEL, 52_428_800],
		// Cursor took a 64 MB body for both upstreams.
		["Claude on Cursor", CURSOR_CLAUDE_MODEL, 64_000_000],
		["GPT on Cursor", CURSOR_GPT_MODEL, 64_000_000],
	] as const)(
		"keeps %s under its measured body limit at omp's 500 KiB image resize target",
		(_label, model, bodyLimit) => {
			// No byte budget applies on these hosts, so the count alone bounds the
			// inline bytes of resized screenshots (`images.autoResize`, on by default).
			const resized = image("A".repeat(Math.ceil((500 * 1024) / 3) * 4));
			const context: Context = {
				systemPrompt: [],
				tools: [],
				messages: Array.from({ length: 1_000 }, (_, index) => ({
					role: "user",
					content: [resized],
					timestamp: index,
				})),
			};

			const kept = imageData(clampProviderContextImages(context, model));

			expect(clampProviderContextImageBytes(context, model)).toBe(context);
			expect(kept.length).toBeGreaterThan(5);
			expect(kept.reduce((bytes, data) => bytes + data.length, 0)).toBeLessThan(bodyLimit);
		},
	);

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

		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `image-${index + 1}`));
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
		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `kept-image-${index}`));
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

		expect(imageData(clamped)).toEqual(Array.from({ length: 200 }, (_, index) => `input-${index + 2}`));
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
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 62 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [text(`result-${index}`), image(screenshot)],
				isError: false,
				timestamp: index,
			})),
		};
		const clamped = clampProviderContextImageBytes(context, ANTHROPIC_MODEL);
		const keptImages = imageData(clamped);
		expect(keptImages).toHaveLength(44);
		expect(keptImages.reduce((size, data) => size + data.length, 0)).toBe(23_496_000);
		expect(clamped.messages.slice(0, 18).every(message => message.content.length === 1)).toBe(true);
		expect(clamped.messages.slice(18).every(message => message.content.length === 2)).toBe(true);
		expect(textData(clamped)).toEqual(Array.from({ length: 62 }, (_, index) => `result-${index}`));
		expect(imageData(context)).toHaveLength(62);
	});

	it("keeps a Factory-hosted request's inline images under the route body limit, but not a custom gateway's", () => {
		const screenshot = "A".repeat(600_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 10 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [text(`result-${index}`), image(screenshot)],
				isError: false,
				timestamp: index,
			})),
		};
		expect(JSON.stringify(context).length).toBeGreaterThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		for (const hosted of [
			factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global")),
			factoryDroidModel(factoryDroidWireBaseUrl("openai-responses", "eu")),
		]) {
			const clamped = clampProviderContextImageBytes(context, hosted);
			const kept = imageData(clamped);
			expect(kept.length).toBeGreaterThan(0);
			expect(kept.length).toBeLessThan(10);
			// Oldest screenshots go first; the newest results keep theirs.
			expect(clamped.messages.at(-1)?.content).toHaveLength(2);
			expect(clamped.messages[0].content).toHaveLength(1);
			expect(textData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `result-${index}`));
			expect(JSON.stringify(clamped).length).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		}
		const gateway = factoryDroidModel("https://factory-gateway.example.com/api/llm/a");
		expect(clampProviderContextImageBytes(context, gateway)).toBe(context);
	});

	it("trims five 1 MB Factory screenshots, which the count cap allows, to three", () => {
		const screenshot = "A".repeat(1_000_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 5 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "screenshot",
				content: [text(`result-${index}`), image(screenshot)],
				isError: false,
				timestamp: index,
			})),
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		const counted = clampProviderContextImages(context, hosted);
		expect(imageData(counted)).toHaveLength(5);
		const clamped = clampProviderContextImageBytes(counted, hosted);
		expect(imageData(clamped)).toHaveLength(3);
		expect(clamped.messages.slice(2).every(message => message.content.length === 2)).toBe(true);
	});

	it("keeps a fresh Factory image that alone fits the route, evicting older ones instead", () => {
		const older = "B".repeat(500_000);
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("first"), image(older)], timestamp: 0 },
				{ role: "user", content: [text("second"), image(older)], timestamp: 1 },
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 2 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		const clamped = clampProviderContextImageBytes(context, hosted);
		expect(imageData(clamped)).toEqual([fresh]);
		expect(clamped.messages[2]).toBe(context.messages[2]);
		expect(textData(clamped)).toEqual(["first", "second", "look at this"]);
		expect(JSON.stringify(clamped).length).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
		// An image too large for the route on its own is still dropped.
		const oversized: Context = {
			...context,
			messages: [{ role: "user", content: [text("huge"), image("D".repeat(4_600_000))], timestamp: 0 }],
		};
		expect(imageData(clampProviderContextImageBytes(oversized, hosted))).toEqual([]);
	});

	it("keeps the fresh Factory image when it and the newest tool result's image do not fit together", () => {
		const toolImage = "B".repeat(1_000_000);
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "screenshot",
					content: [text("shot"), image(toolImage)],
					isError: false,
					timestamp: 0,
				},
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		const clamped = clampProviderContextImageBytes(context, hosted);
		expect(imageData(clamped)).toEqual([fresh]);
		expect(textData(clamped)).toEqual(["shot", "look at this"]);
	});

	it("does not protect a fresh Factory image that the request's text leaves no room for", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("x".repeat(800_000))], timestamp: 0 },
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		const clamped = clampProviderContextImageBytes(context, hosted);
		expect(imageData(clamped)).toEqual([]);
		expect(JSON.stringify(clamped).length).toBeLessThan(FACTORY_DROID_ROUTE_BODY_LIMIT);
	});

	it("reserves a Factory request's text in UTF-8 bytes, not characters", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [text("界".repeat(300_000))], timestamp: 0 },
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toEqual([]);
	});

	it("does not reserve room for assistant images no request replays", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [text("generated"), image("G".repeat(2_000_000))],
					api: "anthropic-messages",
					provider: "factory-droid",
					model: "claude-haiku-4-5-20251001",
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
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toContain(fresh);
	});

	it("does not reserve room for UI-only tool-result details", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "eval",
					content: [text("done")],
					details: { log: "d".repeat(800_000) },
					isError: false,
					timestamp: 0,
				},
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toEqual([fresh]);
	});

	it("does not reserve room for another provider's native assistant payload", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "assistant",
					content: [text("generated")],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai",
						items: [{ type: "image_generation_call", result: "G".repeat(2_000_000) }],
					},
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
					timestamp: 0,
				},
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toEqual([fresh]);
	});

	it("does not reserve room for another provider's payload on a compaction summary", () => {
		const fresh = "C".repeat(3_800_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("summary")],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: "openai-codex",
						items: [{ type: "input_image", image_url: "G".repeat(2_000_000) }],
					},
					timestamp: 0,
				},
				{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 1 },
			],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toEqual([fresh]);
	});

	it("leaves room for the request envelope added after the clamp", () => {
		// The context alone fits 4.5 MB with ~10 KB to spare, less than the provider prompt and request fields need.
		const fresh = "C".repeat(FACTORY_DROID_ROUTE_BODY_LIMIT - 10_000);
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [text("look at this"), image(fresh)], timestamp: 0 }],
		};
		const hosted = factoryDroidModel(factoryDroidWireBaseUrl("anthropic-messages", "global"));
		expect(imageData(clampProviderContextImageBytes(context, hosted))).toEqual([]);
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
		expect(imageData(countClamped)).toHaveLength(10);
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

	it.each([
		["ANTHROPIC_BASE_URL", { ANTHROPIC_BASE_URL: "https://anthropic-proxy.example/v1" }],
		[
			"Foundry's FOUNDRY_BASE_URL",
			{ CLAUDE_CODE_USE_FOUNDRY: "1", FOUNDRY_BASE_URL: "https://foundry-proxy.example" },
		],
	] as const)("does not apply Anthropic's byte policy to an official model rerouted by %s", (_, reroute) => {
		const frame = (fill: string) => image(fill.repeat(1_600_000));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("summary"), frame("A"), frame("B"), frame("C")],
					historyRewriteAt: 1,
					timestamp: 0,
				},
				{
					role: "user",
					content: [image(HALF_ANTHROPIC_IMAGE_BUDGET), image(HALF_ANTHROPIC_IMAGE_BUDGET)],
					timestamp: 1,
				},
			],
		};
		const keys = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY", "FOUNDRY_BASE_URL"] as const;
		const previous = keys.map(key => [key, Bun.env[key]] as const);
		try {
			for (const key of keys) delete Bun.env[key];
			expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).not.toBe(context);
			expect(capArchiveFrameBytes(context, ANTHROPIC_MODEL)).toBe(context);
			Object.assign(Bun.env, reroute);
			expect(clampProviderContextImageBytes(context, ANTHROPIC_MODEL)).toBe(context);
			// The proxy's 3 MB frame budget keeps only the newest frame.
			const capped = capArchiveFrameBytes(context, ANTHROPIC_MODEL);
			expect(imageData(capped)).toEqual([
				"C".repeat(1_600_000),
				HALF_ANTHROPIC_IMAGE_BUDGET,
				HALF_ANTHROPIC_IMAGE_BUDGET,
			]);
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		}
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

		expect(imageData(clampProviderContextImageBytes(context, ANTHROPIC_MODEL))).toHaveLength(44);
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

	it("caps summary archive frames at the request model's frame budget and leaves other images alone", () => {
		const frame = (fill: string) => image(fill.repeat(1_600_000));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("summary"), frame("A"), frame("B"), frame("C"), text("tail")],
					historyRewriteAt: 1,
					timestamp: 1,
				},
				{ role: "user", content: [text("screenshot"), frame("D")], timestamp: 2 },
			],
		};

		const capped = capArchiveFrameBytes(context, ANTHROPIC_PROXY_MODEL);

		expect(imageData(capped).map(data => data[0])).toEqual(["C", "D"]);
		const [summary] = capped.messages;
		if (summary?.role !== "user" || !Array.isArray(summary.content)) throw new Error("Expected the summary message");
		expect(summary.content.map(block => block.type)).toEqual(["text", "text", "image", "text"]);
		expect(textData(capped)).toContainEqual(expect.stringContaining("2 archived image frames could not be included"));
		expect(capArchiveFrameBytes(context, ANTHROPIC_MODEL)).toBe(context);
	});
});
