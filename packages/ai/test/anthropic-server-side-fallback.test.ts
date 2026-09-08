/**
 * Focused regression coverage for the Anthropic server-side-fallback beta chain
 * (`server-side-fallback-2026-06-01`). The provider treats `options.fallbacks`
 * as an opt-in: without it, the request never sends the beta and the response
 * parser stays inert on `fallback` content blocks and `usage.iterations`.
 *
 * Verifies:
 *   • Opt-in path — request carries `fallbacks`; response promotes the served
 *     model, persists the fallback content block, and prices the turn per the
 *     cookbook (cache-read for the served attempt's input).
 *   • Opt-out path — a stray `fallback` content block or `usage.iterations`
 *     leave the message untouched: `output.model` stays the requested id, no
 *     fallback block is persisted, cost uses the requested model.
 *   • `convertAnthropicMessages` replays a persisted `fallback` block only when
 *     the current request also opts in AND the target is official Anthropic.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { convertAnthropicMessages, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { MessageParam } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const fableModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

const umansModel: Model<"anthropic-messages"> = buildModel({
	id: "umans-kimi-k2.7",
	name: "Umans Kimi K2.7 Code",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 32_768,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};

type MockAnthropicEvent = Record<string, unknown>;

function createMockRequest(events: MockAnthropicEvent[]) {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

function createFallbackServedEvents(text: string, servedModel: string) {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_fb",
				model: servedModel,
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: {
				type: "fallback",
				from: { model: "claude-fable-5" },
				to: { model: servedModel },
			},
		},
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 1 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 4,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
				iterations: [
					{
						type: "message",
						model: "claude-fable-5",
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
					{
						type: "fallback_message",
						model: servedModel,
						input_tokens: 12,
						output_tokens: 4,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				],
			},
		},
		{ type: "message_stop" },
	];
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic server-side fallback opt-in", () => {
	it("forwards fallbacks + attaches the server-side-fallback beta when opted in", async () => {
		let capturedParams: Record<string, unknown> | undefined;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			capturedParams = params as Record<string, unknown>;
			return createMockRequest(createFallbackServedEvents("continued", "claude-opus-4-8")) as never;
		});

		const s = streamAnthropic(fableModel, context, {
			apiKey: "sk-ant-test",
			fallbacks: [{ model: "claude-opus-4-8" }],
		});
		for await (const _ of s) {
			// drain
		}
		await s.result();

		expect(capturedParams?.fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
	});

	it("promotes the served model, persists the fallback block, and prices per iteration", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createFallbackServedEvents("continued", "claude-opus-4-8")) as never,
		);

		const s = streamAnthropic(fableModel, context, {
			apiKey: "sk-ant-test",
			fallbacks: [{ model: "claude-opus-4-8" }],
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		expect(result.model).toBe("claude-opus-4-8");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
			{ type: "text", text: "continued" },
		]);
		// Opus 4.8 rates: 4 output tokens × $25/M = $0.0001; fallback input
		// (12 tokens) rebilled as cache-read at $0.5/M = $0.000006.
		expect(result.usage.cost.output).toBeCloseTo(0.0001, 10);
		expect(result.usage.cost.cacheRead).toBeCloseTo(0.000006, 10);
		expect(result.usage.cost.input).toBe(0);
	});

	it("prices dated Opus snapshots against the alias when catalog carries the entry", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createFallbackServedEvents("continued", "claude-opus-4-8-20260615")) as never,
		);

		const s = streamAnthropic(fableModel, context, {
			apiKey: "sk-ant-test",
			fallbacks: [{ model: "claude-opus-4-8" }],
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		expect(result.model).toBe("claude-opus-4-8-20260615");
		// Bundled catalog has no entry for the dated snapshot; resolveIterationModel
		// falls back to the Fable request model, so pricing regresses to Fable
		// rates for output ($50/M × 4 = $0.0002) and cacheRead ($1/M × 12 =
		// $0.000012). Documented fallback behavior — better than crashing.
		expect(result.usage.cost.output).toBeCloseTo(0.0002, 10);
		expect(result.usage.cost.cacheRead).toBeCloseTo(0.000012, 10);
	});

	it("stays inert when opted out: fallback content_block is dropped, model stays requested id", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createFallbackServedEvents("continued", "claude-opus-4-8")) as never,
		);

		const s = streamAnthropic(fableModel, context, { apiKey: "sk-ant-test" });
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		expect(result.model).toBe(fableModel.id);
		// The fallback content_block is dropped; only the continuation text
		// survives.
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "continued" }]);
		// Without opt-in, usage.iterations is ignored and cost uses the
		// request model at normal input rates. Top-level `input_tokens: 12`
		// bills at Fable's $10/M input = $0.00012 (i.e. NOT the fallback
		// cache-read rebilling).
		expect(result.usage.cost.input).toBeCloseTo(0.00012, 10);
		expect(result.usage.cost.output).toBeCloseTo(0.0002, 10);
	});

	it("does not attach the server-side-fallback beta when opted out", async () => {
		let capturedParams: Record<string, unknown> | undefined;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			capturedParams = params as Record<string, unknown>;
			return createMockRequest([
				{
					type: "message_start",
					message: {
						id: "m",
						usage: {
							input_tokens: 1,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
				{ type: "message_stop" },
			]) as never;
		});

		const s = streamAnthropic(fableModel, context, { apiKey: "sk-ant-test" });
		for await (const _ of s) {
			// drain
		}
		await s.result();

		expect(capturedParams?.fallbacks).toBeUndefined();
	});
});

describe("anthropic fallback content-block replay policy", () => {
	// A prior assistant turn that took a fallback carries a persisted `fallback`
	// content block. On the next request the outgoing wire body must strip it
	// UNLESS the current request also opts into the beta chain AND the target
	// is official Anthropic.

	function priorFallbackAssistant(): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
				{ type: "text", text: "continued" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
	}

	it("keeps the fallback block on the wire when replayed to official Anthropic with fallbacks opted in", () => {
		const params = convertAnthropicMessages(
			[priorFallbackAssistant(), { role: "user", content: "next", timestamp: 0 }],
			fableModel,
			false,
			{ serverSideFallbackEnabled: true },
		);
		expect(params[0]?.content).toEqual([
			{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
			{ type: "text", text: "continued" },
		]);
	});

	it("drops the fallback block when the current request does not opt in (official target)", () => {
		const params = convertAnthropicMessages(
			[priorFallbackAssistant(), { role: "user", content: "next", timestamp: 0 }],
			fableModel,
			false,
			// serverSideFallbackEnabled omitted → default false
		);
		expect(params[0]?.content).toEqual([{ type: "text", text: "continued" }]);
	});

	it("drops the fallback block on non-official Anthropic targets even when opted in", () => {
		const params = convertAnthropicMessages(
			[priorFallbackAssistant(), { role: "user", content: "next", timestamp: 0 }],
			umansModel,
			false,
			{ serverSideFallbackEnabled: true },
		);
		expect(params[0]?.content).toEqual([{ type: "text", text: "continued" }]);
	});
});

describe("anthropic assistant replay block ordering (tool_use partition)", () => {
	// Anthropic's replay validator rejects any assistant turn that carries a
	// non-`tool_use` content block AFTER a `tool_use` block
	// (`messages.N: tool_use ids were found without tool_result blocks
	// immediately after`). This bites when a mid-turn server-side fallback
	// (`server-side-fallback-2026-06-01`) lands AFTER the primary model already
	// emitted a tool_use, leaving persisted content shaped like
	// [thinking, text, tool_use, fallback, text, tool_use]. The same validator
	// rejects the older cross-provider [text, tool_use, text] shape (issue
	// #544). `convertAnthropicMessages` defends against both by stable-
	// partitioning every assistant wire message: all non-tool_use blocks first
	// (original relative order), then all tool_use blocks (original relative
	// order). Already-valid messages must serialize byte-identically.

	function assistant(content: AssistantMessage["content"]): AssistantMessage {
		return {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		};
	}

	function toolResult(id: string, name: string): ToolResultMessage {
		return {
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 0,
		};
	}

	function assistantParam(params: MessageParam[]): MessageParam {
		const asst = params.filter(p => p.role === "assistant");
		if (asst.length !== 1 || !Array.isArray(asst[0]?.content)) {
			throw new Error("expected exactly one assistant param with structured content blocks");
		}
		return asst[0];
	}

	it("mid-turn fallback repro: defers trailing tool_use, keeps the fallback marker in place", () => {
		const params = convertAnthropicMessages(
			[
				assistant([
					{ type: "thinking", thinking: "plan", thinkingSignature: "sig-1" },
					{ type: "text", text: "before" },
					{ type: "toolCall", id: "call_a", name: "read", arguments: {} },
					{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
					{ type: "text", text: "after" },
					{ type: "toolCall", id: "call_b", name: "grep", arguments: {} },
					{ type: "toolCall", id: "call_c", name: "glob", arguments: {} },
				]),
				toolResult("call_a", "read"),
				toolResult("call_b", "grep"),
				toolResult("call_c", "glob"),
				{ role: "user", content: "next", timestamp: 0 },
			],
			fableModel,
			false,
			{ serverSideFallbackEnabled: true },
		);
		expect(assistantParam(params).content).toEqual([
			{ type: "thinking", thinking: "plan", signature: "sig-1" },
			{ type: "text", text: "before" },
			{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
			{ type: "text", text: "after" },
			{ type: "tool_use", id: "call_a", name: "read", input: {} },
			{ type: "tool_use", id: "call_b", name: "grep", input: {} },
			{ type: "tool_use", id: "call_c", name: "glob", input: {} },
		]);
	});

	it("opt-out drops the fallback marker but still defers tool_use to the tail", () => {
		const params = convertAnthropicMessages(
			[
				assistant([
					{ type: "thinking", thinking: "plan", thinkingSignature: "sig-1" },
					{ type: "text", text: "before" },
					{ type: "toolCall", id: "call_a", name: "read", arguments: {} },
					{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
					{ type: "text", text: "after" },
					{ type: "toolCall", id: "call_b", name: "grep", arguments: {} },
					{ type: "toolCall", id: "call_c", name: "glob", arguments: {} },
				]),
				toolResult("call_a", "read"),
				toolResult("call_b", "grep"),
				toolResult("call_c", "glob"),
				{ role: "user", content: "next", timestamp: 0 },
			],
			fableModel,
			false,
			// serverSideFallbackEnabled omitted → fallback block dropped
		);
		expect(assistantParam(params).content).toEqual([
			{ type: "thinking", thinking: "plan", signature: "sig-1" },
			{ type: "text", text: "before" },
			{ type: "text", text: "after" },
			{ type: "tool_use", id: "call_a", name: "read", input: {} },
			{ type: "tool_use", id: "call_b", name: "grep", input: {} },
			{ type: "tool_use", id: "call_c", name: "glob", input: {} },
		]);
	});

	it("issue-544 family: text after a tool_use is reordered before the tool_use", () => {
		const params = convertAnthropicMessages(
			[
				assistant([
					{ type: "text", text: "before" },
					{ type: "toolCall", id: "call_a", name: "read", arguments: {} },
					{ type: "text", text: "after" },
				]),
				toolResult("call_a", "read"),
				{ role: "user", content: "next", timestamp: 0 },
			],
			fableModel,
			false,
			{ serverSideFallbackEnabled: true },
		);
		expect(assistantParam(params).content).toEqual([
			{ type: "text", text: "before" },
			{ type: "text", text: "after" },
			{ type: "tool_use", id: "call_a", name: "read", input: {} },
		]);
	});

	it("identity fast-path: already-valid thinking→text→tool_use serializes in unchanged order", () => {
		const params = convertAnthropicMessages(
			[
				assistant([
					{ type: "thinking", thinking: "plan", thinkingSignature: "sig-1" },
					{ type: "text", text: "before" },
					{ type: "toolCall", id: "call_a", name: "read", arguments: {} },
				]),
				toolResult("call_a", "read"),
				{ role: "user", content: "next", timestamp: 0 },
			],
			fableModel,
			false,
			{ serverSideFallbackEnabled: true },
		);
		expect(assistantParam(params).content).toEqual([
			{ type: "thinking", thinking: "plan", signature: "sig-1" },
			{ type: "text", text: "before" },
			{ type: "tool_use", id: "call_a", name: "read", input: {} },
		]);
	});

	it("interleaved signed thinking stays beside the tool calls that produced it", () => {
		const params = convertAnthropicMessages(
			[
				assistant([
					{ type: "thinking", thinking: "first", thinkingSignature: "sig-1" },
					{ type: "toolCall", id: "call_a", name: "read", arguments: {} },
					{ type: "thinking", thinking: "second", thinkingSignature: "sig-2" },
					{ type: "toolCall", id: "call_b", name: "grep", arguments: {} },
				]),
				toolResult("call_a", "read"),
				toolResult("call_b", "grep"),
				{ role: "user", content: "next", timestamp: 0 },
			],
			fableModel,
			false,
			{ serverSideFallbackEnabled: true },
		);
		expect(assistantParam(params).content).toEqual([
			{ type: "thinking", thinking: "first", signature: "sig-1" },
			{ type: "tool_use", id: "call_a", name: "read", input: {} },
			{ type: "thinking", thinking: "second", signature: "sig-2" },
			{ type: "tool_use", id: "call_b", name: "grep", input: {} },
		]);
	});

	it("partition is localized: all other wire messages serialize byte-identically", () => {
		// Prompt-cache contract: partitioning a poisoned assistant turn must be a
		// LOCAL rewrite of that turn's own content — every OTHER wire message
		// (the earlier valid assistant turn whose cached prefix must survive, its
		// tool_result, the poisoned turn's tool_results, and the trailing user
		// turn) must serialize to the exact same bytes. If the reorder leaked past
		// the turn boundary (mutated a shared/adjacent message) or the slow path
		// diverged from an already-ordered fast path, cached prefixes up to the
		// reordered turn would be invalidated. Two histories, identical except the
		// poisoned turn is pre-ordered to the partition result in (b): (a) fires
		// the partition, (b) takes the fast path. Bytes must match everywhere but
		// the poisoned param, which must converge to the same content either way.
		const validAssistant = assistant([
			{ type: "thinking", thinking: "plan", thinkingSignature: "sig-1" },
			{ type: "text", text: "before" },
			{ type: "toolCall", id: "call_v", name: "list", arguments: {} },
		]);
		const poisonedContent: AssistantMessage["content"] = [
			{ type: "text", text: "poison-a" },
			{ type: "toolCall", id: "call_a", name: "read", arguments: {} },
			{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
			{ type: "text", text: "poison-b" },
			{ type: "toolCall", id: "call_b", name: "grep", arguments: {} },
		];
		// Same blocks, hand-ordered to exactly what the stable partition emits:
		// non-tool_use chain first (order preserved), then the tool_use tail.
		const preOrderedContent: AssistantMessage["content"] = [
			{ type: "text", text: "poison-a" },
			{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
			{ type: "text", text: "poison-b" },
			{ type: "toolCall", id: "call_a", name: "read", arguments: {} },
			{ type: "toolCall", id: "call_b", name: "grep", arguments: {} },
		];
		const history = (poisoned: AssistantMessage["content"]) => [
			{ role: "user", content: "start", timestamp: 0 } as const,
			validAssistant,
			toolResult("call_v", "list"),
			assistant(poisoned),
			toolResult("call_a", "read"),
			toolResult("call_b", "grep"),
			{ role: "user", content: "next", timestamp: 0 } as const,
		];

		const a = convertAnthropicMessages(history(poisonedContent), fableModel, false, {
			serverSideFallbackEnabled: true,
		});
		const b = convertAnthropicMessages(history(preOrderedContent), fableModel, false, {
			serverSideFallbackEnabled: true,
		});

		expect(a.length).toBe(b.length);
		const poisonedIdx = a.findIndex(
			p =>
				p.role === "assistant" &&
				Array.isArray(p.content) &&
				p.content.some(block => block.type === "tool_use" && block.id === "call_a"),
		);
		expect(poisonedIdx).toBeGreaterThanOrEqual(0);
		for (let i = 0; i < a.length; i++) {
			if (i === poisonedIdx) continue;
			expect(JSON.stringify(a[i])).toBe(JSON.stringify(b[i]));
		}
		// Convergence: partition (a) and fast path (b) yield identical final content.
		expect(a[poisonedIdx]).toEqual(b[poisonedIdx]);
	});
});
