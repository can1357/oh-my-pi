import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model, Usage } from "@oh-my-pi/pi-ai/types";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { encodeBedrockFrame as encodeBedrockTestFrame } from "../../ai/test/helpers/bedrock-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { isRecord } from "@oh-my-pi/pi-utils";
import { CacheWarmer, type CacheWarmStream, type CacheWarmingRefreshEnd } from "../src/session/cache-warmer";

const PROMPT_TOKENS = 100_000;
// buildModel reapplies catalog TTLs; this fixture resets it for a 1ms timer.
const ACCELERATED_CACHE_TTL_SECONDS = 10.001;
const CONTEXT: Context = {
	systemPrompt: ["Keep this system prefix."],
	messages: [{ role: "user", content: "Keep this user prefix.", timestamp: 1 }],
};

interface WireCapture {
	url?: string;
	payload?: Record<string, unknown>;
	signal?: AbortSignal;
	aborted: boolean;
	bodyCanceled?: boolean;
	terminalMetadataSent: boolean;
}

async function captureRequest(capture: WireCapture, input: string | URL | Request, init?: RequestInit): Promise<void> {
	const request =
		input instanceof Request
			? new Request(input, init)
			: new Request(input instanceof URL ? input.href : input, init);
	capture.url = request.url;
	capture.signal = request.signal;
	const payload: unknown = await request.clone().json();
	if (!isRecord(payload)) throw new Error("Expected provider request payload object");
	capture.payload = payload;
}

function encodeBedrockFrame(eventType: string, payload: unknown): Uint8Array {
	return encodeBedrockTestFrame(
		{
			":message-type": "event",
			":event-type": eventType,
			":content-type": "application/json",
		},
		new TextEncoder().encode(JSON.stringify(payload)),
	);
}

function afterConsumerAdvances(
	source: CacheWarmStream,
	eventType: AssistantMessageEvent["type"],
	onAdvance: () => void,
): CacheWarmStream {
	return {
		async *[Symbol.asyncIterator]() {
			const iterator = source[Symbol.asyncIterator]();
			let releasePending = false;
			while (true) {
				if (releasePending) {
					releasePending = false;
					onAdvance();
				}
				const next = await iterator.next();
				if (next.done) return;
				yield next.value;
				if (next.value.type === eventType) releasePending = true;
			}
		},
		result: () => source.result(),
	};
}

function makeConverseModel(): Model<"bedrock-converse-stream"> {
	const model = buildModel({
		id: "us.anthropic.claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		thinking: { mode: "anthropic-adaptive", efforts: [Effort.High], supportsDisplay: true },
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200_000,
		maxTokens: 128_000,
		compat: {
			promptCacheMode: "explicit",
			supportsLongPromptCacheRetention: false,
			promptCacheMinimumTokens: 0,
			promptCacheMaximumCheckpoints: 2,
		},
	});
	model.promptCache = { ...model.promptCache, short: ACCELERATED_CACHE_TTL_SECONDS };
	return model;
}

function makeConverseFetch(capture: WireCapture, terminalGate: PromiseWithResolvers<void>, usage: Usage): FetchImpl {
	const initial = [
		encodeBedrockFrame("messageStart", { role: "assistant" }),
		encodeBedrockFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "x" } }),
	];
	const terminal = [
		encodeBedrockFrame("contentBlockStop", { contentBlockIndex: 0 }),
		encodeBedrockFrame("messageStop", { stopReason: "end_turn" }),
		encodeBedrockFrame("metadata", {
			usage: {
				inputTokens: usage.input,
				outputTokens: usage.output,
				cacheReadInputTokens: usage.cacheRead,
				cacheWriteInputTokens: usage.cacheWrite,
				totalTokens: usage.totalTokens,
			},
		}),
	];
	const fetchImpl: FetchImpl = async (input, init) => {
		await captureRequest(capture, input, init);
		capture.signal?.addEventListener(
			"abort",
			() => {
				capture.aborted = true;
				terminalGate.resolve();
			},
			{ once: true },
		);
		let tailSent = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of initial) controller.enqueue(frame);
			},
			async pull(controller) {
				if (tailSent) return;
				tailSent = true;
				await terminalGate.promise;
				if (capture.signal?.aborted) {
					controller.close();
					return;
				}
				for (const frame of terminal) controller.enqueue(frame);
				capture.terminalMetadataSent = true;
				controller.close();
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
	};
	return fetchImpl;
}

function createConverseHarness(usage: Usage, deferTerminal = false) {
	const model = makeConverseModel();
	const capture: WireCapture = { aborted: false, terminalMetadataSent: false };
	const terminalAdvanced = Promise.withResolvers<void>();
	const refreshEnded = Promise.withResolvers<CacheWarmingRefreshEnd>();
	const warmed: AssistantMessage[] = [];
	let payloadHooks = 0;
	const warmer = new CacheWarmer({
		stream: (requestModel, context, options) => {
			const terminalGate = Promise.withResolvers<void>();
			const source = streamSimple(requestModel, context, {
				...options,
				fetch: makeConverseFetch(capture, terminalGate, usage),
			});
			return afterConsumerAdvances(source, "text_start", () => {
				terminalAdvanced.resolve();
				if (!deferTerminal) terminalGate.resolve();
			});
		},
		getPromptTokens: () => PROMPT_TOKENS,
		getMode: () => "streaming",
	});
	warmers.add(warmer);
	warmer.onWarmed = message => warmed.push(message);
	warmer.onRefreshEnd = refreshEnded.resolve;
	warmer.start(
		{
			model,
			context: CONTEXT,
			options: {
				cacheRetention: "long",
				reasoning: Effort.High,
				providerOptions: { bearerToken: "test-bedrock-token" },
				onPayload: payload => {
					payloadHooks++;
					return payload;
				},
			},
		},
		() => true,
	);
	return {
		warmer,
		model,
		capture,
		terminalAdvanced: terminalAdvanced.promise,
		refreshEnded: refreshEnded.promise,
		warmed,
		get payloadHooks() {
			return payloadHooks;
		},
	};
}

function makeAnthropicModel(
	provider: "amazon-bedrock" | "bedrock-mantle",
	baseUrl: string,
): Model<"anthropic-messages"> {
	const model = buildModel({
		id: "anthropic.claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200_000,
		maxTokens: 128_000,
		compat: { supportsLongCacheRetention: false },
	});
	model.promptCache = { ...model.promptCache, short: ACCELERATED_CACHE_TTL_SECONDS };
	return model;
}

function anthropicEvent(type: string, data: unknown): Uint8Array {
	return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function makeMessagesFetch(capture: WireCapture, terminalGate: PromiseWithResolvers<void>): FetchImpl {
	const fetchImpl: FetchImpl = async (input, init) => {
		await captureRequest(capture, input, init);
		const onAbort = () => {
			capture.aborted = true;
			terminalGate.resolve();
		};
		capture.signal?.addEventListener("abort", onAbort, { once: true });
		if (capture.signal?.aborted) onAbort();
		let stage = 0;
		let bodyCanceled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					anthropicEvent("message_start", {
						type: "message_start",
						message: {
							id: "msg_1",
							type: "message",
							role: "assistant",
							content: [],
							model: "anthropic.claude-opus-5-5",
							stop_reason: null,
							stop_sequence: null,
							usage: {
								input_tokens: 1,
								output_tokens: 0,
								cache_read_input_tokens: PROMPT_TOKENS,
								cache_creation_input_tokens: 0,
							},
						},
					}),
				);
			},
			async pull(controller) {
				if (stage === 0) {
					stage = 1;
					controller.enqueue(
						anthropicEvent("content_block_start", {
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "" },
						}),
					);
					controller.enqueue(
						anthropicEvent("content_block_delta", {
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "x" },
						}),
					);
					return;
				}
				if (stage === 1) {
					stage = 2;
					await terminalGate.promise;
					if (capture.signal?.aborted || bodyCanceled) {
						if (!bodyCanceled) controller.close();
						return;
					}
					const chunks = [
						anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
						anthropicEvent("message_delta", {
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 1 },
						}),
						anthropicEvent("message_stop", { type: "message_stop" }),
					];
					const joined = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
					let offset = 0;
					for (const chunk of chunks) {
						joined.set(chunk, offset);
						offset += chunk.length;
					}
					controller.enqueue(joined);
					capture.terminalMetadataSent = true;
					controller.close();
				}
			},
			cancel() {
				bodyCanceled = true;
				capture.bodyCanceled = true;
				terminalGate.resolve();
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return fetchImpl;
}

function createMessagesHarness(provider: "amazon-bedrock" | "bedrock-mantle", baseUrl: string) {
	const model = makeAnthropicModel(provider, baseUrl);
	const capture: WireCapture = { aborted: false, terminalMetadataSent: false };
	const refreshEnded = Promise.withResolvers<CacheWarmingRefreshEnd>();
	const warmer = new CacheWarmer({
		stream: (requestModel, context, options) => {
			const terminalGate = Promise.withResolvers<void>();
			return streamSimple(requestModel, context, {
				...options,
				fetch: makeMessagesFetch(capture, terminalGate),
			});
		},
		getPromptTokens: () => PROMPT_TOKENS,
		getMode: () => "streaming",
	});
	warmers.add(warmer);
	warmer.onRefreshEnd = refreshEnded.resolve;
	warmer.start(
		{
			model,
			context: CONTEXT,
			options: {
				cacheRetention: "long",
				...(provider === "amazon-bedrock" ? { apiKey: "bedrock-runtime-api-key" } : {}),
				...(provider === "bedrock-mantle"
					? { providerOptions: { bearerToken: "mantle-bearer-token", region: "us-east-1" } }
					: {}),
			},
		},
		() => true,
	);
	return { warmer, model, capture, refreshEnded: refreshEnded.promise };
}

async function drain(): Promise<void> {
	for (let i = 0; i < 150; i++) await Promise.resolve();
}

async function advanceWarmTimer(): Promise<void> {
	vi.advanceTimersByTime(1);
	await drain();
}

function makeUsage(cacheRead: number, cacheWrite: number): Usage {
	return {
		input: 5,
		output: 1,
		cacheRead,
		cacheWrite,
		totalTokens: 100_006,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const warmers = new Set<CacheWarmer>();

beforeEach(() => vi.useFakeTimers());

afterEach(async () => {
	for (const warmer of warmers) warmer.cancel();
	warmers.clear();
	await drain();
	vi.useRealTimers();
});

describe("cache warmer provider replay behavior", () => {
	test("Converse waits for terminal cache usage with a one-token adaptive request and unchanged prefix/effort", async () => {
		const h = createConverseHarness(makeUsage(PROMPT_TOKENS, 0));
		// onPayload is passed through by the warmer option clone, rather than
		// being replaced by the adaptive thinking-budget override.
		await advanceWarmTimer();
		const ended = await h.refreshEnded;
		const payload = h.capture.payload;
		expect(ended.outcome).toBe("hit");
		expect(h.warmer.status.state).toBe("scheduled");
		expect(h.capture.terminalMetadataSent).toBe(true);
		expect(h.capture.aborted).toBe(false);
		expect(payload?.inferenceConfig).toMatchObject({ maxTokens: 1 });
		expect(payload?.additionalModelRequestFields).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
		});
		const requestText = JSON.stringify(payload);
		expect(requestText).toContain("Keep this system prefix.");
		expect(requestText).toContain("Keep this user prefix.");
		expect(requestText).toContain('"cachePoint":{"type":"default"}');
		expect(requestText).not.toContain('"ttl":"1h"');
		expect(h.warmed[0]?.usage.output).toBe(1);
		expect(h.payloadHooks).toBe(1);
		expect(requestText).not.toContain("budget_tokens");
		h.warmer.cancel();
	});

	test("Converse terminal cache writes stop warming after a miss", async () => {
		const h = createConverseHarness(makeUsage(0, PROMPT_TOKENS));
		await advanceWarmTimer();
		const ended = await h.refreshEnded;
		expect(ended.outcome).toBe("miss");
		expect(h.capture.terminalMetadataSent).toBe(true);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "refresh missed the cache" });
	});

	test("Converse run cancellation aborts while terminal usage is pending", async () => {
		const h = createConverseHarness(makeUsage(PROMPT_TOKENS, 0), true);
		await advanceWarmTimer();
		const reachedTerminalWait = await Promise.race([
			h.terminalAdvanced.then(() => true),
			h.refreshEnded.then(() => false),
		]);
		expect(reachedTerminalWait).toBe(true);
		expect(h.capture.signal?.aborted).toBe(false);
		h.warmer.cancel();
		const ended = await h.refreshEnded;
		expect(ended.outcome).toBe("aborted");
		await drain();
		expect(h.capture.signal?.aborted).toBe(true);
		expect(h.capture.terminalMetadataSent).toBe(false);
	});

	for (const route of [
		{
			name: "Bedrock Runtime /anthropic",
			provider: "amazon-bedrock" as const,
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
		},
		{
			name: "Bedrock Mantle /anthropic",
			provider: "bedrock-mantle" as const,
			baseUrl: "https://bedrock-mantle.{region}.api.aws/anthropic",
		},
	]) {
		test(route.name + " preserves early usage and cuts generation off", async () => {
			const h = createMessagesHarness(route.provider, route.baseUrl);
			await advanceWarmTimer();
			const ended = await h.refreshEnded;
			expect(ended.outcome).toBe("hit");
			expect(h.capture.bodyCanceled).toBe(true);
			expect(h.capture.terminalMetadataSent).toBe(false);
			expect(h.capture.url).toBe(route.baseUrl.replace("{region}", "us-east-1") + "/v1/messages");
			expect(h.capture.payload).toMatchObject({ max_tokens: 1 });
			const requestText = JSON.stringify(h.capture.payload);
			expect(requestText).toContain("Keep this user prefix.");
			expect(requestText).toContain('"type":"ephemeral"');
			expect(requestText).not.toContain('"ttl":"1h"');
			expect(h.warmer.status.state).toBe("scheduled");
			h.warmer.cancel();
		});
	}

	test("budget-based mandatory Converse reasoning is refused before a provider request", () => {
		const model = makeConverseModel();
		model.thinking = { mode: "budget", efforts: [Effort.High], requiresEffort: true };
		let streamCalls = 0;
		const warmer = new CacheWarmer({
			stream: () => {
				streamCalls++;
				throw new Error("unsafe budget-based replay was sent");
			},
			getPromptTokens: () => PROMPT_TOKENS,
			getMode: () => "streaming",
		});
		warmers.add(warmer);
		warmer.start({ model, context: CONTEXT, options: { reasoning: Effort.High } }, () => true);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "request cannot be replayed safely" });
		expect(streamCalls).toBe(0);
	});
});
