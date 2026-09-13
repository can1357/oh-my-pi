import { describe, expect, it } from "bun:test";
import { crc32 as zlibCrc32, deflateSync as zlibDeflateSync } from "node:zlib";
import { setAnthropicManyImageRungEncoder, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
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

/**
 * A lossy WebP fixture, built from a synthetic PNG raster because `Bun.Image`
 * reads encoded bytes rather than a raw one.
 *
 * `fill` picks which re-encode hazard the fixture exercises:
 *   - `"noise"` (xorshift, fixed seed) is high-entropy and expensive to
 *     re-encode, so it is small on the wire yet costly to reproduce. A flat or
 *     upscaled raster is the wrong fixture there — it re-compresses to a few KB
 *     and so can never demonstrate resize growth from lost compression.
 *   - `"flat"` is uniform, so WebP stores it in almost nothing while a JPEG or
 *     PNG of the same pixels pays fixed per-format overhead. That is the other
 *     way a mandatory downscale grows the payload.
 *
 * Deterministic either way, so byte comparisons cannot flake.
 */
async function makeWebp(width: number, height: number, quality: number, fill: "noise" | "flat"): Promise<string> {
	// Truecolor scanlines, each prefixed by PNG's per-row filter byte (0 = None).
	const raster = new Uint8Array(height * (1 + width * 3));
	if (fill === "noise") {
		let state = 0x9e3779b9;
		for (let y = 0; y < height; y++) {
			const row = y * (1 + width * 3);
			for (let x = 0; x < width * 3; x++) {
				state ^= state << 13;
				state ^= state >>> 17;
				state ^= state << 5;
				raster[row + 1 + x] = state & 0xff;
			}
		}
	}
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header[8] = 8; // bit depth
	header[9] = 2; // colour type: truecolor
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", zlibDeflateSync(raster, { level: 9 })),
		pngChunk("IEND", new Uint8Array(0)),
	]);
	const encoded = await new Bun.Image(png).webp({ quality }).bytes();
	return Buffer.from(encoded).toString("base64");
}

/** One length-prefixed, CRC32-suffixed PNG chunk. */
function pngChunk(type: string, data: Uint8Array): Buffer {
	const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(zlibCrc32(body) >>> 0);
	return Buffer.concat([length, body, crc]);
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

	/**
	 * The resize is the LAST byte-changing step before the wire, and it runs
	 * after the caller's image-byte budget has already been enforced. Re-encoding
	 * an efficiently compressed WebP as PNG/JPEG can therefore GROW the payload
	 * past a budget that already fit — a measured 2400px q20 WebP grows ~15% on
	 * the plain `min(png, jpeg@85)` choice — reintroducing the 413 the budget
	 * exists to prevent. Downscaling must never cost more bytes than it saves.
	 */
	it("never grows an image's payload by resizing it", async () => {
		const source = await makeWebp(2400, 2400, 20, "noise");
		const largeImage: ImageContent = { type: "image", data: source, mimeType: "image/webp" };
		const smallImage: ImageContent = { type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const context = makeToolResultContext([largeImage, ...Array.from({ length: 20 }, () => smallImage)]);

		const payload = await capturePayload(context);

		const images = extractToolResultImages(payload);
		expect(images).toHaveLength(21);
		// Still honours the dimension cap the many-image path exists to enforce.
		const { width, height } = await new Bun.Image(Buffer.from(images[0].source.data, "base64")).metadata();
		expect(width).toBeLessThanOrEqual(2000);
		expect(height).toBeLessThanOrEqual(2000);
		// And costs no extra bytes to get there.
		expect(images[0].source.data.length).toBeLessThanOrEqual(source.length);
	});

	/**
	 * The byte-budget guard must never be able to hand back an image that breaks
	 * the dimension cap. A source only just over the cap is the case that pits
	 * the two constraints against each other: scaling 2001px to 2000px sheds
	 * 0.1% of the pixels, so a q5 WebP's re-encode stays heavier than the source
	 * for every quality the ladder used to try — and the "keep the original"
	 * fallback then shipped a 2001px image into a request Anthropic rejects
	 * outright. Byte growth is recoverable; an over-cap image is a hard 400.
	 */
	/**
	 * Removing the "keep the original" fallback is what enforces the dimension
	 * cap, but on its own it ships a LARGER payload than the source (measured
	 * 1.21x for this fixture), regressing the byte budget this PR added. The
	 * quality ladder is what keeps the cap fix from costing bytes, so assert the
	 * byte outcome explicitly — the dimension assertions above pass either way
	 * and cannot detect a shortened ladder.
	 */
	it("keeps the over-cap rendition under the source bytes", async () => {
		const source = await makeWebp(2001, 2001, 5, "noise");
		const largeImage: ImageContent = { type: "image", data: source, mimeType: "image/webp" };
		const smallImage: ImageContent = { type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const context = makeToolResultContext([largeImage, ...Array.from({ length: 20 }, () => smallImage)]);

		const payload = await capturePayload(context);

		const images = extractToolResultImages(payload);
		expect(images[0].source.data.length).toBeLessThanOrEqual(source.length);
	});

	it("never restores an over-dimension original when no rendition is smaller", async () => {
		const source = await makeWebp(2001, 2001, 5, "noise");
		const largeImage: ImageContent = { type: "image", data: source, mimeType: "image/webp" };
		const smallImage: ImageContent = { type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const context = makeToolResultContext([largeImage, ...Array.from({ length: 20 }, () => smallImage)]);

		const payload = await capturePayload(context);

		const images = extractToolResultImages(payload);
		expect(images).toHaveLength(21);
		// The image actually sent must be within the cap, not the 2001px source.
		expect(images[0].source.data).not.toBe(source);
		const { width, height } = await new Bun.Image(Buffer.from(images[0].source.data, "base64")).metadata();
		expect(width).toBeLessThanOrEqual(2000);
		expect(height).toBeLessThanOrEqual(2000);
	});

	/**
	 * A wide, shallow, uniform WebP is the case a JPEG-only ladder cannot
	 * rescue. Its 2001x100 pixels compress to a few hundred bytes in WebP, and
	 * scaling to 2000px sheds 0.05% of them, so every JPEG rung — down to q5 —
	 * still pays more fixed format overhead than the whole source costs
	 * (measured 2.26x). The dimension cap is mandatory, so the resize happens
	 * regardless; without a WebP rung the pipeline therefore ships MORE bytes
	 * than the byte budget upstream already approved, which is the 413 that
	 * budget exists to prevent.
	 */
	it("keeps a uniform wide image under its source bytes when no JPEG rung can", async () => {
		const source = await makeWebp(2001, 100, 1, "flat");
		const largeImage: ImageContent = { type: "image", data: source, mimeType: "image/webp" };
		const smallImage: ImageContent = { type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const context = makeToolResultContext([largeImage, ...Array.from({ length: 20 }, () => smallImage)]);

		const payload = await capturePayload(context);

		const images = extractToolResultImages(payload);
		expect(images).toHaveLength(21);
		// The cap still binds — growth is never avoided by skipping the resize.
		const { width, height } = await new Bun.Image(Buffer.from(images[0].source.data, "base64")).metadata();
		expect(width).toBeLessThanOrEqual(2000);
		expect(height).toBeLessThanOrEqual(2000);
		expect(images[0].source.data.length).toBeLessThanOrEqual(source.length);
	});

	/**
	 * The wide uniform source is the one that reaches the ladder at all (its
	 * initial resize is heavier than the source). Failing every rung leaves the
	 * within-cap initial resize as the only valid rendition, so a rung rejection
	 * must not escape to the outer catch and restore the 2001px original.
	 */
	it("keeps the completed resize when every ladder encode fails", async () => {
		const source = await makeWebp(2001, 100, 1, "flat");
		const largeImage: ImageContent = { type: "image", data: source, mimeType: "image/webp" };
		const smallImage: ImageContent = { type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" };
		const context = makeToolResultContext([largeImage, ...Array.from({ length: 20 }, () => smallImage)]);

		// Through the rung-encoder seam rather than `Bun.Image.prototype`: this
		// package runs `bun test --parallel`, so patching the prototype reaches
		// every image operation in the process and fails concurrent encodes in
		// other files. The seam is scoped to the ladder this test is about.
		const restoreEncoder = setAnthropicManyImageRungEncoder(async () => {
			throw new Error("rung encode failed");
		});

		let images: AnthropicImageBlock[];
		try {
			images = extractToolResultImages(await capturePayload(context));
		} finally {
			restoreEncoder();
		}

		expect(images).toHaveLength(21);
		const { width, height } = await new Bun.Image(Buffer.from(images[0].source.data, "base64")).metadata();
		expect(width).toBeLessThanOrEqual(2000);
		expect(height).toBeLessThanOrEqual(2000);
	});
});
