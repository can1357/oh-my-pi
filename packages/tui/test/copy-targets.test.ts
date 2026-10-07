import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	extractCodeBlocks,
	extractLastAssistantText,
	extractLastCommand,
	extractLastLink,
	extractLinks,
	extractQuoteBlocks,
} from "@oh-my-pi/pi-tui/overlays/copy-targets";

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

describe("extractLinks", () => {
	it("finds inline links, autolinks, and bare URLs in document order, deduplicated by href", () => {
		const text = [
			'See [the docs](https://example.com/docs "Docs") and <https://example.com/auto>.',
			"Bare: https://example.com/bare/path?x=1&y=2 then again https://example.com/docs.",
		].join("\n");
		expect(extractLinks(text)).toEqual([
			{ text: "the docs", href: "https://example.com/docs" },
			{ text: "https://example.com/auto", href: "https://example.com/auto" },
			{ text: "https://example.com/bare/path?x=1&y=2", href: "https://example.com/bare/path?x=1&y=2" },
		]);
	});

	it("trims sentence punctuation but keeps a paren that belongs to the URL", () => {
		expect(extractLinks("(https://en.wikipedia.org/wiki/Foo_(bar)).")).toEqual([
			{ text: "https://en.wikipedia.org/wiki/Foo_(bar)", href: "https://en.wikipedia.org/wiki/Foo_(bar)" },
		]);
		expect(extractLinks("Try https://example.com/a, https://example.com/b; or https://example.com/c?")).toEqual([
			{ text: "https://example.com/a", href: "https://example.com/a" },
			{ text: "https://example.com/b", href: "https://example.com/b" },
			{ text: "https://example.com/c", href: "https://example.com/c" },
		]);
	});

	it("ignores URLs inside fenced code and inline code, because it uses the renderer's lexer", () => {
		const text =
			"Run `curl https://example.com/in-code` then:\n```bash\ncurl https://example.com/fenced\n```\nDocs: https://example.com/prose";
		expect(extractLinks(text)).toEqual([{ text: "https://example.com/prose", href: "https://example.com/prose" }]);
	});

	it("keeps a URL that the terminal would wrap as one target", () => {
		const long = `https://github.com/dalilshorja/dalilshorja/actions/runs/33654874668/job/100330811133?check_suite_focus=true&pr=4`;
		expect(extractLinks(`Run: ${long}`)).toEqual([{ text: long, href: long }]);
	});

	it("only http(s) targets qualify", () => {
		expect(extractLinks("[file](file:///tmp/x) [mail](mailto:a@b.c) ftp://x.y/z a@b.c")).toEqual([]);
	});

	it("resolves reference links and GFM www autolinks through the renderer's lexer", () => {
		expect(extractLinks("[ref link][r] and www.example.com/www\n\n[r]: https://example.com/ref")).toEqual([
			{ text: "ref link", href: "https://example.com/ref" },
			{ text: "www.example.com/www", href: "http://www.example.com/www" },
		]);
	});
});

describe("extractLastLink", () => {
	it("returns the last link of the most recent assistant message that has one", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "old https://example.com/old" }] },
			{
				role: "assistant",
				content: [{ type: "text", text: "a https://example.com/a and b https://example.com/b" }],
			},
			{ role: "user", content: "thanks https://example.com/user-link" },
			{ role: "assistant", content: [{ type: "text", text: "no links here" }] },
		] as unknown as AgentMessage[];
		expect(extractLastLink(messages)).toEqual({ text: "https://example.com/b", href: "https://example.com/b" });
		expect(extractLastLink(messages.slice(3))).toBeUndefined();
	});
});

describe("extractLastAssistantText", () => {
	it("returns undefined for empty messages or messages without assistant text", () => {
		expect(extractLastAssistantText([])).toBeUndefined();
		const nonAssistant = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "text", text: "   " }], stopReason: "stop" },
		] as unknown as AgentMessage[];
		expect(extractLastAssistantText(nonAssistant)).toBeUndefined();
	});

	it("returns the most recent completed assistant message text, walking backwards", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "older assistant response" }], stopReason: "stop" },
			{ role: "user", content: [{ type: "text", text: "user message" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "latest part 1. " },
					{ type: "text", text: "latest part 2." },
				],
				stopReason: "stop",
			},
			{ role: "user", content: [{ type: "text", text: "follow up" }] },
		] as unknown as AgentMessage[];
		expect(extractLastAssistantText(messages)).toBe("latest part 1. latest part 2.");
	});

	it("skips text from an in-progress tool-use turn", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "completed response" }],
				stopReason: "stop",
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Running checks..." },
					{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "bun check" } },
				],
				stopReason: "toolUse",
			},
		] as unknown as AgentMessage[];

		expect(extractLastAssistantText(messages)).toBe("completed response");
	});
});
