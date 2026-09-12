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

const successFetch: FetchImpl = async () => {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_cache_break",
				usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const body = `${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_cache_break" },
	});
};

/** Rejects before any response body exists, the way a malformed request does. */
const rejectedFetch: FetchImpl = async () =>
	new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "rejected" } }), {
		status: 400,
		headers: { "Content-Type": "application/json" },
	});

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
	options: Pick<AnthropicOptions, "onPayload" | "sessionId"> = {},
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
});
