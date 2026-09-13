import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ImageUrlService } from "@oh-my-pi/pi-coding-agent/blob-broker/service";
import { wrapStreamFnWithBlobUrlFallback } from "@oh-my-pi/pi-coding-agent/blob-broker/stream-fallback";
import { providerImageByteBudget } from "@oh-my-pi/snapcompact";
import { smoothDecodablePng } from "./session/fixtures/decodable-png";

const model: Model = buildModel({
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

function message(text: string, stopReason: "stop" | "error" = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(stopReason === "error" ? { errorMessage: "image rejected" } : {}),
		timestamp: 0,
	};
}

function imageContext(channel: "native" | "url" | "inline"): Context {
	return {
		messages: [
			{
				role: "user",
				content: [
					{
						type: "image",
						data: "aW1hZ2U=",
						mimeType: "image/png",
						...(channel !== "inline" ? { url: "https://images.test/blob" } : {}),
						...(channel === "native" ? { providerFile: { provider: "openai" as const, id: "file_bad" } } : {}),
					},
				],
				timestamp: 0,
			},
		],
	};
}

function channelOf(context: Context): "native" | "url" | "inline" {
	const first = context.messages[0];
	if (!first || !Array.isArray(first.content)) throw new Error("missing image message");
	const image = first.content.find(part => part.type === "image");
	if (image?.type !== "image") throw new Error("missing image");
	if (image.providerFile) return "native";
	return image.url ? "url" : "inline";
}

class FakeFallbackService extends ImageUrlService {
	readonly fallbacks: string[] = [];

	constructor() {
		super("/tmp/provider-fallback-test", [], { daemon: false });
	}

	override async fallbackContext(context: Context, _model: Model): Promise<Context> {
		const channel = channelOf(context);
		this.fallbacks.push(channel);
		if (channel === "native") return imageContext("url");
		return imageContext("inline");
	}
}

function scriptedStream(kind: "error" | "success" | "content-error"): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message("") });
		if (kind === "success") {
			stream.push({ type: "done", reason: "stop", message: message("ok") });
			return;
		}
		if (kind === "content-error") {
			stream.push({ type: "text_start", contentIndex: 0, partial: message("") });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: message("partial") });
		}
		stream.push({ type: "error", reason: "error", error: message("", "error") });
	});
	return stream;
}

async function eventTypes(stream: AssistantMessageEventStream): Promise<string[]> {
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	return events;
}

describe("provider-file stream fallback", () => {
	it("recovers native to URL to inline without duplicate start events", async () => {
		const calls: string[] = [];
		const base: StreamFn = (_model, context) => {
			const channel = channelOf(context);
			calls.push(channel);
			return scriptedStream(channel === "inline" ? "success" : "error");
		};
		const service = new FakeFallbackService();
		const wrapped = wrapStreamFnWithBlobUrlFallback(base, service);

		const events = await eventTypes(await wrapped(model, imageContext("native")));

		expect(calls).toEqual(["native", "url", "inline"]);
		expect(service.fallbacks).toEqual(["native", "url"]);
		expect(events).toEqual(["start", "done"]);
	});

	it("removes a rejected native handle and stops after URL succeeds", async () => {
		const seen: Context[] = [];
		const base: StreamFn = (_model, context) => {
			seen.push(context);
			return scriptedStream(seen.length === 1 ? "error" : "success");
		};
		const service = new FakeFallbackService();
		const wrapped = wrapStreamFnWithBlobUrlFallback(base, service);

		expect(await eventTypes(await wrapped(model, imageContext("native")))).toEqual(["start", "done"]);
		expect(seen.map(channelOf)).toEqual(["native", "url"]);
		expect(service.fallbacks).toEqual(["native"]);
	});

	it("never retries after content has been emitted", async () => {
		const calls: string[] = [];
		const base: StreamFn = (_model, context) => {
			calls.push(channelOf(context));
			return scriptedStream("content-error");
		};
		const service = new FakeFallbackService();
		const wrapped = wrapStreamFnWithBlobUrlFallback(base, service);

		const events = await eventTypes(await wrapped(model, imageContext("native")));

		expect(calls).toEqual(["native"]);
		expect(service.fallbacks).toEqual([]);
		expect(events).toEqual(["start", "text_start", "text_delta", "error"]);
	});
});

const anthropicModel: Model = buildModel({
	id: "claude-opus-4-8",
	name: "claude-opus-4-8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

/**
 * Two lazy frames published as `{ data: "", url }` — the shape
 * `blob-broker/service.ts` `frameSink` produces. They carry no inline bytes, so
 * the transform pipeline's byte clamp had nothing to charge them against.
 */
function lazyFrameContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: [{ type: "image", data: "", mimeType: "image/png", url: "https://frames.test/0" }],
				timestamp: 0,
			},
			{
				role: "user",
				content: [{ type: "image", data: "", mimeType: "image/png", url: "https://frames.test/1" }],
				timestamp: 1,
			},
		],
	};
}

/** Materializes both frames inline at 60% of the byte budget each — 1.2x the cap. */
class OversizedMaterializingService extends ImageUrlService {
	constructor() {
		super("/tmp/provider-fallback-oversized-test", [], { daemon: false });
	}

	override async fallbackContext(_context: Context, _model: Model): Promise<Context> {
		const chunk = Math.ceil(providerImageByteBudget("anthropic") * 0.6);
		const frame = (tag: string) => ({
			type: "image" as const,
			data: tag + "x".repeat(chunk - 1),
			mimeType: "image/png",
		});
		return {
			messages: [
				{ role: "user", content: [frame("0")], timestamp: 0 },
				{ role: "user", content: [frame("1")], timestamp: 1 },
			],
		};
	}
}

function inlineImageBytes(context: Context): number {
	let total = 0;
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") total += part.data.length;
		}
	}
	return total;
}

describe("byte budget on materialized fallback images", () => {
	it("re-clamps images the URL fallback materializes inline", async () => {
		// `base` here is the low-level provider stream fn: the fallback calls it
		// directly, so the Agent's transform pipeline (where the byte clamp runs)
		// never sees the materialized bytes.
		const seen: Context[] = [];
		const base: StreamFn = (_model, context) => {
			seen.push(context);
			return scriptedStream(seen.length === 1 ? "error" : "success");
		};
		const wrapped = wrapStreamFnWithBlobUrlFallback(base, new OversizedMaterializingService());

		expect(await eventTypes(await wrapped(anthropicModel, lazyFrameContext()))).toEqual(["start", "done"]);

		const retried = seen[1];
		if (!retried) throw new Error("expected an inline retry");
		// Unclamped, the recovery request carries 1.2x the byte budget and 413s —
		// the very failure this fallback exists to recover from.
		expect(inlineImageBytes(retried)).toBeLessThanOrEqual(providerImageByteBudget("anthropic"));
		expect(retried.messages[0]?.content).toEqual([{ type: "text", text: "[image omitted: provider image limit]" }]);
	});
});

/**
 * Materializes 21 oversized-but-low-detail frames: one past Anthropic's
 * many-image threshold, huge before its 2000px downscale and small after.
 */
class OversizedManyImageService extends ImageUrlService {
	constructor() {
		super("/tmp/provider-fallback-many-image-test", [], { daemon: false });
	}

	override async fallbackContext(_context: Context, _model: Model): Promise<Context> {
		const data = Buffer.from(smoothDecodablePng(2400)).toString("base64");
		return {
			messages: Array.from({ length: 21 }, (_, index) => ({
				role: "user" as const,
				content: [{ type: "image" as const, data, mimeType: "image/png" }],
				timestamp: index,
			})),
		};
	}
}

describe("provider sizing on materialized fallback images", () => {
	it("downscales before charging the byte budget", async () => {
		// This path re-spelled only the pipeline's LAST stage, so it charged
		// pre-resize bytes: `streamAnthropic` downsizes the survivors afterward,
		// meaning a recovery request whose resized payload fits still lost its
		// oldest images. It now goes through the shared helper, which runs the
		// provider size pass first.
		const seen: Context[] = [];
		const base: StreamFn = (_model, context) => {
			seen.push(context);
			return scriptedStream(seen.length === 1 ? "error" : "success");
		};
		const wrapped = wrapStreamFnWithBlobUrlFallback(base, new OversizedManyImageService());

		expect(await eventTypes(await wrapped(anthropicModel, lazyFrameContext()))).toEqual(["start", "done"]);

		const retried = seen[1];
		if (!retried) throw new Error("expected an inline retry");
		// Every frame survives, and the payload sent fits — measured post-resize.
		expect(imageCount(retried)).toBe(21);
		expect(inlineImageBytes(retried)).toBeLessThanOrEqual(providerImageByteBudget("anthropic"));
	});
});

function imageCount(context: Context): number {
	let count = 0;
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) if (part.type === "image") count++;
	}
	return count;
}
