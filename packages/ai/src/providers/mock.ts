/**
 * Mock provider for tests.
 *
 * Implements `Model<"mock">` + `streamMock` so test code can drive
 * pi-agent-core / streamSimple-shaped consumers without an HTTP client.
 *
 * Usage:
 *
 *   import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
 *
 *   // 1. Array of responses, one per call.
 *   const mock = createMockModel({
 *     responses: [
 *       { content: [{ type: "toolCall", name: "read", arguments: { path: "/x" } }] },
 *       { content: ["done"] },
 *     ],
 *   });
 *
 *   // 2. Async generator — full state-machine power, can await between turns.
 *   const mock = createMockModel({
 *     responses: (async function* () {
 *       yield { content: [{ type: "toolCall", name: "fetch", arguments: { url } }] };
 *       // wait for external coordination
 *       await externalReady;
 *       yield { content: ["got it"] };
 *     })(),
 *   });
 *
 *   // 3. Per-call handler (closure with access to the call).
 *   const mock = createMockModel({
 *     handler: (context) => ({ content: [`turn ${context.messages.length}`] }),
 *   });
 *
 *   // 4. Use as a streamFn for agentLoop:
 *   await agentLoop(prompts, context, config, undefined, mock.stream).result();
 *
 *   // 5. Or register globally and use stream():
 *   registerMockApi();
 *   stream(mock.model, context, options);
 *
 *   // Inspect calls afterwards.
 *   expect(mock.calls).toHaveLength(2);
 */

import { registerCustomApi } from "../api-registry";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StopDetails,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";

/** The API string this provider serves. */
export const MOCK_API = "mock" as const;
export type MockApi = typeof MOCK_API;

/** Shorthand for a single content block. Strings become text blocks. */
export type MockContent =
	| string
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; thinkingSignature?: string }
	| {
			type: "toolCall";
			/** Optional explicit id; auto-generated when omitted. */
			id?: string;
			name: string;
			/** Object form is preferred; strings are passed through verbatim. */
			arguments: Record<string, unknown> | string;
	  };

/** One scripted response. */
export interface MockResponse {
	/** Content blocks to emit, in order. Strings become text blocks. */
	content?: ReadonlyArray<MockContent>;
	/** Stop reason. Defaults to `"toolUse"` when content has tool calls, else `"stop"`. */
	stopReason?: StopReason;
	/** Structured terminal stop classification, e.g. Anthropic refusal metadata. */
	stopDetails?: StopDetails | null;
	/** Error text paired with an explicit `"error"` stop reason. */
	errorMessage?: string;
	/** Usage stats. Missing fields default to 0; missing `cost.total` is recomputed from components. */
	usage?: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> };
	/** Pre-set responseId. */
	responseId?: string;
	/** If set, the stream emits a terminal error event instead of completing. */
	throw?: string | Error;
	/** Delay before any event is emitted. Honors the call's AbortSignal. */
	delayMs?: number;
	/**
	 * If set, the mock synthesizes a {@link ProviderResponseMetadata} and fires
	 * `options.onResponse` once before streaming events. Headers are forwarded
	 * verbatim (keys lowercased to match real provider plumbing).
	 */
	responseHeaders?: Readonly<Record<string, string>>;
	/** HTTP status code paired with {@link responseHeaders}. Defaults to 200. */
	responseStatus?: number;
	/** Pre-set requestId surfaced via {@link ProviderResponseMetadata.requestId}. */
	responseRequestId?: string;
}

/** Handler resolved per call: static script or function. */
export type MockHandler =
	| MockResponse
	| ((context: Context, options?: SimpleStreamOptions) => MockResponse | Promise<MockResponse>);

/**
 * A source of handlers, one per call.
 *
 * - Arrays / iterables consume one entry per call (most ergonomic for scripts).
 * - Async iterables (e.g. `async function*()`) let the test pause between calls,
 *   coordinate with external events, or build state machines.
 *
 * The first call pulls the first entry, the second call pulls the second, and
 * so on. When the source is exhausted, `MockModelOptions.handler` is used; if
 * neither is set, the call rejects.
 */
export type MockResponseSource = Iterable<MockHandler> | AsyncIterable<MockHandler>;

/** Recorded call for inspection. */
export interface MockCall {
	readonly context: Context;
	readonly options?: SimpleStreamOptions;
}

/** Construction options. */
export interface MockModelOptions {
	/** Model id. Defaults to `"mock-model"`. */
	id?: string;
	/** Provider string used in the returned AssistantMessage. Defaults to `"mock"`. */
	provider?: string;
	/** Base URL reported by the model. Defaults to `"mock://"`. */
	baseUrl?: string;
	/** A sequence of responses, one per call. Accepts arrays, generators, or any iterable. */
	responses?: MockResponseSource;
	/** Fallback handler used when `responses` is exhausted. */
	handler?: MockHandler;
	/** Cost per million tokens. Defaults to zeros. */
	cost?: Model["cost"];
	/** Context window. Defaults to 200_000. */
	contextWindow?: number;
	/** Max output tokens. Defaults to 32_768. */
	maxTokens?: number;
	/** Whether the model claims to support reasoning. Defaults to false. */
	reasoning?: boolean;
}

const ZERO_COST: Model["cost"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

/**
 * A `Model<"mock">` that carries its own scripted state. Pass instances to
 * `stream()` or agent configs, and use the same instance to inspect calls
 * and feed additional handlers.
 */
export class MockModel implements Model<MockApi> {
	readonly id: string;
	readonly name: string;
	readonly api: MockApi = MOCK_API;
	readonly provider: string;
	readonly baseUrl: string;
	readonly reasoning: boolean;
	readonly input: ("text" | "image")[] = ["text"];
	readonly cost: Model["cost"];
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly compat = undefined;

	/** Recorded calls in invocation order. */
	readonly calls: MockCall[] = [];

	iterator?: Iterator<MockHandler> | AsyncIterator<MockHandler>;
	exhausted: boolean;
	readonly extras: MockHandler[] = [];
	fallback?: MockHandler;
	toolCallCounter = 0;

	constructor(options: MockModelOptions = {}) {
		this.id = options.id ?? "mock-model";
		this.name = options.id ?? "mock-model";
		this.provider = options.provider ?? "mock";
		this.baseUrl = options.baseUrl ?? "mock://";
		this.reasoning = options.reasoning ?? false;
		this.cost = options.cost ?? ZERO_COST;
		this.contextWindow = options.contextWindow ?? 200_000;
		this.maxTokens = options.maxTokens ?? 32_768;
		this.iterator = options.responses === undefined ? undefined : iteratorOf(options.responses);
		this.exhausted = options.responses === undefined;
		this.fallback = options.handler;
	}

	/** Back-compat alias: the model is its own handle. */
	get model(): this {
		return this;
	}

	/** A streamFn-compatible callable. Forward to `agentLoop` or pi `stream()`. */
	stream = (_model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream =>
		streamMock(this, context, options);

	/**
	 * Append a handler to the internal queue consumed AFTER the constructor
	 * `responses` source is exhausted (but before the fallback). Use this for
	 * interactive tests that decide responses after the model is created.
	 */
	push(response: MockHandler): void {
		this.extras.push(response);
	}

	/** Reset recorded calls AND the extras queue. The constructor `responses` are NOT reset. */
	reset(): void {
		this.extras.length = 0;
		this.calls.length = 0;
		this.toolCallCounter = 0;
	}
}
/** Check whether `model` was produced by `createMockModel`. */
export function isMockModel(model: Model<Api>): model is MockModel {
	return model instanceof MockModel;
}

/** Construct a mock model. */
export function createMockModel(options: MockModelOptions = {}): MockModel {
	return new MockModel(options);
}

/** Stream function for `Model<"mock">`. Matches the pi-ai per-provider stream signature. */
export function streamMock(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	if (!isMockModel(model)) {
		queueMicrotask(() => {
			stream.fail(
				new AIError.ValidationError(
					"streamMock called with a model not produced by createMockModel(). " + "Pass a MockModel instance.",
				),
			);
		});
		return stream;
	}

	model.calls.push({ context, options });
	void runMock(stream, model, context, options);
	return stream;
}

/** Convenience: register the mock provider with the global custom API registry. */
export function registerMockApi(sourceId = "pi-ai/mock"): void {
	registerCustomApi(MOCK_API, streamMock, sourceId);
}

// =============================================================================
// Internal
// =============================================================================

function iteratorOf(source: MockResponseSource): Iterator<MockHandler> | AsyncIterator<MockHandler> {
	if (Symbol.asyncIterator in source) {
		return (source as AsyncIterable<MockHandler>)[Symbol.asyncIterator]();
	}
	return (source as Iterable<MockHandler>)[Symbol.iterator]();
}

async function pullHandler(state: MockModel): Promise<MockHandler | undefined> {
	if (state.iterator && !state.exhausted) {
		const result = await Promise.resolve(state.iterator.next());
		if (!result.done) return result.value;
		state.exhausted = true;
	}
	if (state.extras.length > 0) return state.extras.shift();
	return state.fallback;
}

async function runMock(
	stream: AssistantMessageEventStream,
	model: MockModel,
	context: Context,
	options: SimpleStreamOptions | undefined,
): Promise<void> {
	const startedAt = Date.now();
	const perfStart = performance.now();

	let handler: MockHandler | undefined;
	try {
		handler = await pullHandler(model);
	} catch (err) {
		stream.fail(err);
		return;
	}

	if (handler === undefined) {
		stream.fail(
			new AIError.ValidationError(
				`Mock model "${model.id}" received call ${model.calls.length} but no response or handler is configured.`,
			),
		);
		return;
	}

	let response: MockResponse;
	try {
		response = typeof handler === "function" ? await handler(context, options) : handler;
	} catch (err) {
		stream.fail(err);
		return;
	}

	if (response.responseHeaders && options?.onResponse) {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(response.responseHeaders)) {
			headers[key.toLowerCase()] = value;
		}
		try {
			await options.onResponse(
				{
					status: response.responseStatus ?? 200,
					headers,
					...(response.responseRequestId !== undefined ? { requestId: response.responseRequestId } : {}),
				},
				model,
			);
		} catch (err) {
			stream.fail(err);
			return;
		}
	}

	if (response.delayMs && response.delayMs > 0) {
		try {
			await sleep(response.delayMs, options?.signal);
		} catch {
			emitTerminalError(stream, model, startedAt, perfStart, "aborted", "Mock aborted during delay.");
			return;
		}
	}

	if (response.throw !== undefined) {
		const message =
			typeof response.throw === "string"
				? response.throw
				: response.throw instanceof Error
					? response.throw.message
					: String(response.throw);
		emitTerminalError(stream, model, startedAt, perfStart, "error", message);
		return;
	}

	const blocks: Array<TextContent | ThinkingContent | ToolCall> = [];
	const partial: AssistantMessage = {
		role: "assistant",
		content: blocks,
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseId: response.responseId,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: startedAt,
	};

	stream.push({ type: "start", partial });

	for (const input of response.content ?? []) {
		const block = normalizeContent(input, model);
		blocks.push(block);
		const contentIndex = blocks.length - 1;

		if (block.type === "text") {
			stream.push({ type: "text_start", contentIndex, partial });
			stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
			stream.push({ type: "text_end", contentIndex, content: block.text, partial });
		} else if (block.type === "thinking") {
			stream.push({ type: "thinking_start", contentIndex, partial });
			stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
			stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
		} else {
			const serialized = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments);
			stream.push({ type: "toolcall_start", contentIndex, partial });
			stream.push({ type: "toolcall_delta", contentIndex, delta: serialized, partial });
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
		}
	}

	const hasToolCall = blocks.some(b => b.type === "toolCall");
	const reason: StopReason = response.stopReason ?? (hasToolCall ? ("toolUse" as StopReason) : ("stop" as StopReason));

	partial.stopReason = reason;
	partial.stopDetails = response.stopDetails;
	partial.errorMessage = response.errorMessage;
	partial.usage = mergeUsage(response.usage);
	partial.duration = performance.now() - perfStart;

	if (reason === "aborted" || reason === "error") {
		stream.push({
			type: "error",
			reason,
			error: { ...partial, errorMessage: partial.errorMessage ?? "mock error" },
		});
		return;
	}
	stream.push({ type: "done", reason: reason as "stop" | "length" | "toolUse", message: partial });
}

function normalizeContent(input: MockContent, state: MockModel): TextContent | ThinkingContent | ToolCall {
	if (typeof input === "string") {
		return { type: "text", text: input };
	}
	if (input.type === "toolCall") {
		return {
			type: "toolCall",
			id: input.id ?? generateToolCallId(state),
			name: input.name,
			arguments: typeof input.arguments === "string" ? input.arguments : { ...input.arguments },
		} as ToolCall;
	}
	return input;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	} as Usage;
}

function mergeUsage(partial?: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> }): Usage {
	const base = emptyUsage();
	if (!partial) return base;
	const merged = { ...base, ...partial } as Usage;
	const costProvided = partial.cost !== undefined;
	if (costProvided) {
		merged.cost = { ...base.cost, ...partial.cost } as Usage["cost"];
	}
	// Recompute totalTokens when not explicitly provided (canonical formula matches types.ts).
	if (partial.totalTokens === undefined) {
		const orchestration = merged.orchestration;
		merged.totalTokens =
			merged.input +
			merged.output +
			merged.cacheRead +
			merged.cacheWrite +
			(orchestration?.input ?? 0) +
			(orchestration?.output ?? 0) +
			(orchestration?.cacheRead ?? 0);
	}
	// Recompute cost.total when cost components were supplied without an explicit total.
	if (costProvided && partial.cost?.total === undefined) {
		merged.cost.total = merged.cost.input + merged.cost.output + merged.cost.cacheRead + merged.cost.cacheWrite;
	}
	return merged;
}

function emitTerminalError(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	startedAt: number,
	perfStart: number,
	reason: "aborted" | "error",
	message: string,
): void {
	const failure: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: reason as StopReason,
		errorMessage: message,
		timestamp: startedAt,
		duration: performance.now() - perfStart,
	};
	stream.push({ type: "start", partial: failure });
	stream.push({ type: "error", reason, error: failure });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal?.aborted) {
		reject(signal.reason);
		return promise;
	}
	const onAbort = () => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		reject(signal?.reason ?? new AIError.AbortError("aborted"));
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

function generateToolCallId(state: MockModel): string {
	state.toolCallCounter += 1;
	return `mock-tc-${state.toolCallCounter}`;
}
