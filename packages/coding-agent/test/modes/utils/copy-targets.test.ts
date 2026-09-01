import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	extractCodeBlocks,
	extractLastCommand,
	extractQuoteBlocks,
} from "@oh-my-pi/pi-coding-agent/modes/utils/copy-targets";

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
