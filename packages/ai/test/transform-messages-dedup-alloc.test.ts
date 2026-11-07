// The dedup pass copies an assistant turn's content array only on the turn that
// mints a `_dup` id; a duplicate-free turn keeps the array it was handed. A
// per-turn `msg.content.map(...)` rebuilt every assistant turn's array on every
// request and threw the result away, so a long transcript paid one wasted array
// per turn per request.
//
// Block identity cannot see that: the `.map` path also emitted the caller's own
// blocks, and its `if (!contentChanged) return msg` handed back the original
// message, so both paths produce element-identical output. This counts the
// array copy itself instead, differentially: two transcripts of identical
// shape, one with a repeated id, must differ by exactly the copy the repeated
// turn needs.
import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeSameModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "GPT Test",
		id: "gpt-test",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function assistantTurn(id: string, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id, name: "read", arguments: { path: "a" } },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(id: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

/** Only a message content array has every element shaped like a content block. */
function isContentBlockArray(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			element => typeof element === "object" && element !== null && typeof Reflect.get(element, "type") === "string",
		)
	);
}

/**
 * Count the `map`/`slice` calls that rebuild a message content array while `run`
 * executes. Nothing else the pass does around those calls is visible: the copy
 * is discarded, so only the call itself distinguishes a turn that allocated an
 * array from one that did not.
 */
function countContentArrayCopies(run: () => void): number {
	const savedMap = Array.prototype.map;
	const savedSlice = Array.prototype.slice;
	// `Function.prototype.call.bind` keeps the wrappers free of a rest-argument
	// tuple type, which the dated prototype signatures cannot express.
	const forwardMap = Function.prototype.call.bind(savedMap);
	const forwardSlice = Function.prototype.call.bind(savedSlice);
	let copies = 0;
	const countMap = function (this: unknown, ...args: unknown[]): unknown {
		if (isContentBlockArray(this)) copies += 1;
		return forwardMap(this, ...args);
	};
	const countSlice = function (this: unknown, ...args: unknown[]): unknown {
		if (isContentBlockArray(this)) copies += 1;
		return forwardSlice(this, ...args);
	};
	Reflect.set(Array.prototype, "map", countMap);
	Reflect.set(Array.prototype, "slice", countSlice);
	try {
		run();
	} finally {
		Reflect.set(Array.prototype, "map", savedMap);
		Reflect.set(Array.prototype, "slice", savedSlice);
	}
	return copies;
}

describe("dedup pass copies an assistant turn's content array only when it must", () => {
	it("pays exactly one content-array copy for the one turn that repeats an id", () => {
		const model = makeSameModel();
		const withoutRepeat: Message[] = [
			assistantTurn("call_one", "first"),
			toolResult("call_one", "one", 1),
			assistantTurn("call_two", "second"),
			toolResult("call_two", "two", 2),
		];
		const withRepeat: Message[] = [
			assistantTurn("call_same", "first"),
			toolResult("call_same", "one", 1),
			assistantTurn("call_same", "second"),
			toolResult("call_same", "two", 2),
		];

		const duplicateFreeCopies = countContentArrayCopies(() => transformMessages(withoutRepeat, model));
		const repeatedCopies = countContentArrayCopies(() => transformMessages(withRepeat, model));

		// The repeat really did take the rewrite path; without that the comparison
		// below would be measuring two copies of the same duplicate-free run.
		const emittedIds = transformMessages(withRepeat, model)
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap(message => message.content)
			.filter(block => block.type === "toolCall")
			.map(block => block.id);
		expect(emittedIds).toEqual(["call_same", "call_same_dup1"]);

		// A duplicate-free turn copies nothing, so the repeated transcript costs
		// exactly the one copy its rewritten turn needs — and not one per turn.
		expect(repeatedCopies).toBe(duplicateFreeCopies + 1);
	});
});
