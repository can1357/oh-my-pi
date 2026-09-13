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
import { willReplayOpenAIResponsesNativeHistory } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	applyProviderImagePipeline,
	clampProviderContextImageCount,
	clampProviderContextImages,
	PROVIDER_IMAGE_COUNT_DECODE_SLACK,
} from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import { providerImageBudget, providerImageByteBudget } from "@oh-my-pi/snapcompact";
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

		// Warmed (the default) the payload is charged and the older user image goes.
		const warmed = clampProviderContextImages(context, OPENAI_MODEL, true);
		expect(imageData(warmed)).not.toContain(generated);

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
