import { describe, expect, it } from "bun:test";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	ProviderSessionState,
	TextContent,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { convertCodexResponsesMessages } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { willReplayOpenAIResponsesNativeHistory } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	applyProviderImagePipeline,
	clampProviderContextImageCount,
	clampProviderContextImages,
	PROVIDER_IMAGE_COUNT_DECODE_SLACK,
} from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import { providerImageByteBudget } from "@oh-my-pi/pi-catalog/compat/behavior";
import { providerImageBudget } from "@oh-my-pi/snapcompact";
import { largeDecodablePng, smoothDecodablePng } from "./fixtures/decodable-png";

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

const OPENAI_MODEL = buildModel({
	id: "gpt-6-codex",
	name: "gpt-6-codex",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
});

const VISION_ONLY_MODEL = buildModel({
	id: "gpt-6-vision",
	name: "gpt-6-vision",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
	supportsComputerUse: false,
});

const COMPUTER_MODEL = buildModel({
	id: "gpt-6-computer",
	name: "gpt-6-computer",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
	supportsComputerUse: true,
});

/**
 * Codex: reaches the same Responses tool-result converter, but its own
 * `convertMessages()` calls `unrollCodexComputerToolResult()` first, which
 * DELETES `providerMetadata` — so a demoted screenshot travels as an ordinary
 * content image rather than a metadata note.
 */
const CODEX_MODEL = buildModel({
	id: "gpt-6-codex-cli",
	name: "gpt-6-codex-cli",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
	supportsComputerUse: false,
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

/**
 * Every `image_url` a context's replayed native payloads still carry — the
 * population `dropUnreadableContextImages()` walks and DECODES. A `computer_call`
 * pair or a spliced-off turn that keeps its payload here is one the decode pass
 * will pay for.
 */
function nativePayloadImageUrls(context: Context): string[] {
	const urls: string[] = [];
	const visit = (item: unknown): void => {
		if (!isRecord(item)) return;
		if (item.type === "input_image" && typeof item.image_url === "string") urls.push(item.image_url);
		if (item.type === "computer_call_output" && isRecord(item.output) && typeof item.output.image_url === "string") {
			urls.push(item.output.image_url);
		}
		if (Array.isArray(item.content)) for (const part of item.content) visit(part);
	};
	for (const message of context.messages) {
		const payload = "providerPayload" in message ? message.providerPayload : undefined;
		if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) continue;
		for (const item of payload.items) visit(item);
	}
	return urls;
}

/**
 * Images in the request the provider actually receives, counted by converting
 * the context through the real Anthropic-messages transform. This is the
 * population the per-request image cap applies to; anything the transform drops
 * on the way out never consumed it.
 */
function wireImageCount(context: Context, model: Model<"anthropic-messages">): number {
	let count = 0;
	for (const param of convertAnthropicMessages(context.messages, model, false)) {
		if (typeof param.content === "string") continue;
		for (const block of param.content) {
			if (block.type === "image") count++;
		}
	}
	return count;
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

/**
 * An assistant turn replaying native `image_generation_call` results, the way a
 * continuing same-model Responses request does. The base64 lives on
 * `providerPayload`, never in `content` — which is exactly why a content-only
 * tally reads zero for it.
 */
function replayTurn(results: string[], timestamp: number, model: Model = OPENAI_MODEL): AssistantMessage {
	return {
		...assistantTurn([], timestamp),
		// Tagged to MATCH `model`: replay is gated on the turn's api/model/provider
		// agreeing with the request's, so a mismatched fixture would exercise the
		// dead-payload path instead of the live one.
		api: model.api,
		provider: model.provider,
		model: model.id,
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			items: [
				{ type: "reasoning", id: "rs_keepme", summary: [] },
				...results.map((result, index) => ({
					type: "image_generation_call",
					id: `ig_${index}`,
					status: "completed",
					result,
				})),
			],
		},
	};
}

/** Replayed base64 still present on `context`'s assistant payloads. */
function replayedResults(context: Context): string[] {
	const out: string[] = [];
	for (const message of context.messages) {
		if (message.role !== "assistant") continue;
		const payload = message.providerPayload;
		if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) continue;
		for (const item of payload.items) {
			if (item.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 0) {
				out.push(item.result);
			}
		}
	}
	return out;
}

function dataUri(data: string): string {
	return `data:image/png;base64,${data}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function replayedItems(message: Message | undefined): Array<Record<string, unknown>> {
	const payload = message && "providerPayload" in message ? message.providerPayload : undefined;
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return [];
	return payload.items;
}

/** The `computer_call` that pairs a screenshot result — without it the converter sends generic output. */
function computerCallMessage(toolCallId: string): AssistantMessage {
	return {
		role: "assistant",
		timestamp: 1,
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: "computer",
				arguments: {},
				providerMetadata: {
					type: "computer",
					providerItemId: `ctc_${toolCallId}`,
					actions: [],
					pendingSafetyChecks: [],
				},
			},
		],
		api: OPENAI_MODEL.api,
		model: OPENAI_MODEL.id,
		provider: OPENAI_MODEL.provider,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
	};
}

/** A paired call + result, the shape the Responses converter actually sends. */
function computerTurn(toolCallId: string, data: string): Message[] {
	return [computerCallMessage(toolCallId), computerResultMessage(toolCallId, data)];
}

/** A paired turn whose screenshot lives server-side, so it carries no inline bytes. */
function referencedComputerTurn(toolCallId: string): Message[] {
	return [
		computerCallMessage(toolCallId),
		{
			role: "toolResult",
			timestamp: 1,
			toolCallId,
			toolName: "computer",
			content: [text("screenshot")],
			isError: false,
			providerMetadata: {
				type: "computer",
				acknowledgedSafetyChecks: [],
				screenshot: { type: "computer_screenshot", file_id: "server-side-shot" },
			},
		},
	];
}

function computerResultMessage(toolCallId: string, data: string): ToolResultMessage {
	return {
		role: "toolResult",
		timestamp: 1,
		toolCallId,
		toolName: "computer",
		content: [text("screenshot"), image(data)],
		isError: false,
		providerMetadata: {
			type: "computer",
			acknowledgedSafetyChecks: [],
			screenshot: { type: "computer_screenshot", image_url: dataUri(data) },
		},
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

	it("does not spend the byte budget on an image the unreadable pass will drop anyway", async () => {
		// Exercises `applyProviderImagePipeline` — the unit both `sdk.ts`
		// `transformProviderContext` callbacks now call — rather than a
		// hand-composed step order. A manual composition here would keep passing
		// if a production callsite later reversed the order and reintroduced this
		// eviction.
		//
		// The bug: the byte clamp ran BEFORE the unreadable pass, so a corrupt
		// newest image was charged against the budget, the oldest-first clamp
		// evicted the VALID older image to make room, and the unreadable pass then
		// replaced the corrupt one too — the request lost every image although the
		// readable one fit on its own.
		const budget = providerImageByteBudget(ANTHROPIC_MODEL.provider);

		// A REAL decodable PNG, over half the budget. The unreadable check decodes
		// in full, so filler bytes would be dropped as corrupt and could not stand
		// in for the valid image; and a solid colour re-compresses to a few KB, so
		// the raster carries per-pixel variation and is stored with deflate level
		// 0 to keep the encoded size near the raster size.
		const valid = Buffer.from(largeDecodablePng(1100)).toString("base64");
		if (valid.length <= budget * 0.5) throw new Error("fixture image cannot bust the budget");
		// Undecodable base64 of comparable size: `unreadableImageReason` rejects it.
		const corrupt = "!".repeat(valid.length);

		// User turns, not assistant: assistant images count toward the budget but
		// are never dropped by either pass, so they cannot express this bug.
		const context: Context = {
			messages: [
				{ role: "user", content: [image(valid)], timestamp: 1 },
				{ role: "user", content: [image(corrupt)], timestamp: 2 },
			],
		};

		// Identity normalizer: the model-specific pass is not what this covers,
		// and it keeps the assertion about the surviving image's own bytes.
		const piped = await applyProviderImagePipeline(context, ANTHROPIC_MODEL, async ctx => ctx);

		// The readable image survives whole; only the corrupt one is replaced.
		expect(imageData(piped)).toEqual([valid]);
	});

	it("weighs the byte budget against the provider's downscaled payload", async () => {
		// The bug: this clamp ran before Anthropic's own many-image downscale
		// (`prepareAnthropicManyImageContext`), which resizes every image in a
		// >20-image request down to 2000px. So a request whose RESIZED payload fit
		// the budget still lost its oldest images, measured at full size — and
		// because the downscale only triggers above 20 images, a clamp that cut
		// the count to 20 also stopped it from ever running.
		//
		// 21 images: one over the provider's many-image threshold, so the
		// downscale applies and the count cap (90 for anthropic) does not.
		const budget = providerImageByteBudget(ANTHROPIC_MODEL.provider);
		// Smooth, not the noisy `largeDecodablePng` raster: this fixture has to be
		// huge BEFORE the resize and small after, and per-pixel noise survives a
		// downscale as noise (measured: ~3 MB each post-resize, so 21 still bust
		// the budget and the test could not distinguish the fix). A low-detail
		// raster stays large when stored uncompressed and re-encodes to ~26 KB.
		const oversized = Buffer.from(smoothDecodablePng(2400)).toString("base64");
		const context: Context = {
			messages: Array.from({ length: 21 }, (_, index) => ({
				role: "user" as const,
				content: [image(oversized)],
				timestamp: index,
			})),
		};
		// The premise: at full size this payload busts the budget many times over,
		// so a pre-resize measurement must evict.
		if (oversized.length * 21 <= budget) throw new Error("fixture payload cannot bust the byte budget");

		const piped = await applyProviderImagePipeline(context, ANTHROPIC_MODEL, async ctx => ctx);

		// Every image survives: once resized to 2000px the whole request fits.
		const survivors = imageData(piped);
		expect(survivors).toHaveLength(21);
		// And they survive RESIZED, not merely unclamped — the payload the byte
		// budget was weighed against is the one the provider will receive.
		const total = survivors.reduce((sum, data) => sum + data.length, 0);
		expect(total).toBeLessThanOrEqual(budget);
		expect(survivors[0]?.length).toBeLessThan(oversized.length);
	});

	it("charges replayed native image results, which do reach the wire", async () => {
		// A completed `image_generation_call` keeps its base64 on
		// `providerPayload`, and `openai-shared.ts` replays the sanitized item
		// verbatim on a continuing same-model Responses request. The tally read
		// only generic `content`, so several generated images could bust the byte
		// budget while the count stayed zero and nothing was ever evicted.
		const budget = providerImageByteBudget(OPENAI_MODEL.provider);
		const generated = Buffer.from(largeDecodablePng(1700)).toString("base64");
		if (generated.length * 2 <= budget) throw new Error("fixture cannot bust the byte budget");
		const context: Context = { messages: [replayTurn([generated, generated], 1)] };

		const clamped = clampProviderContextImages(context, OPENAI_MODEL);

		// One is evicted to fit; the other survives.
		expect(replayedResults(clamped)).toEqual([generated]);
		// Evicted by CLEARING the result, so the rest of the payload survives —
		// the sanitizer then drops the emptied item from replay on its own.
		const payload = clamped.messages[0]?.role === "assistant" ? clamped.messages[0].providerPayload : undefined;
		const items = payload?.type === "openaiResponsesHistory" ? payload.items : [];
		expect(items.some(item => item.type === "reasoning" && item.id === "rs_keepme")).toBe(true);
		expect(items).toHaveLength(3);
	});

	it("ignores a replayed result the request will not carry, sparing the older user image", async () => {
		// The reviewer's routing case: replay is gated on the turn's api/model/
		// provider matching the request's, so a payload from a DIFFERENT model is
		// dead weight. Charging it made the oldest-first calculation delete the
		// older user image that IS being sent, to make room for bytes that never
		// travel — the same harm the byte budget exists to prevent.
		const budget = providerImageByteBudget(OPENAI_MODEL.provider);
		const generated = Buffer.from(largeDecodablePng(1700)).toString("base64");
		if (generated.length * 2 <= budget) throw new Error("fixture cannot bust the byte budget");
		const live = image(generated);
		const context: Context = {
			messages: [
				{ role: "user", content: [live], timestamp: 0 },
				// Same provider, DIFFERENT model: `convertConversationMessages`
				// excludes this payload, so its bytes are not on the wire.
				replayTurn([generated, generated], 1, { ...OPENAI_MODEL, id: "gpt-6-other" }),
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL);

		// Untouched by identity: only the live user image is charged, and it fits.
		expect(clamped).toBe(context);
	});

	it("ignores every replayed result on a request that will not replay at all", async () => {
		// The reviewer's restore case, a step past the routing one above. On the
		// FIRST request after restoring a Responses session the replay state is
		// unwarmed, so `buildParams` sends NO native history — every payload here
		// is dead weight however well its api/model/provider match. Charging them
		// deleted the older user image the request genuinely carries.
		const budget = providerImageByteBudget(OPENAI_MODEL.provider);
		const generated = Buffer.from(largeDecodablePng(1700)).toString("base64");
		if (generated.length * 2 <= budget) throw new Error("fixture cannot bust the byte budget");
		const live = image(generated);
		const context: Context = {
			messages: [
				{ role: "user", content: [live], timestamp: 0 },
				// A perfectly matching payload: same api, model and provider.
				replayTurn([generated, generated], 1),
			],
		};

		// Warmed, the payload is charged — and since it has no `dt` it is a full
		// SNAPSHOT, so the splice takes the older user image off the wire anyway.
		// The drop therefore has to land on a replayed result: spending it on the
		// user image reclaimed nothing and left the payload over the limit.
		const warmed = clampProviderContextImages(context, OPENAI_MODEL, true);
		expect(replayedResults(warmed)).toHaveLength(1);
		expect(imageData(warmed)).toContain(generated);

		// Unwarmed, nothing is charged and the live image survives untouched.
		const unwarmed = clampProviderContextImages(context, OPENAI_MODEL, false);
		expect(unwarmed).toBe(context);
	});

	it("weighs the byte budget against the references decoration produced", async () => {
		// A successful blob upload turns inline base64 into a URL or provider file,
		// and a reference puts no bytes on the wire. Clamping ahead of decoration
		// charged bytes the request was about to stop sending, evicting images that
		// would have travelled as references.
		const budget = providerImageByteBudget(ANTHROPIC_MODEL.provider);
		const inline = Buffer.from(largeDecodablePng(1400)).toString("base64");
		const count = Math.ceil((budget * 2) / inline.length);
		if (count < 2) throw new Error("fixture cannot bust the byte budget");
		const context: Context = {
			messages: Array.from({ length: count }, (_unused, index) => ({
				role: "user" as const,
				content: [image(inline)],
				timestamp: index,
			})),
		};

		// Decoration publishes every image as a URL: no inline bytes survive.
		const decorate = async (decorating: Context): Promise<Context> => ({
			...decorating,
			messages: decorating.messages.map(message => {
				if (message.role !== "user" || !Array.isArray(message.content)) return message;
				return {
					...message,
					content: message.content.map(part =>
						part.type === "image" ? { ...part, data: "", url: "https://blobs.example/x.png" } : part,
					),
				};
			}),
		});

		const piped = await applyProviderImagePipeline(context, ANTHROPIC_MODEL, async ctx => ctx, true, decorate);

		// Every image survives: none of them put bytes on the wire.
		expect(piped.messages.length).toBe(count);
		expect(imageData(piped).length).toBe(count);
	});

	it("charges and evicts the images a replayed native history carries", async () => {
		// A remote-compaction replacement retains `input_image` items whose bytes
		// live ONLY on the payload: the generic content was reduced to text, so a
		// content-only tally reads zero while megabytes travel.
		const big = "y".repeat(9 * 1024 * 1024);
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [{ type: "text", text: "compaction summary" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: [
							{ type: "message", role: "user", content: [{ type: "input_image", image_url: dataUri(big) }] },
							{ type: "message", role: "user", content: [{ type: "input_image", image_url: dataUri(big) }] },
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL);

		const items = replayedItems(clamped.messages[0]);
		const remaining = items.flatMap(item =>
			Array.isArray(item.content) ? item.content.filter(part => isRecord(part) && part.type === "input_image") : [],
		);
		// Two 9 MB images exceed the 16 MB budget; the oldest is degraded in place.
		expect(remaining.length).toBe(1);
		// The item keeps its shape and position rather than being removed.
		expect(items.length).toBe(2);
	});

	it("clears the screenshot metadata a computer result actually sends", async () => {
		// `computer_call_output.output` carries `providerMetadata.screenshot`, not
		// the mirrored content image, so dropping only the content block gives back
		// no wire bytes at all.
		const big = "z".repeat(9 * 1024 * 1024);
		const context: Context = {
			messages: [...computerTurn("call-1", big), ...computerTurn("call-2", big)],
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL);

		const results = clamped.messages.filter(message => message.role === "toolResult");
		expect(results.length).toBe(2);
		// The oldest screenshot is cleared; the newer one still travels.
		expect(results[0]?.providerMetadata).toBeUndefined();
		expect(results[1]?.providerMetadata).toBeDefined();
	});

	it("charges one computer screenshot once, not twice", async () => {
		// The metadata screenshot REPLACES the content image on the wire, so a
		// single 9 MB screenshot with the normal mirrored content block must
		// measure 9 MB, not 18 — otherwise the only copy that travels is evicted
		// for busting a budget it fits inside.
		const big = "w".repeat(9 * 1024 * 1024);
		const context: Context = { messages: computerTurn("call-1", big) };

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL);

		const results = clamped.messages.filter(message => message.role === "toolResult");
		expect(results.length).toBe(1);
		expect(results[0]?.providerMetadata).toBeDefined();
	});

	it("counts replayed input images against the per-request image cap", async () => {
		// Small enough that bytes never bind: the cap that must bite is the count.
		const small = "q".repeat(64);
		const overCount = providerImageBudget(OPENAI_MODEL.provider) + 3;
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [{ type: "text", text: "compaction summary" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: Array.from({ length: overCount }, () => ({
							type: "message",
							role: "user",
							content: [{ type: "input_image", image_url: dataUri(small) }],
						})),
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL);

		const surviving = replayedItems(clamped.messages[0]).filter(
			item =>
				Array.isArray(item.content) && item.content.some(part => isRecord(part) && part.type === "input_image"),
		);
		expect(surviving.length).toBe(providerImageBudget(OPENAI_MODEL.provider));
	});

	it("charges a cold payload that a compaction marker replays anyway", async () => {
		// `convertConversationMessages()` replays on the marker alone, independently
		// of the session's warmed replay state, so a cold resume's very first
		// request still carries these bytes.
		const big = "v".repeat(9 * 1024 * 1024);
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [{ type: "text", text: "compaction summary" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: [
							{ type: "compaction_summary" },
							{ type: "message", role: "user", content: [{ type: "input_image", image_url: dataUri(big) }] },
							{ type: "message", role: "user", content: [{ type: "input_image", image_url: dataUri(big) }] },
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL, false);

		const remaining = replayedItems(clamped.messages[0]).flatMap(item =>
			Array.isArray(item.content) ? item.content.filter(part => isRecord(part) && part.type === "input_image") : [],
		);
		expect(remaining.length).toBe(1);
	});

	it("treats Codex native history as always replayed", async () => {
		// The Codex transport replays every matching payload unconditionally, so
		// warmed replay state is a Responses-only gate.
		const codexModel = { ...OPENAI_MODEL, api: "openai-codex-responses" } as Model;

		expect(willReplayOpenAIResponsesNativeHistory(codexModel, new Map<string, ProviderSessionState>())).toBe(true);
		expect(willReplayOpenAIResponsesNativeHistory(OPENAI_MODEL, new Map<string, ProviderSessionState>())).toBe(false);
	});

	it("clears computer screenshots the count cap alone requires dropping", async () => {
		// Small screenshots: bytes never bind, so only the count can evict. Gating
		// eviction on the byte allowance returned every result unchanged and left
		// the request over the per-request image cap.
		const small = "s".repeat(64);
		const overCount = providerImageBudget(COMPUTER_MODEL.provider) + 2;
		const context: Context = {
			messages: Array.from({ length: overCount }, (_, index) => computerTurn(`call-${index}`, small)).flat(),
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL);

		const surviving = clamped.messages.filter(
			message => message.role === "toolResult" && message.providerMetadata !== undefined,
		);
		expect(surviving.length).toBe(providerImageBudget(COMPUTER_MODEL.provider));
	});

	it("counts reference-backed replayed input images against the cap", async () => {
		// An HTTPS-backed `input_image` carries no inline bytes but is still sent
		// as an image input, so it consumes the count cap.
		const overCount = providerImageBudget(OPENAI_MODEL.provider) + 3;
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [{ type: "text", text: "compaction summary" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: Array.from({ length: overCount }, (_, index) => ({
							type: "message",
							role: "user",
							content: [{ type: "input_image", image_url: `https://blobs.example/${index}.png` }],
						})),
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL);

		const surviving = replayedItems(clamped.messages[0]).filter(
			item =>
				Array.isArray(item.content) && item.content.some(part => isRecord(part) && part.type === "input_image"),
		);
		expect(surviving.length).toBe(providerImageBudget(OPENAI_MODEL.provider));
	});

	it("does not count a native payload the early pass will not send", async () => {
		// The count pass runs first and must take the same replay decision as the
		// byte pass: a cold payload with no compaction marker never travels, so it
		// must not justify dropping generic images that WILL.
		const small = "n".repeat(64);
		const liveImages = 3;
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: Array.from({ length: liveImages }, () => image(small)),
				},
				{
					role: "user",
					timestamp: 2,
					content: [{ type: "text", text: "restored turn" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: Array.from({ length: providerImageBudget(OPENAI_MODEL.provider) * 2 }, () => ({
							type: "message",
							role: "user",
							content: [{ type: "input_image", image_url: dataUri(small) }],
						})),
					},
				},
			],
		};

		const clamped = clampProviderContextImageCount(context, OPENAI_MODEL, false);

		expect(imageData(clamped).length).toBe(liveImages);
	});

	it("does not count replayed computer items the model demotes to text", async () => {
		// `adaptResponsesReplayItemsForModel()` rewrites a replayed
		// `computer_call_output` into a short assistant TEXT message whenever the
		// model does not support computer use, so its screenshot reaches the wire
		// as text and occupies no image part. Counting it meant that with more than
		// the cap's worth of such items, the count-only clamp evicted live generic
		// images for a request that carries zero image parts from the replay.
		//
		// RED (pre-fix): the live images were dropped to make room for screenshots
		// that never become image parts.
		const small = "d".repeat(64);
		const liveImages = 3;
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: Array.from({ length: liveImages }, () => image(small)),
				},
				{
					role: "user",
					timestamp: 2,
					content: [{ type: "text", text: "restored turn" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: VISION_ONLY_MODEL.provider,
						items: [
							// A compaction marker makes the payload replay on a cold resume,
							// matching the warm/compaction case.
							{ type: "message", role: "user", content: [{ type: "input_text", text: "compaction" }] },
							// Each output is PAIRED with its call: an unpaired one is already
							// excluded as a repaired orphan, which would make this vacuous.
							...Array.from({ length: providerImageBudget(VISION_ONLY_MODEL.provider) * 2 }, (_, index) => [
								{ type: "computer_call", call_id: `call-${index}`, action: { type: "screenshot" } },
								{
									type: "computer_call_output",
									call_id: `call-${index}`,
									output: { type: "computer_screenshot", image_url: dataUri(small) },
								},
							]).flat(),
						],
					},
				},
			],
		};

		// `supportsComputerUse: false`, so every replayed computer item above is
		// demoted to assistant text by the converter.
		const clamped = clampProviderContextImageCount(context, VISION_ONLY_MODEL, true);

		expect(imageData(clamped).length).toBe(liveImages);
	});

	it("leaves replay-superseded content alone and keeps the payload that travels", async () => {
		// `convertConversationMessages()` pushes the replay items and skips
		// `msg.content` entirely, so a superseded turn's generic images never
		// travel — which is why the accounting skips them too. The clamp still
		// descended into them, spending the allowance on bytes the converter drops
		// and then setting `providerPayload: undefined`, discarding the replay
		// items that ARE the request.
		//
		// The superseded turn's own replay image is REFERENCE-backed, so it carries
		// no bytes to give back: that leaves the byte allowance still owed when the
		// clamp reaches its generic content, which is the case the fix covers.
		const generic = "g".repeat(4096);
		const live = "l".repeat(providerImageByteBudget(OPENAI_MODEL.provider) + 1024);
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [text("summary"), image(generic)],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: [
							{ type: "compaction", id: "cmp_1" },
							{
								type: "message",
								role: "user",
								content: [{ type: "input_image", image_url: "https://example.test/shot.png" }],
							},
						],
					},
				},
				{ role: "user", timestamp: 2, content: [image(live)] },
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL, true);
		const first = clamped.messages[0];

		// RED (pre-fix): the generic image was dropped and the payload cleared, so
		// the replayed history the request actually carries went with it.
		expect(first.role === "user" && first.providerPayload).toBeDefined();
		expect(imageData(clamped).some(data => data === generic)).toBe(true);
	});

	it("drops the content mirror when it redacts a demoted screenshot", async () => {
		// Clearing `providerMetadata` takes the result OFF the demotion branch:
		// `appendResponsesToolResultMessages()` only demotes a `type: "computer"`
		// result, so afterwards the generic content image is what travels. Redacting
		// the metadata alone therefore reclaimed no bytes at all — the same
		// screenshot went out as the mirror.
		const big = "b".repeat(providerImageByteBudget(VISION_ONLY_MODEL.provider));
		const context: Context = {
			messages: [
				// The fixture already mirrors the screenshot into generic content.
				computerResultMessage("call-demoted", big),
				{ role: "user", timestamp: 2, content: [image("c".repeat(4096))] },
			],
		};

		const clamped = clampProviderContextImages(context, VISION_ONLY_MODEL, true);
		const result = clamped.messages[0];

		expect(result.role === "toolResult" && result.providerMetadata).toBeUndefined();
		// RED (pre-fix): the mirror survived, so the redaction freed nothing.
		expect(imageData(clamped).some(data => data === big)).toBe(false);
	});

	it("counts input images a replayed assistant snapshot splices onto the wire", async () => {
		// A legacy same-model assistant payload with `dt` absent/false is a full
		// SNAPSHOT: `buildResponsesInput()` splices it over the whole message list,
		// so any `input_image` items it retained go out as ordinary image inputs.
		// The assistant branch recorded only `image_generation_call.result` values,
		// so those parts counted toward neither budget and an oversized restored
		// session kept failing with 413 with no drop ever owed.
		//
		// RED (pre-fix): nothing was evicted — the snapshot's images were invisible.
		const small = "s".repeat(64);
		// The count pass admits `cap * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK)`, so
		// the fixture has to exceed THAT to owe a drop at all.
		const admissible = providerImageBudget(OPENAI_MODEL.provider) * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK);
		const snapshotImages = admissible + 3;
		const context: Context = {
			messages: [
				{
					...assistantTurn([], 1),
					api: OPENAI_MODEL.api,
					provider: OPENAI_MODEL.provider,
					model: OPENAI_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						// No `dt`: a full snapshot, spliced over the message list.
						items: Array.from({ length: snapshotImages }, () => ({
							type: "message",
							role: "user",
							content: [{ type: "input_image", image_url: dataUri(small) }],
						})),
					},
				},
				{ role: "user", timestamp: 2, content: [image(small)] },
			],
		};

		const clamped = clampProviderContextImageCount(context, OPENAI_MODEL, true);

		// The snapshot is over the cap on its own, so the clamp has to act; before
		// the fix it saw nothing to drop and left every image in place.
		const remaining = replayedItems(clamped.messages[0]).filter(item =>
			Array.isArray(item.content) ? item.content.some(part => isRecord(part) && part.type === "input_image") : false,
		).length;
		expect(remaining + imageData(clamped).length).toBeLessThanOrEqual(admissible);
	});

	it("counts a metadata-only computer screenshot with no content mirror", async () => {
		// A history parsed back from `computer_call_output` has `content: []`, so
		// nothing in the generic view stands for the screenshot. Leaving the count
		// to the content loop left a replay of these entirely uncounted.
		const overCount = providerImageBudget(COMPUTER_MODEL.provider) + 2;
		const context: Context = {
			messages: Array.from({ length: overCount }, (_, index) => [
				computerCallMessage(`call-${index}`),
				{ ...computerResultMessage(`call-${index}`, "t".repeat(32)), content: [] },
			]).flat(),
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL);

		const surviving = clamped.messages.filter(
			message => message.role === "toolResult" && message.providerMetadata !== undefined,
		);
		expect(surviving.length).toBe(providerImageBudget(COMPUTER_MODEL.provider));
	});

	it("counts a Codex computer screenshot as the generic image it actually sends", async () => {
		// Codex reaches `appendResponsesToolResultMessages()` like the other
		// Responses routes, so it looked metadata-demoted — but its own
		// `convertMessages()` calls `unrollCodexComputerToolResult()` first, which
		// deletes `providerMetadata`. The converter therefore never sees a computer
		// result and encodes the generic CONTENT image as an ordinary function
		// result. Treating it as demoted made the content loop skip that image, so
		// the count tally read zero for every screenshot and a long history could
		// exceed the per-request cap.
		//
		// RED (pre-fix): nothing was evicted, because `total` never counted these.
		const overCount = providerImageBudget(CODEX_MODEL.provider) + 2;
		const context: Context = {
			messages: Array.from({ length: overCount }, (_, index) =>
				computerTurn(`call-${index}`, "c".repeat(32)),
			).flat(),
		};

		const clamped = clampProviderContextImages(context, CODEX_MODEL);

		// The images that travel are the generic content ones, so the surviving
		// count is the provider's cap.
		expect(imageData(clamped).length).toBe(providerImageBudget(CODEX_MODEL.provider));
	});

	it("gives an Anthropic-compatible proxy the Anthropic byte allowance", async () => {
		// A configured proxy picks its own slug but declares the route it speaks,
		// and the request-size limit belongs to the route. Falling to the unknown
		// floor evicted history the real endpoint accepts.
		const proxyModel = { ...ANTHROPIC_MODEL, provider: "anthropic-proxy" } as Model<"anthropic-messages">;
		// 5 MB: over the 4 MB unknown floor, under Anthropic's 6 MB.
		const payload = "p".repeat(5 * 1000 * 1000);
		const context: Context = { messages: [{ role: "user", timestamp: 1, content: [image(payload)] }] };

		const clamped = clampProviderContextImages(context, proxyModel);

		expect(imageData(clamped).length).toBe(1);
	});

	it("ignores an orphan screenshot whose computer call was compacted away", async () => {
		// With no surviving `computer_call`, `appendResponsesToolResultMessages()`
		// falls through to generic output and never sends the metadata screenshot.
		// Charging it would evict a live user image for bytes that never travel.
		// Orphan bytes alone bust the 16 MB budget; the live images alone do not.
		const orphan = "o".repeat(15 * 1000 * 1000);
		const liveImage = "L".repeat(3 * 1000 * 1000);
		const context: Context = {
			messages: [
				// The result alone, its `computer_call` gone. Its generic content — the
				// only thing that now travels — is tiny; the metadata copy is not.
				{ ...computerResultMessage("call-gone", orphan), content: [text("screenshot"), image("tiny")] },
				{ role: "user", timestamp: 2, content: [image(liveImage)] },
				{ role: "user", timestamp: 3, content: [image(liveImage)] },
			],
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL);

		// Untouched: the orphan's metadata never travels, so it neither entered the
		// byte budget nor was evicted to satisfy one. Charging it would have put the
		// request 5 MB over and cleared this very field.
		const orphanResult = clamped.messages.find(message => message.role === "toolResult");
		expect(orphanResult?.providerMetadata).toBeDefined();
		// And both live images survive, since nothing owed a drop.
		expect(imageData(clamped).filter(data => data.length > 16).length).toBe(2);
	});

	it("clamps a screenshot replayed inside a computer_call_output", async () => {
		// `buildResponsesInput()` replays this item unchanged, and its image_url
		// sits in `output` rather than an `input_image` — so a payload of these was
		// invisible to both budgets.
		const big = "c".repeat(9 * 1024 * 1024);
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [{ type: "text", text: "compaction summary" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: [
							{ type: "computer_call", call_id: "c1" },
							{
								type: "computer_call_output",
								call_id: "c1",
								output: { type: "computer_screenshot", image_url: dataUri(big) },
							},
							{ type: "computer_call", call_id: "c2" },
							{
								type: "computer_call_output",
								call_id: "c2",
								output: { type: "computer_screenshot", image_url: dataUri(big) },
							},
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL);

		const items = replayedItems(clamped.messages[0]);
		// The oldest pair is REMOVED, call and output together: there is no valid
		// empty `computer_screenshot` to degrade the output to, and a call left
		// without its output is an orphan the provider rejects. Never a fabricated
		// file ref, which the next request would ask the provider to resolve.
		const callIds = items.map(item => `${String(item.type)}:${String(item.call_id)}`);
		expect(callIds).toEqual(["computer_call:c2", "computer_call_output:c2"]);
		expect(JSON.stringify(items)).not.toContain("omitted");
	});

	it("ignores a native payload a completions model will never replay", async () => {
		// Switching to a same-provider `openai-completions` model leaves the payload
		// attached and unread. Charging it would evict a live image for bytes the
		// completions converter never sends.
		const completionsModel = { ...OPENAI_MODEL, api: "openai-completions" } as Model;
		const stale = "s".repeat(15 * 1000 * 1000);
		const liveImage = "L".repeat(3 * 1000 * 1000);
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [{ type: "text", text: "restored turn" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: [
							{ type: "message", role: "user", content: [{ type: "input_image", image_url: dataUri(stale) }] },
						],
					},
				},
				{ role: "user", timestamp: 2, content: [image(liveImage)] },
				{ role: "user", timestamp: 3, content: [image(liveImage)] },
			],
		};

		const clamped = clampProviderContextImages(context, completionsModel);

		// Both live images survive; the stale payload never entered the budget.
		expect(imageData(clamped).length).toBe(2);
	});

	it("counts a native payload an Azure Responses model replays", async () => {
		// azure-openai-responses.ts builds its request with `nativeHistory: { replay: true }`.
		const azureModel = { ...OPENAI_MODEL, api: "azure-openai-responses" } as Model;
		const big = "z".repeat(9 * 1024 * 1024);
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [{ type: "text", text: "compaction summary" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: [
							{ type: "message", role: "user", content: [{ type: "input_image", image_url: dataUri(big) }] },
							{ type: "message", role: "user", content: [{ type: "input_image", image_url: dataUri(big) }] },
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, azureModel);

		const images = replayedItems(clamped.messages[0]).filter(item => JSON.stringify(item).includes("input_image"));
		expect(images.length).toBe(1);
	});

	it("does not charge a replayed turn's superseded generic content", async () => {
		// `convertConversationMessages()` replays the payload and `continue`s past
		// `msg.content`, so the attached frames never reach the wire — charging them
		// would evict the native history that does.
		const nativeImage = "n".repeat(9 * 1000 * 1000);
		const attached = "a".repeat(9 * 1000 * 1000);
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [{ type: "text", text: "compaction summary" }, image(attached)],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: [
							{ type: "compaction", id: "c" },
							{
								type: "message",
								role: "user",
								content: [{ type: "input_image", image_url: dataUri(nativeImage) }],
							},
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL);

		// The native image survives: 9 MB alone fits the 16 MB budget.
		const images = replayedItems(clamped.messages[0]).filter(item => JSON.stringify(item).includes("input_image"));
		expect(images.length).toBe(1);
	});

	it("keeps the byte debt when the dropped screenshot carries no inline bytes", async () => {
		// The oldest image is a server-side screenshot contributing nothing to the
		// byte tally, so retiring a byte drop for it would leave the two inline
		// images over the cap.
		const half = "h".repeat(10 * 1000 * 1000);
		const context: Context = {
			messages: [
				...referencedComputerTurn("call-ref"),
				{ role: "user", timestamp: 9, content: [image(half)] },
				{ role: "user", timestamp: 10, content: [image(half)] },
			],
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL);

		const survivingInlineBytes = clamped.messages
			.flatMap(message => (Array.isArray(message.content) ? message.content : []))
			.filter((part): part is ImageContent => part.type === "image" && part.url === undefined)
			.reduce((sum, part) => sum + part.data.length, 0);
		expect(survivingInlineBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
	});

	it("does not charge a replayed orphan computer output the converter repairs", async () => {
		// `repairOrphanResponsesToolOutputs()` rewrites an output with no preceding
		// `computer_call` into a 16 KB-capped assistant note, so its screenshot
		// never travels — charging it evicted a live image for bytes already gone.
		const orphan = "o".repeat(10 * 1000 * 1000);
		const live = "v".repeat(10 * 1000 * 1000);
		const context: Context = {
			messages: [
				{ role: "user", timestamp: 1, content: [image(live)] },
				{
					role: "user",
					timestamp: 2,
					content: [{ type: "text", text: "compaction summary" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: [
							{ type: "compaction", id: "c" },
							{
								type: "computer_call_output",
								call_id: "gone",
								output: { type: "computer_screenshot", image_url: dataUri(orphan) },
							},
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL);

		// The live image survives: the orphan's 10 MB never reach the wire.
		expect(imageData(clamped).some(data => data.startsWith("v"))).toBe(true);
	});

	it("charges and redacts a screenshot a non-computer model demotes to a note", async () => {
		// `appendResponsesToolResultMessages()` stringifies the whole metadata
		// screenshot — data uri included — into an assistant note for a model with
		// `supportsComputerUse !== true`, and never sends the content mirror. This
		// result has no mirror at all (a history parsed back from a
		// `computer_call_output` has `content: []`), so the metadata is the only
		// representation there is to charge.
		const shot = "d".repeat(10 * 1000 * 1000);
		const live = "v".repeat(10 * 1000 * 1000);
		const context: Context = {
			messages: [
				computerCallMessage("call-demoted"),
				{
					role: "toolResult",
					timestamp: 1,
					toolCallId: "call-demoted",
					toolName: "computer",
					content: [text("screenshot")],
					isError: false,
					providerMetadata: {
						type: "computer",
						acknowledgedSafetyChecks: [],
						screenshot: { type: "computer_screenshot", image_url: dataUri(shot) },
					},
				},
				{ role: "user", timestamp: 9, content: [image(live)] },
			],
		};

		const clamped = clampProviderContextImages(context, VISION_ONLY_MODEL);

		// 20 MB against a 16 MB budget: the metadata is what travels, so it is what
		// gets redacted, and the later live image survives.
		const result = clamped.messages.find(message => message.role === "toolResult") as ToolResultMessage;
		expect(result.providerMetadata).toBeUndefined();
		expect(imageData(clamped).some(data => data.startsWith("v"))).toBe(true);
	});

	it("treats a managed session with no provider state yet as unwarmed", async () => {
		// The provider-context transform runs BEFORE `streamOpenAIResponses` creates
		// the session state, so on the first request the map exists and is EMPTY.
		// Defaulting that to warm charged image-generation results the provider was
		// about to omit. An absent MAP is different — an unmanaged session, which
		// always replays.
		const managedButEmpty = new Map<string, ProviderSessionState>();

		expect(willReplayOpenAIResponsesNativeHistory(OPENAI_MODEL, managedButEmpty)).toBe(false);
		expect(willReplayOpenAIResponsesNativeHistory(OPENAI_MODEL, undefined)).toBe(true);
	});

	it("still never charges a display-only assistant content image", async () => {
		// The original rule stands for generic content: those blocks are dropped
		// before a request is built, so charging them would evict a live user
		// image to make room for something never sent.
		const budget = providerImageByteBudget(ANTHROPIC_MODEL.provider);
		const big = Buffer.from(largeDecodablePng(1100)).toString("base64");
		if (big.length * 2 <= budget) throw new Error("fixture cannot bust the byte budget");
		const user = image(big);
		const context: Context = {
			messages: [assistantTurn([image(big), image(big)], 1), { role: "user", content: [user], timestamp: 2 }],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);

		// Nothing is dropped: only the single user image is charged, and it fits.
		expect(clamped).toBe(context);
	});
});

describe("count cap ahead of the decode pass", () => {
	it("drops over-cap images before the unreadable pass can decode them", async () => {
		// The count cap for `umans` is 10, and this pass admits a slack multiple
		// of it. A history well past that window has the excess discarded
		// regardless of content, so decoding it (a full decode each, behind a
		// cache a longer history evicts every request) is pure waste.
		const admissible = providerImageBudget(UMANS_MODEL.provider) * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK);
		const total = admissible + 20;
		// Undecodable bytes: if the count clamp runs FIRST these never reach
		// `dropUnreadableContextImages`, so they stay verbatim image blocks. Run
		// after, and the decode pass rewrites each survivor to an omission notice.
		const context: Context = {
			messages: Array.from({ length: total }, (_, index) => ({
				role: "user" as const,
				content: [image(`!${"!".repeat(index)}`)],
				timestamp: index,
			})),
		};

		const counted = clampProviderContextImageCount(context, UMANS_MODEL);

		// Only the newest `admissible` images survive, and they are still images:
		// the count pass never decodes, so it cannot have consulted readability.
		expect(imageData(counted)).toEqual(
			Array.from({ length: admissible }, (_, index) => `!${"!".repeat(total - admissible + index)}`),
		);
		// Every discarded turn keeps its conversational position.
		expect(counted.messages).toHaveLength(total);
		expect(counted.messages[0]?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("leaves a context already within the count cap untouched", () => {
		const context: Context = {
			messages: [{ role: "user", content: [image("a"), image("b")], timestamp: 0 }],
		};

		expect(clampProviderContextImageCount(context, UMANS_MODEL)).toBe(context);
	});

	it("ignores the byte budget so normalization can still rewrite sizes", () => {
		// A single image far over the BYTE budget but within the count cap must
		// survive this pass: byte counts are not final until normalization has
		// run, so charging them here would evict an image that may shrink.
		const huge = image("x".repeat(providerImageByteBudget("anthropic") * 2));
		const context: Context = {
			messages: [{ role: "user", content: [huge], timestamp: 0 }],
		};

		expect(clampProviderContextImageCount(context, ANTHROPIC_MODEL)).toBe(context);
		// The byte-aware clamp, which runs later, is what drops it.
		expect(imageData(clampProviderContextImages(context, ANTHROPIC_MODEL))).toEqual([]);
	});

	it("never spends the cap on assistant display images, which the wire population excludes", () => {
		// An assistant image is a display artifact: `transformMessages` drops
		// every one of them before a request is built, so it cannot consume the
		// provider's per-request image cap. Charging it anyway evicted live user
		// images to make room for artifacts that were never going to be sent.
		const admissible = providerImageBudget(UMANS_MODEL.provider) * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK);
		const userImages = Array.from({ length: 5 }, (_, index) => `user-${index}`);
		const context: Context = {
			messages: [
				assistantTurn(
					Array.from({ length: admissible }, (_, index) => image(`assistant-${index}`)),
					0,
				),
				{ role: "user", content: userImages.map(image), timestamp: 1 },
			],
		};

		// The externally observable contract: only the 5 user images are images
		// on the wire, however many the assistant turn carries in the transcript.
		expect(wireImageCount(context, UMANS_MODEL)).toBe(5);

		// So the clamp has nothing to do, and every user image survives.
		const clamped = clampProviderContextImageCount(context, UMANS_MODEL);
		expect(imageData(clamped)).toEqual([
			...Array.from({ length: admissible }, (_, index) => `assistant-${index}`),
			...userImages,
		]);
		expect(wireImageCount(clamped, UMANS_MODEL)).toBe(5);
	});

	it("still clamps once the wire-bound images alone exceed the cap", () => {
		// The exclusion above is not a licence to overshoot: user images are wire
		// images, so an assistant turn beside them changes nothing about their
		// own eviction. `budget + 1` survive the count pass (cap plus one slack
		// multiple), and the wire sees exactly that many.
		const budget = providerImageBudget(UMANS_MODEL.provider);
		const admissible = budget * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK);
		const total = admissible + 4;
		const context: Context = {
			messages: [
				assistantTurn([image("assistant-0")], 0),
				...Array.from({ length: total }, (_, index) => ({
					role: "user" as const,
					content: [image(`user-${index}`)],
					timestamp: index + 1,
				})),
			],
		};

		const clamped = clampProviderContextImageCount(context, UMANS_MODEL);

		expect(imageData(clamped)).toEqual([
			"assistant-0",
			...Array.from({ length: admissible }, (_, index) => `user-${index + 4}`),
		]);
		expect(wireImageCount(clamped, UMANS_MODEL)).toBe(admissible);
		// The byte-aware clamp that runs last brings the wire down to the cap.
		expect(wireImageCount(clampProviderContextImages(clamped, UMANS_MODEL), UMANS_MODEL)).toBe(budget);
	});
});

describe("replayed assistant payload byte accounting", () => {
	// `supportsComputerUse` defaults to TRUE on a Responses model, so the
	// demotion path needs a model that explicitly lacks it — with the default
	// fixture the converter replays the computer items natively and the test
	// would pass for the wrong reason.
	const NO_COMPUTER_MODEL = buildModel({
		id: "gpt-6-codex",
		name: "gpt-6-codex",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		supportsComputerUse: false,
	});
	const BYTE_BUDGET = providerImageByteBudget(OPENAI_MODEL.provider, OPENAI_MODEL.api);

	/** Base64 of `bytes` length, distinct per `tag` so drops are identifiable. */
	function payloadOfSize(tag: string, bytes: number): string {
		return `${tag}${"A".repeat(Math.max(0, bytes - tag.length))}`;
	}

	function payloadTurn(items: Array<Record<string, unknown>>, model: Model = NO_COMPUTER_MODEL): AssistantMessage {
		return {
			...assistantTurn([], 1),
			api: model.api,
			provider: model.provider,
			model: model.id,
			providerPayload: {
				type: "openaiResponsesHistory",
				provider: model.provider,
				items: [{ type: "reasoning", id: "rs_keepme", summary: [] }, ...items],
			},
		};
	}

	it("charges a demoted computer item's bytes without charging an image slot", async () => {
		// `adaptResponsesReplayItemsForModel()` stringifies the WHOLE item — base64
		// data URI included — into an untruncated assistant text message when the
		// model does not support computer use. Excluding it from the count is
		// right; excluding its BYTES let several restored screenshots exceed the
		// request-size limit while the byte clamp measured zero.
		const big = payloadOfSize("demoted", BYTE_BUDGET + 1);
		const context: Context = {
			messages: [
				payloadTurn([
					{
						type: "computer_call_output",
						call_id: "call-1",
						output: { type: "computer_screenshot", image_url: dataUri(big) },
					},
				]),
			],
		};

		const clamped = clampProviderContextImages(context, NO_COMPUTER_MODEL);

		// RED (pre-fix): the demoted item was invisible to the byte tally, so no
		// drop was owed and the oversized payload travelled whole.
		const remaining = JSON.stringify(clamped.messages).includes(big);
		expect(remaining).toBe(false);
	});

	it("does not spend a count drop on a demoted computer item", async () => {
		// The converter stringifies a demoted computer output into assistant text,
		// so it puts no image PART on the wire -- which is why the accounting
		// leaves it out of the count tally. The clamp still paid a COUNT drop for
		// it, which reclaims nothing the count cap measures and spends the
		// allowance a real image needs, so the built request stays over the cap.
		const small = "s".repeat(64);
		const admissible = providerImageBudget(VISION_ONLY_MODEL.provider) * 2;
		// One image over the admissible count, so exactly one count drop is owed.
		const liveImages = admissible + 1;
		// The demoted item comes FIRST: the clamp evicts oldest-first, so this is
		// the ordering in which it reaches the demoted screenshot while a count
		// drop is still owed.
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [{ type: "text", text: "restored turn" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: VISION_ONLY_MODEL.provider,
						items: [
							{ type: "message", role: "user", content: [{ type: "input_text", text: "compaction" }] },
							// Paired, so it is not excluded as a repaired orphan.
							{ type: "computer_call", call_id: "call-0", action: { type: "screenshot" } },
							{
								type: "computer_call_output",
								call_id: "call-0",
								output: { type: "computer_screenshot", image_url: dataUri(small) },
							},
						],
					},
				},
				{
					role: "user",
					timestamp: 2,
					content: Array.from({ length: liveImages }, () => image(small)),
				},
			],
		};

		const clamped = clampProviderContextImageCount(context, VISION_ONLY_MODEL, true);

		// RED (pre-fix): the demoted screenshot absorbed the only count drop, so
		// every live image survived and the request stayed one over the cap.
		expect(imageData(clamped).length).toBe(liveImages - 1);
	});

	it("spends a byte drop on the oversized item, not an earlier small one", async () => {
		// The clamp evicts in the payload's OWN item order, so a size sequence
		// built as "all generation results, then all input images" could size the
		// allowance against a late large result while the clamp spent it on an
		// early small input — leaving the request over the byte limit.
		const small = payloadOfSize("small", 64);
		const big = payloadOfSize("big", BYTE_BUDGET + 1);
		const context: Context = {
			messages: [
				payloadTurn([
					{
						type: "message",
						role: "user",
						content: [{ type: "input_image", image_url: dataUri(small) }],
					},
					{ type: "image_generation_call", id: "ig_0", status: "completed", result: big },
				]),
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL);
		const serialized = JSON.stringify(clamped.messages);

		// RED (pre-fix): the single drop landed on the small input image and the
		// oversized generation result survived.
		expect(serialized).not.toContain(big);
	});
});

describe("computer pairing across a snapshot replacement", () => {
	it("does not charge images a full snapshot splices off the wire", async () => {
		// `buildResponsesInput()` replaces the whole accumulated input at a
		// `dt`-falsy payload, so everything before it is not on the wire and owes
		// neither budget. Tallying across the boundary measured the SUM of both
		// sides, so the allowance was spent evicting content the splice already
		// removes — a drop that reclaims nothing the request was going to send.
		const over = "x".repeat(providerImageByteBudget(OPENAI_MODEL.provider, OPENAI_MODEL.api) + 4_000_000);
		const context: Context = {
			messages: [
				{ role: "user", timestamp: 1, content: [image(over)] },
				{
					...assistantTurn([], 2),
					api: OPENAI_MODEL.api,
					provider: OPENAI_MODEL.provider,
					model: OPENAI_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						// No `dt`: replaces the whole accumulated input.
						items: [{ type: "image_generation_call", id: "ig_0", status: "completed", result: over }],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL, true);

		// RED (pre-fix): the pre-splice image was charged and evicted, spending the
		// allowance on bytes the request never carries.
		expect(imageData(clamped)).toContain(over);
	});

	it("keeps spliced-off images out of the expensive pipeline stages", async () => {
		// The count pass stops DROPPING pre-snapshot images, but
		// `normalizeForModel()`, `dropUnreadableContextImages()` and the provider
		// size pass all traversed the original full context afterward -- so images
		// that cannot reach the wire were still decoded and re-encoded on every
		// request, defeating the bound the count pass exists to hold.
		const spliced = "p".repeat(4096);
		const onWire = "w".repeat(4096);
		const context: Context = {
			messages: [
				{ role: "user", timestamp: 1, content: [image(spliced)] },
				{
					...assistantTurn([], 2),
					api: OPENAI_MODEL.api,
					provider: OPENAI_MODEL.provider,
					model: OPENAI_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: [
							{ type: "reasoning", id: "rs_snap", summary: [] },
							{ type: "message", role: "assistant", content: [{ type: "output_text", text: "snapshot" }] },
						],
					},
				},
				{ role: "user", timestamp: 3, content: [image(onWire)] },
			],
		};

		// What the expensive stages actually SEE.
		const seen: string[][] = [];
		const normalize = async (input: Context): Promise<Context> => {
			seen.push(imageData(input));
			return input;
		};

		await applyProviderImagePipeline(context, OPENAI_MODEL, normalize, true);

		// RED (pre-fix): the pre-snapshot image reached the normalize stage.
		expect(seen[0]).toEqual([onWire]);
	});

	it("removes a reference-backed screenshot mirror when redacting the metadata", async () => {
		// Clearing `providerMetadata` CHANGES THE ROUTE: the result stops being a
		// computer result, so the converter sends the generic content mirror
		// instead. When blob decoration has attached a provider-file reference to
		// that mirror, `clampContent` classifies it as non-inline and the cloned
		// `remainingDrops: 0` state left it in place -- creating an image part the
		// tally deliberately did not count, which puts the request over the COUNT
		// cap while the byte drop was being paid.
		// The metadata screenshot is the oversized half: its bytes are what the
		// demotion charges, so a byte drop is genuinely owed and the redaction
		// branch runs.
		const overScreenshot = "t".repeat(providerImageByteBudget(VISION_ONLY_MODEL.provider, VISION_ONLY_MODEL.api) + 1);
		const referencedMirror: ImageContent = {
			...image("v".repeat(64)),
			// Reference-backed: carries no inline bytes for this api.
			providerFile: { provider: "openai", id: "file-mirror" },
		};
		const context: Context = {
			messages: [
				computerCallMessage("call-demoted"),
				{
					role: "toolResult",
					timestamp: 4,
					toolCallId: "call-demoted",
					toolName: "computer",
					content: [text("screenshot"), referencedMirror],
					isError: false,
					providerMetadata: {
						type: "computer",
						acknowledgedSafetyChecks: [],
						screenshot: { type: "computer_screenshot", image_url: dataUri(overScreenshot) },
					},
				},
			],
		};

		// `supportsComputerUse: false`, so this result is demoted to assistant text.
		const clamped = clampProviderContextImages(context, VISION_ONLY_MODEL, true);

		// RED (pre-fix): the reference-backed mirror survived the redaction, so the
		// route change handed the converter an uncounted image part.
		const result = clamped.messages.find(message => message.role === "toolResult");
		expect(JSON.stringify(result)).not.toContain("file-mirror");
	});

	it("keeps charging history a hidden-empty payload does not splice away", async () => {
		// A `dt`-falsy payload only REPLACES the wire when the sanitizer returns
		// items. Reasoning plus an empty assistant message sanitizes to
		// `undefined`, so `buildResponsesInput()` never splices and the earlier
		// history still travels -- but the boundary advanced past it anyway,
		// excluding those images from both budgets. Nothing was ever owed a drop,
		// so the oversized request went out and 413'd.
		const over = "o".repeat(providerImageByteBudget(OPENAI_MODEL.provider, OPENAI_MODEL.api) + 1);
		const context: Context = {
			messages: [
				{ role: "user", timestamp: 1, content: [image(over)] },
				{
					...assistantTurn([], 2),
					api: OPENAI_MODEL.api,
					provider: OPENAI_MODEL.provider,
					model: OPENAI_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						// No `dt`, but hidden-empty: reasoning plus an assistant message
						// with no non-whitespace output. The sanitizer returns `undefined`.
						items: [
							{ type: "reasoning", id: "rs_hidden", summary: [] },
							{ type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] },
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL, true);

		// RED (pre-fix): the boundary skipped the user image, so no drop was owed
		// and the oversized image travelled whole.
		expect(imageData(clamped).join("")).not.toContain(over);
	});

	it("charges the mirror of a computer call a full snapshot splices away", async () => {
		// `buildResponsesInput()` treats a `dt`-falsy assistant payload as a full
		// SNAPSHOT: it splices away every message built so far and clears its
		// computer-call pair set, so the generic computer call below is not on the
		// wire. Recording it anyway made `sendsComputerScreenshot()` charge the
		// METADATA copy — which for an unpaired result never travels — instead of
		// the generic content mirror the converter actually sends. With the mirror
		// the oversized half, the tally read a tiny screenshot, owed no drop, and
		// the request still went out over the byte limit.
		const tinyScreenshot = "t".repeat(64);
		const bigMirror = "m".repeat(providerImageByteBudget(OPENAI_MODEL.provider, OPENAI_MODEL.api) + 1);
		const unpairedResult: ToolResultMessage = {
			role: "toolResult",
			timestamp: 4,
			toolCallId: "call-spliced",
			toolName: "computer",
			content: [text("screenshot"), image(bigMirror)],
			isError: false,
			providerMetadata: {
				type: "computer",
				acknowledgedSafetyChecks: [],
				screenshot: { type: "computer_screenshot", image_url: dataUri(tinyScreenshot) },
			},
		};
		// The call is BEFORE the snapshot and its result AFTER it: the splice takes
		// the call off the wire while the result survives, which is the shape that
		// leaves the result unpaired.
		const context: Context = {
			messages: [
				computerCallMessage("call-spliced"),
				{
					...assistantTurn([], 3),
					api: OPENAI_MODEL.api,
					provider: OPENAI_MODEL.provider,
					model: OPENAI_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						// No `dt`: the splice that takes the call above off the wire.
						// A reasoning item alone would NOT splice -- the sanitizer returns
						// `undefined` for a hidden-empty payload and the converter keeps
						// the accumulated wire -- so the payload carries real assistant
						// output too.
						items: [
							{ type: "reasoning", id: "rs_keepme", summary: [] },
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "snapshot" }],
							},
						],
					},
				},
				unpairedResult,
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL, true);

		// RED (pre-fix): the call counted as paired, so the tally charged the 64-byte
		// metadata screenshot, owed nothing, and the oversized mirror survived.
		expect(imageData(clamped).some(data => data === bigMirror)).toBe(false);
	});
});

describe("computer output eviction from a replayed assistant snapshot", () => {
	it("evicts an oversized computer_call_output the assistant snapshot replays natively", async () => {
		// A computer-capable model replays a `computer_call_output` unchanged, its
		// screenshot in `output.image_url` rather than an `input_image`. The
		// accounting CHARGES that screenshot, but the clamp delegated to
		// `dropNativeInputImages()`, which only touches top-level `input_image`
		// items or images under `content` — so the byte it charged could never be
		// reclaimed and the oversized snapshot shipped whole, producing the 413 the
		// clamp exists to prevent.
		const budget = providerImageByteBudget(COMPUTER_MODEL.provider, COMPUTER_MODEL.api);
		const over = "z".repeat(budget + 1);
		const context: Context = {
			messages: [
				{
					...assistantTurn([], 1),
					api: COMPUTER_MODEL.api,
					provider: COMPUTER_MODEL.provider,
					model: COMPUTER_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: COMPUTER_MODEL.provider,
						// `dt: true`: a plain replay append, not a full-snapshot splice, so
						// the wire boundary stays at 0 and this pair is what travels.
						dt: true,
						items: [
							{ type: "reasoning", id: "rs_keepme", summary: [] },
							{ type: "message", role: "assistant", content: [{ type: "output_text", text: "surviving-note" }] },
							// Paired, so the output is not a repaired orphan the tally skips.
							{
								type: "computer_call",
								id: "cu_0",
								call_id: "call-0",
								action: { type: "screenshot" },
								pending_safety_checks: [],
								status: "completed",
							},
							{
								type: "computer_call_output",
								call_id: "call-0",
								output: { type: "computer_screenshot", image_url: dataUri(over) },
							},
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL, true);

		// Verify the FINAL wire shape, not just the intermediate payload: the pair
		// is gone, so `buildResponsesInput()` puts no computer item — and no
		// oversized screenshot — on the wire.
		const wire = buildResponsesInput({
			model: COMPUTER_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		const serialized = JSON.stringify(wire);
		// RED (pre-fix): the byte allowance was owed but `dropNativeInputImages`
		// never reached `output.image_url`, so the oversized screenshot travelled.
		expect(serialized).not.toContain(over);
		// The paired call + output are BOTH gone from the wire: an output whose
		// screenshot cannot degrade in place is evicted with its call.
		expect(wire.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);
		// Real assistant history the generic content never reproduces survives the
		// eviction — only the paired computer screenshot is gone.
		expect(serialized).toContain("surviving-note");
	});
});

describe("pre-boundary native payloads bypass the decode pass", () => {
	it("strips spliced-off native input images before they reach the decode stage", async () => {
		// A user turn BEFORE a full-snapshot boundary keeps its native `input_image`
		// items on `providerPayload`, which the splice discards off the wire — but
		// `dropUnreadableContextImages()` still walked and DECODED every one. A
		// restored history with many native-image turns therefore paid unbounded
		// image decoding per request. The images must be gone before the expensive
		// stages run.
		const preBoundary = ["a", "b", "c"].map(tag => dataUri(`${tag}`.repeat(4096)));
		const onWire = "w".repeat(4096);
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [{ type: "text", text: "restored turn" }],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: preBoundary.map(image_url => ({
							type: "message",
							role: "user",
							content: [{ type: "input_image", image_url }],
						})),
					},
				},
				{
					...assistantTurn([], 2),
					api: OPENAI_MODEL.api,
					provider: OPENAI_MODEL.provider,
					model: OPENAI_MODEL.id,
					// No `dt`, and non-empty: reasoning plus real assistant output, so the
					// sanitizer returns items and `buildResponsesInput()` splices the wire.
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						items: [
							{ type: "reasoning", id: "rs_snap", summary: [] },
							{ type: "message", role: "assistant", content: [{ type: "output_text", text: "snapshot" }] },
						],
					},
				},
				{ role: "user", timestamp: 3, content: [image(onWire)] },
			],
		};

		// The native payloads the decode/normalize stage actually SEES.
		const seen: string[][] = [];
		const normalize = async (input: Context): Promise<Context> => {
			seen.push(nativePayloadImageUrls(input));
			return input;
		};

		await applyProviderImagePipeline(context, OPENAI_MODEL, normalize, true);

		// RED (pre-fix): all three pre-boundary native input images reached the
		// normalize stage and were decoded, even though the splice drops them.
		expect(seen[0]).toEqual([]);
	});
});

describe("computer pairing across a replayed user/developer payload", () => {
	it("evicts a screenshot the wire pairs via a computer_call a replayed user payload carries", () => {
		// The pairing `computer_call` lives in a REPLAYED USER payload, not an
		// assistant snapshot. `buildResponsesInput()` appends that payload's items
		// and adds the `computer_call` to `computerCallIds`, so a surviving
		// `toolResult` with the same call id is emitted as a paired
		// `computer_call_output` carrying `providerMetadata.screenshot` — the copy
		// that actually travels. The clamp's pairing scan only walked ASSISTANT
		// carriers, so this call was absent from the pair set:
		// `sendsComputerScreenshot()` read false, the accounting charged and
		// clamped only the generic content mirror the converter discards, and the
		// oversized metadata screenshot went out whole — the 413 the clamp exists
		// to prevent.
		//
		// The result survives `transformMessages()` because a live assistant tool
		// call declares its id (an orphan result is folded into a stale-tool-result
		// note and never reaches the converter). That live call carries NO computer
		// `providerMetadata`, so the assistant-only scan skipped it too — the whole
		// pairing is visible only in the replayed payload.
		const budget = providerImageByteBudget(COMPUTER_MODEL.provider, COMPUTER_MODEL.api);
		const over = "z".repeat(budget + 1);
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [text("summary")],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: COMPUTER_MODEL.provider,
						items: [
							{ type: "compaction", id: "cmp" },
							// The pairing call lives HERE, on a user carrier — the path the
							// assistant-only scan missed.
							{
								type: "computer_call",
								id: "cu_0",
								call_id: "call-0",
								action: { type: "screenshot" },
								pending_safety_checks: [],
								status: "completed",
							},
						],
					},
				},
				// A live tool call declaring `call-0`, so its result is not orphaned
				// into a stale note. No computer `providerMetadata`, so the assistant
				// scan does not record it — the pairing is only in the payload above.
				{
					...assistantTurn([], 2),
					api: COMPUTER_MODEL.api,
					provider: COMPUTER_MODEL.provider,
					model: COMPUTER_MODEL.id,
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "call-0", name: "computer", arguments: {} }],
				} as AssistantMessage,
				// The result whose metadata screenshot the converter emits as the
				// paired `computer_call_output`. Its generic content mirror never
				// travels.
				{
					role: "toolResult",
					timestamp: 3,
					toolCallId: "call-0",
					toolName: "computer",
					content: [text("screenshot")],
					isError: false,
					providerMetadata: {
						type: "computer",
						acknowledgedSafetyChecks: [],
						screenshot: { type: "computer_screenshot", image_url: dataUri(over) },
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL, true);

		// The FINAL provider input, not an intermediate structure: convert the
		// clamped context the way the request actually would.
		const wire = buildResponsesInput({
			model: COMPUTER_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		const serialized = JSON.stringify(wire);
		// RED (pre-fix): the user-carried call was not in the pair set, so the
		// metadata screenshot was left in place and shipped whole.
		expect(serialized).not.toContain(over);
		// Specifically, no `computer_call_output` still carries the oversized
		// screenshot the mirror removal was supposed to reclaim.
		expect(
			wire.some(item => item.type === "computer_call_output" && JSON.stringify(item.output ?? "").includes(over)),
		).toBe(false);
	});
});

describe("byte clamp preserves what actually reaches the wire", () => {
	it("keeps a full snapshot splicing after its last replayable result is cleared", async () => {
		// A `dt`-falsy FULL snapshot whose only replayable output is an oversized
		// `image_generation_call` (plus reasoning). Clearing its result for the
		// byte budget makes `sanitizeOpenAIResponsesAssistantHistoryItemsForReplay`
		// return `undefined`, so `buildResponsesInput()` stops treating the payload
		// as a snapshot and does not splice — resurrecting the superseded
		// pre-snapshot user turn AND losing the snapshot. A replayable omission item
		// keeps the splice semantics intact.
		const budget = providerImageByteBudget(OPENAI_MODEL.provider, OPENAI_MODEL.api);
		const over = "o".repeat(budget + 1);
		const stale = "STALE_PRE_SNAPSHOT_CONTEXT_MARKER";
		const context: Context = {
			messages: [
				// Superseded pre-snapshot history the splice is supposed to discard.
				{ role: "user", timestamp: 1, content: [text(stale)] },
				{
					...assistantTurn([], 2),
					api: OPENAI_MODEL.api,
					provider: OPENAI_MODEL.provider,
					model: OPENAI_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						// No `dt`: a full-snapshot replacement. Reasoning plus one oversized
						// generation result — the only replayable output.
						items: [
							{ type: "reasoning", id: "rs_snap", summary: [] },
							{ type: "image_generation_call", id: "ig_0", status: "completed", result: over },
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL, true);

		// The FINAL provider input, converted the way the request actually would.
		const wire = buildResponsesInput({
			model: OPENAI_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		const serialized = JSON.stringify(wire);
		// RED (pre-fix): clearing the result stopped the payload splicing, so the
		// pre-snapshot user turn came back onto the wire.
		expect(serialized).not.toContain(stale);
		// The oversized result is gone either way.
		expect(serialized).not.toContain(over);
		// The splice still ran: the retained omission item stands in for the snapshot.
		expect(serialized).toContain("[image omitted: provider image limit]");
	});

	it("clamps the final image count before decoration uploads blobs", async () => {
		// Anthropic's count cap is 90; the preliminary count pass keeps up to a
		// slack multiple (180) so the decode pass can consume the overage. With
		// 135 valid images (between 1x and 2x the cap) every one survives to
		// decoration, which uploads/publishes a blob for each — so without an exact
		// count clamp ahead of decoration, 135 blobs are created when only 90 can
		// be sent.
		const budget = providerImageBudget(ANTHROPIC_MODEL.provider);
		const admissible = budget * (1 + PROVIDER_IMAGE_COUNT_DECODE_SLACK);
		const total = Math.floor(budget * 1.5);
		// Between 1x and 2x the cap: the count pass keeps all of them.
		expect(total).toBeGreaterThan(budget);
		expect(total).toBeLessThanOrEqual(admissible);
		// A real, decodable PNG so the unreadable pass keeps it an image all the way
		// to decoration; a junk string would be rewritten to a text notice first.
		const png = Buffer.from(largeDecodablePng(8)).toString("base64");
		const context: Context = {
			messages: Array.from({ length: total }, (_unused, index) => ({
				role: "user" as const,
				content: [image(png)],
				timestamp: index,
			})),
		};

		// The count of images the decoration stage is handed to upload.
		let uploaded = 0;
		const decorate = async (decorating: Context): Promise<Context> => {
			for (const message of decorating.messages) {
				if (!Array.isArray(message.content)) continue;
				for (const part of message.content) if (part.type === "image") uploaded++;
			}
			return {
				...decorating,
				messages: decorating.messages.map(message => {
					if (message.role !== "user" || !Array.isArray(message.content)) return message;
					return {
						...message,
						content: message.content.map(part =>
							part.type === "image" ? { ...part, data: "", url: "https://blobs.example/x.png" } : part,
						),
					};
				}),
			};
		};

		await applyProviderImagePipeline(context, ANTHROPIC_MODEL, async ctx => ctx, true, decorate);

		// RED (pre-fix): decoration ran before the exact clamp, so it uploaded every
		// one of the 135 survivors instead of the 90 the request can carry.
		expect(uploaded).toBe(budget);
	});

	it("does not let a malformed generation result evict a live image", async () => {
		// An incremental payload holds an `image_generation_call` with a nonempty
		// result but no valid string `id`. The Responses sanitizer drops it before
		// the request is built, so its bytes never reach the wire — but the tally
		// charged them. An older live image plus that dead result exceeds the byte
		// budget, so the oldest-first clamp deleted the LIVE image and the converter
		// then dropped the malformed result: the request ended with neither.
		const budget = providerImageByteBudget(OPENAI_MODEL.provider, OPENAI_MODEL.api);
		const live = "L".repeat(Math.floor(budget * 0.7));
		const dead = "D".repeat(Math.floor(budget * 0.7));
		const context: Context = {
			messages: [
				// The older live image: on its own it fits the byte budget.
				{ role: "user", timestamp: 1, content: [image(live)] },
				{
					...assistantTurn([], 2),
					api: OPENAI_MODEL.api,
					provider: OPENAI_MODEL.provider,
					model: OPENAI_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						// Incremental append, so the live image stays on the wire.
						dt: true,
						items: [
							{ type: "reasoning", id: "rs_keepme", summary: [] },
							// Malformed: a nonempty result but NO `id`, so the sanitizer drops it.
							{ type: "image_generation_call", status: "completed", result: dead },
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL, true);

		const wire = buildResponsesInput({
			model: OPENAI_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		const serialized = JSON.stringify(wire);
		// RED (pre-fix): the dead result was charged, the live image was evicted to
		// fit it, and the converter then dropped the malformed result — so the wire
		// carried neither.
		expect(serialized).toContain(live);
		// The malformed result never reaches the wire regardless.
		expect(serialized).not.toContain(dead);
	});

	it("evicts an oversized generation result a replayed user payload carries", () => {
		// A remote-compaction replacement is attached to its user summary and
		// carries an `image_generation_call.result`. `convertConversationMessages()`
		// replays that payload verbatim (marker branch), so the sanitizer keeps the
		// completed result and its base64 travels — but the user/developer
		// accounting collected only `input_image`/computer parts, never a
		// generation result. Those bytes entered neither the tally nor the eviction
		// path, so one oversized result busts the byte budget with no drop owed.
		const budget = providerImageByteBudget(OPENAI_MODEL.provider, OPENAI_MODEL.api);
		const over = "u".repeat(budget + 1);
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [text("summary")],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: OPENAI_MODEL.provider,
						// A `compaction_summary` marker replays this payload even on a cold
						// session, exactly like the oversized restored replacement this
						// accounts for.
						items: [
							{ type: "compaction_summary" },
							{ type: "image_generation_call", id: "ig_0", status: "completed", result: over },
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL, true);

		// The FINAL provider input, converted the way the request actually would.
		const wire = buildResponsesInput({
			model: OPENAI_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		const serialized = JSON.stringify(wire);
		// Prove the fixture reaches the branch: the marker still replays, so the
		// payload's own items (the summary marker) are on the wire — the result is
		// what got cleared, not the whole turn dropped.
		expect(wire.some(item => item.type === "image_generation_call")).toBe(false);
		// RED (pre-fix): the generation result was charged to neither budget, so no
		// drop was owed and the oversized base64 shipped whole.
		expect(serialized).not.toContain(over);
	});
});

describe("replayed computer screenshots reach the wire as image parts", () => {
	// A Codex line whose provider is absent from the budget table, so it falls to
	// the strict floor (5) — small enough to bust with a handful of screenshots.
	const CODEX_SMALL_MODEL = buildModel({
		id: "gpt-6-codex-cli",
		name: "gpt-6-codex-cli",
		api: "openai-codex-responses",
		provider: "codex-small",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		supportsComputerUse: false,
	});

	// A computer-capable Responses line on an unbudgeted provider, so its
	// per-request image cap is the strict floor (5) too.
	const COMPUTER_SMALL_MODEL = buildModel({
		id: "gpt-6-computer",
		name: "gpt-6-computer",
		api: "openai-responses",
		provider: "resp-small",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		supportsComputerUse: true,
	});

	/** `input_image` parts a converted Codex request carries, however nested. */
	function codexInputImageCount(wire: readonly unknown[]): number {
		let count = 0;
		for (const item of wire) {
			if (!isRecord(item) || !Array.isArray(item.content)) continue;
			for (const part of item.content) if (isRecord(part) && part.type === "input_image") count++;
		}
		return count;
	}

	it("counts Codex-replayed computer screenshots so a history over the cap is evicted", () => {
		// Codex is a Responses route but does NOT demote replayed computer items:
		// its own `convertMessages()` runs `unrollCodexComputerItems()`, turning
		// every `computer_call_output` into a user `input_image`. The demotion
		// predicate wrongly treated Codex as demoting, so these screenshots accrued
		// ZERO count debt and a history of more than the cap's worth went over the
		// provider image limit.
		const cap = providerImageBudget(CODEX_SMALL_MODEL.provider);
		const over = cap + 2;
		const items: Array<Record<string, unknown>> = [{ type: "compaction", id: "cmp" }];
		for (let index = 0; index < over; index++) {
			items.push({
				type: "computer_call_output",
				call_id: `call-${index}`,
				// A server-resolved URL: no inline bytes, so ONLY the count binds.
				output: { type: "computer_screenshot", image_url: `https://shots.example/${index}.png` },
			});
		}
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [text("restored codex history")],
					providerPayload: { type: "openaiResponsesHistory", provider: CODEX_SMALL_MODEL.provider, items },
				},
			],
		};

		const clamped = clampProviderContextImages(context, CODEX_SMALL_MODEL, true);

		// The FINAL converted Codex input, the shape the request actually sends.
		const wire = convertCodexResponsesMessages(CODEX_SMALL_MODEL, clamped);
		// RED (pre-fix): every screenshot was excluded from the count, so none were
		// evicted and the unrolled request carried all `over` image parts.
		expect(codexInputImageCount(wire)).toBe(cap);
	});

	it("recognizes a file-backed native computer screenshot as an image part", () => {
		// A computer-capable model replays `computer_call_output` unchanged. When
		// its screenshot uses the supported `file_id` form instead of `image_url`,
		// the native-image-parts helper returned nothing — so file-backed
		// screenshots entered neither the tally nor the eviction path and a history
		// over the cap shipped whole.
		const cap = providerImageBudget(COMPUTER_SMALL_MODEL.provider);
		const over = cap + 2;
		const items: Array<Record<string, unknown>> = [{ type: "compaction", id: "cmp" }];
		for (let index = 0; index < over; index++) {
			// Paired call + output, so the output is not a repaired orphan the tally skips.
			items.push({
				type: "computer_call",
				id: `cu_${index}`,
				call_id: `call-${index}`,
				action: { type: "screenshot" },
				pending_safety_checks: [],
				status: "completed",
			});
			items.push({
				type: "computer_call_output",
				call_id: `call-${index}`,
				// The server-side FILE form, not `image_url`.
				output: { type: "computer_screenshot", file_id: `file-${index}` },
			});
		}
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [text("restored history")],
					providerPayload: { type: "openaiResponsesHistory", provider: COMPUTER_SMALL_MODEL.provider, items },
				},
			],
		};

		const clamped = clampProviderContextImages(context, COMPUTER_SMALL_MODEL, true);

		// The FINAL provider input, converted the way the request actually would.
		const wire = buildResponsesInput({
			model: COMPUTER_SMALL_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const screenshots = wire.filter(item => item.type === "computer_call_output").length;
		// RED (pre-fix): file-backed screenshots were invisible to the count, so
		// none were evicted and every one reached the wire.
		expect(screenshots).toBe(cap);
	});

	it("excludes an assistant-payload orphan screenshot before charging its bytes", async () => {
		// The assistant replay path tallied every `computer_call_output` without
		// applying the orphan-repair skip the user/developer path uses. For a warm
		// incremental assistant payload holding an orphan screenshot, the converter
		// replaces it with a 16 KB-capped note — yet the loop charged the orphan's
		// full data URI first, so an older VALID image could be evicted.
		const budget = providerImageByteBudget(COMPUTER_MODEL.provider, COMPUTER_MODEL.api);
		const valid = "V".repeat(Math.floor(budget * 0.7));
		const orphan = "O".repeat(Math.floor(budget * 0.9));
		const context: Context = {
			messages: [
				// The older valid image: on its own it fits the byte budget.
				{ role: "user", timestamp: 1, content: [image(valid)] },
				{
					...assistantTurn([], 2),
					api: COMPUTER_MODEL.api,
					provider: COMPUTER_MODEL.provider,
					model: COMPUTER_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: COMPUTER_MODEL.provider,
						// Incremental append, so the older user image stays on the wire.
						dt: true,
						items: [
							{ type: "reasoning", id: "rs_keepme", summary: [] },
							// Orphan: no preceding `computer_call`, so the converter repairs it
							// into a truncated note and its screenshot never travels.
							{
								type: "computer_call_output",
								call_id: "gone",
								output: { type: "computer_screenshot", image_url: dataUri(orphan) },
							},
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL, true);

		const wire = buildResponsesInput({
			model: COMPUTER_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const serialized = JSON.stringify(wire);
		// RED (pre-fix): the orphan's full data URI was charged, the older valid
		// image was evicted to fit it, and the converter then truncated the orphan —
		// so the wire carried neither.
		expect(serialized).toContain(valid);
		// The orphan's oversized screenshot never reaches the wire regardless.
		expect(serialized).not.toContain(orphan);
	});

	it("charges a computer output whose paired call is in an earlier wire-bound message", async () => {
		// The split case: the `computer_call` rides an EARLIER replayed assistant
		// payload, its matching `computer_call_output` a LATER one. Each payload
		// built its own known-call set from empty, so the later payload saw no
		// preceding `computer_call` and misread the output as a repaired orphan —
		// skipping its bytes. But `buildResponsesInput()` repairs orphans only after
		// assembling the COMPLETE input, where the cross-message pair IS recognized:
		// the screenshot travels while both accounting passes charged it nothing, so
		// the oversized screenshot slipped the byte clamp and the request kept 413ing.
		const budget = providerImageByteBudget(COMPUTER_MODEL.provider, COMPUTER_MODEL.api);
		// Oversized on its own, so it alone must be the drop the clamp owes.
		const orphan = "O".repeat(budget + 1);
		// Newer and small, so oldest-first eviction targets the screenshot, not this.
		const valid = "V".repeat(Math.floor(budget * 0.3));
		const context: Context = {
			messages: [
				// Earlier wire-bound message: carries the pairing `computer_call`.
				{
					...assistantTurn([], 1),
					api: COMPUTER_MODEL.api,
					provider: COMPUTER_MODEL.provider,
					model: COMPUTER_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: COMPUTER_MODEL.provider,
						// Incremental append, not a splice: the later output stays paired.
						dt: true,
						items: [
							{
								type: "computer_call",
								id: "cu_0",
								call_id: "call-0",
								action: { type: "screenshot" },
								pending_safety_checks: [],
								status: "completed",
							},
						],
					},
				},
				// Later wire-bound message: carries the matching output. On its own
				// payload this call id looks unpaired.
				{
					...assistantTurn([], 2),
					api: COMPUTER_MODEL.api,
					provider: COMPUTER_MODEL.provider,
					model: COMPUTER_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: COMPUTER_MODEL.provider,
						dt: true,
						items: [
							{ type: "message", role: "assistant", content: [{ type: "output_text", text: "surviving-note" }] },
							{
								type: "computer_call_output",
								call_id: "call-0",
								output: { type: "computer_screenshot", image_url: dataUri(orphan) },
							},
						],
					},
				},
				// A newer, small live image: on its own it fits, so it must survive.
				{ role: "user", timestamp: 3, content: [image(valid)] },
			],
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL, true);

		const wire = buildResponsesInput({
			model: COMPUTER_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const serialized = JSON.stringify(wire);
		// RED (pre-fix): the later payload read the output as a repaired orphan, so
		// its bytes were never charged, no drop was owed, and the oversized
		// screenshot reached the wire whole.
		expect(serialized).not.toContain(orphan);
		// The newer valid image was never the drop: the screenshot alone busted the
		// byte budget, so oldest-first eviction spent the drop on it, not this.
		expect(serialized).toContain(valid);
		// No `computer_call_output` still carries the oversized screenshot the byte
		// clamp was supposed to reclaim.
		expect(
			wire.some(item => item.type === "computer_call_output" && JSON.stringify(item.output ?? "").includes(orphan)),
		).toBe(false);
	});

	it("strips a demoted computer output with no call id before it reaches the wire", async () => {
		// A demoting Responses model rewrites a replayed `computer_call_output`
		// into an assistant note that stringifies the WHOLE item — data URI
		// included. When the output carries no string `call_id`, the id-keyed
		// exclusion the clamp used could not remove it, so the clamp booked the
		// byte debt as paid while the untouched data URI still shipped inside the
		// note. Strip the screenshot BY INDEX instead, the same in-place rewrite
		// the assistant-payload path uses.
		const budget = providerImageByteBudget(VISION_ONLY_MODEL.provider, VISION_ONLY_MODEL.api);
		const over = "z".repeat(budget + 1);
		const context: Context = {
			messages: [
				{
					role: "user",
					timestamp: 1,
					content: [text("restored turn")],
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: VISION_ONLY_MODEL.provider,
						items: [
							{ type: "message", role: "user", content: [{ type: "input_text", text: "compaction" }] },
							// No `call_id`: the id-keyed exclusion cannot remove it.
							{
								type: "computer_call_output",
								output: { type: "computer_screenshot", image_url: dataUri(over) },
							},
						],
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, VISION_ONLY_MODEL, true);

		const wire = buildResponsesInput({
			model: VISION_ONLY_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const serialized = JSON.stringify(wire);
		// RED (pre-fix): the clamp decremented the byte allowance but rewrote no
		// item, so the demoted note carried the full data URI to the wire.
		expect(serialized).not.toContain(over);
	});
});

describe("byte clamp applies to a text-only Responses model", () => {
	// A text-only Responses line: no image input at all, on a provider absent
	// from the byte-budget table so it falls to the floor (4 MB) — small enough
	// to bust with a single retained screenshot. `azure-openai-responses` is not
	// in `API_IMAGE_BYTE_BUDGETS` either, so the route floor applies too.
	const TEXT_ONLY_RESPONSES_MODEL = buildModel({
		id: "o3-mini-textonly",
		name: "o3-mini-textonly",
		api: "azure-openai-responses",
		provider: "resp-textonly",
		baseUrl: "https://example.openai.azure.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		supportsComputerUse: false,
	});

	it("evicts an oversized retained screenshot demoted to an assistant text note", () => {
		// A session holding a computer screenshot switches to a text-only Responses
		// model. `appendResponsesToolResultMessages()` serializes
		// `providerMetadata.screenshot` — the full data URI, untruncated — into an
		// assistant text note whenever `supportsComputerUse` is not true, so the
		// bytes reach the wire even though no image PART does. The old
		// `!model.input.includes("image")` early return skipped the byte clamp
		// entirely, so one oversized screenshot busted the request-size limit and
		// wedged the switched session.
		const budget = providerImageByteBudget(TEXT_ONLY_RESPONSES_MODEL.provider, TEXT_ONLY_RESPONSES_MODEL.api);
		const big = "B".repeat(budget + 1);
		const context: Context = {
			messages: [
				computerCallMessage("call-shot"),
				{
					role: "toolResult",
					timestamp: 2,
					toolCallId: "call-shot",
					toolName: "computer",
					content: [text("screenshot"), image(big)],
					isError: false,
					providerMetadata: {
						type: "computer",
						acknowledgedSafetyChecks: [],
						screenshot: { type: "computer_screenshot", image_url: dataUri(big) },
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, TEXT_ONLY_RESPONSES_MODEL, true);

		// The FINAL converted provider input, the shape the request actually sends.
		const wire = buildResponsesInput({
			model: TEXT_ONLY_RESPONSES_MODEL,
			context: clamped,
			strictResponsesPairing: true,
			supportsImageDetailOriginal: false,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const serialized = JSON.stringify(wire);
		// RED (pre-fix): the byte clamp was skipped, the metadata screenshot was
		// never redacted, and its full data URI travelled inside the demoted note.
		expect(serialized).not.toContain(big);
	});
});

describe("byte accounting excludes results dropped by message sanitization", () => {
	it("keeps an older valid image the dead malformed result's bytes should never have evicted", () => {
		// A persisted assistant tool call with an EMPTY id is malformed, so
		// `transformMessages()` -> `sanitizeMalformedToolCalls()` drops BOTH it and
		// its matched tool result before any converter runs. Charging that result's
		// image bytes here let an older VALID image plus the dead result exceed the
		// budget: oldest-first eviction discarded the valid image, the converter
		// then dropped the malformed pair, and the wire carried NEITHER — though
		// the live one fit on its own.
		const budget = providerImageByteBudget(ANTHROPIC_MODEL.provider, ANTHROPIC_MODEL.api);
		// Each fits the budget alone; together they bust it, so charging both owes
		// exactly one drop that oldest-first eviction lands on the valid image.
		const valid = "V".repeat(Math.floor(budget * 0.7));
		const dead = "D".repeat(Math.floor(budget * 0.7));
		const context: Context = {
			messages: [
				// The older valid image: on its own it fits the byte budget.
				{ role: "user", timestamp: 1, content: [image(valid)] },
				// A malformed assistant tool call: empty id, so the sanitizer drops it.
				{
					role: "assistant",
					timestamp: 2,
					content: [{ type: "toolCall", id: "", name: "read", arguments: {} }],
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
					stopReason: "toolUse",
				},
				// Its matched result, dropped with it: its image bytes never travel.
				{
					role: "toolResult",
					timestamp: 3,
					toolCallId: "",
					toolName: "read",
					content: [image(dead)],
					isError: false,
				},
			],
		};

		const clamped = clampProviderContextImages(context, ANTHROPIC_MODEL);

		// The FINAL wire the request actually sends, converted the real way.
		let validSurvives = false;
		for (const param of convertAnthropicMessages(clamped.messages, ANTHROPIC_MODEL, false)) {
			if (typeof param.content === "string") continue;
			for (const block of param.content) {
				if (
					block.type === "image" &&
					isRecord(block.source) &&
					block.source.type === "base64" &&
					block.source.data === valid
				) {
					validSurvives = true;
				}
			}
		}
		// RED (pre-fix): the dead result's bytes were charged, the valid image was
		// evicted to fit them, and the converter then dropped the malformed pair —
		// so the wire carried no image at all.
		expect(validSurvives).toBe(true);
	});
});

describe("byte accounting excludes orphan tool results the converter repairs", () => {
	it("keeps an older valid image an image-bearing orphan tool result should never have evicted", async () => {
		// A Responses history holds an image-bearing `toolResult` whose paired
		// tool call never reaches the wire (a locally-rejected call). The converter
		// folds that orphan output into a 16 KB-capped assistant note via
		// `repairOrphanResponsesToolOutputs()`, so its image never travels — but the
		// accounting charged its full bytes, and under byte pressure the drop that
		// bought room for a payload already gone evicted an older VALID image.
		const budget = providerImageByteBudget(OPENAI_MODEL.provider, OPENAI_MODEL.api);
		// Each fits alone; together they bust the budget, so charging the orphan
		// owes exactly one drop that oldest-first eviction lands on the valid image.
		const valid = "V".repeat(Math.floor(budget * 0.7));
		const orphan = "O".repeat(Math.floor(budget * 0.9));
		const context: Context = {
			messages: [
				// The older valid image: on its own it fits the byte budget.
				{ role: "user", timestamp: 1, content: [image(valid)] },
				// An orphan tool result: no assistant tool call precedes it, so the
				// converter truncates it to a note and its image never travels.
				{
					role: "toolResult",
					timestamp: 2,
					toolCallId: "call-rejected",
					toolName: "read",
					content: [image(orphan)],
					isError: false,
				},
			],
		};

		const clamped = clampProviderContextImages(context, OPENAI_MODEL, true);

		// The FINAL provider input, converted the way the request actually would.
		const wire = buildResponsesInput({
			model: OPENAI_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const serialized = JSON.stringify(wire);
		// RED (pre-fix): the orphan's bytes were charged, the valid image was
		// evicted to fit them, and the converter then truncated the orphan away —
		// so the wire carried neither.
		expect(serialized).toContain(valid);
		// The orphan's oversized image never reaches the wire regardless.
		expect(serialized).not.toContain(orphan);
	});
});

describe("preserving text when a native computer screenshot is removed", () => {
	it("keeps a computer result's text after byte pressure evicts its screenshot", async () => {
		// A paired computer result carries BOTH the mirrored screenshot and useful
		// text. Byte-only pressure clears its metadata; clearing it reroutes the
		// result through the generic converter, whose fallback note is built from
		// the result's content. Replacing the whole content with the omission
		// notice therefore lost the tool's text silently — retain the non-image
		// content instead.
		const budget = providerImageByteBudget(COMPUTER_MODEL.provider, COMPUTER_MODEL.api);
		const shot = "s".repeat(budget + 1);
		const mirror = "m".repeat(64);
		const context: Context = {
			messages: [
				computerCallMessage("call-shot"),
				{
					role: "toolResult",
					timestamp: 2,
					toolCallId: "call-shot",
					toolName: "computer",
					content: [text("important tool output"), image(mirror)],
					isError: false,
					providerMetadata: {
						type: "computer",
						acknowledgedSafetyChecks: [],
						screenshot: { type: "computer_screenshot", image_url: dataUri(shot) },
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL, true);

		// The FINAL provider input, converted the way the request actually would.
		const wire = buildResponsesInput({
			model: COMPUTER_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const serialized = JSON.stringify(wire);
		// The oversized screenshot was evicted regardless.
		expect(serialized).not.toContain(shot);
		// RED (pre-fix): the fallback replaced the whole content with the omission
		// notice, so the demoted note carried it in place of the real output.
		expect(serialized).toContain("important tool output");
	});
});

describe("incremental assistant payload computer calls pair a later screenshot", () => {
	it("evicts an oversized screenshot paired by an incremental assistant payload call", async () => {
		// A `dt: true` assistant payload APPENDS its `computer_call` to the wire and
		// `buildResponsesInput()` records it in the pair set — but the pairing scan
		// recorded payload calls only for a full-snapshot splice and otherwise read
		// this turn's (empty) generic content. So the later result's metadata
		// screenshot looked unpaired, went untallied, and its oversized bytes slipped
		// the clamp onto the wire.
		//
		// The pairing `computer_call` rides the incremental payload. A separate live
		// assistant tool call declares the same id so the matching result survives
		// `transformMessages()` (an orphan result is folded into a stale note and
		// never reaches the converter) — that live call carries no computer
		// `providerMetadata`, so the pairing is visible ONLY in the replayed payload.
		const budget = providerImageByteBudget(COMPUTER_MODEL.provider, COMPUTER_MODEL.api);
		const shot = "s".repeat(budget + 1);
		const context: Context = {
			messages: [
				{
					...assistantTurn([], 1),
					api: COMPUTER_MODEL.api,
					provider: COMPUTER_MODEL.provider,
					model: COMPUTER_MODEL.id,
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: COMPUTER_MODEL.provider,
						// Incremental append: the call rides the payload, NOT generic content.
						dt: true,
						items: [
							{ type: "message", role: "assistant", content: [{ type: "output_text", text: "surviving-note" }] },
							{
								type: "computer_call",
								id: "cu_0",
								call_id: "call-0",
								action: { type: "screenshot" },
								pending_safety_checks: [],
								status: "completed",
							},
						],
					},
				},
				// A live tool call declaring `call-0`, so its result is not orphaned
				// into a stale note. No computer `providerMetadata`, so the pairing is
				// only in the payload above.
				{
					...assistantTurn([], 2),
					api: COMPUTER_MODEL.api,
					provider: COMPUTER_MODEL.provider,
					model: COMPUTER_MODEL.id,
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "call-0", name: "computer", arguments: {} }],
				} as AssistantMessage,
				// The matching result: a history parsed back from a
				// `computer_call_output` carries `content: []`, so the metadata is the
				// only representation there is to tally.
				{
					role: "toolResult",
					timestamp: 3,
					toolCallId: "call-0",
					toolName: "computer",
					content: [],
					isError: false,
					providerMetadata: {
						type: "computer",
						acknowledgedSafetyChecks: [],
						screenshot: { type: "computer_screenshot", image_url: dataUri(shot) },
					},
				},
			],
		};

		const clamped = clampProviderContextImages(context, COMPUTER_MODEL, true);

		// The FINAL provider input, converted the way the request actually would.
		const wire = buildResponsesInput({
			model: COMPUTER_MODEL,
			context: clamped,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const serialized = JSON.stringify(wire);
		// RED (pre-fix): the screenshot looked unpaired, was never tallied, no drop
		// was owed, and its oversized data URI reached the wire whole.
		expect(serialized).not.toContain(shot);
		// No `computer_call_output` still carries the oversized screenshot.
		expect(
			wire.some(item => item.type === "computer_call_output" && JSON.stringify(item.output ?? "").includes(shot)),
		).toBe(false);
	});
});
