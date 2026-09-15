/**
 * The Anthropic provider must report WHY a request rewrote the cached prompt
 * prefix, so a cold turn can say what caused it instead of leaving the user to
 * guess. The reason rides on the returned `AssistantMessage`, which is the
 * observable contract these tests defend.
 *
 * The trap guarded here: omp deliberately expresses tool additions and removals
 * as `tool_addition` / `tool_removal` control transitions precisely so they do
 * NOT break the prefix. Reporting them as a cause would blame the wrong thing.
 *
 * No network: a capturing `fetch` returns a minimal successful SSE stream.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type AnthropicOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	DeveloperMessage,
	FetchImpl,
	Message,
	Model,
	ProviderSessionState,
	Tool,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

// Opus 4.8 on the direct Anthropic endpoint is the deployment that carries
// mid-conversation tool changes, so tool add/remove really becomes a control
// transition rather than a re-baseline.
const MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

// Sonnet 3.7 carries no mid-conversation tool changes, so there is no
// stable-tools plane and any difference in the array rewrites the prefix.
const NO_TOOL_PLANE_MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-3-7-sonnet-20250219",
	name: "Claude Sonnet 3.7",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

// Deployments that escape builtin tool names (Umans-hosted models, and every
// OAuth request) put tool names on the wire behind the `_` transport prefix,
// so the byte-stability plane sees `_bash` where the user configured `bash`.
const ESCAPED_TOOL_NAMES_MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 200_000,
	maxTokens: 8_192,
	compat: { escapeBuiltinToolNames: true },
});

// Per-message effort arrives with Opus 5 (and Fable/Mythos 5.1) on the direct
// endpoint, so an effort change there really becomes an `output_config` control
// on a mid-conversation system message instead of a top-level field.
const PER_MESSAGE_EFFORT_MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-5",
	name: "Claude Opus 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const SESSION_ID = "cache-break-attribution-session";

function tool(name: string, properties: Record<string, unknown>): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties, additionalProperties: false },
	};
}

function contextWithTools(tools: Tool[], systemPrompt = "You are a precise assistant."): Context {
	return {
		systemPrompt: [systemPrompt],
		messages: [{ role: "user", content: "Use the tools", timestamp: 1 }],
		tools,
	};
}

/**
 * Tool whose description carries a lone UTF-16 high surrogate, the way one
 * arrives from an extension or an MCP server. The provider rewrites it to
 * U+FFFD before the request leaves, so the bytes the cached prefix holds are
 * not the bytes `buildParams` assembled.
 */
const loneSurrogateTool: Tool = { ...tool("lookup", {}), description: "lookup tool \ud800" };

function assistantTurn(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/**
 * A conversation of `exchanges` completed assistant/user pairs after the
 * opening user turn, with every earlier message byte-identical across calls
 * and a real user turn last, so no `Continue.` pad is on the wire. An append
 * is therefore the only difference between `appendingHistory(n)` and
 * `appendingHistory(n + 1)`, which is what makes the prefix a turn inherited
 * — and a bound on it — observable at all.
 */
function appendingHistory(exchanges: number, tools: Tool[]): Context {
	const messages: Message[] = [{ role: "user", content: "Use the tools", timestamp: 1 }];
	for (let index = 0; index < exchanges; index++) {
		messages.push(assistantTurn([{ type: "text", text: `reply ${index}` }], index * 2 + 2));
		messages.push({ role: "user", content: `follow-up ${index}`, timestamp: index * 2 + 3 });
	}
	return { ...contextWithTools(tools), messages };
}

/**
 * Payload hook that returns a replacement body whose `messages[0]` is a
 * different message and whose system blocks, tool array, retention and later
 * messages are the ones `buildParams` assembled. A rewritten conversation root
 * is therefore the only difference between the assembled payload and the sent
 * one, and the assembled payload keeps its own root — an in-place mutation
 * would edit the object both sides hold and could not tell them apart.
 */
const rewriteWireRoot: NonNullable<AnthropicOptions["onPayload"]> = payload => {
	const assembled = payload as Record<string, unknown> & { messages: ReadonlyArray<unknown> };
	return {
		...assembled,
		messages: [
			{ role: "user", content: [{ type: "text", text: "Rewritten root." }] },
			...assembled.messages.slice(1),
		],
	};
};

/**
 * Payload hook that returns a replacement body whose `tools` array is the
 * assembled one with a rewritten description on its first entry. The array
 * stays present and keeps its length, so the declared tool bytes are the only
 * difference between the array the stable-tools plane produced and the one the
 * request actually sends.
 */
const rewriteWireTools: NonNullable<AnthropicOptions["onPayload"]> = payload => {
	const assembled = payload as Record<string, unknown> & { tools: ReadonlyArray<Record<string, unknown>> };
	return {
		...assembled,
		tools: assembled.tools.map((entry, index) =>
			index === 0 ? { ...entry, description: "rewritten after assembly" } : entry,
		),
	};
};

/**
 * Shape of a wire message as the hooks below read it: enough to find the
 * `tool_addition` / `tool_removal` blocks and the per-message `output_config`
 * the provider materializes for a control transition.
 */
type WireControlMessage = {
	role: string;
	content: string | Array<{ type: string; tool?: { type: string; name: string } }>;
	output_config?: { effort?: string };
};

function mapWireMessages(
	payload: unknown,
	map: (message: WireControlMessage) => WireControlMessage,
): Record<string, unknown> {
	const assembled = payload as Record<string, unknown> & { messages: readonly WireControlMessage[] };
	return { ...assembled, messages: assembled.messages.map(map) };
}

/**
 * Payload hook that returns a replacement body whose `tool_addition` blocks
 * name a different tool. Every other byte — message order, content, the tool
 * array, the system blocks, retention — is the one `buildParams` assembled, so
 * the declaration the plane materialized is the only difference between the
 * assembled payload and the sent one.
 */
const rewriteWireToolAddition: NonNullable<AnthropicOptions["onPayload"]> = payload =>
	mapWireMessages(payload, message =>
		typeof message.content === "string"
			? message
			: {
					...message,
					content: message.content.map(block =>
						block.type === "tool_addition" && block.tool
							? { ...block, tool: { ...block.tool, name: "rewritten" } }
							: block,
					),
				},
	);

/**
 * Payload hook that returns a replacement body with one more control-only
 * `role: "system"` message after the whole history, the way a gateway that
 * declares a tool of its own does. It adds no chain-visible message, so the
 * history chain cannot see it at all, and the bytes it adds sit after every
 * message the previous request sent.
 */
const appendWireControlDeclaration = (payload: unknown): Record<string, unknown> => {
	const assembled = payload as Record<string, unknown> & { messages: readonly WireControlMessage[] };
	return {
		...assembled,
		messages: [
			...assembled.messages,
			{ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_reference", name: "hooked" } }] },
		],
	};
};

/**
 * {@link rewriteWireToolAddition} and {@link appendWireControlDeclaration} in
 * one hook, in that order, so the appended declaration keeps its own name and
 * the cached one is the only rewritten byte.
 */
const rewriteAndAppendWireControlDeclaration: NonNullable<AnthropicOptions["onPayload"]> = payload =>
	appendWireControlDeclaration(rewriteWireToolAddition(payload));

/**
 * Payload hook that returns a replacement body with every control block taken
 * out, the way a hook that only understands text content would rewrite one.
 * The declaring message stays where it was, so the blocks are the only thing
 * that changed.
 */
const dropWireControlBlocks: NonNullable<AnthropicOptions["onPayload"]> = payload =>
	mapWireMessages(payload, message =>
		typeof message.content === "string"
			? message
			: {
					...message,
					content: message.content.filter(
						block => block.type !== "tool_addition" && block.type !== "tool_removal",
					),
				},
	);

/**
 * Payload hook that returns a replacement body whose per-message
 * `output_config.effort` is rewritten wherever the provider set one. The
 * declaring message is otherwise untouched.
 */
function rewriteWireEffort(effort: string): NonNullable<AnthropicOptions["onPayload"]> {
	return payload =>
		mapWireMessages(payload, message =>
			message.output_config === undefined ? message : { ...message, output_config: { effort } },
		);
}

/**
 * Shape of a wire message as the thinking hooks below read it: enough to find
 * the replayed `thinking` / `redacted_thinking` blocks on a prior assistant
 * turn and rewrite them in place of the block the provider materialized.
 */
type WireThinkingBlock = { type: string; thinking?: string; signature?: string; data?: string };
type WireThinkingMessage = { role: string; content: string | WireThinkingBlock[] };

function mapWireBlocks(
	payload: unknown,
	map: (block: WireThinkingBlock) => WireThinkingBlock,
): Record<string, unknown> {
	const assembled = payload as Record<string, unknown> & { messages: readonly WireThinkingMessage[] };
	return {
		...assembled,
		messages: assembled.messages.map(message =>
			typeof message.content === "string" ? message : { ...message, content: message.content.map(map) },
		),
	};
}

/**
 * Payload hook that returns a replacement body whose replayed `thinking` block
 * carries different reasoning under the signature the provider replayed. Every
 * other byte — the message's own text block, its position, the tool array, the
 * system blocks, retention — is the one `buildParams` assembled, so a branch
 * or a hook substituting one assistant's reasoning for another's is the only
 * difference between the assembled payload and the sent one.
 */
const rewriteWireThinking: NonNullable<AnthropicOptions["onPayload"]> = payload =>
	mapWireBlocks(payload, block =>
		block.type === "thinking" ? { ...block, thinking: "Rewritten after assembly." } : block,
	);

/** {@link rewriteWireThinking} for the opaque `redacted_thinking` payload. */
const rewriteWireRedactedThinking: NonNullable<AnthropicOptions["onPayload"]> = payload =>
	mapWireBlocks(payload, block =>
		block.type === "redacted_thinking" ? { ...block, data: "rewritten-redacted-payload" } : block,
	);

/**
 * `message_start` is the acceptance boundary: it carries this request's own
 * cache-creation usage, so Anthropic has processed the prompt and written its
 * cache entry before a single content block exists.
 */
const MESSAGE_START_FRAME = {
	type: "message_start",
	message: {
		id: "msg_cache_break",
		usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 4 },
	},
};

function sseBody(events: ReadonlyArray<{ type: string; [key: string]: unknown }>): string {
	return `${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

function sseResponse(body: string | ReadableStream<Uint8Array>): Response {
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_cache_break" },
	});
}

const successFetch: FetchImpl = async () =>
	sseResponse(
		sseBody([
			MESSAGE_START_FRAME,
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		]),
	);

/** {@link successFetch} that also records the request body the SDK serialized. */
function capturingFetch(sink: { body: string }): FetchImpl {
	return async (input, init) => {
		sink.body = typeof init?.body === "string" ? init.body : "";
		return await successFetch(input, init);
	};
}

/** Rejects before any response body exists, the way a malformed request does. */
const rejectedFetch: FetchImpl = async () =>
	new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "rejected" } }), {
		status: 400,
		headers: { "Content-Type": "application/json" },
	});

/**
 * Accepts the request and then dies with no content at all: `message_start`,
 * then a terminal `error` frame. The provider only stamps `firstTokenTime` on
 * the first content block, so this is exactly the window where "nothing came
 * back yet" and "the prefix is not cached yet" disagree.
 */
const acceptedThenStreamErrorFetch: FetchImpl = async () =>
	sseResponse(
		sseBody([
			MESSAGE_START_FRAME,
			{ type: "error", error: { type: "invalid_request_error", message: "generation abandoned mid-envelope" } },
		]),
	);

/**
 * Accepts the request, streams a text block, and then the body ends with no
 * terminal envelope, the way a connection dropped mid-generation looks. Text
 * already streamed, so no arm replays the turn.
 */
const acceptedThenTruncatedFetch: FetchImpl = async () =>
	sseResponse(
		sseBody([
			MESSAGE_START_FRAME,
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		]),
	);

/**
 * Streams `message_start`, then aborts the caller's signal without ever
 * closing the body — a user cancelling a turn that had already started
 * streaming. The ordering is structural rather than timed: a stream's `pull`
 * runs while the read that drains the previous chunk is still settling, so the
 * abort is armed one frame late on purpose. `message_start` therefore reaches
 * the provider before the signal trips, and the keepalive behind it is the
 * frame the abort actually cancels.
 */
function abortAfterAcceptanceFetch(abort: AbortController): FetchImpl {
	return async () => {
		const chunks = [sseBody([MESSAGE_START_FRAME]), sseBody([{ type: "ping" }])];
		let pulls = 0;
		return sseResponse(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					const chunk = chunks[pulls];
					pulls += 1;
					if (chunk !== undefined) {
						controller.enqueue(new TextEncoder().encode(chunk));
						return;
					}
					abort.abort();
					// Never resolves: the abort, not the body, is what ends this turn.
					return Promise.withResolvers<void>().promise;
				},
			}),
		);
	};
}

/**
 * Rejects the first request of a turn with the compiled-grammar 400 Anthropic
 * returns when a strict tool schema is too large, then succeeds. Records every
 * serialized body, so a test can prove the retry really did strip `strict`
 * instead of passing on an unchanged payload.
 */
function grammarRejectedOnceFetch(sink: { bodies: string[] }): FetchImpl {
	return async (input, init) => {
		sink.bodies.push(typeof init?.body === "string" ? init.body : "");
		if (sink.bodies.length === 1) {
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "invalid_request_error", message: "compiled grammar is too large" },
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}
		return await successFetch(input, init);
	};
}

/**
 * Rejects the first request of a turn with the 400 Anthropic returns when the
 * model or account does not carry fast mode, then succeeds. The retry rebuilds
 * the same turn without `speed`, and `speed` is not part of the cached prefix,
 * so the rebuild changes nothing the attribution pass looks at — which makes it
 * the clean way to ask what a rebuild reports about its own payload.
 */
function fastModeRejectedOnceFetch(sink: { bodies: string[] }): FetchImpl {
	return async (input, init) => {
		sink.bodies.push(typeof init?.body === "string" ? init.body : "");
		if (sink.bodies.length === 1) {
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "invalid_request_error", message: "This model does not support the speed parameter" },
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}
		return await successFetch(input, init);
	};
}

/**
 * Rejects the first request of a turn with the 400 Anthropic returns when a
 * replayed signed thinking block is bound to a conversation prefix the request
 * no longer carries, then succeeds. The provider answers by remembering the
 * bound blocks on its session state and rebuilding the turn without them, so
 * this is the provider's own between-turn decision to stop replaying thinking
 * — no hook, no caller change.
 */
function thinkingPrefixRejectedOnceFetch(sink: { bodies: string[] }): FetchImpl {
	return async (input, init) => {
		sink.bodies.push(typeof init?.body === "string" ? init.body : "");
		if (sink.bodies.length === 1) {
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: "invalid_request_error",
						message:
							"messages.1.content.0: invalid `signature` in `thinking` block: the block is bound to a different conversation",
					},
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}
		return await successFetch(input, init);
	};
}

/** Reasoning the provider replays natively, because it is signed and same-deployment. */
const SIGNED_THINKING: AssistantMessage["content"] = [
	{ type: "thinking", thinking: "Read the file, then summarise.", thinkingSignature: "sig-prior-turn" },
	{ type: "text", text: "on it" },
];

/** The same turn with an opaque redacted payload in place of the signed one. */
const REDACTED_THINKING: AssistantMessage["content"] = [
	{ type: "redactedThinking", data: "redacted-prior-turn-payload" },
	{ type: "text", text: "on it" },
];

/**
 * A conversation whose middle message is an assistant turn carrying replayed
 * reasoning. The trailing message is a real user turn, so there is no
 * `Continue.` pad and every message is part of the compared prefix.
 */
function contextWithPriorThinking(content: AssistantMessage["content"]): Context {
	return {
		systemPrompt: ["You are a precise assistant."],
		messages: [
			{ role: "user", content: "Think it through", timestamp: 1 },
			assistantTurn(content, 2),
			{ role: "user", content: "keep going", timestamp: 3 },
		],
		tools: [tool("lookup", {})],
	};
}

/** Thinking must be on for the provider to replay a prior turn's reasoning. */
const THINKING: Pick<AnthropicOptions, "thinkingEnabled"> = { thinkingEnabled: true };

/** Fast mode is what the in-provider degradation retry below strips. */
const PRIORITY: Pick<AnthropicOptions, "serviceTier"> = { serviceTier: "priority" };

/**
 * Payload hook that replaces the system prompt on the first attempt of a turn
 * and leaves every later rebuild alone, the way a hook keyed on some external
 * state does. The rejected attempt therefore sends a prompt the accepted one
 * does not.
 */
function systemPromptOnFirstAttempt(text: string): NonNullable<AnthropicOptions["onPayload"]> {
	let attempt = 0;
	return payload => {
		attempt += 1;
		if (attempt > 1) return undefined;
		return { ...(payload as Record<string, unknown>), system: [{ type: "text", text }] };
	};
}

const stateMaps: Array<Map<string, ProviderSessionState>> = [];

function createProviderSessionState(): Map<string, ProviderSessionState> {
	const states = new Map<string, ProviderSessionState>();
	stateMaps.push(states);
	return states;
}

async function turn(
	providerSessionState: Map<string, ProviderSessionState>,
	context: Context,
	cacheRetention?: CacheRetention,
	model: Model<"anthropic-messages"> = MODEL,
	fetch: FetchImpl = successFetch,
	options: Pick<
		AnthropicOptions,
		"onPayload" | "sessionId" | "promptCacheKey" | "serviceTier" | "effort" | "thinkingEnabled" | "signal"
	> = {},
): Promise<AssistantMessage> {
	return await streamAnthropic(model, context, {
		apiKey: "sk-ant-api-test",
		fetch,
		providerSessionState,
		sessionId: SESSION_ID,
		...(cacheRetention ? { cacheRetention } : {}),
		...options,
	}).result();
}

/**
 * Drives a session up to and including the turn that learns the strict-tools
 * drop, and returns that turn.
 *
 * A strict-eligible tool is declared at baseline and then leaves the active
 * set, so the plane withdraws it with a `tool_removal` control and keeps
 * declaring it — `strict` and all. The third turn's first attempt is rejected
 * for the compiled grammar that declaration still produces, and the retry
 * strips `strict` from the whole declared array. The withdrawn tool is not in
 * the current array, so the plane's definition-key re-baseline never compares
 * it and names nothing: only the prefix fingerprints can speak for the rewrite.
 */
async function learnStrictToolsDropMidTurn(
	states: Map<string, ProviderSessionState>,
	sink: { bodies: string[] },
): Promise<AssistantMessage> {
	// `bash` is on the strict allowlist, so its declaration really carries `strict`.
	const strictEligible = tool("bash", { command: { type: "string" } });
	const plain = tool("lookup", {});
	await turn(states, contextWithTools([strictEligible, plain]));
	await turn(states, contextWithTools([plain]));
	return await turn(states, contextWithTools([plain]), undefined, MODEL, grammarRejectedOnceFetch(sink));
}

afterEach(() => {
	for (const states of stateMaps.splice(0)) {
		for (const state of states.values()) state.close();
		states.clear();
	}
});

withOfficialAnthropicEndpoint();

describe("anthropic cache-break attribution", () => {
	it("names the tool whose definition changed for an already-declared tool", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {})]));
		const second = await turn(states, contextWithTools([tool("lookup", { key: { type: "string" } })]));

		expect(second.cacheBreakReason).toEqual({ kind: "tools", tool: "lookup" });
	});

	it("reports a retention switch when only the resolved cache ttl changed", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		await turn(states, context, "short");
		const second = await turn(states, context, "long");

		expect(second.cacheBreakReason).toEqual({ kind: "retention", from: "5m", to: "1h" });
	});

	it("blames nothing on the first request of a conversation", async () => {
		const states = createProviderSessionState();
		const first = await turn(states, contextWithTools([tool("lookup", {})]));

		expect(first.cacheBreakReason).toBeUndefined();
	});

	it("does not blame a tool added or removed between requests", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {}), tool("compute", {})]));
		// `compute` leaves, `search` joins: both ride mid-conversation controls,
		// which keep the declared prefix intact.
		const second = await turn(states, contextWithTools([tool("lookup", {}), tool("search", {})]));

		expect(second.cacheBreakReason).toBeUndefined();
	});

	it("blames the tool array on the turn that learns the strict-tools drop", async () => {
		const states = createProviderSessionState();
		const sink = { bodies: [] as string[] };
		const learned = await learnStrictToolsDropMidTurn(states, sink);

		// Without the retry really stripping `strict` off the declared array there
		// would be no prefix rewrite left to report, and this would pass on an
		// unchanged payload.
		expect(sink.bodies[0]).toContain('"strict":true');
		expect(sink.bodies[1]).not.toContain('"strict":true');
		expect(learned.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("does not blame a tool added after the strict-tools drop was learned", async () => {
		const states = createProviderSessionState();
		await learnStrictToolsDropMidTurn(states, { bodies: [] });
		// The array stays stripped from every later turn, so treating the strip
		// as "not what the plane planned" would blame this turn — and every turn
		// after it — instead of the one that actually changed. `search` joins on
		// a `tool_addition` control here exactly as it does where the drop was
		// never learned, and the declared array grows a `defer_loading` entry, so
		// only the exemption can keep this silent. The conversation moves on
		// first, so the new control lands at its own history slot rather than
		// growing the one the earlier withdrawal already wrote.
		const added = await turn(states, {
			...contextWithTools([tool("lookup", {}), tool("search", {})]),
			messages: [
				{ role: "user", content: "Use the tools", timestamp: 1 },
				assistantTurn([{ type: "text", text: "on it" }], 2),
				{ role: "user", content: "now search", timestamp: 3 },
			],
		});

		expect(added.cacheBreakReason).toBeUndefined();
	});

	it("blames the tool array on a deployment without mid-conversation tool changes", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		// No stable-tools plane here, so an added tool really does rewrite the
		// declared prefix — but no single tool can be blamed for it.
		const second = await turn(
			states,
			contextWithTools([tool("lookup", {}), tool("search", {})]),
			undefined,
			NO_TOOL_PLANE_MODEL,
		);

		expect(second.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("reports a rewritten history when a recorded control no longer lines up", async () => {
		const states = createProviderSessionState();
		const history = (tail: string): Context => ({
			...contextWithTools([tool("lookup", {}), tool("compute", {})]),
			messages: [
				{ role: "user", content: "Use the tools", timestamp: 1 },
				{ role: "user", content: tail, timestamp: 2 },
			],
		});
		await turn(states, history("keep going"));
		// A tool change pins a control transition to the tail message…
		await turn(states, {
			...history("keep going"),
			tools: [tool("lookup", {}), tool("compute", {}), tool("search", {})],
		});
		// …which a rewritten tail (compaction, branch switch, edit) invalidates.
		const third = await turn(states, {
			...history("actually, do this instead"),
			tools: [tool("lookup", {}), tool("compute", {}), tool("search", {})],
		});

		expect(third.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("reports a rewritten history when compaction replaced the conversation root", async () => {
		const states = createProviderSessionState();
		const tools = [tool("lookup", {}), tool("compute", {}), tool("search", {})];
		const history: Context = {
			...contextWithTools(tools.slice(0, 2)),
			messages: [
				{ role: "user", content: "Use the tools", timestamp: 1 },
				{ role: "user", content: "keep going", timestamp: 2 },
			],
		};
		await turn(states, history);
		// A tool change pins a control transition to the tail…
		await turn(states, { ...history, tools });
		// …then compaction collapses the whole history into one summary message,
		// so nothing the transition was anchored to survives.
		const third = await turn(states, {
			...history,
			tools,
			messages: [{ role: "user", content: "Summary: the user wanted the tools exercised.", timestamp: 3 }],
		});

		expect(third.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("blames the tool array when only a description changed and there is no tool plane", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		// The plane's comparison key ignores descriptions because a control cannot
		// express one; without a plane the description is prefix like any other byte.
		const second = await turn(
			states,
			contextWithTools([{ ...tool("lookup", {}), description: "lookup tool, now with caveats" }]),
			undefined,
			NO_TOOL_PLANE_MODEL,
		);

		expect(second.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("does not report a retention switch when caching was merely switched on", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		await turn(states, context, "none");
		const second = await turn(states, context, "long");

		expect(second.cacheBreakReason).toBeUndefined();
	});

	it("keeps the cause for a retry of a turn that was rejected before any response", async () => {
		const states = createProviderSessionState();
		const grown = contextWithTools([tool("lookup", {}), tool("search", {})]);
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		const rejected = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL, rejectedFetch);
		// The rejected attempt never reached Anthropic, so its prefix was never
		// written and the retry is the turn that really pays for the change.
		const retried = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL);

		expect(rejected.stopReason).toBe("error");
		expect(retried.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("advances the snapshot for a stream that failed after it was accepted", async () => {
		const states = createProviderSessionState();
		const grown = contextWithTools([tool("lookup", {}), tool("search", {})]);
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		const failed = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL, acceptedThenTruncatedFetch);
		// Anthropic accepted this prefix and wrote its cache entry before the
		// stream died, so the change belongs to the failed turn and the next one
		// changed nothing.
		const next = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL);

		expect(failed.stopReason).toBe("error");
		expect(failed.cacheBreakReason).toEqual({ kind: "tools" });
		expect(next.cacheBreakReason).toBeUndefined();
	});

	it("advances the snapshot for a stream accepted with no content at all", async () => {
		const states = createProviderSessionState();
		const grown = contextWithTools([tool("lookup", {}), tool("search", {})]);
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		const failed = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL, acceptedThenStreamErrorFetch);
		// No content block ever opened, so the provider's "nothing came back"
		// signal is still unset here — the prefix is cached all the same.
		const next = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL);

		expect(failed.stopReason).toBe("error");
		expect(next.cacheBreakReason).toBeUndefined();
	});

	it("advances the snapshot for a turn aborted after it was accepted", async () => {
		const states = createProviderSessionState();
		const abort = new AbortController();
		const grown = contextWithTools([tool("lookup", {}), tool("search", {})]);
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, NO_TOOL_PLANE_MODEL);
		const aborted = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL, abortAfterAcceptanceFetch(abort), {
			signal: abort.signal,
		});
		// A cancelled turn still paid for its prefix; the cache does not roll back
		// because the user changed their mind.
		const next = await turn(states, grown, undefined, NO_TOOL_PLANE_MODEL);

		expect(aborted.stopReason).toBe("aborted");
		expect(next.cacheBreakReason).toBeUndefined();
	});

	it("reports a system-prompt edit with the signed character delta", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		await turn(states, contextWithTools([tool("lookup", {})], before));
		const second = await turn(states, contextWithTools([tool("lookup", {})], after));

		expect(second.cacheBreakReason).toEqual({
			kind: "system_prompt",
			charDelta: after.length - before.length,
		});
	});

	it("does not blame a main turn for an isolated side request", async () => {
		const states = createProviderSessionState();
		const main = contextWithTools([tool("lookup", {})]);
		await turn(states, main);
		await turn(
			states,
			contextWithTools([tool("lookup", {})], "Summarize the conversation below."),
			undefined,
			MODEL,
			successFetch,
			{ sessionId: `${SESSION_ID}:side:1` },
		);
		const third = await turn(states, main);

		expect(third.cacheBreakReason).toBeUndefined();
	});

	it("attributes a payload-hook system edit and compares the next turn to the sent prompt", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		const context = contextWithTools([tool("lookup", {})], before);
		await turn(states, context);
		const second = await turn(states, context, undefined, MODEL, successFetch, {
			onPayload: payload => ({ ...(payload as Record<string, unknown>), system: [{ type: "text", text: after }] }),
		});
		const third = await turn(states, context);

		expect(second.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: after.length - before.length });
		expect(third.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: before.length - after.length });
	});

	it("reports a rewritten history when a payload hook replaced the conversation root", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		await turn(states, context);
		// The hook rewrites the root after the payload was assembled, so the
		// request really sends a different prefix than buildParams planned. A
		// turn that compares the assembled payload instead of the sent one goes
		// cold with nothing to report.
		const second = await turn(states, context, undefined, MODEL, successFetch, { onPayload: rewriteWireRoot });
		// The hook stops firing, so the root reverts to the caller's own: the
		// stored snapshot has to describe what was sent, or this turn is
		// compared against a prefix that never reached Anthropic.
		const third = await turn(states, context);

		expect(second.cacheBreakReason).toEqual({ kind: "history_rewrite" });
		expect(third.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("blames nothing when a payload hook rewrites the root the same way on every turn", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		const messages: Message[] = [{ role: "user", content: "Use the tools", timestamp: 1 }];
		const hooked = async (): Promise<AssistantMessage> =>
			await turn(states, { ...base, messages: [...messages] }, undefined, MODEL, successFetch, {
				onPayload: rewriteWireRoot,
			});
		await hooked();
		messages.push(assistantTurn([{ type: "text", text: "on it" }], 2), {
			role: "user",
			content: "keep going",
			timestamp: 3,
		});
		const second = await hooked();
		messages.push(assistantTurn([{ type: "text", text: "done" }], 4), {
			role: "user",
			content: "now summarize",
			timestamp: 5,
		});
		const third = await hooked();

		// Every turn sends the same rewritten root and appends below it, which is
		// an ordinary append of the history that was actually sent. Snapshotting
		// one of the two payloads and comparing against the other reports a
		// rewrite on every hooked turn forever.
		expect(second.cacheBreakReason).toBeUndefined();
		expect(third.cacheBreakReason).toBeUndefined();
	});

	it("reports a hook-rewritten root on a session-less request too", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		// Without a session id the snapshot is keyed on the root the caller
		// supplied. Keying it on the sent root instead would give a rewritten
		// root its own key, find no previous snapshot, and report nothing.
		await turn(states, context, undefined, MODEL, successFetch, { sessionId: undefined });
		const second = await turn(states, context, undefined, MODEL, successFetch, {
			sessionId: undefined,
			onPayload: rewriteWireRoot,
		});

		expect(second.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("reports a change back to an earlier system prefix on the same session", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		const original = contextWithTools([tool("lookup", {})], before);
		await turn(states, original);
		await turn(states, contextWithTools([tool("lookup", {})], after));
		const third = await turn(states, original);

		expect(third.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: before.length - after.length });
	});

	it("reports omitted and restored tool arrays even with mid-conversation tool changes", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		await turn(states, context);
		const second = await turn(states, { ...context, tools: undefined });
		const third = await turn(states, context);

		expect(second.cacheBreakReason).toEqual({ kind: "tools" });
		expect(third.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("blames a still-present tool array a payload hook rewrote under the tool plane", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		await turn(states, context);
		// The plane earns its exemption by keeping the array it produces stable.
		// The hook runs after it and rewrites that array, so this request really
		// does declare different tools than the cached prefix holds.
		const second = await turn(states, context, undefined, MODEL, successFetch, { onPayload: rewriteWireTools });
		// The hook stops firing and the array changes straight back, which is the
		// same prefix rewrite in the other direction.
		const third = await turn(states, context);

		expect(second.cacheBreakReason).toEqual({ kind: "tools" });
		expect(third.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("blames nothing when a payload hook rewrites the tool array the same way on every turn", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([tool("lookup", {})]);
		const hooked = async (): Promise<AssistantMessage> =>
			await turn(states, context, undefined, MODEL, successFetch, { onPayload: rewriteWireTools });
		await hooked();
		// Every turn sends the same rewritten array, so the declared prefix stands
		// still. Treating "the hook touched it" as the cause rather than comparing
		// what was sent blames a steady state on every hooked turn forever.
		const second = await hooked();

		expect(second.cacheBreakReason).toBeUndefined();
	});

	it("does not blame an added tool when a declared description carries a lone surrogate", async () => {
		const states = createProviderSessionState();
		const sent = { body: "" };
		await turn(states, contextWithTools([loneSurrogateTool]));
		// The add appends a `defer_loading` entry, so the plane's array really
		// does change bytes between the two turns and only the exemption keeps
		// this silent. The exemption holds only when the fingerprint taken over
		// the plane's output describes the normalized array that was sent.
		const second = await turn(
			states,
			contextWithTools([loneSurrogateTool, tool("search", {})]),
			undefined,
			MODEL,
			capturingFetch(sent),
		);

		// Without the surrogate really being rewritten on the wire, the two
		// fingerprints would have nothing to disagree about.
		expect(sent.body).toContain("lookup tool \ufffd");
		expect(second.cacheBreakReason).toBeUndefined();
	});

	it("blames a hook-rewritten tool array even when a declared description carries a lone surrogate", async () => {
		const states = createProviderSessionState();
		const context = contextWithTools([loneSurrogateTool]);
		await turn(states, context);
		// Normalizing the planned array must not turn the comparison into a
		// rubber stamp: the hook still sends an array the plane never produced.
		const second = await turn(states, context, undefined, MODEL, successFetch, { onPayload: rewriteWireTools });

		expect(second.cacheBreakReason).toEqual({ kind: "tools" });
	});

	it("blames nothing across a long run of turns that only append", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		const messages: Message[] = [{ role: "user", content: "Use the tools", timestamp: 1 }];
		const blamed: string[] = [];
		// 18 turns crosses the 15-user-turn decimation checkpoint, so the rolling
		// cache breakpoints really do move off messages that carried one earlier.
		// An append must still read as an append after they have moved.
		for (let index = 0; index < 18; index++) {
			const stamp = index * 4;
			const appended = await turn(states, { ...base, messages: [...messages] });
			if (appended.cacheBreakReason) blamed.push(`turn ${index}: ${appended.cacheBreakReason.kind}`);
			if (index % 3 === 1) {
				messages.push(
					assistantTurn(
						[{ type: "toolCall", id: `call_${index}`, name: "lookup", arguments: { key: `k${index}` } }],
						stamp + 1,
					),
					{
						role: "toolResult",
						toolCallId: `call_${index}`,
						toolName: "lookup",
						content: [{ type: "text", text: `row ${index}` }],
						isError: false,
						timestamp: stamp + 2,
					},
				);
			} else {
				messages.push(assistantTurn([{ type: "text", text: `reply ${index}` }], stamp + 1));
				// Continuing from a trailing assistant puts the synthetic `Continue.`
				// pad on the wire, and the next turn replaces it with the real user
				// turn — a disappearance that is not a rewrite.
				if (index % 4 === 3) {
					const continued = await turn(states, { ...base, messages: [...messages] });
					if (continued.cacheBreakReason) blamed.push(`continue ${index}: ${continued.cacheBreakReason.kind}`);
				}
			}
			messages.push({ role: "user", content: `follow-up ${index}`, timestamp: stamp + 3 });
		}

		expect(blamed).toEqual([]);
	});

	it("reports a rewritten history when a middle message was edited and no control was ever recorded", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		const history = (middle: string): Message[] => [
			{ role: "user", content: "Use the tools", timestamp: 1 },
			assistantTurn([{ type: "text", text: "on it" }], 2),
			{ role: "user", content: middle, timestamp: 3 },
			assistantTurn([{ type: "text", text: "done" }], 4),
			{ role: "user", content: "now summarize", timestamp: 5 },
		];
		await turn(states, { ...base, messages: history("check the second file") });
		// The tool set, the system prompt and the root all stand still, so no
		// control transition was ever recorded and nothing but the history
		// itself can name this turn's cause.
		const second = await turn(states, { ...base, messages: history("check the third file instead") });

		expect(second.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("reports a rewritten history when a middle message was removed", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		const root: Message[] = [
			{ role: "user", content: "Use the tools", timestamp: 1 },
			assistantTurn([{ type: "text", text: "on it" }], 2),
		];
		const removed: Message[] = [
			{ role: "user", content: "check the second file", timestamp: 3 },
			assistantTurn([{ type: "text", text: "second file is clean" }], 4),
		];
		const tail: Message[] = [{ role: "user", content: "now summarize", timestamp: 5 }];
		await turn(states, { ...base, messages: [...root, ...removed, ...tail] });
		// The removed pair is replaced by an equal-length continuation, so the
		// wire history is exactly as long as before and only a per-message
		// comparison can tell the two apart.
		const second = await turn(states, {
			...base,
			messages: [
				...root,
				...tail,
				assistantTurn([{ type: "text", text: "summary" }], 6),
				{ role: "user", content: "thanks", timestamp: 7 },
			],
		});

		expect(second.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("reports a rewritten history when a turn-scoped system message stopped being sent", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		const head: Message[] = [{ role: "user", content: "Use the tools", timestamp: 1 }];
		const scoped: DeveloperMessage = {
			role: "developer",
			content: [{ type: "text", text: "Keep this turn brief." }],
			providerPayload: { type: "anthropicMessage", clearAt: "next_user_message" },
			timestamp: 2,
		};
		const tail: Message[] = [
			assistantTurn([{ type: "text", text: "brief" }], 3),
			{ role: "user", content: "carry on", timestamp: 4 },
		];
		let turnScopedSent = 0;
		await turn(states, { ...base, messages: [...head, scoped, ...tail] }, undefined, MODEL, successFetch, {
			onPayload: payload => {
				const sent = payload as { messages?: Array<{ clear_at?: string }> };
				turnScopedSent = (sent.messages ?? []).filter(message => message.clear_at === "next_user_message").length;
			},
		});
		// The caller stops sending it once its turn is over. It sat mid-history,
		// so everything after it moves and the cached prefix goes with it. This
		// is reported rather than projected out: omp never emits one itself, so
		// it cannot mask the other causes, and staying silent here would leave a
		// genuinely cold turn unexplained.
		const second = await turn(states, {
			...base,
			messages: [
				...head,
				...tail,
				assistantTurn([{ type: "text", text: "still here" }], 5),
				{ role: "user", content: "again", timestamp: 6 },
			],
		});

		expect(turnScopedSent).toBe(1);
		expect(second.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("reports a rewritten history for a prompt-cache-key caller with no session id", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		// A direct caller (the Anthropic-compatible server, the auth gateway)
		// declares its cache identity as a prompt cache key. Request setup already
		// routes on it, so diagnostics must key on it too: falling back to the
		// conversation root gives the compacted turn its own snapshot key, finds
		// nothing to compare against, and leaves the cold turn unexplained.
		const identity: Pick<AnthropicOptions, "sessionId" | "promptCacheKey"> = {
			sessionId: undefined,
			promptCacheKey: "prompt-cache-key-without-session",
		};
		await turn(
			states,
			{
				...base,
				messages: [
					{ role: "user", content: "Use the tools", timestamp: 1 },
					assistantTurn([{ type: "text", text: "on it" }], 2),
					{ role: "user", content: "keep going", timestamp: 3 },
				],
			},
			undefined,
			MODEL,
			successFetch,
			identity,
		);
		const second = await turn(
			states,
			{
				...base,
				messages: [{ role: "user", content: "Summary: the user wanted the tools exercised.", timestamp: 4 }],
			},
			undefined,
			MODEL,
			successFetch,
			identity,
		);

		expect(second.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("scopes diagnostics to the declared prompt cache key rather than the conversation root", async () => {
		const states = createProviderSessionState();
		const base = contextWithTools([tool("lookup", {})]);
		const conversation = (opening: string): Context => ({
			...base,
			messages: [{ role: "user", content: opening, timestamp: 1 }],
		});
		const first = conversation("first conversation");
		const second = conversation("second conversation");
		const under = (
			promptCacheKey: string,
		): Pick<AnthropicOptions, "sessionId" | "promptCacheKey"> & { sessionId: undefined } => ({
			sessionId: undefined,
			promptCacheKey,
		});
		// One key is one cache identity, exactly as one session id is: the two
		// conversations share a snapshot and each reads as a rewrite of the other.
		// That is the same self-healing imprecision a shared session id has always
		// carried — the consumer only surfaces a reason on a turn that went cold —
		// and the alternative, mixing the root back into the key, is what loses
		// attribution across a compaction.
		await turn(states, first, undefined, MODEL, successFetch, under("shared"));
		const interleaved = await turn(states, second, undefined, MODEL, successFetch, under("shared"));
		const returned = await turn(states, first, undefined, MODEL, successFetch, under("shared"));
		// Distinct keys partition the snapshots, so the same interleaving is
		// silent: the rewrite above is caused by the shared identity, not by
		// anything about the two histories.
		await turn(states, first, undefined, MODEL, successFetch, under("own-key-a"));
		await turn(states, second, undefined, MODEL, successFetch, under("own-key-b"));
		const isolated = await turn(states, first, undefined, MODEL, successFetch, under("own-key-a"));

		expect(interleaved.cacheBreakReason).toEqual({ kind: "history_rewrite" });
		expect(returned.cacheBreakReason).toEqual({ kind: "history_rewrite" });
		expect(isolated.cacheBreakReason).toBeUndefined();
	});

	it("names the internal tool rather than its wire name when an escaped tool is redefined", async () => {
		const states = createProviderSessionState();
		let sentToolNames: string[] = [];
		await turn(states, contextWithTools([tool("bash", {})]), undefined, ESCAPED_TOOL_NAMES_MODEL);
		// The reason is persisted on the AssistantMessage and printed in the
		// cache-miss marker, so it has to name the tool the user configured. The
		// wire name is asserted alongside it: without the transport prefix really
		// being applied, the decode this defends would be a no-op.
		const second = await turn(
			states,
			contextWithTools([tool("bash", { command: { type: "string" } })]),
			undefined,
			ESCAPED_TOOL_NAMES_MODEL,
			successFetch,
			{
				onPayload: payload => {
					const sent = payload as { tools?: Array<{ name: string }> };
					sentToolNames = (sent.tools ?? []).map(entry => entry.name);
				},
			},
		);

		expect(sentToolNames).toEqual(["_bash"]);
		expect(second.cacheBreakReason).toEqual({ kind: "tools", tool: "bash" });
	});

	it("blames nothing when a degradation retry no longer carries the rejected attempt's change", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		const context = contextWithTools([tool("lookup", {})], before);
		await turn(states, context, undefined, MODEL, successFetch, PRIORITY);
		const sink = { bodies: [] as string[] };
		// The hook edits the prompt only on the attempt that gets rejected. The
		// rebuild sends the prompt the cached prefix already holds, so the turn
		// that actually reached Anthropic changed nothing and must say so.
		const second = await turn(states, context, undefined, MODEL, fastModeRejectedOnceFetch(sink), {
			...PRIORITY,
			onPayload: systemPromptOnFirstAttempt(after),
		});
		// The snapshot has to come from the accepted attempt: had the rejected
		// one been stored, this unchanged turn would read as a prompt reverting
		// from `after` back to `before`.
		const third = await turn(states, context, undefined, MODEL, successFetch, PRIORITY);

		// Without two really different payloads there is no misattribution to make.
		expect(sink.bodies).toHaveLength(2);
		expect(sink.bodies[0]).toContain(after);
		expect(sink.bodies[1]).not.toContain(after);
		expect(second.cacheBreakReason).toBeUndefined();
		expect(third.cacheBreakReason).toBeUndefined();
	});

	it("still blames a change the successful attempt of a degradation retry carries", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		await turn(states, contextWithTools([tool("lookup", {})], before), undefined, MODEL, successFetch, PRIORITY);
		const sink = { bodies: [] as string[] };
		// The edit is the caller's own, so it survives the rebuild and is on the
		// wire of the attempt that succeeded. Clearing attribution per rebuild
		// must not turn into wiping it.
		const second = await turn(
			states,
			contextWithTools([tool("lookup", {})], after),
			undefined,
			MODEL,
			fastModeRejectedOnceFetch(sink),
			PRIORITY,
		);

		expect(sink.bodies).toHaveLength(2);
		expect(second.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: after.length - before.length });
	});

	it("keeps a control-state cause consumed before a degradation retry rebuilt the turn", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, MODEL, successFetch, PRIORITY);
		const sink = { bodies: [] as string[] };
		// The redefinition re-baselines the stable-tools plane on the first
		// attempt, which both names `lookup` and updates the declared array. The
		// rebuild finds the plane already re-baselined, so it can neither
		// re-record the cause nor re-derive it from the payload: the declared
		// array is the plane's own output on both sides of the comparison and is
		// exempt. Only carrying the consumed cause forward keeps the tool named.
		const second = await turn(
			states,
			contextWithTools([tool("lookup", { key: { type: "string" } })]),
			undefined,
			MODEL,
			fastModeRejectedOnceFetch(sink),
			PRIORITY,
		);

		expect(sink.bodies).toHaveLength(2);
		expect(second.cacheBreakReason).toEqual({ kind: "tools", tool: "lookup" });
	});

	it("names the redefined tool on a turn whose re-baseline also dropped a recorded control", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {}), tool("compute", {})]));
		// `search` joins on a control transition, so this turn puts a synthetic
		// system message on the wire that the next one will not have.
		await turn(states, contextWithTools([tool("lookup", {}), tool("compute", {}), tool("search", {})]));
		// Redefining `lookup` re-baselines the plane: it records `lookup` as the
		// cause and clears the recorded transition in the same step. Counting
		// the control message as history makes the previous wire history stop
		// being a prefix of this one and buries the tool under a rewrite that
		// never happened.
		const third = await turn(
			states,
			contextWithTools([tool("lookup", { key: { type: "string" } }), tool("compute", {}), tool("search", {})]),
		);

		expect(third.cacheBreakReason).toEqual({ kind: "tools", tool: "lookup" });
	});

	it("reports the system-prompt edit that selected a fresh control state, not a rewrite", async () => {
		const states = createProviderSessionState();
		const before = "You are a precise assistant.";
		const after = "You are a precise assistant. Prefer short answers.";
		const tools = [tool("lookup", {}), tool("compute", {})];
		await turn(states, contextWithTools(tools, before));
		await turn(states, contextWithTools([...tools, tool("search", {})], before));
		// The control-state key carries the system texts, so editing the prompt
		// picks a fresh baseline whose transitions are empty — the control
		// message simply stops being sent. The prompt is the cause and is
		// already reported on its own dimension.
		const third = await turn(states, contextWithTools([...tools, tool("search", {})], after));

		expect(third.cacheBreakReason).toEqual({ kind: "system_prompt", charDelta: after.length - before.length });
	});

	it("drops a latched tool cause when the accepted rebuild sent the cached tool array", async () => {
		const states = createProviderSessionState();
		const cached: { tools: unknown } = { tools: undefined };
		await turn(states, contextWithTools([tool("lookup", {})]), undefined, MODEL, successFetch, {
			...PRIORITY,
			onPayload: payload => {
				const sent = payload as { tools: unknown };
				cached.tools = sent.tools;
				return undefined;
			},
		});
		const sink = { bodies: [] as string[] };
		let attempt = 0;
		// The redefinition re-baselines the plane on the rejected attempt and
		// latches `lookup`. The hook then puts the previously cached array back
		// on the rebuild, so the payload that actually reached Anthropic
		// declares exactly the tools the cached prefix already holds. Reporting
		// the latched cause here would blame a change the wire never carried,
		// and mislabel a turn that went cold for an unrelated reason.
		const second = await turn(
			states,
			contextWithTools([tool("lookup", { key: { type: "string" } })]),
			undefined,
			MODEL,
			fastModeRejectedOnceFetch(sink),
			{
				...PRIORITY,
				onPayload: payload => {
					attempt += 1;
					if (attempt === 1) return undefined;
					return { ...(payload as Record<string, unknown>), tools: cached.tools };
				},
			},
		);

		// Without two really different tool arrays there is no latch to misfire.
		expect(sink.bodies).toHaveLength(2);
		expect(sink.bodies[0]).toContain('"key":{"type":"string"}');
		expect(sink.bodies[1]).not.toContain('"key":{"type":"string"}');
		expect(second.cacheBreakReason).toBeUndefined();
	});

	it("reports a hook-rewritten tool_addition block on a cached control message", async () => {
		const states = createProviderSessionState();
		const declared = { body: "" };
		const sent = { body: "" };
		await turn(states, contextWithTools([tool("lookup", {}), tool("compute", {})]));
		// `search` joins on a control transition, so the wire history now carries
		// a system message whose `tool_addition` block is part of the cached
		// prefix. That turn itself is silent — see "does not blame a tool added
		// or removed between requests".
		const grown = contextWithTools([tool("lookup", {}), tool("compute", {}), tool("search", {})]);
		await turn(states, grown, undefined, MODEL, capturingFetch(declared));
		// The hook edits that block after the payload was assembled. The history
		// chain projects control declarations out, so nothing else in the request
		// compares these bytes and the turn would go cold with nothing to report.
		const third = await turn(states, grown, undefined, MODEL, capturingFetch(sent), {
			onPayload: rewriteWireToolAddition,
		});

		// Without the block really being declared and then really rewritten on
		// the wire, there is no prefix change to attribute.
		expect(declared.body).toContain('{"type":"tool_addition","tool":{"type":"tool_reference","name":"search"}}');
		expect(sent.body).toContain('{"type":"tool_addition","tool":{"type":"tool_reference","name":"rewritten"}}');
		expect(third.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("reports a hook that dropped the control blocks off a cached control message", async () => {
		const states = createProviderSessionState();
		const sent = { body: "" };
		await turn(states, contextWithTools([tool("lookup", {}), tool("compute", {})]));
		const grown = contextWithTools([tool("lookup", {}), tool("compute", {}), tool("search", {})]);
		await turn(states, grown);
		// The declaring message is control-only, so the projection drops it from
		// the chain whether or not it still holds its blocks: emptying it is
		// invisible to every other dimension while it still moves cached bytes.
		const third = await turn(states, grown, undefined, MODEL, capturingFetch(sent), {
			onPayload: dropWireControlBlocks,
		});

		expect(sent.body).not.toContain("tool_addition");
		expect(third.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("reports a hook-rewritten per-message effort and stays silent for the plane's own", async () => {
		const states = createProviderSessionState();
		const declared = { body: "" };
		const sent = { body: "" };
		const context: Context = {
			...contextWithTools([tool("lookup", {})]),
			messages: [
				{ role: "user", content: "Use the tools", timestamp: 1 },
				assistantTurn([{ type: "text", text: "on it" }], 2),
				{ role: "user", content: "keep going", timestamp: 3 },
			],
		};
		const at = (
			effort: "high" | "low",
		): Pick<AnthropicOptions, "effort" | "thinkingEnabled"> & { onPayload?: undefined } => ({
			thinkingEnabled: true,
			effort,
		});
		await turn(states, context, undefined, PER_MESSAGE_EFFORT_MODEL, successFetch, at("high"));
		// Lowering the effort is carried as an `output_config` control anchored
		// before the latest user message rather than as a top-level change, and
		// that is an ordinary plane-carried declaration: it must stay silent.
		const second = await turn(states, context, undefined, PER_MESSAGE_EFFORT_MODEL, capturingFetch(declared), {
			...at("low"),
		});
		// The plane replays the same control from here on, so the only thing that
		// changes on this turn is the hook's rewrite of its effort.
		const third = await turn(states, context, undefined, PER_MESSAGE_EFFORT_MODEL, capturingFetch(sent), {
			...at("low"),
			onPayload: rewriteWireEffort("max"),
		});

		expect(declared.body).toContain('{"role":"system","content":[],"output_config":{"effort":"low"}}');
		expect(sent.body).toContain('{"role":"system","content":[],"output_config":{"effort":"max"}}');
		expect(second.cacheBreakReason).toBeUndefined();
		expect(third.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("does not report a declaration a hook rewrote only in the messages this turn appended", async () => {
		const states = createProviderSessionState();
		const sent = { body: "" };
		const declared = [tool("lookup", {}), tool("compute", {})];
		await turn(states, appendingHistory(0, declared));
		// `search` joins on a turn that also appends an exchange, so the plane
		// anchors its `tool_addition` at the end of the wire history — after
		// every message the first turn sent. The hook then rewrites that block.
		// Those bytes sit past the prefix the first turn cached and cannot have
		// invalidated it, so a cold turn here is an expiry with no cause to
		// name, and reporting one would mislabel it.
		const second = await turn(
			states,
			appendingHistory(1, [...declared, tool("search", {})]),
			undefined,
			MODEL,
			capturingFetch(sent),
			{ onPayload: rewriteWireToolAddition },
		);

		// Without the declaration really being rewritten, and really sitting
		// after the appended user turn, there is nothing for the bound to keep
		// quiet about.
		expect(sent.body).toContain('{"type":"tool_addition","tool":{"type":"tool_reference","name":"rewritten"}}');
		expect(sent.body.indexOf('"rewritten"')).toBeGreaterThan(sent.body.indexOf("follow-up 0"));
		expect(second.cacheBreakReason).toBeUndefined();
	});

	it("reports a hook-rewritten declaration inside the cached prefix on a turn that also appended", async () => {
		const states = createProviderSessionState();
		const sent = { body: "" };
		const declared = [tool("lookup", {}), tool("compute", {})];
		const grown = [...declared, tool("search", {})];
		await turn(states, appendingHistory(0, declared));
		// `search` declares itself at the end of this turn's history.
		await turn(states, appendingHistory(1, grown));
		// Two more exchanges leave that declaration strictly inside the prefix
		// the previous turn cached, with chained messages on both sides of it.
		await turn(states, appendingHistory(2, grown));
		const fourth = await turn(states, appendingHistory(3, grown), undefined, MODEL, capturingFetch(sent), {
			onPayload: rewriteWireToolAddition,
		});

		// Without the declaration really sitting before a message the previous
		// turn also sent, this would pass on the append case above instead.
		expect(sent.body).toContain('{"type":"tool_addition","tool":{"type":"tool_reference","name":"rewritten"}}');
		expect(sent.body.indexOf('"rewritten"')).toBeLessThan(sent.body.indexOf("follow-up 1"));
		expect(fourth.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("does not report a control-only declaration a hook appended after the cached history", async () => {
		const states = createProviderSessionState();
		const sent = { body: "" };
		await turn(states, contextWithTools([tool("lookup", {}), tool("compute", {})]));
		// `search` joins on a control transition, so the plane's own declaration
		// rides the end of the wire history from here on and the next turn
		// inherits it as a cached byte.
		const grown = contextWithTools([tool("lookup", {}), tool("compute", {}), tool("search", {})]);
		await turn(states, grown);
		// The hook adds a control-only system message of its own after the whole
		// history. It is outside the chain, and it adds no chained message, so
		// the declaration count is the only thing that separates it from the
		// plane's trailing one — which the turn above really did cache and this
		// turn replays untouched. Nothing already cached moved, so a cold turn
		// here is an expiry with no cause to name.
		const third = await turn(states, grown, undefined, MODEL, capturingFetch(sent), {
			onPayload: appendWireControlDeclaration,
		});

		// Without the hook's declaration really being sent, and really sitting
		// after the plane's own, there is nothing for the bound to keep quiet
		// about.
		expect(sent.body).toContain('{"type":"tool_addition","tool":{"type":"tool_reference","name":"hooked"}}');
		expect(sent.body.indexOf('"hooked"')).toBeGreaterThan(
			sent.body.indexOf('{"type":"tool_addition","tool":{"type":"tool_reference","name":"search"}}'),
		);
		expect(third.cacheBreakReason).toBeUndefined();
	});

	it("reports a hook-rewritten cached declaration on a turn whose hook also appended one", async () => {
		const states = createProviderSessionState();
		const sent = { body: "" };
		await turn(states, contextWithTools([tool("lookup", {}), tool("compute", {})]));
		const grown = contextWithTools([tool("lookup", {}), tool("compute", {}), tool("search", {})]);
		await turn(states, grown);
		// Same append as above, plus a rewrite of the declaration the previous
		// turn cached. The appended one must not fill the bound in place of the
		// cached one and hide the rewrite behind it.
		const third = await turn(states, grown, undefined, MODEL, capturingFetch(sent), {
			onPayload: rewriteAndAppendWireControlDeclaration,
		});

		expect(sent.body).toContain('{"type":"tool_addition","tool":{"type":"tool_reference","name":"rewritten"}}');
		expect(sent.body).toContain('{"type":"tool_addition","tool":{"type":"tool_reference","name":"hooked"}}');
		expect(third.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("blames nothing when a payload hook rewrites a cached declaration the same way on every turn", async () => {
		const states = createProviderSessionState();
		await turn(states, contextWithTools([tool("lookup", {}), tool("compute", {})]));
		const grown = contextWithTools([tool("lookup", {}), tool("compute", {}), tool("search", {})]);
		await turn(states, grown);
		// The hook rewrites the plane's declaration on this turn and the next,
		// so the declaration the fourth turn sends is byte-identical to the one
		// the third turn cached. Neither turn is planned, so the exemption is
		// off and the bound is the only thing answering: it has to read the
		// declaration that sits at the boundary itself, not skip over it,
		// because skipping leaves the empty fold to compare against a prefix
		// that carried one and reports a rewrite nobody made.
		await turn(states, grown, undefined, MODEL, successFetch, { onPayload: rewriteWireToolAddition });
		const fourth = await turn(states, grown, undefined, MODEL, successFetch, {
			onPayload: rewriteWireToolAddition,
		});

		expect(fourth.cacheBreakReason).toBeUndefined();
	});

	it("reports a hook-rewritten thinking block on a prior assistant turn", async () => {
		const states = createProviderSessionState();
		const declared = { body: "" };
		const sent = { body: "" };
		const context = contextWithPriorThinking(SIGNED_THINKING);
		await turn(states, context, undefined, MODEL, successFetch, THINKING);
		// Replaying the same signed block changes nothing, which is what makes
		// the third turn's rewrite the only difference there is.
		const second = await turn(states, context, undefined, MODEL, capturingFetch(declared), THINKING);
		// The hook swaps the reasoning under the replayed signature and leaves
		// the turn's text block alone. The history chain projects thinking out
		// of an assistant message, so nothing else in the request compares
		// these bytes and the turn would go cold with nothing to report.
		const third = await turn(states, context, undefined, MODEL, capturingFetch(sent), {
			...THINKING,
			onPayload: rewriteWireThinking,
		});

		// Without the block really being replayed and then really rewritten on
		// the wire, there is no prefix change to attribute.
		expect(declared.body).toContain('{"type":"thinking","thinking":"Read the file, then summarise."');
		expect(sent.body).toContain('{"type":"thinking","thinking":"Rewritten after assembly."');
		// The visible content the chain does measure is untouched on both.
		expect(sent.body).toContain('{"type":"text","text":"on it"');
		expect(second.cacheBreakReason).toBeUndefined();
		expect(third.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("reports a hook-rewritten redacted_thinking block on a prior assistant turn", async () => {
		const states = createProviderSessionState();
		const declared = { body: "" };
		const sent = { body: "" };
		const context = contextWithPriorThinking(REDACTED_THINKING);
		await turn(states, context, undefined, MODEL, successFetch, THINKING);
		const second = await turn(states, context, undefined, MODEL, capturingFetch(declared), THINKING);
		const third = await turn(states, context, undefined, MODEL, capturingFetch(sent), {
			...THINKING,
			onPayload: rewriteWireRedactedThinking,
		});

		expect(declared.body).toContain('{"type":"redacted_thinking","data":"redacted-prior-turn-payload"}');
		expect(sent.body).toContain('{"type":"redacted_thinking","data":"rewritten-redacted-payload"}');
		expect(sent.body).toContain('{"type":"text","text":"on it"');
		expect(second.cacheBreakReason).toBeUndefined();
		expect(third.cacheBreakReason).toEqual({ kind: "history_rewrite" });
	});

	it("reports the turn on which the provider itself stopped replaying a prior thinking block", async () => {
		const states = createProviderSessionState();
		const sink = { bodies: [] as string[] };
		const after = { body: "" };
		const context = contextWithPriorThinking(SIGNED_THINKING);
		await turn(states, context, undefined, MODEL, successFetch, THINKING);
		// Anthropic rejects the replayed block as bound to a prefix this
		// request no longer carries. The provider remembers it on the session
		// state and rebuilds the turn without it: an unhooked, provider-driven
		// change to bytes the cached prefix already held, with every other
		// dimension — chain, control declarations, system, tools, retention —
		// equal. Reported, because nothing else names it and the turn is cold.
		const second = await turn(states, context, undefined, MODEL, thinkingPrefixRejectedOnceFetch(sink), THINKING);
		// The drop is latched on the session state, so the next turn sends the
		// same history the accepted attempt did and has nothing to report. The
		// decision answers once, on the turn the behavior changed.
		const third = await turn(states, context, undefined, MODEL, capturingFetch(after), THINKING);

		// Without the first attempt really carrying the block and the accepted
		// one really dropping it, there is no provider-driven change to report.
		expect(sink.bodies).toHaveLength(2);
		expect(sink.bodies[0]).toContain('"type":"thinking"');
		expect(sink.bodies[1]).not.toContain('"type":"thinking"');
		expect(sink.bodies[1]).toContain('{"type":"text","text":"on it"');
		expect(after.body).not.toContain('"type":"thinking"');
		expect(second.cacheBreakReason).toEqual({ kind: "history_rewrite" });
		expect(third.cacheBreakReason).toBeUndefined();
	});
});
