/**
 * Claude's image contract, enforced before a request leaves the client. Every
 * wire that delivers images to a Claude reader shares it: `anthropic-messages`
 * always, and Google's Cloud Code Assist wire when resolved policy declares
 * the host's limits (`max-image-dimension` / `max-image-payload-bytes`).
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Context, ImageContent, Message, Model, TextContent } from "../types";

const ANTHROPIC_MANY_IMAGE_THRESHOLD = 20;
const ANTHROPIC_MANY_IMAGE_MAX_DIMENSION = 2000;
/**
 * Image contract of the canonical Anthropic Messages API, used when resolved
 * model policy names no other: 8000px per side ("At least one of the image
 * dimensions exceed max allowed size: 8000 pixels") and a 10 MB base64
 * payload per block ("image exceeds 10 MB maximum: 14012300 bytes >
 * 10485760 bytes"), measured on the encoded string rather than the decoded
 * bytes. Either rejection poisons every retry and model fallback because the
 * block stays in context, so both are clamped before the request goes out.
 * A host with a different image contract sets `max-image-dimension` /
 * `max-image-payload-bytes` in the KDL compatibility rules.
 */
const ANTHROPIC_MAX_IMAGE_DIMENSION = 8000;
const ANTHROPIC_MAX_IMAGE_PAYLOAD_BYTES = 10 * 1024 * 1024;
/** Headroom for the surrounding JSON and any provider-side accounting. */
const ANTHROPIC_IMAGE_PAYLOAD_HEADROOM = 0.9;
/** Re-encode passes allowed to bring one image under the byte budget. */
const ANTHROPIC_IMAGE_RESIZE_ATTEMPTS = 4;

/**
 * Image bounds for one request. `maxDimension` and `payloadBudget` come from
 * resolved model policy (`max-image-dimension`, `max-image-payload-bytes`) so
 * a deployment whose image contract differs from the canonical API can
 * override them, and the many-image path tightens `maxDimension` further
 * because many images share one request budget.
 */
interface AnthropicImageCaps {
	maxDimension: number;
	payloadBudget: number;
}

function countAnthropicImageBlocks(messages: Message[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "developer" && message.role !== "toolResult") continue;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "image") count++;
		}
	}
	return count;
}

/**
 * Ceiling on encoder output pixels in flight. One 8000x8000 RGBA surface is
 * roughly 256 MiB, so admitting four of them would spike the CLI by a
 * gigabyte; at the full-resolution cap this yields a single pipeline, while
 * the many-image cap encodes at most 2000px and keeps the four-way fan-out.
 */
const ANTHROPIC_IMAGE_RESIZE_PIXEL_BUDGET = 16_000_000;
const ANTHROPIC_IMAGE_RESIZE_MAX_CONCURRENCY = 4;

function anthropicImageResizeConcurrency(maxDimension: number): number {
	const perPipeline = maxDimension * maxDimension;
	if (perPipeline <= 0) return ANTHROPIC_IMAGE_RESIZE_MAX_CONCURRENCY;
	return Math.max(
		1,
		Math.min(ANTHROPIC_IMAGE_RESIZE_MAX_CONCURRENCY, Math.floor(ANTHROPIC_IMAGE_RESIZE_PIXEL_BUDGET / perPipeline)),
	);
}

/**
 * Memoized resize results keyed on ImageContent identity, per cap pair.
 * Callers keep message objects stable across turns, so without this every
 * request (and every in-provider retry of a fresh turn) re-decodes and
 * re-encodes the same oversized screenshots. A cached value identical to the
 * key means "already within bounds / unresizable — skip the decode". The caps
 * depend on image count and on resolved policy, so each pair keeps its own
 * cache: a value cached at 8000px is not reusable at 2000px.
 */
const anthropicImageResizeCaches = new Map<string, WeakMap<ImageContent, ImageContent>>();

function anthropicImageResizeCache(caps: AnthropicImageCaps): WeakMap<ImageContent, ImageContent> {
	const key = `${caps.maxDimension}:${caps.payloadBudget}`;
	const existing = anthropicImageResizeCaches.get(key);
	if (existing) return existing;
	const created = new WeakMap<ImageContent, ImageContent>();
	anthropicImageResizeCaches.set(key, created);
	return created;
}

type ResizeLimiter = <R>(fn: () => Promise<R>) => Promise<R>;

/**
 * Bounded-concurrency gate for image decode/encode work. The many-image path
 * fans out over every block of every message; unbounded, 100+ oversized images
 * would decode concurrently and spike memory by gigabytes. Slots are handed
 * off directly to the next waiter on release.
 */
function createResizeLimiter(limit: number): ResizeLimiter {
	let active = 0;
	const queue: (() => void)[] = [];
	return async fn => {
		if (active >= limit) {
			const { promise, resolve } = Promise.withResolvers<void>();
			queue.push(resolve);
			await promise;
		} else {
			active++;
		}
		try {
			return await fn();
		} finally {
			const next = queue.shift();
			if (next) next();
			else active--;
		}
	};
}

async function resizeAnthropicImageBlock(block: ImageContent, caps: AnthropicImageCaps): Promise<ImageContent> {
	const { maxDimension, payloadBudget } = caps;
	try {
		const inputBuffer = Buffer.from(block.data, "base64");
		const { width, height } = await new Bun.Image(inputBuffer).metadata();
		if (!width || !height) return block;
		const overDimension = width > maxDimension || height > maxDimension;
		const overBudget = block.data.length > payloadBudget;
		if (!overDimension && !overBudget) return block;

		// Fitting the pixel cap does not imply fitting the byte cap: a dense
		// screenshot re-encodes large even at the cap. Shrink by the overshoot in
		// area terms until the payload fits or the passes run out.
		let scale = Math.min(1, maxDimension / width, maxDimension / height);
		let best: { buffer: Uint8Array; mimeType: string } | undefined;
		for (let attempt = 0; attempt < ANTHROPIC_IMAGE_RESIZE_ATTEMPTS; attempt++) {
			const targetWidth = Math.max(1, Math.min(maxDimension, Math.round(width * scale)));
			const targetHeight = Math.max(1, Math.min(maxDimension, Math.round(height * scale)));
			// One encoder at a time: a full-resolution surface is hundreds of
			// megabytes, so the two candidates never coexist.
			const png = await new Bun.Image(inputBuffer).resize(targetWidth, targetHeight).png().bytes();
			const jpeg = await new Bun.Image(inputBuffer).resize(targetWidth, targetHeight).jpeg({ quality: 85 }).bytes();
			best =
				png.length <= jpeg.length
					? { buffer: png, mimeType: "image/png" }
					: { buffer: jpeg, mimeType: "image/jpeg" };

			// Base64 expands three bytes into four characters; the encoded length
			// is what Anthropic measures, so derive it without encoding.
			const encoded = Math.ceil(best.buffer.length / 3) * 4;
			if (encoded <= payloadBudget) break;
			if (targetWidth === 1 && targetHeight === 1) break;
			scale *= Math.max(0.25, Math.sqrt(payloadBudget / encoded) * 0.9);
		}
		if (!best) return block;

		const data = Buffer.from(best.buffer).toString("base64");
		// An image inside the pixel cap is only worth replacing if it shrank.
		if (!overDimension && data.length >= block.data.length) return block;
		// The rebuilt block carries no `url` or `providerFile`: those reference
		// the original bytes, and Anthropic validates a referenced image after
		// fetching it, so keeping either would resend the oversized copy.
		return {
			type: "image",
			data,
			mimeType: best.mimeType,
		};
	} catch (error) {
		logger.warn("anthropic: failed to resize oversized image", {
			mimeType: block.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return block;
	}
}

async function resizeAnthropicImageContent(
	content: (TextContent | ImageContent)[],
	state: { resized: number },
	limit: ResizeLimiter,
	caps: AnthropicImageCaps,
): Promise<(TextContent | ImageContent)[]> {
	let changed = false;
	const cache = anthropicImageResizeCache(caps);
	const next = await Promise.all(
		content.map(async block => {
			if (block.type !== "image") return block;
			let resized = cache.get(block);
			if (resized === undefined) {
				resized = await limit(() => resizeAnthropicImageBlock(block, caps));
				cache.set(block, resized);
			}
			if (resized !== block) {
				changed = true;
				state.resized++;
			}
			return resized;
		}),
	);
	return changed ? next : content;
}

async function resizeAnthropicImageMessage(
	message: Message,
	state: { resized: number },
	limit: ResizeLimiter,
	caps: AnthropicImageCaps,
): Promise<Message> {
	if (message.role === "user" || message.role === "developer") {
		if (!Array.isArray(message.content)) return message;
		const content = await resizeAnthropicImageContent(message.content, state, limit, caps);
		return content === message.content ? message : { ...message, content };
	}
	if (message.role === "toolResult") {
		const content = await resizeAnthropicImageContent(message.content, state, limit, caps);
		return content === message.content ? message : { ...message, content };
	}
	return message;
}

/**
 * Clamp every image a Claude reader would receive to the host's contract.
 * Limits the model's policy leaves unset fall back to the canonical Anthropic
 * API. Returns `context` itself when nothing needed resizing.
 */
export async function prepareAnthropicImageContext(
	context: Context,
	model: Model<"anthropic-messages"> | Model<"google-gemini-cli">,
): Promise<Context> {
	if (!model.input.includes("image")) return context;
	const imageCount = countAnthropicImageBlocks(context.messages);
	if (imageCount === 0) return context;
	// Many images share one request size budget, so they get the tighter cap.
	// A smaller set only has to clear the host's per-image limit.
	const hostMaxDimension = model.compat.maxImageDimension ?? ANTHROPIC_MAX_IMAGE_DIMENSION;
	const maxDimension =
		imageCount > ANTHROPIC_MANY_IMAGE_THRESHOLD
			? Math.min(ANTHROPIC_MANY_IMAGE_MAX_DIMENSION, hostMaxDimension)
			: hostMaxDimension;
	const maxPayloadBytes = model.compat.maxImagePayloadBytes ?? ANTHROPIC_MAX_IMAGE_PAYLOAD_BYTES;
	const caps: AnthropicImageCaps = {
		maxDimension,
		payloadBudget: Math.floor(maxPayloadBytes * ANTHROPIC_IMAGE_PAYLOAD_HEADROOM),
	};

	let changed = false;
	const state = { resized: 0 };
	const limit = createResizeLimiter(anthropicImageResizeConcurrency(maxDimension));
	const messages = await Promise.all(
		context.messages.map(async message => {
			const next = await resizeAnthropicImageMessage(message, state, limit, caps);
			if (next !== message) changed = true;
			return next;
		}),
	);
	if (!changed) return context;
	logger.debug("anthropic: resized oversized images", {
		imageCount,
		resized: state.resized,
		maxDimension,
	});
	return { ...context, messages };
}
