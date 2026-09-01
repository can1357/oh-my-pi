import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { CacheControlEphemeral, MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { CacheRetention, Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

const CACHE_REFRESH_DELAY_MS = 5 * 60_000 - 15_000;
const CACHE_TOKENS = 1_200;

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const thinkingModel: Model<"anthropic-messages"> = buildModel({
	...model,
	reasoning: true,
});

const context: Context = {
	messages: [{ role: "user", content: "Keep this prefix warm.", timestamp: 1 }],
};

type ResponseMode = "ordinary-write" | "ordinary-roll" | "refresh-read" | "thinking-refresh";

interface FetchCapture {
	bodies: MessageCreateParams[];
	thinkingRefreshAborted: boolean;
}

const stateMaps: Array<Map<string, ProviderSessionState>> = [];

function createProviderSessionState(): Map<string, ProviderSessionState> {
	const states = new Map<string, ProviderSessionState>();
	stateMaps.push(states);
	return states;
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const body = `${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_cache_refresh" },
	});
}

function usage(cacheRead: number, cacheWrite: number, output: number): Record<string, unknown> {
	return {
		input_tokens: 0,
		output_tokens: output,
		cache_read_input_tokens: cacheRead,
		cache_creation_input_tokens: cacheWrite,
		cache_creation: {
			ephemeral_5m_input_tokens: cacheWrite,
			ephemeral_1h_input_tokens: 0,
		},
	};
}

function ordinaryResponse(mode: "ordinary-write" | "ordinary-roll"): Response {
	const cacheRead = mode === "ordinary-roll" ? CACHE_TOKENS : 0;
	return sseResponse([
		{
			type: "message_start",
			message: {
				id: "msg_ordinary",
				usage: usage(cacheRead, CACHE_TOKENS, 0),
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: usage(cacheRead, CACHE_TOKENS, 1),
		},
		{ type: "message_stop" },
	]);
}

function refreshResponse(): Response {
	return new Response(
		JSON.stringify({
			id: "msg_refresh",
			type: "message",
			role: "assistant",
			model: model.id,
			content: [],
			stop_reason: "end_turn",
			usage: usage(CACHE_TOKENS, 0, 0),
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json", "request-id": "req_cache_refresh" },
		},
	);
}

function thinkingRefreshResponse(signal: AbortSignal | null | undefined, capture: FetchCapture): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const events = [
				{
					type: "message_start",
					message: { id: "msg_thinking_refresh", usage: usage(CACHE_TOKENS, 0, 0) },
				},
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "", signature: "" },
				},
			];
			controller.enqueue(
				encoder.encode(
					`${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
				),
			);
			const closeOnAbort = () => {
				capture.thinkingRefreshAborted = true;
				controller.close();
			};
			if (signal?.aborted) closeOnAbort();
			else signal?.addEventListener("abort", closeOnAbort, { once: true });
		},
		cancel() {
			capture.thinkingRefreshAborted = true;
		},
	});
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_thinking_refresh" },
	});
}

function createFetch(modes: ResponseMode[], capture: FetchCapture): FetchImpl {
	return async (input, init) => {
		const body: MessageCreateParams = JSON.parse(String(init?.body ?? "{}"));
		capture.bodies.push(body);
		const mode = modes[capture.bodies.length - 1];
		switch (mode) {
			case "ordinary-write":
			case "ordinary-roll":
				return ordinaryResponse(mode);
			case "refresh-read":
				return refreshResponse();
			case "thinking-refresh":
				return thinkingRefreshResponse(input instanceof Request ? input.signal : init?.signal, capture);
		}
	};
}

interface FinishRequestOptions {
	anthropicCacheRefresh?: boolean;
	cacheRetention?: CacheRetention;
	model?: Model<"anthropic-messages">;
	sessionId?: string;
}

async function finishRequest(
	fetch: FetchImpl,
	providerSessionState: Map<string, ProviderSessionState>,
	options: FinishRequestOptions = {},
): Promise<void> {
	const requestModel = options.model ?? model;
	const stream = streamSimple(requestModel, context, {
		fetch,
		apiKey: "test-anthropic-key",
		anthropicCacheRefresh: options.anthropicCacheRefresh ?? true,
		cacheRetention: options.cacheRetention,
		providerSessionState,
		sessionId: options.sessionId ?? "cache-refresh-test-session",
	});
	for await (const _event of stream) {
		// Drain the public response before the idle gap begins.
	}
	await stream.result();
}

async function drainUntil(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(message);
}

async function advanceToRefresh(capture: FetchCapture, expectedRequests: number): Promise<void> {
	vi.advanceTimersByTime(CACHE_REFRESH_DELAY_MS);
	await drainUntil(
		() => capture.bodies.length >= expectedRequests,
		`Expected ${expectedRequests} Anthropic requests, saw ${capture.bodies.length}`,
	);
}

afterEach(() => {
	for (const states of stateMaps.splice(0)) {
		for (const state of states.values()) state.close();
		states.clear();
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
});

withOfficialAnthropicEndpoint();

describe("Anthropic prompt-cache refresh", () => {
	it("replays max_tokens=0 once per interval and stops after three refreshes", async () => {
		vi.useFakeTimers();
		const capture: FetchCapture = { bodies: [], thinkingRefreshAborted: false };
		const fetch = createFetch(["ordinary-write", "refresh-read", "refresh-read", "refresh-read"], capture);
		const states = createProviderSessionState();

		await finishRequest(fetch, states);
		for (let requestCount = 2; requestCount <= 4; requestCount++) {
			await advanceToRefresh(capture, requestCount);
		}
		vi.advanceTimersByTime(CACHE_REFRESH_DELAY_MS * 2);
		await Promise.resolve();

		expect(capture.bodies).toHaveLength(4);
		for (const refresh of capture.bodies.slice(1)) {
			expect(refresh.max_tokens).toBe(0);
			expect(refresh.stream).toBe(false);
		}
	});

	it("resets the idle gap when another normal request starts", async () => {
		vi.useFakeTimers();
		const capture: FetchCapture = { bodies: [], thinkingRefreshAborted: false };
		const fetch = createFetch(["ordinary-write", "ordinary-roll", "refresh-read"], capture);
		const states = createProviderSessionState();

		await finishRequest(fetch, states);
		vi.advanceTimersByTime(CACHE_REFRESH_DELAY_MS - 1);
		await finishRequest(fetch, states);
		vi.advanceTimersByTime(CACHE_REFRESH_DELAY_MS - 1);
		await Promise.resolve();
		expect(capture.bodies).toHaveLength(2);

		vi.advanceTimersByTime(1);
		await drainUntil(() => capture.bodies.length === 3, "Replacement idle timer did not refresh");
		expect(capture.bodies).toHaveLength(3);
	});

	it("keeps refresh ownership with the main turn when a side request shares provider state", async () => {
		vi.useFakeTimers();
		const capture: FetchCapture = { bodies: [], thinkingRefreshAborted: false };
		const fetch = createFetch(["ordinary-write", "ordinary-roll", "refresh-read"], capture);
		const states = createProviderSessionState();
		const halfInterval = Math.floor(CACHE_REFRESH_DELAY_MS / 2);

		await finishRequest(fetch, states);
		vi.advanceTimersByTime(halfInterval);
		await finishRequest(fetch, states, {
			anthropicCacheRefresh: false,
			sessionId: "cache-refresh-test-session:side:1",
		});
		vi.advanceTimersByTime(CACHE_REFRESH_DELAY_MS - halfInterval);
		await drainUntil(() => capture.bodies.length === 3, "Main idle timer did not refresh");

		vi.advanceTimersByTime(halfInterval);
		await Promise.resolve();
		expect(capture.bodies).toHaveLength(3);
	});

	it("treats omitted adaptive thinking as active and aborts at the first generated block", async () => {
		vi.useFakeTimers();
		const capture: FetchCapture = { bodies: [], thinkingRefreshAborted: false };
		const fetch = createFetch(["ordinary-write", "thinking-refresh"], capture);
		const states = createProviderSessionState();

		await finishRequest(fetch, states, { model: thinkingModel });
		await advanceToRefresh(capture, 2);
		await drainUntil(() => capture.thinkingRefreshAborted, "Thinking refresh was not aborted");

		expect(capture.bodies[1]?.thinking).toBeUndefined();
		expect(capture.bodies[1]?.output_config?.effort).toBe("low");
		expect(capture.bodies[1]?.max_tokens).toBeGreaterThan(0);
		expect(capture.bodies[1]?.stream).toBe(true);
		expect(capture.thinkingRefreshAborted).toBe(true);
	});

	it("skips keep-alive refreshes and emits 1h breakpoints when retention is long", async () => {
		vi.useFakeTimers();
		const capture: FetchCapture = { bodies: [], thinkingRefreshAborted: false };
		const fetch = createFetch(["ordinary-write"], capture);
		const states = createProviderSessionState();

		await finishRequest(fetch, states, { cacheRetention: "long" });
		vi.advanceTimersByTime(CACHE_REFRESH_DELAY_MS * 2);
		await Promise.resolve();

		// No zero-output replay was scheduled for the 1h entry.
		expect(capture.bodies).toHaveLength(1);
		const blocks = (capture.bodies[0]?.messages ?? []).flatMap(message =>
			Array.isArray(message.content) ? message.content : [],
		);
		const breakpoints = blocks
			.map(block => ("cache_control" in block ? (block.cache_control ?? undefined) : undefined))
			.filter((cc): cc is CacheControlEphemeral => cc != null);
		expect(breakpoints.length).toBeGreaterThan(0);
		for (const cc of breakpoints) {
			expect(cc.ttl).toBe("1h");
		}
	});
});
