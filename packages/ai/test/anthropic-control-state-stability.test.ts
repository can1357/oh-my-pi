import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, Message, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

const MODEL = buildModel({
	id: "claude-fable-5-1",
	name: "claude-fable-5-1",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

type WireMessage = { role: string; content: unknown; output_config?: { effort?: string } };
type Payload = { output_config?: { effort?: string }; messages: WireMessage[] };

let clock = 1;
function user(text: string, steering?: boolean): Message {
	return { role: "user", content: [{ type: "text", text }], attribution: "user", steering, timestamp: clock++ };
}
function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
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
		stopReason,
		timestamp: clock++,
	};
}
function reply(text: string): AssistantMessage {
	return assistant(
		[
			{ type: "thinking", thinking: `thinking about ${text}`, thinkingSignature: `sig-${text}` },
			{ type: "text", text },
		],
		"stop",
	);
}
function tool(name: string): NonNullable<Context["tools"]>[number] {
	return { name, description: `${name} tool`, parameters: { type: "object", properties: {} } };
}

/** Builds one request through the real param path; every call shares `state` like one omp session. */
function capture(
	state: Map<string, ProviderSessionState>,
	messages: Message[],
	reasoning: Effort,
	options: { sessionId?: string; tools?: Context["tools"] } = {},
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	const controller = new AbortController();
	controller.abort();
	streamAnthropic(
		MODEL,
		{ systemPrompt: ["Stable system prompt."], messages, tools: options.tools ?? [tool("read")] },
		{
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			signal: controller.signal,
			thinkingEnabled: true,
			reasoning,
			sessionId: options.sessionId ?? "session",
			providerSessionState: state,
			onPayload: payload => resolve(payload as Payload),
		},
	);
	return promise;
}

/** Cache breakpoints move with the request; everything else must be byte-identical. */
function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (value && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key in source) {
			if (key !== "cache_control") out[key] = withoutCacheControl(source[key]);
		}
		return out;
	}
	return value;
}

/**
 * A continuation must keep the top-level effort and replay every wire message
 * the earlier request already sent (materialized `role: "system"` controls
 * included) byte for byte; cache breakpoints may move.
 */
function expectCacheStableContinuation(earlier: Payload, later: Payload): void {
	expect(later.output_config?.effort).toBe(earlier.output_config?.effort);
	const serialize = (message: WireMessage) => JSON.stringify(withoutCacheControl(message));
	expect(later.messages.slice(0, earlier.messages.length).map(serialize)).toEqual(earlier.messages.map(serialize));
}

describe("Anthropic control state across one session's requests", () => {
	it("keeps the conversation's controls when side requests share the provider session state", async () => {
		const state = new Map<string, ProviderSessionState>();
		const turn0 = [user("start")];
		await capture(state, turn0, Effort.High);
		const turn1 = [...turn0, reply("ready"), user("continue")];
		const beforeSideRequests = await capture(state, turn1, Effort.Low);
		// `runEphemeralTurn` (/btw, /omfg, idle recap) sends the main history under a
		// fresh `<session>:side:<snowflake>` id through the same providerSessionState.
		for (let index = 0; index < 16; index++) {
			await capture(state, [...turn1, user(`side question ${index}`)], Effort.Low, {
				sessionId: `session:side:${index}`,
			});
		}
		const afterSideRequests = await capture(state, [...turn1, reply("done"), user("again")], Effort.Low);

		expectCacheStableContinuation(beforeSideRequests, afterSideRequests);
	});

	it("does not rewrite an already-sent tool control when a later effort change lands on its slot", async () => {
		const state = new Map<string, ProviderSessionState>();
		const turn0 = [user("start")];
		await capture(state, turn0, Effort.Low, { tools: [tool("read"), tool("grep")] });
		const loop = [
			...turn0,
			assistant(
				[
					{ type: "thinking", thinking: "reading", thinkingSignature: "sig-read" },
					{ type: "toolCall", id: "call_1", name: "read", arguments: {} },
				],
				"toolUse",
			),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: clock++,
			} satisfies Message,
		];
		// `grep` leaves the roster: a `tool_removal` control is sent after the tool result.
		const toolChange = await capture(state, loop, Effort.Low, { tools: [tool("read")] });
		// The user interrupts the next step and steers with a different effort.
		const steered = await capture(
			state,
			[...loop, assistant([], "aborted"), user("stop, do it differently", true)],
			Effort.Medium,
			{ tools: [tool("read")] },
		);

		expectCacheStableContinuation(toolChange, steered);
		// Not rewriting the sent control must not drop the steer's effort either:
		// it goes out exactly once, as its own control message.
		expect(steered.messages.flatMap(message => message.output_config?.effort ?? [])).toEqual(["medium"]);
	});
});
