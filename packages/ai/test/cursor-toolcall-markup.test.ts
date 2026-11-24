import { expect, it } from "bun:test";
import {
	type BlockState,
	processInteractionUpdate,
	type ToolCallState,
	type UsageState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

interface Harness {
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	captured: AssistantMessageEvent[];
	state: BlockState;
	usageState: UsageState;
}

function newHarness(): Harness {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
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
	const stream = new AssistantMessageEventStream();
	const captured: AssistantMessageEvent[] = [];
	const origPush = stream.push.bind(stream);
	stream.push = (event: AssistantMessageEvent) => {
		captured.push(event);
		origPush(event);
	};

	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	const state: BlockState = {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		openToolCalls: new Map(),
		resolvedMcpToolCallIds: new Set(),
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
	};
	return { output, stream, captured, state, usageState: { sawTokenDelta: false } };
}

// The markup is Cursor's dialect that cursor-agent sometimes returns as text (issue 8495).
it("stores no tool-call markup as text and does not finish the turn silently", () => {
	const h = newHarness();
	const leak =
		'<|open|>toolscall tool="Shell" index="1"<|sep|><|open|>argument key="command" type="string"<|sep|>git add -A && git commit -m "ci: fix format check and skip native builds on Windows" && git push 2>&1 | tail -2 && sleep 10 && ghargument<|sep|><|close|>call<|sep|><|close|>toolsmessage<|sep|>';
	let thrown: unknown;
	try {
		processInteractionUpdate(
			{ message: { case: "textDelta", value: { text: leak.slice(0, 4) } } },
			h.output,
			h.stream,
			h.state,
			h.usageState,
		);
		processInteractionUpdate(
			{ message: { case: "textDelta", value: { text: leak.slice(4) } } },
			h.output,
			h.stream,
			h.state,
			h.usageState,
		);
	} catch (err) {
		thrown = err;
	}
	const storedText = h.output.content
		.filter(block => block.type === "text")
		.map(block => (block as { text: string }).text)
		.join("");
	expect(storedText).not.toContain("<|open|>toolscall");
	expect(thrown).toBeInstanceOf(Error);
	expect((thrown as Error).message).toContain("tool-call markup");
});
