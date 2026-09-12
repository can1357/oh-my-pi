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
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	FetchImpl,
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
): Promise<AssistantMessage> {
	return await streamAnthropic(model, context, {
		apiKey: "sk-ant-api-test",
		fetch,
		providerSessionState,
		sessionId: SESSION_ID,
		...(cacheRetention ? { cacheRetention } : {}),
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

	it("does not blame a main turn for a side request that reused the session and conversation", async () => {
		const states = createProviderSessionState();
		const main = contextWithTools([tool("lookup", {})]);
		await turn(states, main);
		// Summarizers and classifiers reuse the session id and the conversation
		// root with their own prompt; the main turn's prefix is untouched by them.
		await turn(states, contextWithTools([tool("lookup", {})], "Summarize the conversation below."));
		const third = await turn(states, main);

		expect(third.cacheBreakReason).toBeUndefined();
	});
});
