import { expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core/agent";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentLoopConfig, AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createAssistantMessage, createUserMessage } from "./helpers";

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

it("retains one finalized argument snapshot with a read-only interceptor without exposing final rewrites", async () => {
	const mock = createMockModel({ responses: [{ content: ["finished"] }] });
	const args = { entries: Array.from({ length: 1000 }, (_, value) => ({ value })) };
	const toolCall = { type: "toolCall" as const, id: "first", name: "noop", arguments: args };
	const partial = createAssistantMessage([toolCall, { type: "text", text: "later" }], "toolUse");
	let calls = 0;
	const streamFn: typeof mock.stream = (model, context, options) => {
		if (calls++ > 0) return mock.stream(model, context, options);
		const response = new AssistantMessageEventStream();
		response.push({ type: "start", partial });
		response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
		for (let i = 0; i < 100; i++) {
			response.push({ type: "text_delta", contentIndex: 1, delta: "later", partial });
		}
		response.push({ type: "done", reason: "toolUse", message: partial });
		return response;
	};
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: [], messages: [], tools: [] },
		streamFn,
		convertToLlm,
		transformAssistantMessage(message) {
			const block = message.content[0];
			if (block?.type === "toolCall") (block.arguments.entries as { value: number }[])[0].value = -1;
		},
	});
	let observed = 0;
	agent.setAssistantMessageEventInterceptor(
		(_message, event) => {
			if (event.type === "toolcall_end" || event.type === "text_delta") observed++;
		},
		{ readOnly: true },
	);
	const retained = new Set<Record<string, unknown>>();
	let updates = 0;
	let finalArgs: Record<string, unknown> | undefined;
	const unsubscribe = agent.subscribe(event => {
		if (event.type !== "message_update" && event.type !== "message_end") return;
		if (event.message.role !== "assistant") return;
		const block = event.message.content[0];
		if (block?.type !== "toolCall") return;
		if (event.type === "message_update") {
			updates++;
			retained.add(block.arguments);
		} else finalArgs = block.arguments;
	});
	try {
		await agent.prompt("run");
	} finally {
		unsubscribe();
	}
	expect(updates).toBe(101);
	expect(observed).toBe(102);
	expect(retained.size).toBe(1);
	const snapshot = [...retained][0];
	expect(snapshot.entries).toEqual(args.entries);
	expect(snapshot.entries).not.toBe(args.entries);
	if (!finalArgs) throw new Error("missing finalized tool arguments");
	expect((finalArgs.entries as { value: number }[])[0].value).toBe(-1);
	expect((snapshot.entries as { value: number }[])[0].value).toBe(0);
});

it("isolates interleaved argument updates, reopened calls, and restarted partials", async () => {
	const mock = createMockModel({ responses: [{ content: ["finished"] }] });
	const first = { type: "toolCall" as const, id: "first", name: "noop", arguments: { nested: { value: 0 } } };
	const second = { type: "toolCall" as const, id: "second", name: "noop", arguments: { nested: { value: 0 } } };
	const partial = createAssistantMessage([first], "toolUse");
	const response = new AssistantMessageEventStream();
	let calls = 0;
	const streamFn: typeof mock.stream = (model, context, options) => {
		if (calls++ > 0) return mock.stream(model, context, options);
		response.push({ type: "start", partial });
		return response;
	};
	const steps = [
		() => response.push({ type: "toolcall_start", contentIndex: 0, partial }),
		() => {
			first.arguments.nested.value = 1;
			response.push({ type: "toolcall_delta", contentIndex: 0, delta: "1", partial });
		},
		() => response.push({ type: "toolcall_end", contentIndex: 0, toolCall: first, partial }),
		() => {
			partial.content.push(second);
			response.push({ type: "toolcall_start", contentIndex: 1, partial });
		},
		() => {
			second.arguments.nested.value = 2;
			response.push({ type: "toolcall_delta", contentIndex: 1, delta: "2", partial });
		},
		() => {
			first.arguments.nested.value = 3;
			response.push({ type: "toolcall_delta", contentIndex: 0, delta: "3", partial });
		},
		() => response.push({ type: "toolcall_end", contentIndex: 0, toolCall: first, partial }),
		() => response.push({ type: "toolcall_end", contentIndex: 1, toolCall: second, partial }),
		() => {
			first.arguments.nested.value = 4;
			response.push({ type: "start", partial });
		},
		() => response.push({ type: "toolcall_end", contentIndex: 0, toolCall: first, partial }),
		() => response.push({ type: "done", reason: "toolUse", message: partial }),
	];
	let step = 0;
	const snapshots: Record<string, unknown>[][] = [];
	const config: AgentLoopConfig = { model: mock.model, convertToLlm };
	for await (const event of agentLoop(
		[createUserMessage("run")],
		{ systemPrompt: [], messages: [], tools: [] },
		config,
		undefined,
		streamFn,
	)) {
		if (event.type !== "message_update" && event.type !== "message_start") continue;
		if (event.message.role !== "assistant" || event.message.content[0]?.type !== "toolCall") continue;
		snapshots.push(event.message.content.filter(block => block.type === "toolCall").map(block => block.arguments));
		steps[step++]?.();
	}
	expect(snapshots.map(blocks => blocks.map(args => (args.nested as { value: number }).value))).toEqual([
		[0],
		[0],
		[1],
		[1],
		[1, 0],
		[1, 2],
		[3, 2],
		[3, 2],
		[3, 2],
		[4, 2],
		[4, 2],
	]);
});

it("publishes streaming-hook revisions without rewriting earlier finalized snapshots", async () => {
	const mock = createMockModel({ responses: [{ content: ["finished"] }] });
	const toolCall = { type: "toolCall" as const, id: "first", name: "noop", arguments: { nested: { value: 0 } } };
	const partial = createAssistantMessage([toolCall, { type: "text", text: "later" }], "toolUse");
	let calls = 0;
	const streamFn: typeof mock.stream = (model, context, options) => {
		if (calls++ > 0) return mock.stream(model, context, options);
		const response = new AssistantMessageEventStream();
		response.push({ type: "start", partial });
		response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
		response.push({ type: "text_delta", contentIndex: 1, delta: "later", partial });
		response.push({ type: "done", reason: "toolUse", message: partial });
		return response;
	};
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm,
		onAssistantMessageEvent(message, event) {
			const block = message.content[0];
			if (event.type === "text_delta" && block?.type === "toolCall") {
				(block.arguments.nested as { value: number }).value = 1;
			}
		},
	};
	const snapshots: Record<string, unknown>[] = [];
	for await (const event of agentLoop(
		[createUserMessage("run")],
		{ systemPrompt: [], messages: [], tools: [] },
		config,
		undefined,
		streamFn,
	)) {
		if (event.type !== "message_update" || event.message.role !== "assistant") continue;
		const block = event.message.content[0];
		if (block?.type === "toolCall") snapshots.push(block.arguments);
	}
	expect(snapshots.map(args => (args.nested as { value: number }).value)).toEqual([0, 1]);
});
