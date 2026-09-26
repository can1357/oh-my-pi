import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { Context, FetchImpl, Model, ProviderSessionState, ToolChoice } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

/**
 * #12597 — a pinned forced `tool_choice` is incompatible with the zero-output
 * cache-refresh replay: Anthropic rejects `tool_choice: tool|any` paired with
 * `max_tokens: 0` (400 invalid_request_error). Stripping the choice from the
 * replay is not a way out either — any `tool_choice` change invalidates the
 * messages cache (platform.claude.com prompt-caching docs), so the replay
 * would write a newly billed messages entry instead of refreshing the pinned
 * one, failing the refresh plan's `cacheRead > 0 && cacheWrite === 0` contract.
 *
 * The keep-alive must therefore skip zero-output refreshes captured from
 * forced-choice turns, while compatible payloads replay unchanged (identical
 * `tool_choice` on the wire ⇒ identical messages cache key ⇒ pure read).
 */

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

const context: Context = {
	messages: [{ role: "user", content: "Keep this prefix warm.", timestamp: 1 }],
};

interface FetchCapture {
	bodies: MessageCreateParams[];
}

const stateMaps: Array<Map<string, ProviderSessionState>> = [];

function createProviderSessionState(): Map<string, ProviderSessionState> {
	const states = new Map<string, ProviderSessionState>();
	stateMaps.push(states);
	return states;
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

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const body = `${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_tool_choice_refresh" },
	});
}

function ordinaryWriteResponse(): Response {
	return sseResponse([
		{ type: "message_start", message: { id: "msg_ordinary", usage: usage(0, CACHE_TOKENS, 0) } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usage(0, CACHE_TOKENS, 1) },
		{ type: "message_stop" },
	]);
}

function refreshReadResponse(): Response {
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
			headers: { "Content-Type": "application/json", "request-id": "req_tool_choice_refresh" },
		},
	);
}

/**
 * OAuth requests are re-encoded to a `Uint8Array` by `wrapFetchForCch`, so
 * decode both shapes.
 */
function readRequestBody(body: unknown): MessageCreateParams {
	const text = body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? "{}");
	return JSON.parse(text) as MessageCreateParams;
}

function createFetch(modes: Array<"ordinary-write" | "refresh-read">, capture: FetchCapture): FetchImpl {
	return async (_input, init) => {
		capture.bodies.push(readRequestBody(init?.body));
		return modes[capture.bodies.length - 1] === "refresh-read" ? refreshReadResponse() : ordinaryWriteResponse();
	};
}

async function finishRequest(
	fetch: FetchImpl,
	providerSessionState: Map<string, ProviderSessionState>,
	toolChoice?: ToolChoice,
): Promise<void> {
	const stream = streamSimple(model, context, {
		fetch,
		apiKey: "test-anthropic-key",
		anthropicCacheRefresh: true,
		providerSessionState,
		sessionId: "cache-refresh-tool-choice-session",
		...(toolChoice !== undefined ? { toolChoice } : {}),
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

afterEach(() => {
	for (const states of stateMaps.splice(0)) {
		for (const state of states.values()) state.close();
		states.clear();
	}
	vi.useRealTimers();
	vi.restoreAllMocks();
});

withOfficialAnthropicEndpoint();

describe("Anthropic cache refresh with pinned tool_choice (#12597)", () => {
	it("skips the zero-output refresh when the captured turn pinned tool_choice", async () => {
		vi.useFakeTimers();
		const capture: FetchCapture = { bodies: [] };
		const fetch = createFetch(["ordinary-write"], capture);
		const states = createProviderSessionState();

		await finishRequest(fetch, states, { type: "tool", name: "_yield" });
		expect(capture.bodies[0]?.tool_choice).toEqual({ type: "tool", name: "_yield" });

		vi.advanceTimersByTime(CACHE_REFRESH_DELAY_MS * 2);
		await Promise.resolve();
		await Promise.resolve();

		// Replaying with `max_tokens: 0` would 400, and stripping the pinned
		// `tool_choice` would invalidate the messages cache and bill a fresh
		// write, so no keep-alive request may go out at all.
		expect(capture.bodies).toHaveLength(1);
	});

	it("replays a compatible tool_choice unchanged so the cache key is preserved", async () => {
		vi.useFakeTimers();
		const capture: FetchCapture = { bodies: [] };
		const fetch = createFetch(["ordinary-write", "refresh-read"], capture);
		const states = createProviderSessionState();

		await finishRequest(fetch, states, "auto");
		vi.advanceTimersByTime(CACHE_REFRESH_DELAY_MS);
		await drainUntil(() => capture.bodies.length >= 2, "Compatible refresh did not fire");

		const refresh = capture.bodies[1];
		expect(refresh?.max_tokens).toBe(0);
		expect(refresh?.stream).toBe(false);
		// Identical tool_choice to the captured payload ⇒ identical messages
		// cache key; the refresh stays a pure cache read.
		expect(refresh?.tool_choice).toEqual({ type: "auto" });
	});
});
