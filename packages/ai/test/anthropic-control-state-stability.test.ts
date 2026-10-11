import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai/types";
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
type Payload = {
	output_config?: { effort?: string };
	messages: WireMessage[];
	tools?: { name: string; defer_loading?: boolean }[];
};

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

type Turn = { payload: Payload; message: AssistantMessage };

/**
 * Builds one request through the real param path. `message` is the terminal
 * message; its `requestControls` go on the reply appended for the next turn.
 */
async function capture(
	messages: Message[],
	reasoning: Effort,
	options: { sessionId?: string; tools?: Context["tools"]; inactiveTools?: Context["tools"] } = {},
): Promise<Turn> {
	let payload: Payload | undefined;
	const controller = new AbortController();
	controller.abort();
	const message = await streamAnthropic(
		MODEL,
		{
			systemPrompt: ["Stable system prompt."],
			messages,
			tools: options.tools ?? [tool("read")],
			inactiveTools: options.inactiveTools,
		},
		{
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			signal: controller.signal,
			thinkingEnabled: true,
			reasoning,
			sessionId: options.sessionId ?? "session",
			onPayload: captured => {
				payload = captured as Payload;
			},
		},
	).result();
	if (!payload) throw new Error("expected a built payload");
	return { payload, message };
}

/** `message` as the response to `turn`'s request. */
function answering<T extends AssistantMessage>(message: T, turn: Turn): T {
	return { ...message, requestControls: turn.message.requestControls };
}

/** Wire tool name `turn` declared for `name` (OAuth prefixes tool names). */
function wireName(turn: Turn, index: number): string {
	const name = turn.payload.tools?.[index]?.name;
	if (!name) throw new Error(`expected declared tool ${index}`);
	return name;
}

function referencesTool(payload: Payload, name: string): boolean {
	return payload.messages.some(
		message =>
			Array.isArray(message.content) &&
			message.content.some(
				(block: { tool?: { type?: string; name?: string } }) =>
					block.tool?.type === "tool_reference" && block.tool.name === name,
			),
	);
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

/** Anthropic rejects a `system` message with content unless an assistant turn (or the end) follows. */
function expectValidSystemPlacement(payload: Payload): void {
	payload.messages.forEach((message, index) => {
		if (message.role !== "system" || !Array.isArray(message.content) || message.content.length === 0) return;
		const next = payload.messages.slice(index + 1).find(later => later.role !== "system");
		expect(next?.role ?? "end").not.toBe("user");
	});
}

describe("Anthropic controls derived from the transcript", () => {
	it("replays a tool removal and an effort change from records so the next turn is a cache-stable continuation", async () => {
		const turn0 = [user("start")];
		const first = await capture(turn0, Effort.High, { tools: [tool("read"), tool("grep")] });
		const turn1 = [...turn0, answering(reply("ready"), first), user("continue")];
		const changed = await capture(turn1, Effort.Low, { tools: [tool("read")], inactiveTools: [tool("grep")] });

		expect(changed.payload.tools?.map(declared => declared.name)).toEqual([wireName(first, 0), wireName(first, 1)]);
		expect(changed.payload.output_config?.effort).toBe("high");
		expect(referencesTool(changed.payload, wireName(first, 1))).toBe(true);
		expect(changed.payload.messages.flatMap(message => message.output_config?.effort ?? [])).toEqual(["low"]);

		const next = await capture([...turn1, answering(reply("done"), changed), user("again")], Effort.Low, {
			tools: [tool("read")],
			inactiveTools: [tool("grep")],
		});
		expectCacheStableContinuation(changed.payload, next.payload);
	});

	it("gives a side request the main request's messages as a byte-identical prefix", async () => {
		const turn0 = [user("start")];
		const first = await capture(turn0, Effort.High, { tools: [tool("read"), tool("grep")] });
		const turn1 = [...turn0, answering(reply("ready"), first), user("continue")];
		const changed = await capture(turn1, Effort.Low, { tools: [tool("read")], inactiveTools: [tool("grep")] });
		const history = [...turn1, answering(reply("done"), changed), user("again")];
		const options = { tools: [tool("read")], inactiveTools: [tool("grep")] };

		// Same tools and effort as the latest record: no tail control.
		const main = await capture(history, Effort.Low, options);
		const side = await capture([...history, user("side question")], Effort.Low, {
			...options,
			sessionId: "session:side:1",
		});

		expect(referencesTool(main.payload, wireName(first, 1))).toBe(true);
		expect(main.payload.messages.at(-1)?.role).toBe("user");
		expect(withoutCacheControl(side.payload.tools)).toEqual(withoutCacheControl(main.payload.tools));
		expectCacheStableContinuation(main.payload, side.payload);
	});

	it("drops a declared tool whose definition is no longer available", async () => {
		const turn0 = [user("start")];
		const first = await capture(turn0, Effort.High, { tools: [tool("read"), tool("grep")] });
		const grep = wireName(first, 1);
		const next = await capture([...turn0, answering(reply("ready"), first), user("continue")], Effort.High, {
			tools: [tool("read")],
		});

		expect(next.payload.tools?.map(declared => declared.name)).toEqual([wireName(first, 0)]);
		expect(referencesTool(next.payload, grep)).toBe(false);
	});

	it("loads the tools a tool-less conversation gains instead of deferring all of them", async () => {
		const turn0 = [user("start")];
		const first = await capture(turn0, Effort.Low, { tools: [] });
		const turn1 = [...turn0, answering(reply("ready"), first), user("continue")];
		const gained = await capture(turn1, Effort.Low, { tools: [tool("read"), tool("grep")] });

		expect(gained.payload.tools?.map(declared => declared.defer_loading)).toEqual([undefined, undefined]);
		expectValidSystemPlacement(gained.payload);
		const next = await capture([...turn1, answering(reply("done"), gained), user("again")], Effort.Low, {
			tools: [tool("read"), tool("grep")],
		});
		expectCacheStableContinuation(gained.payload, next.payload);
	});

	it("moves an interrupted request's tool control past the steer and keeps it there once answered", async () => {
		const turn0 = [user("start")];
		const first = await capture(turn0, Effort.Low, { tools: [tool("read"), tool("grep")] });
		const loop = [
			...turn0,
			answering(
				assistant(
					[
						{ type: "thinking", thinking: "reading", thinkingSignature: "sig-read" },
						{ type: "toolCall", id: "call_1", name: "read", arguments: {} },
					],
					"toolUse",
				),
				first,
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
		const withdrawn = { tools: [tool("read")], inactiveTools: [tool("grep")] };
		// `grep` leaves the roster: a `tool_removal` control is sent after the tool result.
		const toolChange = await capture(loop, Effort.Low, withdrawn);
		// The user interrupts that request before any output and steers with a different effort.
		const steeredHistory = [
			...loop,
			answering(assistant([], "aborted"), toolChange),
			user("stop, do it differently", true),
		];
		const steered = await capture(steeredHistory, Effort.Medium, withdrawn);

		// The empty interrupted reply is not replayed, so the removal moves to the
		// steer's reply; everything the interrupted request sent before it stays.
		const sent = toolChange.payload.messages;
		expectCacheStableContinuation({ ...toolChange.payload, messages: sent.slice(0, -1) }, steered.payload);
		expect(withoutCacheControl(steered.payload.messages.at(-1))).toEqual(withoutCacheControl(sent.at(-1)));
		expectValidSystemPlacement(steered.payload);
		// The steer's effort goes out exactly once, as its own control message.
		expect(steered.payload.messages.flatMap(message => message.output_config?.effort ?? [])).toEqual(["medium"]);

		const next = await capture(
			[...steeredHistory, answering(reply("redone"), steered), user("thanks")],
			Effort.Medium,
			withdrawn,
		);
		expectCacheStableContinuation(steered.payload, next.payload);
		expectValidSystemPlacement(next.payload);
	});
});
