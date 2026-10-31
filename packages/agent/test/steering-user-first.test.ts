import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

/** An agent-authored card, as an extension's `sendMessage(..., { deliverAs: "steer" })` queues it. */
function card(n: number): AgentMessage {
	return { role: "custom", customType: "card", content: `card ${n}`, display: true, timestamp: n };
}

function person(text: string): AgentMessage {
	return { role: "user", content: text, attribution: "user", timestamp: Date.now() };
}

/** Hidden companion the session queues just ahead of the prompt it belongs to. */
function companion(text: string): AgentMessage {
	return {
		role: "custom",
		customType: "image-attachment-description",
		content: text,
		display: false,
		attribution: "user",
		timestamp: Date.now(),
	};
}

/** Show custom records to the model as user text, as the coding agent's conversion does. */
function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.flatMap((message): Message[] => {
		if (message.role === "custom") {
			const content = typeof message.content === "string" ? message.content : "";
			return [{ role: "user", content, timestamp: message.timestamp }];
		}
		return message.role === "user" || message.role === "assistant" || message.role === "toolResult" ? [message] : [];
	});
}

function texts(context: Context): string[] {
	return context.messages.map(message =>
		typeof message.content === "string"
			? message.content
			: message.content.map(part => ("text" in part ? part.text : `[${part.type}]`)).join(""),
	);
}

function transcriptTexts(agent: Agent): string[] {
	return agent.state.messages
		.filter(message => message.role === "user" || message.role === "custom")
		.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content.map(part => ("text" in part ? part.text : "")).join(""),
		);
}

/**
 * A run whose first model call queues `queued` mid-batch from a tool, then answers in text
 * until the steering queue drains; each later model call reads one steering unit.
 */
async function runWithQueued(
	queued: AgentMessage[],
	options: { steeringMode?: "all" | "one-at-a-time"; grouping?: boolean } = {},
): Promise<{ agent: Agent; calls: Context[] }> {
	const agentRef = {} as { current: Agent };
	const schema = type({});
	const tool: AgentTool<typeof schema> = {
		name: "step",
		label: "Step",
		description: "Step tool",
		parameters: schema,
		async execute() {
			for (const message of queued) agentRef.current.steer(message);
			return { content: [{ type: "text", text: "stepped" }] };
		},
	};
	const mock = createMockModel({
		handler: context =>
			context.messages.length === 1
				? { content: [{ type: "toolCall", id: "step-1", name: "step", arguments: {} }] }
				: { content: [`read ${context.messages.length}`] },
	});
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
		streamFn: mock.stream,
		convertToLlm,
		steeringMode: options.steeringMode ?? "one-at-a-time",
	});
	if (options.grouping) {
		agent.setQueuedMessageGrouping(
			(previous, next) =>
				previous.role === "custom" &&
				previous.display === false &&
				(next.role === "user" || next.role === "custom"),
		);
	}
	agentRef.current = agent;
	await agent.prompt("start");
	return { agent, calls: mock.calls.map(call => call.context) };
}

describe("one-at-a-time steering: a person's message before agent steering", () => {
	it("reads a person's steer at the next model call, ahead of agent steers queued before it", async () => {
		const { agent, calls } = await runWithQueued([card(1), card(2), card(3), person("read me now")]);

		// Call 0 starts the run and asks for the tool; call 1 is the first boundary after the steer.
		expect(texts(calls[1]).at(-1)).toBe("read me now");
		for (const n of [1, 2, 3]) expect(texts(calls[1])).not.toContain(`card ${n}`);
		// The agent steers still arrive, one per boundary, in the order they were queued.
		expect(texts(calls[2]).at(-1)).toBe("card 1");
		expect(texts(calls[3]).at(-1)).toBe("card 2");
		expect(texts(calls[4]).at(-1)).toBe("card 3");
		expect(calls).toHaveLength(5);
		expect(transcriptTexts(agent)).toEqual(["start", "read me now", "card 1", "card 2", "card 3"]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("keeps a person's messages in the order typed and a companion with its prompt", async () => {
		const { agent, calls } = await runWithQueued(
			[card(1), companion("diagram description"), person("first"), card(2), person("second")],
			{ grouping: true },
		);

		expect(texts(calls[1]).slice(-2)).toEqual(["diagram description", "first"]);
		expect(texts(calls[2]).at(-1)).toBe("second");
		expect(texts(calls[3]).at(-1)).toBe("card 1");
		expect(texts(calls[4]).at(-1)).toBe("card 2");
		expect(transcriptTexts(agent)).toEqual(["start", "diagram description", "first", "second", "card 1", "card 2"]);
	});

	it("leaves agent-only steering in queue order", async () => {
		const parent: AgentMessage = { role: "user", content: "parent", attribution: "agent", timestamp: 1 };
		const { agent } = await runWithQueued([card(1), parent, card(2)]);

		expect(transcriptTexts(agent)).toEqual(["start", "card 1", "parent", "card 2"]);
	});

	it("delivers the whole queue in order at the next boundary in all mode", async () => {
		const { agent, calls } = await runWithQueued([card(1), person("mine"), card(2)], { steeringMode: "all" });

		expect(texts(calls[1]).slice(-3)).toEqual(["card 1", "mine", "card 2"]);
		expect(calls).toHaveLength(2);
		expect(transcriptTexts(agent)).toEqual(["start", "card 1", "mine", "card 2"]);
	});

	it("interrupts a tool batch for a person's steer queued behind agent steering", async () => {
		const agentRef = {} as { current: Agent };
		const schema = type({ value: type("string") });
		const executed: string[] = [];
		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: schema,
			concurrency: "exclusive",
			interruptible: true,
			async execute(_id, params) {
				executed.push(params.value);
				if (params.value === "first") {
					agentRef.current.steer(card(1));
					agentRef.current.steer(person("stop and read this"));
				}
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["read"] },
				{ content: ["read card"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: mock.stream,
			convertToLlm,
			steeringMode: "one-at-a-time",
			interruptMode: "immediate",
		});
		agentRef.current = agent;
		const events: AgentEvent[] = [];
		agent.subscribe(event => events.push(event));

		await agent.prompt("start");

		expect(executed).toEqual(["first"]);
		const skipped = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end" && event.toolCallId === "tool-2",
		);
		const skippedText = skipped?.result.content[0];
		expect(skippedText?.type === "text" ? skippedText.text : "").toContain("Skipped due to queued user message");
		expect(texts(mock.calls[1].context).at(-1)).toBe("stop and read this");
	});
});
