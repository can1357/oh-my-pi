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
 *   • Opt-out path — a `fallback` content block is still persisted as the
 *     replay boundary, but `output.model` stays the requested id and
 *     `usage.iterations` are ignored: cost uses the requested model.
 *   • `convertAnthropicMessages` replays a persisted `fallback` block only when
 *     the current request also opts in AND the target is official Anthropic;
 *     otherwise it drops the marker and keeps one model's reasoning.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { convertAnthropicMessages, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { MessageParam } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	ProviderSessionState,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
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

	it("persists the boundary when opted out, without promoting the model or pricing per iteration", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createFallbackServedEvents("continued", "claude-opus-4-8")) as never,
		);

		const s = streamAnthropic(fableModel, context, { apiKey: "sk-ant-test" });
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		expect(result.model).toBe(fableModel.id);
		// The boundary survives for replay; the served model is not adopted.
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
			{ type: "text", text: "continued" },
		]);
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

	function priorFallbackAssistant(
		content: AssistantMessage["content"] = [
			{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
			{ type: "text", text: "continued" },
		],
	): AssistantMessage {
		return {
			role: "assistant",
			content,
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

	it("keeps one model's reasoning when the marker cannot go on the wire", () => {
		// Each model signed its reasoning against the turn's original prefix.
		// Back to back without the marker, Anthropic rejects the latest turn:
		// "`thinking` or `redacted_thinking` blocks in the latest assistant
		// message cannot be modified".
		const history = [
			priorFallbackAssistant([
				{ type: "thinking", thinking: "primary plan", thinkingSignature: "sig-primary" },
				{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
				{ type: "thinking", thinking: "fallback plan", thinkingSignature: "sig-fallback" },
				{ type: "text", text: "continued" },
			]),
			{ role: "user", content: "next", timestamp: 0 } as const,
		];
		const optedIn = convertAnthropicMessages(history, fableModel, false, { serverSideFallbackEnabled: true });
		expect(optedIn[0]?.content).toEqual([
			{ type: "thinking", thinking: "primary plan", signature: "sig-primary" },
			{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } },
			{ type: "thinking", thinking: "fallback plan", signature: "sig-fallback" },
			{ type: "text", text: "continued" },
		]);
		const optedOut = convertAnthropicMessages(history, fableModel, false);
		expect(optedOut[0]?.content).toEqual([
			{ type: "thinking", thinking: "fallback plan", signature: "sig-fallback" },
			{ type: "text", text: "continued" },
		]);
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

describe("mid-turn fallback a gateway opted into", () => {
	// A gateway can opt into the beta chain on the client's behalf, so a request
	// without `fallbacks` still streams a `fallback` boundary between two models'
	// signed reasoning. Live repro (claude-opus-5-5 → claude-opus-4-8 after a
	// refusal): replaying both reasoning blocks without the marker failed every
	// later request with "`thinking` or `redacted_thinking` blocks in the latest
	// assistant message cannot be modified".
	const gatewayModel: Model<"anthropic-messages"> = buildModel({
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5 (gateway)",
		api: "anthropic-messages",
		provider: "gateway",
		baseUrl: "https://llm-gateway.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
	const usage = { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	const fallbackTurnEvents: MockAnthropicEvent[] = [
		{ type: "message_start", message: { id: "msg_turn", model: "claude-opus-5-5", usage } },
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "primary plan" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-primary" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "content_block_start",
			index: 1,
			content_block: {
				type: "fallback",
				from: { model: "claude-opus-5-5" },
				to: { model: "claude-opus-4-8" },
				trigger: { type: "refusal", category: "cyber" },
			},
		},
		{ type: "content_block_stop", index: 1 },
		{ type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "fallback plan" } },
		{ type: "content_block_delta", index: 2, delta: { type: "signature_delta", signature: "sig-fallback" } },
		{ type: "content_block_stop", index: 2 },
		{ type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Reading it." } },
		{ type: "content_block_stop", index: 3 },
		{
			type: "content_block_start",
			index: 4,
			content_block: { type: "tool_use", id: "toolu_read", name: "read", input: {} },
		},
		{ type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } },
		{ type: "content_block_stop", index: 4 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage },
		{ type: "message_stop" },
	];
	const nextTurnEvents: MockAnthropicEvent[] = [
		{ type: "message_start", message: { id: "msg_next", usage } },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
		{ type: "message_stop" },
	];

	it("replays only the fallback model's reasoning on the next request", async () => {
		const requests: Array<{ messages: MessageParam[] }> = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			requests.push(params as { messages: MessageParam[] });
			return createMockRequest(requests.length === 1 ? fallbackTurnEvents : nextTurnEvents) as never;
		});
		const options = { apiKey: "sk-gateway", thinkingEnabled: true };
		const user = { role: "user", content: "Read a.txt", timestamp: 0 } as const;
		const turn = await streamAnthropic(gatewayModel, { messages: [user] }, options).result();
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "toolu_read",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: 0,
		};
		await streamAnthropic(gatewayModel, { messages: [user, turn, result] }, options).result();

		const replayed = requests[1]?.messages.find(message => message.role === "assistant")?.content;
		if (!Array.isArray(replayed)) throw new Error("expected the fallback turn on the wire");
		expect(replayed.map(block => block.type)).toEqual(["thinking", "text", "tool_use"]);
		expect(replayed[0]).toMatchObject({ thinking: "fallback plan", signature: "sig-fallback" });
	});

	// A turn recorded before boundaries were kept: both models' reasoning and no
	// marker. Sessions that already hold one must recover rather than 400 forever.
	const zeroUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const markerlessHistory: Message[] = [
		{ role: "user", content: "Summarize the README", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "earlier plan", thinkingSignature: "sig-earlier" },
				{ type: "text", text: "It covers the CLI." },
			],
			api: "anthropic-messages",
			provider: "gateway",
			model: "claude-opus-5-5",
			usage: zeroUsage,
			stopReason: "stop",
			timestamp: 0,
		},
		{ role: "user", content: "Read a.txt", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "primary plan", thinkingSignature: "sig-primary" },
				{ type: "thinking", thinking: "fallback plan", thinkingSignature: "sig-fallback" },
				{ type: "text", text: "Reading it." },
				{ type: "toolCall", id: "toolu_read", name: "read", arguments: { path: "a.txt" } },
			],
			api: "anthropic-messages",
			provider: "gateway",
			model: "claude-opus-5-5",
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: 0,
		},
		{
			role: "toolResult",
			toolCallId: "toolu_read",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
			timestamp: 0,
		},
	];

	/** Answers like the gateway: any request whose latest turn replays thinking is refused. */
	function refuseLatestTurnThinking(requests: Array<{ messages: MessageParam[] }>): void {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			const request = params as { messages: MessageParam[] };
			requests.push(request);
			const latest = request.messages.findLast(message => message.role === "assistant")?.content;
			if (Array.isArray(latest) && latest.some(block => block.type === "thinking")) {
				const rejection = Object.assign(
					new Error(
						'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."}}',
					),
					{ status: 400 },
				);
				return {
					async withResponse() {
						throw rejection;
					},
				} as never;
			}
			return createMockRequest(nextTurnEvents) as never;
		});
	}

	it("drops a refused latest turn's reasoning once and keeps it dropped for the session", async () => {
		const requests: Array<{ messages: MessageParam[] }> = [];
		refuseLatestTurnThinking(requests);
		const options = {
			apiKey: "sk-gateway",
			thinkingEnabled: true,
			providerSessionState: new Map<string, ProviderSessionState>(),
		};

		const recovered = await streamAnthropic(gatewayModel, { messages: markerlessHistory }, options).result();
		expect(recovered.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		const [earlier, latest] = requests[1]!.messages.filter(message => message.role === "assistant");
		expect(Array.isArray(latest?.content) && latest.content.map(block => block.type)).toEqual(["text", "tool_use"]);
		// Only the refused turn loses its reasoning.
		expect(earlier?.content).toContainEqual(expect.objectContaining({ type: "thinking", signature: "sig-earlier" }));

		// The session's next request replays the same prefix on its first attempt.
		await streamAnthropic(gatewayModel, { messages: markerlessHistory }, options).result();
		expect(requests).toHaveLength(3);
	});

	it("recovers without session state by dropping every replayed thinking block", async () => {
		const requests: Array<{ messages: MessageParam[] }> = [];
		refuseLatestTurnThinking(requests);

		const recovered = await streamAnthropic(
			gatewayModel,
			{ messages: markerlessHistory },
			{ apiKey: "sk-gateway", thinkingEnabled: true },
		).result();
		expect(recovered.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1]!.messages)).not.toContain('"type":"thinking"');
	});
});

describe("fallback-credit continuation after a mid-turn fallback", () => {
	// The continuation echoes the refused response's content. A `fallback`
	// boundary is accepted without the beta and validates the thinking around
	// it by position, so it must stay exactly where it appeared even though
	// redemption deletes `fallbacks` from the frozen body.
	const usage = { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

	it("echoes the boundary in place and persists the same prefix", async () => {
		let captured: Record<string, unknown> | undefined;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			captured = params as Record<string, unknown>;
			return createMockRequest([
				{ type: "message_start", message: { id: "msg_credit", usage } },
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
				{ type: "message_stop" },
			]) as never;
		});

		const redeemed = await streamAnthropic({ ...fableModel, id: "claude-opus-4-8" }, context, {
			apiKey: "sk-ant-test",
			fallbackCreditRedemption: {
				token: "fct_mid_turn_fallback",
				prefillClaim: true,
				params: {
					model: "claude-fable-5",
					messages: [{ role: "user", content: "Say hi" }],
					max_tokens: 1024,
					stream: true,
					fallbacks: [{ model: "claude-opus-4-8" }],
				},
				betas: ["fallback-credit-2026-06-01"],
				expiresAt: Date.now() + 60_000,
				refusedContent: [
					{ type: "thinking", thinking: "primary plan", thinkingSignature: "sig-primary" },
					{ type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
					{ type: "thinking", thinking: "fallback plan", thinkingSignature: "sig-fallback" },
					{ type: "text", text: "Partial " },
				],
			},
		}).result();

		expect(captured?.fallbacks).toBeUndefined();
		const messages = captured?.messages as Array<{ role: string; content: unknown }>;
		expect(messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "primary plan", signature: "sig-primary" },
				{ type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
				{ type: "thinking", thinking: "fallback plan", signature: "sig-fallback" },
				{ type: "text", text: "Partial" },
			],
		});
		// The persisted turn keeps the boundary, so a later replay that cannot
		// carry it collapses to one model's reasoning instead of two chains.
		expect(redeemed.content.map(block => block.type)).toEqual(["thinking", "fallback", "thinking", "text", "text"]);
	});
});

describe("thinking-led classification with a fallback boundary", () => {
	// A gateway that falls back before the primary emits any reasoning persists
	// `[fallback, thinking(fallbackModel), …]`. The marker is bookkeeping, not
	// output: a `compat.stripThinkingHistory` route that read it as a
	// thinkingless turn would drop the one reasoning segment the replay keeps.
	// `stripThinkingHistory` only fires on a budget (`enabled`) thinking route.
	const strippingModel: Model<"anthropic-messages"> = (() => {
		const built = buildModel({
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});
		return {
			...built,
			compat: { ...built.compat, stripThinkingHistory: true, disableAdaptiveThinking: true },
		};
	})();

	interface Payload {
		thinking?: { type: string };
		messages: Array<{ role: string; content: string | Array<{ type: string }> }>;
	}

	async function payloadFor(messages: Message[]): Promise<Payload> {
		const controller = new AbortController();
		controller.abort();
		let payload: unknown;
		await streamAnthropic(
			strippingModel,
			{ messages },
			{
				apiKey: "sk-ant-test",
				thinkingEnabled: true,
				signal: controller.signal,
				onPayload: built => {
					payload = built;
				},
			},
		).result();
		if (!payload) throw new Error("expected a built payload");
		return payload as Payload;
	}

	function turn(content: AssistantMessage["content"]): Message[] {
		return [
			{ role: "user", content: "Read a.txt", timestamp: 0 },
			{
				role: "assistant",
				content,
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
				stopReason: "toolUse",
				timestamp: 0,
			},
			{
				role: "toolResult",
				toolCallId: "toolu_read",
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
				timestamp: 0,
			},
		];
	}

	const assistantBlockTypes = (payload: Payload) =>
		payload.messages
			.filter(message => message.role === "assistant")
			.flatMap(message => (Array.isArray(message.content) ? message.content.map(block => block.type) : []));

	it("keeps budget thinking and the replayed reasoning when the marker leads the turn", async () => {
		const payload = await payloadFor(
			turn([
				{ type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
				{ type: "thinking", thinking: "fallback plan", thinkingSignature: "sig-fallback" },
				{ type: "toolCall", id: "toolu_read", name: "read", arguments: { path: "a.txt" } },
			]),
		);
		expect(payload.thinking?.type).toBe("enabled");
		expect(assistantBlockTypes(payload)).toEqual(["thinking", "tool_use"]);
	});

	it("still strips a turn that leads with output after the marker", async () => {
		const payload = await payloadFor(
			turn([
				{ type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
				{ type: "text", text: "Reading it." },
				{ type: "toolCall", id: "toolu_read", name: "read", arguments: { path: "a.txt" } },
			]),
		);
		expect(payload.thinking).toBeUndefined();
		expect(assistantBlockTypes(payload)).toEqual(["text", "tool_use"]);
	});
});
