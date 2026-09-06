import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { clampProviderContextImages } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import { providerImageBudget, providerImageByteBudget } from "@oh-my-pi/snapcompact";

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

const ANTHROPIC_MODEL = buildModel({
	id: "claude-opus-4-8",
	name: "claude-opus-4-8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
});

/**
 * A minimal but fully typed assistant turn. Only `role` and `content` matter to
 * the clamp; the provider bookkeeping fields are required by `AssistantMessage`
 * and carry no meaning for these assertions.
 */
function assistantTurn(content: ImageContent[], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: ANTHROPIC_MODEL.api,
		provider: ANTHROPIC_MODEL.provider,
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
		timestamp,
	};
}

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

	it("drops oldest images when total image bytes exceed the provider byte budget", () => {
		const byteBudget = providerImageByteBudget("anthropic");
		const chunk = Math.ceil(byteBudget * 0.4);
		const frame = (tag: string) => image(tag + "x".repeat(chunk - 1));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [frame("0")], timestamp: 0 },
				{ role: "user", content: [frame("1")], timestamp: 1 },
				{ role: "user", content: [frame("2")], timestamp: 2 },
			],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);
		const remaining = imageData(clamped);
		const totalBytes = remaining.reduce((sum, data) => sum + data.length, 0);

		// 3 frames sit far under Anthropic's image COUNT cap (90) yet total ~1.2x
		// the byte budget; the oldest frame drops so the payload fits.
		expect(totalBytes).toBeLessThanOrEqual(byteBudget);
		expect(remaining.map(data => data[0])).toEqual(["1", "2"]);
	});

	it("still relieves byte pressure when the count cap binds at the same time", () => {
		// The case a single shared drop counter gets wrong: an old reference-backed
		// image satisfies the count cap while relieving zero bytes, so collapsing
		// the two budgets with max() drops only the reference and leaves the
		// request over the byte budget -- still a 413.
		const countBudget = providerImageBudget("anthropic");
		const byteBudget = providerImageByteBudget("anthropic");
		const referenced = { ...image("old-reference"), url: "https://images.test/old.png" };
		const oversized = image("z".repeat(byteBudget + 1));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [referenced], timestamp: 0 },
				{ role: "user", content: [oversized], timestamp: 1 },
				...Array.from({ length: countBudget - 1 }, (_, index) => ({
					role: "user" as const,
					content: [image(`small-${index}`)],
					timestamp: index + 2,
				})),
			],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);

		const survivingInlineBytes = clamped.messages
			.flatMap(message => (Array.isArray(message.content) ? message.content : []))
			.filter((part): part is ImageContent => part.type === "image" && part.url === undefined)
			.reduce((sum, part) => sum + part.data.length, 0);
		expect(survivingInlineBytes).toBeLessThanOrEqual(byteBudget);
	});

	it("counts reference-backed images toward the per-request image cap", () => {
		// The count cap is a provider limit on image PARTS, which a reference
		// consumes just like inline bytes. Counting only inline images would let a
		// context of references sail past the cap.
		const countBudget = providerImageBudget("anthropic");
		const referenced = (tag: string) => ({ ...image(tag), url: `https://images.test/${tag}.png` });
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: countBudget + 3 }, (_, index) => ({
				role: "user" as const,
				content: [referenced(`frame-${index}`)],
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);

		const remaining = clamped.messages.filter(message =>
			Array.isArray(message.content) ? message.content.some(part => part.type === "image") : false,
		).length;
		expect(remaining).toBe(countBudget);
	});

	it("drops inline images, not preceding references, when only bytes are over budget", () => {
		// A reference carries no wire bytes, so dropping it cannot relieve byte
		// pressure: the oversized inline image would survive and the request would
		// still be too large, having lost context for nothing.
		const byteBudget = providerImageByteBudget("anthropic");
		const referenced = { ...image("kept-reference"), url: "https://images.test/kept.png" };
		const oversizedInline = image("y".repeat(byteBudget + 1));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [referenced], timestamp: 0 },
				{ role: "user", content: [oversizedInline], timestamp: 1 },
			],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);

		expect(clamped.messages[0]?.content).toEqual([referenced]);
		expect(clamped.messages[1]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("ignores URL-backed images for the byte budget", () => {
		// Strictly over the limit: `imageDropCountForBytes` drops only while
		// `total > byteLimit`, so a payload of exactly the budget never drops and
		// would pass whether or not URL-backed images are excluded.
		const byteBudget = providerImageByteBudget("anthropic");
		const oversized = image("x".repeat(byteBudget + 1));
		const referenced = { ...oversized, url: "https://images.test/frame.png" };
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [referenced], timestamp: 0 }],
		};

		expect(clampProviderContextImages(context, ANTHROPIC_MODEL)).toBe(context);
	});

	it("keeps image-only user and developer turns meaningful when dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [image("user-image")], timestamp: 0 },
				{ role: "developer", content: [image("developer-image")], timestamp: 1 },
				...Array.from({ length: 10 }, (_, index) => ({
					role: "user" as const,
					content: [image(`kept-image-${index}`)],
					timestamp: index + 2,
				})),
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
		expect(clamped.messages[1]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("drops oversized tool-result images when only the byte budget is exceeded", () => {
		// The count cap is satisfied (2 images, cap 90) but the summed inline
		// bytes are ~1.2x the byte budget. A tool-result path guarded on the
		// count budget alone would leave the oversized base64 on the wire.
		const byteBudget = providerImageByteBudget("anthropic");
		const chunk = Math.ceil(byteBudget * 0.6);
		const frame = (tag: string) => image(tag + "x".repeat(chunk - 1));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-0",
					toolName: "read",
					content: [frame("0")],
					isError: false,
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [frame("1")],
					isError: false,
					timestamp: 1,
				},
			],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);
		const remaining = imageData(clamped);

		expect(remaining.reduce((sum, data) => sum + data.length, 0)).toBeLessThanOrEqual(byteBudget);
		expect(remaining.map(data => data[0])).toEqual(["1"]);
		expect(clamped.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("does not charge assistant display images against the byte budget", () => {
		// `transform-messages.ts` drops every assistant image block
		// unconditionally, so its base64 never reaches the wire. Charging it here
		// evicts a live image in its place: an old oversized generated artifact
		// plus one small current screenshot busts the budget on paper, and since
		// assistant turns are never themselves clamped the small user image is
		// what gets dropped — leaving the request no smaller.
		const byteBudget = providerImageByteBudget("anthropic");
		const huge = image("a".repeat(Math.ceil(byteBudget * 1.2)));
		const small = image("s".repeat(1024));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [assistantTurn([huge], 0), { role: "user", content: [small], timestamp: 1 }],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);

		// The user image survives: only wire-bound bytes constrain the budget.
		expect(imageData(clamped).map(data => data[0])).toEqual(["a", "s"]);
		expect(clamped).toBe(context);
	});

	it("keeps every image when total image bytes fit the provider byte budget", () => {
		const small = image("x".repeat(1024));
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [{ role: "user", content: [small, small, small], timestamp: 0 }],
		};

		expect(clampProviderContextImages(context, ANTHROPIC_MODEL)).toBe(context);
	});
});
