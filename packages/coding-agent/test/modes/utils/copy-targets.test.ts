import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	buildCopyTargets,
	type CopySource,
	type CopyTarget,
	dedentCodeBlock,
	extractCodeBlocks,
	extractCodeBlocksNewestFirst,
	extractLastCommand,
	extractQuoteBlocks,
	locateCodeBlockInMessage,
} from "@oh-my-pi/pi-coding-agent/modes/utils/copy-targets";

function source(overrides: Partial<CopySource>): CopySource {
	return {
		messages: [],
		getLastVisibleHandoffText: () => undefined,
		...overrides,
	};
}

function byId(targets: CopyTarget[], id: string): CopyTarget | undefined {
	return targets.find(t => t.id === id);
}

function assistantText(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function assistantCalls(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>): AgentMessage {
	return {
		role: "assistant",
		content: toolCalls.map((tc, i) => ({ type: "toolCall", id: `tc-${i}`, name: tc.name, arguments: tc.arguments })),
	} as unknown as AgentMessage;
}

describe("extractCodeBlocks", () => {
	it("captures the language id and strips the trailing newline", () => {
		expect(extractCodeBlocks("intro\n```ts\nconst x = 1;\n```\ntail")).toEqual([
			{ lang: "ts", code: "const x = 1;" },
		]);
	});

	it("returns blocks in document order with empty lang for bare fences", () => {
		const blocks = extractCodeBlocks("```\nplain\n```\n\n```py\nprint(1)\n```");
		expect(blocks.map(b => b.lang)).toEqual(["", "py"]);
		expect(blocks.map(b => b.code)).toEqual(["plain", "print(1)"]);
	});
	it("ignores empty and whitespace-only fenced blocks", () => {
		const blocks = extractCodeBlocks("```\n```\n\n```ts\n\n```\n\n```js\nconst x = 1;\n```");
		expect(blocks.map(b => b.code)).toEqual(["const x = 1;"]);
	});
});

describe("extractQuoteBlocks", () => {
	it("collects a `>`-prefixed run and strips the marker plus one space", () => {
		const text = "intro\n> line one\n> line two\ntail";
		expect(extractQuoteBlocks(text)).toEqual([{ text: "line one\nline two" }]);
	});

	it("keeps bare `>` separator lines as blank lines and splits on plain text", () => {
		const text = "> first\n>\n> second\n\nbreak\n> later";
		expect(extractQuoteBlocks(text).map(b => b.text)).toEqual(["first\n\nsecond", "later"]);
	});

	it("does not treat `>` lines inside a fenced code block as a quote", () => {
		const text = "> real quote\n```\n> not a quote\n```";
		expect(extractQuoteBlocks(text)).toEqual([{ text: "real quote" }]);
	});
});

describe("extractLastCommand", () => {
	it("returns the most recent bash command, walking backwards", () => {
		const messages = [
			assistantCalls([{ name: "bash", arguments: { command: "echo old" } }]),
			assistantCalls([{ name: "read", arguments: { path: "x" } }]),
			assistantCalls([
				{ name: "bash", arguments: { command: "echo a" } },
				{ name: "bash", arguments: { command: "echo b" } },
			]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(messages)).toEqual({ kind: "bash", code: "echo b", language: "bash" });
	});

	it("extracts eval code from flat args and reports the language", () => {
		const py = [
			assistantCalls([{ name: "eval", arguments: { language: "py", code: "print(1)" } }]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(py)).toEqual({ kind: "eval", code: "print(1)", language: "python" });

		const js = [
			assistantCalls([{ name: "eval", arguments: { language: "js", code: "log(1)" } }]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(js)?.language).toBe("javascript");
	});

	it("still joins legacy multi-cell eval args from older transcripts", () => {
		const py = [
			assistantCalls([
				{ name: "eval", arguments: { cells: [{ language: "py", code: "print(1)" }, { code: "print(2)" }] } },
			]),
		] as unknown as AgentMessage[];
		expect(extractLastCommand(py)).toEqual({ kind: "eval", code: "print(1)\n\nprint(2)", language: "python" });
	});
});

describe("buildCopyTargets", () => {
	it("lists assistant messages most-recent-first, drilling code-bearing ones", () => {
		const newer = "Newer message\n```ts\nconst a = 1;\n```\nand\n```py\nprint(2)\n```";
		const targets = buildCopyTargets(
			source({
				messages: [assistantText("Older message"), assistantText(newer)] as unknown as AgentMessage[],
			}),
		);

		// Newest first.
		expect(targets[0]?.id).toBe("msg:1");
		expect(targets[0]?.label).toBe("Newer message");
		expect(targets[1]?.id).toBe("msg:2");

		// The newer message is itself a copy target (full text) AND a tree node
		// exposing each code block as a child copy target.
		const group = targets[0]!;
		expect(group.content).toBe(newer);
		expect(group.children?.map(c => c.label)).toEqual(["Block 1", "Block 2", "All 2 blocks"]);
		expect(group.children?.[0]?.content).toBe("const a = 1;");
		expect(group.children?.[0]?.language).toBe("ts"); // drives preview syntax highlighting
		expect(group.children?.at(-1)?.content).toBe("const a = 1;\n\nprint(2)");

		// The older, code-free message is a leaf that copies its full text.
		expect(targets[1]?.children).toBeUndefined();
		expect(targets[1]?.content).toBe("Older message");
	});

	it("exposes a single-block message as content plus one block child (no 'all')", () => {
		const targets = buildCopyTargets(
			source({ messages: [assistantText("Just one\n```js\nfoo();\n```")] as unknown as AgentMessage[] }),
		);
		const msg = byId(targets, "msg:1");
		expect(msg?.content).toBe("Just one\n```js\nfoo();\n```");
		expect(msg?.children?.map(c => c.label)).toEqual(["Block 1"]);
	});

	it("drills a quoted message into a de-prefixed quote child", () => {
		const text = "Copy-paste to the other agent:\n\n> relay this\n> across agents";
		const targets = buildCopyTargets(source({ messages: [assistantText(text)] as unknown as AgentMessage[] }));
		const msg = byId(targets, "msg:1");
		// The message node still copies the full markdown (with markers).
		expect(msg?.content).toBe(text);
		expect(msg?.hint).toBe("4 lines · 1 quote");
		const quote = msg?.children?.find(c => c.id === "msg:1:quote:0");
		expect(quote?.label).toBe("Quote 1");
		// The drilled child copies the un-prefixed quote, ready to paste onward.
		expect(quote?.content).toBe("relay this\nacross agents");
		expect(quote?.language).toBeUndefined();
		expect(quote?.copyMessage).toBe("Copied quote block 1 to clipboard");
	});

	it("interleaves code and quote children in document order with combined nodes", () => {
		const text = "intro\n```ts\na;\n```\n> q one\n```py\nb\n```\n> q two";
		const targets = buildCopyTargets(source({ messages: [assistantText(text)] as unknown as AgentMessage[] }));
		const msg = byId(targets, "msg:1");
		expect(msg?.children?.map(c => c.id)).toEqual([
			"msg:1:code:0",
			"msg:1:quote:0",
			"msg:1:code:1",
			"msg:1:quote:1",
			"msg:1:all",
			"msg:1:all-quotes",
		]);
		expect(msg?.hint).toBe("9 lines · 2 code · 2 quote");
		expect(msg?.children?.find(c => c.id === "msg:1:all-quotes")?.content).toBe("q one\n\nq two");
	});

	it("skips tool-only assistant turns and non-assistant messages", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			assistantCalls([{ name: "read", arguments: { path: "x" } }]),
			assistantText("real answer"),
		] as unknown as AgentMessage[];
		const targets = buildCopyTargets(source({ messages }));
		expect(targets.filter(t => t.id.startsWith("msg:")).map(t => t.label)).toEqual(["real answer"]);
	});

	it("falls back to handoff context only when there are no assistant messages", () => {
		const withMessages = buildCopyTargets(
			source({
				messages: [assistantText("answer")] as unknown as AgentMessage[],
				getLastVisibleHandoffText: () => "<handoff>",
			}),
		);
		expect(byId(withMessages, "handoff")).toBeUndefined();

		const fresh = buildCopyTargets(source({ getLastVisibleHandoffText: () => "<handoff>\nGoal" }));
		expect(byId(fresh, "handoff")?.content).toBe("<handoff>\nGoal");
		expect(byId(fresh, "handoff")?.copyMessage).toBe("Copied handoff context to clipboard");
	});

	it("interleaves runnable commands after the assistant message that issued them", () => {
		const targets = buildCopyTargets(
			source({
				messages: [
					assistantText("older answer"),
					assistantCalls([{ name: "bash", arguments: { command: "echo old" } }]),
					assistantText("newer answer"),
					assistantCalls([{ name: "bash", arguments: { command: "bun check" } }]),
				] as unknown as AgentMessage[],
			}),
		);

		expect(targets.map(t => t.id)).toEqual(["msg:1", "cmd:1", "msg:2", "cmd:2"]);

		const cmd = byId(targets, "cmd:1");
		expect(cmd?.label).toBe("bun check");
		expect(cmd?.hint).toBe("bash · 1 line");
		expect(cmd?.content).toBe("bun check");
		expect(cmd?.language).toBe("bash");
		expect(byId(targets, "cmd:2")?.content).toBe("echo old");
	});
});
describe("extractCodeBlocksNewestFirst", () => {
	it("enumerates newest message first with blocks reversed within a message", () => {
		const older = assistantText("```ts\nconst a = 1;\n```\ntext\n```js\nconst b = 2;\n```");
		const newer = assistantText("```py\nprint(1)\n```");
		const refs = extractCodeBlocksNewestFirst([older, newer] as unknown as AgentMessage[]);

		expect(refs.map(r => r.block.code)).toEqual(["print(1)", "const b = 2;", "const a = 1;"]);
		expect(refs[0]!.message).toBe(newer);
		expect(refs[1]!.message).toBe(older);
		expect(refs[2]!.message).toBe(older);
		expect(refs.map(r => r.blockIndex)).toEqual([0, 1, 0]);
	});

	it("skips user messages and assistant messages without text or blocks", () => {
		const user = { role: "user", content: [{ type: "text", text: "```c\nx\n```" }] } as unknown as AgentMessage;
		const proseOnly = assistantText("just prose");
		const noContent = { role: "assistant", content: [] } as unknown as AgentMessage;
		const block = assistantText("```\ncode\n```");
		const refs = extractCodeBlocksNewestFirst([user, proseOnly, noContent, block] as unknown as AgentMessage[]);

		expect(refs.map(r => r.block.code)).toEqual(["code"]);
		expect(refs[0]!.message).toBe(block);
	});
	it("skips empty fenced blocks so the cycle only walks copyable content", () => {
		const message = assistantText("```\n```\n\n```ts\nconst a = 1;\n```");
		const refs = extractCodeBlocksNewestFirst([message] as unknown as AgentMessage[]);
		expect(refs.map(r => r.block.code)).toEqual(["const a = 1;"]);
	});
});

describe("dedentCodeBlock", () => {
	it("strips the minimum common leading whitespace of non-blank lines", () => {
		expect(dedentCodeBlock("    def f():\n        return 1\n    x = 2")).toBe("def f():\n    return 1\nx = 2");
	});

	it("turns blank and whitespace-only lines into empty strings without truncation", () => {
		expect(dedentCodeBlock("  a\n\n  b\n  c")).toBe("a\n\nb\nc");
		expect(dedentCodeBlock("  a\n \n  b")).toBe("a\n\nb");
	});

	it("returns the input unchanged when there is no common indent", () => {
		const code = "a\nb\n  c";
		expect(dedentCodeBlock(code)).toBe(code);
		expect(dedentCodeBlock("x\n")).toBe("x\n");
	});
});
describe("locateCodeBlockInMessage", () => {
	it("maps a document-order block index to its content block and local ordinal", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "prose\n```ts\nconst a = 1;\n```\n```js\nconst b = 2;\n```" },
				{ type: "text", text: "```py\nprint(1)\n```" },
			],
		} as unknown as AgentMessage;
		// Document order across the concatenated assistant text: block 0 = ts,
		// 1 = js, 2 = py. Non-text content does not shift ordinals.
		expect(locateCodeBlockInMessage(message, 0)).toEqual({ contentIndex: 1, localIndex: 0 });
		expect(locateCodeBlockInMessage(message, 1)).toEqual({ contentIndex: 1, localIndex: 1 });
		expect(locateCodeBlockInMessage(message, 2)).toEqual({ contentIndex: 2, localIndex: 0 });
	});

	it("returns undefined for out-of-range, empty, or non-assistant messages", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "no fences here" }],
		} as unknown as AgentMessage;
		expect(locateCodeBlockInMessage(message, 0)).toBeUndefined();
		const user = { role: "user", content: [{ type: "text", text: "```c\nx\n```" }] } as unknown as AgentMessage;
		expect(locateCodeBlockInMessage(user, 0)).toBeUndefined();
	});
});
