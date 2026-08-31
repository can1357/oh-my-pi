import { afterEach, describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { clampProviderContextImages } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import { configureProviderImageBudgets, configureProviderImageByteBudgets } from "@oh-my-pi/snapcompact";

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

const CODEX_GATEWAY_MODEL = buildModel({
	id: "probe-vision",
	name: "probe-vision",
	api: "openai-codex-responses",
	provider: "codex-gateway",
	baseUrl: "https://gateway.invalid",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function assistantImage(data: string): AssistantMessage {
	return {
		role: "assistant",
		content: [image(data)],
		api: "anthropic-messages",
		provider: "umans",
		model: "umans-glm-5.2",
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
	};
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

function nativeItem(id: string, imageUrls: string[]): Record<string, unknown> {
	return {
		id,
		type: "message",
		role: "user",
		content: [
			{ type: "input_text", text: `note-${id}` },
			...imageUrls.map(url => ({ type: "input_image", image_url: url })),
		],
	};
}

function nativeParts(context: Context): Array<{ type: string; text?: string; image_url?: string }> {
	const parts: Array<{ type: string; text?: string; image_url?: string }> = [];
	for (const message of context.messages) {
		const payload = "providerPayload" in message ? message.providerPayload : undefined;
		if (payload?.type !== "openaiResponsesHistory") continue;
		for (const item of payload.items) {
			if (!Array.isArray(item.content)) continue;
			parts.push(...(item.content as Array<{ type: string; text?: string; image_url?: string }>));
		}
	}
	return parts;
}

function nativeImageUrls(context: Context): string[] {
	return nativeParts(context)
		.filter(part => part.type === "input_image")
		.map(part => part.image_url ?? "");
}

function dataUri(fill: string, length: number): string {
	return `data:image/png;base64,${fill.repeat(length)}`;
}

describe("provider context image budgets", () => {
	afterEach(() => {
		configureProviderImageBudgets(undefined);
		configureProviderImageByteBudgets(undefined);
	});

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
				toolName: "inspect_image",
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

	it("keeps image-only user and developer turns on the wire when every image is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				// Submitting images with no prompt still emits a text block, empty.
				{ role: "user", content: [text(""), image("user-image")], timestamp: 0 },
				{ role: "developer", content: [image("developer-image")], timestamp: 1 },
				{ role: "user", content: [text("and now?")], timestamp: 2 },
			],
		};
		configureProviderImageByteBudgets({ umans: 1 });

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual([]);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
		expect(clamped.messages[1]?.content).toEqual([text("[image omitted: provider image limit]")]);
		expect(clamped.messages[2]).toBe(context.messages[2]);
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

	it("drops oldest images until the configured byte budget fits", () => {
		configureProviderImageByteBudgets({ umans: 2500 });
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 4 }, (_, index) => ({
				role: "user",
				content: [text(`text-${index}`), image(`${index}`.repeat(1000))],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual(["2".repeat(1000), "3".repeat(1000)]);
		expect(textData(clamped)).toEqual(["text-0", "text-1", "text-2", "text-3"]);
	});

	it("charges retained assistant image bytes against the byte budget", () => {
		configureProviderImageByteBudgets({ umans: 2500 });
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				assistantImage("a".repeat(2000)),
				{ role: "user", content: [text("first"), image("b".repeat(1000))], timestamp: 1 },
				{ role: "user", content: [text("second"), image("c".repeat(1000))], timestamp: 2 },
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual(["a".repeat(2000)]);
		expect(clamped.messages[0]).toBe(context.messages[0]);
		expect(textData(clamped)).toEqual(["first", "second"]);
	});

	it("stops at the retained assistant images when the byte budget cannot be met", () => {
		configureProviderImageByteBudgets({ umans: 1500 });
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				assistantImage("a".repeat(2000)),
				{ role: "user", content: [text("only"), image("b".repeat(1000))], timestamp: 1 },
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual(["a".repeat(2000)]);
		expect(clamped.messages[0]).toBe(context.messages[0]);
		expect(textData(clamped)).toEqual(["only"]);
	});

	it("preserves context identity when the byte budget is not exceeded", () => {
		configureProviderImageByteBudgets({ umans: 1_000_000 });
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

	it("counts replayed native images that never reach the generic content view", () => {
		configureProviderImageBudgets({ "codex-gateway": 2 });
		const olderPayload = {
			type: "openaiResponsesHistory" as const,
			items: [nativeItem("older", [dataUri("a", 8), dataUri("b", 8)])],
		};
		const newerPayload = {
			type: "openaiResponsesHistory" as const,
			items: [nativeItem("newer", [dataUri("c", 8), dataUri("d", 8)])],
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			// The Responses server keeps only text in `content`; the images ride on the payload.
			messages: [
				{ role: "user", content: [text("older turn")], providerPayload: olderPayload, timestamp: 0 },
				{ role: "user", content: [text("newer turn")], providerPayload: newerPayload, timestamp: 1 },
			],
		};

		const clamped = clampProviderContextImages(context, CODEX_GATEWAY_MODEL);

		expect(nativeImageUrls(clamped)).toEqual([dataUri("c", 8), dataUri("d", 8)]);
		expect(nativeParts(clamped).filter(part => part.text === "[image omitted: provider image limit]")).toHaveLength(
			2,
		);
		// The item keeps its id and its own text, and the untouched turn keeps identity.
		const older = clamped.messages[0];
		const olderItems =
			older && "providerPayload" in older && older.providerPayload?.type === "openaiResponsesHistory"
				? older.providerPayload.items
				: [];
		expect(olderItems[0]?.id).toBe("older");
		expect(older?.content).toBe(context.messages[0]?.content);
		expect(clamped.messages[1]).toBe(context.messages[1]);
		expect(nativeImageUrls(context)).toHaveLength(4);
	});

	it("charges replayed native image bytes against the byte budget", () => {
		configureProviderImageByteBudgets({ "codex-gateway": 2500 });
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("three images")],
					providerPayload: {
						type: "openaiResponsesHistory" as const,
						items: [nativeItem("only", [dataUri("a", 1000), dataUri("b", 1000), dataUri("c", 1000)])],
					},
					timestamp: 0,
				},
			],
		};

		const clamped = clampProviderContextImages(context, CODEX_GATEWAY_MODEL);

		expect(nativeImageUrls(clamped)).toEqual([dataUri("b", 1000), dataUri("c", 1000)]);
	});

	it("leaves replayed native images alone on a provider that sends the generic content view", () => {
		configureProviderImageBudgets({ umans: 1 });
		const payload = {
			type: "openaiResponsesHistory" as const,
			items: [nativeItem("stale", [dataUri("a", 8), dataUri("b", 8)])],
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [text("only text")], providerPayload: payload, timestamp: 0 }],
		};

		expect(clampProviderContextImages(context, UMANS_MODEL)).toBe(context);
	});
});
