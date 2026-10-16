import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { type AnthropicOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { PromptCacheDebugJournal } from "@oh-my-pi/pi-ai/utils/prompt-cache-debug";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { CacheWarmer } from "../src/session/cache-warmer";

const CACHE_READ = 90_000;

// A 10.002s lifetime makes the warmer refresh ~2ms after `start`, so the
// replay runs on real timers through the real Anthropic provider.
const model = buildModel({
	id: "claude-sonnet-5",
	name: "Claude Sonnet 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8_192,
}) as Model<"anthropic-messages">;
// The catalog entry for this id supplies its own lifetimes, so override after building.
model.promptCache = { short: 10.002 };

const context: Context = {
	systemPrompt: ["stable system prompt"],
	messages: [{ role: "user", content: "keep this prefix warm", timestamp: 1 }],
};

type Body = "generate" | "network-error";

function sse(event: Record<string, unknown>): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Anthropic SSE that reports cache usage on `message_start`, then either keeps
 * generating until the request is aborted or drops the connection. Chunks are
 * produced on demand so the usage is consumed before any failure lands.
 */
function anthropicFetch(body: Body): FetchImpl {
	const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const encoder = new TextEncoder();
		const chunks = [
			{
				type: "message_start",
				message: {
					id: "msg_warm",
					model: model.id,
					usage: {
						input_tokens: 7,
						output_tokens: 1,
						cache_read_input_tokens: CACHE_READ,
						cache_creation_input_tokens: 0,
					},
				},
			},
			...(body === "generate"
				? [
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "generating" } },
					]
				: []),
		].map(event => encoder.encode(sse(event)));
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks.shift();
				if (chunk) {
					controller.enqueue(chunk);
					return;
				}
				if (body === "network-error") {
					controller.error(new TypeError("socket hang up"));
					return;
				}
				// The model keeps generating until the caller hangs up: the provider
				// either aborts the request signal or cancels the body reader.
				const { promise, resolve } = Promise.withResolvers<void>();
				const signal = init?.signal;
				const onAbort = () => {
					controller.error(signal?.reason);
					resolve();
				};
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				return promise;
			},
		});
		return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
	};
	return Object.assign(fetchImpl, { preconnect: fetch.preconnect }) as FetchImpl;
}

function providerOptions(journal: PromptCacheDebugJournal, body: Body): AnthropicOptions {
	return {
		fetch: anthropicFetch(body),
		providerOptions: { promptCacheDiagnosticJournal: journal },
		providerRetryWait: async () => {},
	};
}

interface WarmRefresh {
	/** Final message of the provider stream the warmer opened. */
	provider: AssistantMessage;
	/** Message the warmer reported to `onWarmed`, when it reported one. */
	warmed: AssistantMessage | undefined;
}

/**
 * Runs exactly one real warm refresh. The model's ~10s lifetime makes the
 * warmer schedule it ~2ms out on the real clock: the replay must run through
 * the real provider's SSE parsing and abort handling, which fake timers stall.
 */
async function warmOnce(journal: PromptCacheDebugJournal, body: Body): Promise<WarmRefresh> {
	const opened = Promise.withResolvers<AssistantMessage>();
	const warmer = new CacheWarmer({
		stream: (streamModel, streamContext, options) => {
			const stream = streamAnthropic(streamModel as Model<"anthropic-messages">, streamContext, {
				...(options as AnthropicOptions),
				...providerOptions(journal, body),
			});
			opened.resolve(stream.result());
			return stream;
		},
		getPromptTokens: () => CACHE_READ,
		getMode: () => "streaming",
	});
	let warmed: AssistantMessage | undefined;
	const reported = Promise.withResolvers<void>();
	warmer.onWarmed = message => {
		warmed = message;
		reported.resolve();
	};
	const request: SimpleStreamOptions = {
		apiKey: "sk-ant-test",
		cacheRetention: "short",
		sessionId: "cache-warmer-diagnostics",
	};
	warmer.start({ model, context, options: request }, () => true);
	const provider = await opened.promise;
	// A cutoff replay carries usage, so the warmer reports it; wait for that
	// before cancelling so the next refresh is never armed.
	if (body === "generate") await reported.promise;
	warmer.cancel();
	return { provider, warmed };
}

function realRequestOptions(journal: PromptCacheDebugJournal, signal?: AbortSignal): AnthropicOptions {
	return {
		apiKey: "sk-ant-test",
		cacheRetention: "short",
		sessionId: "cache-warmer-diagnostics",
		signal,
		...providerOptions(journal, "generate"),
	};
}

describe("cache warmer prompt-cache diagnostics", () => {
	let previousDebug: string | undefined;
	let previousRetention: string | undefined;
	let previousBaseUrl: string | undefined;

	beforeEach(() => {
		previousDebug = Bun.env.PI_PROMPT_CACHE_DEBUG;
		previousRetention = Bun.env.PI_CACHE_RETENTION;
		previousBaseUrl = Bun.env.ANTHROPIC_BASE_URL;
		Bun.env.PI_PROMPT_CACHE_DEBUG = "1";
		delete Bun.env.PI_CACHE_RETENTION;
		delete Bun.env.ANTHROPIC_BASE_URL;
	});

	afterEach(() => {
		for (const [key, value] of [
			["PI_PROMPT_CACHE_DEBUG", previousDebug],
			["PI_CACHE_RETENTION", previousRetention],
			["ANTHROPIC_BASE_URL", previousBaseUrl],
		] as const) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	test("a warm replay cut off at generation records the observed cache usage as a cutoff", async () => {
		const journal = new PromptCacheDebugJournal();
		const { provider, warmed } = await warmOnce(journal, "generate");

		expect(provider.stopReason).toBe("aborted");
		expect(warmed?.stopReason).toBe("aborted");
		expect(warmed?.usage.cacheRead).toBe(CACHE_READ);
		expect(journal.records).toHaveLength(1);
		const record = journal.records[0];
		expect(record).toMatchObject({
			outcome: "cutoff",
			status: 200,
			errorCode: null,
			usage: { input: 7, cacheRead: CACHE_READ, cacheWrite: 0, output: 1 },
		});

		// The warm touched the cache, so it is the baseline the next real request
		// is classified against: a full miss right after it is an observed reset.
		const miss = streamAnthropic(model, context, {
			...realRequestOptions(journal),
			fetch: Object.assign(
				async () =>
					new Response(
						[
							{
								type: "message_start",
								message: {
									id: "msg_real",
									model: model.id,
									usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0 },
								},
							},
							{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
							{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
							{ type: "content_block_stop", index: 0 },
							{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
							{ type: "message_stop" },
						]
							.map(sse)
							.join(""),
						{ headers: { "Content-Type": "text/event-stream" } },
					),
				{ preconnect: fetch.preconnect },
			) as FetchImpl,
		});
		expect((await miss.result()).stopReason).toBe("stop");
		expect(journal.records[1]).toMatchObject({
			outcome: "success",
			reset: { observed: true, previousSequence: record?.sequence },
		});
	});

	test("an ordinary caller abort after cache usage stays an aborted failure without usage", async () => {
		const journal = new PromptCacheDebugJournal();
		const controller = new AbortController();
		const stream = streamAnthropic(model, context, realRequestOptions(journal, controller.signal));
		for await (const event of stream) {
			if (event.type === "text_start") {
				controller.abort();
				break;
			}
		}
		expect((await stream.result()).stopReason).toBe("aborted");
		expect(journal.records).toHaveLength(1);
		expect(journal.records[0]).toMatchObject({
			outcome: "error",
			usage: { input: null, cacheRead: null, cacheWrite: null, output: null },
		});
		expect(journal.records[0]?.errorCode).not.toBeNull();
	});

	test("a warm replay whose connection drops records failures, never a cutoff", async () => {
		const journal = new PromptCacheDebugJournal();
		const { provider } = await warmOnce(journal, "network-error");

		expect(provider.stopReason).toBe("error");
		expect(journal.records.length).toBeGreaterThan(0);
		for (const record of journal.records) {
			expect(record).toMatchObject({
				outcome: "error",
				usage: { input: null, cacheRead: null, cacheWrite: null, output: null },
			});
		}
	});
});
