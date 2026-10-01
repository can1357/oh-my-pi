/**
 * Regression: an image whose bytes cannot be decoded makes the provider reject
 * the WHOLE request, not just the offending block, so a single corrupt payload
 * in history leaves a session permanently unable to send anything. The outbound
 * guard must degrade exactly that block to text and leave everything else —
 * including images with unusual-but-decodable framing, and images whose bytes
 * never travel because a reference does — byte-identical.
 */
import { describe, expect, test } from "bun:test";
import type {
	Context,
	ImageContent,
	Message,
	Model,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { dropUnreadableContextImages } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";

/**
 * 1x1 PNG whose chunk framing does not land exactly on `IEND`, yet every
 * decoder (and every vision backend) accepts it. Pins the guard against a
 * structural walk that would reject payloads providers happily read.
 */
const ODD_FRAMED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/**
 * The incident shape: a base64 payload that was middle-elided before being
 * written to disk, so the signature, the header and the `IEND` trailer all
 * survive while the compressed stream has a hole in it.
 */
const MIDDLE_ELIDED_PNG = (() => {
	const whole = Buffer.from(ODD_FRAMED_PNG, "base64");
	return Buffer.concat([whole.subarray(0, 20), whole.subarray(40)]).toString("base64");
})();

const INTACT_IMAGE: ImageContent = { type: "image", data: ODD_FRAMED_PNG, mimeType: "image/png" };
const BROKEN_IMAGE: ImageContent = { type: "image", data: MIDDLE_ELIDED_PNG, mimeType: "image/png" };
const OPENAI_RESPONSES_MODEL = buildModel({
	id: "gpt-4.1",
	name: "GPT 4.1",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
});
const BEDROCK_MODEL: Model = {
	...OPENAI_RESPONSES_MODEL,
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
};

function userMessage(content: (TextContent | ImageContent)[], providerPayload?: ProviderPayload): UserMessage {
	return {
		role: "user",
		content,
		timestamp: 0,
		...(providerPayload ? { providerPayload } : {}),
	} satisfies UserMessage;
}

function toolResult(content: (TextContent | ImageContent)[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read",
		content,
		isError: false,
		timestamp: 0,
	} satisfies ToolResultMessage;
}

/** Native Responses input item as `parseRequest` records it on `providerPayload`. */
function nativeImagePayload(imageUrl: string): ProviderPayload {
	return {
		type: "openaiResponsesHistory",
		dt: true,
		items: [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "what is in this screenshot?" },
					{ type: "input_image", detail: "auto", image_url: imageUrl },
				],
			},
		],
	} satisfies ProviderPayload;
}

function nativeItems(message: Message): unknown[] {
	if (message.role !== "user" && message.role !== "developer") throw new Error("expected an input message");
	const payload = message.providerPayload;
	if (payload?.type !== "openaiResponsesHistory") throw new Error("expected a native history payload");
	return payload.items;
}

function nativeContentParts(message: Message): unknown[] {
	const item = nativeItems(message)[0];
	if (!item || typeof item !== "object" || !("content" in item)) throw new Error("expected a native content array");
	const content = item.content;
	if (!Array.isArray(content)) throw new Error("expected a native content array");
	return content;
}

/** Reads a native part's `text` only after confirming it really is an `input_text` part. */
function nativeTextOf(part: unknown): string {
	if (!part || typeof part !== "object") throw new Error("expected a native part object");
	if (!("type" in part) || part.type !== "input_text") throw new Error("expected an input_text part");
	if (!("text" in part) || typeof part.text !== "string") throw new Error("expected input_text.text");
	return part.text;
}

function textOf(part: TextContent | ImageContent | undefined): string {
	if (part?.type !== "text") throw new Error(`expected a text block, got ${part?.type}`);
	return part.text;
}

describe("dropUnreadableContextImages", () => {
	test("degrades an undecodable image to text and keeps decodable siblings byte-identical", async () => {
		const context: Context = {
			messages: [
				userMessage([INTACT_IMAGE]),
				toolResult([{ type: "text", text: "Read image file [image/png]" }, BROKEN_IMAGE, INTACT_IMAGE]),
			],
		};

		const guarded = await dropUnreadableContextImages(context, OPENAI_RESPONSES_MODEL);

		const guardedResult = guarded.messages[1];
		if (guardedResult?.role !== "toolResult") throw new Error("expected a tool result");
		expect(guardedResult.content[0]).toEqual({ type: "text", text: "Read image file [image/png]" });
		expect(textOf(guardedResult.content[1])).toContain("image omitted");
		expect(guardedResult.content[2]).toEqual(INTACT_IMAGE);
		// The user turn carried only the decodable image, so it is untouched.
		expect(guarded.messages[0]).toBe(context.messages[0]);
	});

	test("returns the original context when every image decodes", async () => {
		const context: Context = { messages: [userMessage([{ type: "text", text: "look" }, INTACT_IMAGE])] };

		expect(await dropUnreadableContextImages(context, OPENAI_RESPONSES_MODEL)).toBe(context);
	});

	test("degrades empty inline data and provider references unusable by the active API", async () => {
		const emptyInline: ImageContent = { type: "image", data: "", mimeType: "image/png" };
		const foreignReference: ImageContent = {
			...BROKEN_IMAGE,
			providerFile: { provider: "anthropic", id: "file-anthropic" },
		};
		const context: Context = { messages: [userMessage([emptyInline, foreignReference])] };

		const guarded = await dropUnreadableContextImages(context, OPENAI_RESPONSES_MODEL);
		const message = guarded.messages[0];
		if (message?.role !== "user" || !Array.isArray(message.content)) throw new Error("expected user content");
		expect(textOf(message.content[0])).toContain("empty image data");
		expect(textOf(message.content[1])).toContain("image omitted");

		const urlContext: Context = {
			messages: [userMessage([{ ...BROKEN_IMAGE, url: "https://blobs.example/corrupt.png" }])],
		};
		const guardedUrl = await dropUnreadableContextImages(urlContext, BEDROCK_MODEL);
		const urlMessage = guardedUrl.messages[0];
		if (urlMessage?.role !== "user" || !Array.isArray(urlMessage.content)) {
			throw new Error("expected user content");
		}
		expect(textOf(urlMessage.content[0])).toContain("image omitted");
	});

	test("degrades malformed base64 and bytes that do not match the declared container", async () => {
		const malformedBase64: ImageContent = {
			...INTACT_IMAGE,
			data: `${ODD_FRAMED_PNG.slice(0, 20)}!${ODD_FRAMED_PNG.slice(20)}`,
		};
		const mislabeled: ImageContent = { ...INTACT_IMAGE, mimeType: "image/jpeg" };
		const context: Context = { messages: [userMessage([malformedBase64, mislabeled])] };

		const guarded = await dropUnreadableContextImages(context, OPENAI_RESPONSES_MODEL);
		const message = guarded.messages[0];
		if (message?.role !== "user" || !Array.isArray(message.content)) throw new Error("expected user content");
		expect(textOf(message.content[0])).toContain("invalid base64");
		expect(textOf(message.content[1])).toContain("contains image/png");
	});

	/**
	 * The reviewer's repro. A reference-backed block carries EMPTY `data` on
	 * purpose — `functionOutputContent()` builds `{ data: "", url }` /
	 * `{ data: "", providerFile }`, and the lazy snapcompact frame sink builds
	 * `{ data: "", url }` before this guard even runs. Decoding those bytes yields
	 * "empty image data" and would delete a perfectly good image.
	 */
	test("leaves reference-backed images alone instead of decoding bytes that never travel", async () => {
		const urlBacked: ImageContent = {
			type: "image",
			data: "",
			mimeType: "image/png",
			url: "https://blobs.example/sc:deadbeef:0",
		};
		const fileBacked: ImageContent = {
			type: "image",
			data: "",
			mimeType: "application/octet-stream",
			providerFile: { provider: "openai", id: "file-abc123" },
		};
		const context: Context = {
			messages: [userMessage([urlBacked, fileBacked]), toolResult([urlBacked, fileBacked])],
		};

		const guarded = await dropUnreadableContextImages(context, OPENAI_RESPONSES_MODEL);

		expect(guarded).toBe(context);
		expect(guarded.messages[0]).toBe(context.messages[0]);
		expect(guarded.messages[1]).toBe(context.messages[1]);
	});

	/**
	 * `inputContentParts()` keeps only text in the generic view, so a native input
	 * image exists ONLY on `providerPayload` — and `convertConversationMessages()`
	 * replays that payload in place of the content. An undecodable image there
	 * must not reach the wire; a decodable one must survive byte-identical.
	 */
	test("degrades an undecodable image reachable only through a native replay payload", async () => {
		const original = userMessage(
			[{ type: "text", text: "what is in this screenshot?" }],
			nativeImagePayload(`data:image/png;base64,${MIDDLE_ELIDED_PNG}`),
		);
		const context: Context = { messages: [original] };

		const guarded = await dropUnreadableContextImages(context, OPENAI_RESPONSES_MODEL);

		expect(guarded).not.toBe(context);
		const parts = nativeContentParts(guarded.messages[0]!);
		// The text part keeps its place and shape.
		expect(parts[0]).toEqual({ type: "input_text", text: "what is in this screenshot?" });
		// The image part became the input_text equivalent the schema accepts here.
		expect(nativeTextOf(parts[1])).toContain("image omitted");
		// Generic content carried no image, so it is reused as-is.
		const guardedMessage = guarded.messages[0];
		if (guardedMessage?.role !== "user") throw new Error("expected a user message");
		expect(guardedMessage.content).toBe(original.content);
	});

	test("keeps a decodable native replay payload byte-identical", async () => {
		const context: Context = {
			messages: [
				userMessage(
					[{ type: "text", text: "what is in this screenshot?" }],
					nativeImagePayload(`data:image/png;base64,${ODD_FRAMED_PNG}`),
				),
			],
		};

		expect(await dropUnreadableContextImages(context, OPENAI_RESPONSES_MODEL)).toBe(context);
	});

	test("degrades empty or malformed native data URIs instead of throwing", async () => {
		for (const imageUrl of ["data:image/png,", "data:image/png,%ZZ"]) {
			const context: Context = {
				messages: [userMessage([{ type: "text", text: "look" }], nativeImagePayload(imageUrl))],
			};

			const guarded = await dropUnreadableContextImages(context, OPENAI_RESPONSES_MODEL);
			expect(nativeTextOf(nativeContentParts(guarded.messages[0]!)[1])).toContain("image omitted");
		}
	});

	/**
	 * A native `file_id` / https `image_url` in a replayed payload is a reference
	 * with no local bytes, so it must not be decode-checked either.
	 */
	test("leaves reference-backed native replay payloads untouched", async () => {
		const context: Context = {
			messages: [userMessage([{ type: "text", text: "look" }], nativeImagePayload("https://cdn.example/shot.png"))],
		};

		expect(await dropUnreadableContextImages(context, OPENAI_RESPONSES_MODEL)).toBe(context);
	});

	/**
	 * A computer screenshot rides on `providerMetadata` and is replayed verbatim
	 * into `computer_call_output.output`, bypassing generic content entirely.
	 * `computer_call_output` accepts only a `computer_screenshot` ref, so the
	 * unreadable one is cleared — the provider layer then falls back to an
	 * assistant note built from this result's generic content.
	 */
	test("clears computer metadata whose screenshot cannot be decoded", async () => {
		const result: ToolResultMessage = {
			...toolResult([{ type: "text", text: "clicked at 100,200" }]),
			toolName: "computer",
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", image_url: `data:image/png;base64,${MIDDLE_ELIDED_PNG}` },
				acknowledgedSafetyChecks: [],
			},
		};
		const context: Context = { messages: [result] };

		const guarded = await dropUnreadableContextImages(context, OPENAI_RESPONSES_MODEL);

		const guardedResult = guarded.messages[0];
		if (guardedResult?.role !== "toolResult") throw new Error("expected a tool result");
		expect(guardedResult.providerMetadata).toBeUndefined();
		// The text the fallback note is built from survives untouched.
		expect(guardedResult.content).toBe(result.content);
	});

	test("keeps a decodable computer screenshot byte-identical", async () => {
		const result: ToolResultMessage = {
			...toolResult([{ type: "text", text: "clicked at 100,200" }]),
			toolName: "computer",
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", image_url: `data:image/png;base64,${ODD_FRAMED_PNG}` },
				acknowledgedSafetyChecks: [],
			},
		};
		const context: Context = { messages: [result] };

		expect(await dropUnreadableContextImages(context, OPENAI_RESPONSES_MODEL)).toBe(context);
	});
});
