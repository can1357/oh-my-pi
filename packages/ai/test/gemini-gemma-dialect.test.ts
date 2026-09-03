import { describe, expect, it } from "bun:test";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { createInbandScanner, type Dialect, getDialectDefinition, type InbandScanEvent } from "@oh-my-pi/pi-ai/dialect";

function scan(dialect: Dialect, text: string, charByChar = false): InbandScanEvent[] {
	const scanner = createInbandScanner(dialect);
	const events: InbandScanEvent[] = [];
	if (charByChar) for (const ch of text) events.push(...scanner.feed(ch));
	else events.push(...scanner.feed(text));
	events.push(...scanner.flush());
	return events;
}

function parsedCalls(
	dialect: Dialect,
	text: string,
	charByChar = false,
): { name: string; arguments: Record<string, unknown> }[] {
	return scan(dialect, text, charByChar)
		.filter((event): event is Extract<InbandScanEvent, { type: "toolEnd" }> => event.type === "toolEnd")
		.map(event => ({ name: event.name, arguments: event.arguments }));
}

function visibleText(events: readonly InbandScanEvent[]): string {
	return events
		.filter((event): event is Extract<InbandScanEvent, { type: "text" }> => event.type === "text")
		.map(event => event.text)
		.join("");
}

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id: name,
	name,
	arguments: args,
});

describe("gemini dialect (Pythonic tool_code)", () => {
	it("parses the print(default_api...) form", () => {
		const calls = parsedCalls("gemini", "```tool_code\nprint(default_api.read(path='a.ts', count=2))\n```");
		expect(calls).toEqual([{ name: "read", arguments: { path: "a.ts", count: 2 } }]);
	});

	it("parses bare default_api calls and the assignment form", () => {
		expect(parsedCalls("gemini", '```tool_code\ndefault_api.search(pattern="x")\n```')).toEqual([
			{ name: "search", arguments: { pattern: "x" } },
		]);
		expect(parsedCalls("gemini", '```tool_code\nresult = search(pattern="x")\n```')).toEqual([
			{ name: "search", arguments: { pattern: "x" } },
		]);
	});

	it("decodes Python literals (bool/None/number/list/dict)", () => {
		const calls = parsedCalls(
			"gemini",
			'```tool_code\ndefault_api.f(s="hi", n=3, r=1.5, b=True, z=None, arr=[1, 2], obj={"k": "v"})\n```',
		);
		expect(calls[0]!.arguments).toEqual({ s: "hi", n: 3, r: 1.5, b: true, z: null, arr: [1, 2], obj: { k: "v" } });
	});

	it("ignores parens and commas inside string arguments", () => {
		const calls = parsedCalls("gemini", '```tool_code\ndefault_api.search(pattern="foo(a, b)", flag=False)\n```');
		expect(calls[0]!.arguments).toEqual({ pattern: "foo(a, b)", flag: false });
	});

	it("ignores Python comments and decodes raw/unicode string literals", () => {
		const text = [
			"```tool_code",
			'# default_api.write(path="ignored")',
			"result = read(",
			'  path=r"src/(foo)\\.ts", # default_api.write(path="ignored")',
			"  count=2,",
			'  meta={"emoji": "\\U0001F600"},',
			")",
			'[default_api.write(path="out", content="foo(,bar")]',
			"```",
		].join("\n");

		const calls = parsedCalls("gemini", text);

		expect(calls.map(parsed => parsed.name)).toEqual(["read", "write"]);
		expect(calls[0]!.arguments).toEqual({ path: "src/(foo)\\.ts", count: 2, meta: { emoji: "😀" } });
		expect(calls[1]!.arguments).toEqual({ path: "out", content: "foo(,bar" });
	});

	it("parses parallel calls written as a [a, b] list", () => {
		const calls = parsedCalls(
			"gemini",
			'```tool_code\n[default_api.read(path="a"), default_api.write(path="b", content="c")]\n```',
		);
		expect(calls).toEqual([
			{ name: "read", arguments: { path: "a" } },
			{ name: "write", arguments: { path: "b", content: "c" } },
		]);
	});

	it("preserves prose outside the fence", () => {
		const text = visibleText(scan("gemini", 'before\n```tool_code\ndefault_api.read(path="a")\n```\nafter'));
		expect(text).toContain("before");
		expect(text).toContain("after");
		expect(text).not.toContain("default_api");
	});

	it("yields the same calls when streamed character by character", () => {
		const text = '```tool_code\ndefault_api.read(path="a.ts", count=7)\n```';
		expect(parsedCalls("gemini", text, true)).toEqual([{ name: "read", arguments: { path: "a.ts", count: 7 } }]);
	});

	it("renders parallel calls as a list and round-trips through the scanner", () => {
		const definition = getDialectDefinition("gemini");
		const rendered = definition.renderAssistantToolCalls([
			call("read", { path: "a" }),
			call("write", { path: "b", content: "c" }),
		]);
		expect(rendered).toContain("```tool_code");
		expect(rendered).toContain("[default_api.read(path=");
		expect(rendered).toContain("default_api.write(path=");
		expect(parsedCalls("gemini", rendered)).toEqual([
			{ name: "read", arguments: { path: "a" } },
			{ name: "write", arguments: { path: "b", content: "c" } },
		]);
	});

	it("renders a single call fenced with the default_api prefix", () => {
		const definition = getDialectDefinition("gemini");
		expect(definition.renderToolCall(call("read", { path: "a.ts" }))).toBe('default_api.read(path="a.ts")');
		expect(definition.renderAssistantToolCalls([call("read", { path: "a.ts" })])).toBe(
			'```tool_code\ndefault_api.read(path="a.ts")\n```',
		);
	});

	it("escapes special characters on render and decodes them on parse", () => {
		const definition = getDialectDefinition("gemini");
		const rendered = definition.renderAssistantToolCalls([call("write", { content: 'a "b"\n\tc\\d' })]);
		expect(parsedCalls("gemini", rendered)).toEqual([{ name: "write", arguments: { content: 'a "b"\n\tc\\d' } }]);
	});
});

describe("gemma dialect (token-delimited call:NAME{…})", () => {
	it("parses a single call with string and scalar args", () => {
		const calls = parsedCalls("gemma", '<|tool_call>call:read{path:<|"|>a.ts<|"|>,count:2}<tool_call|>');
		expect(calls).toEqual([{ name: "read", arguments: { path: "a.ts", count: 2 } }]);
	});

	it('keeps commas and quotes inside <|"|> string values', () => {
		const calls = parsedCalls("gemma", '<|tool_call>call:f{loc:<|"|>San Francisco, CA "downtown"<|"|>}<tool_call|>');
		expect(calls[0]!.arguments).toEqual({ loc: 'San Francisco, CA "downtown"' });
	});

	it("keeps close-token text inside string values", () => {
		const calls = parsedCalls(
			"gemma",
			'<|tool_call>call:read{path:<|"|>literal <tool_call|> marker, ok<|"|>,count:2}<tool_call|>',
			true,
		);

		expect(calls).toEqual([{ name: "read", arguments: { path: "literal <tool_call|> marker, ok", count: 2 } }]);
	});

	it("parses scalars, lists, and nested objects", () => {
		const calls = parsedCalls(
			"gemma",
			'<|tool_call>call:f{b:true,z:null,n:3,arr:[<|"|>a<|"|>,<|"|>b<|"|>],obj:{k:<|"|>v<|"|>}}<tool_call|>',
		);
		expect(calls[0]!.arguments).toEqual({ b: true, z: null, n: 3, arr: ["a", "b"], obj: { k: "v" } });
	});

	it("parses consecutive blocks as parallel calls", () => {
		const calls = parsedCalls(
			"gemma",
			'<|tool_call>call:read{path:<|"|>a<|"|>}<tool_call|><|tool_call>call:write{path:<|"|>b<|"|>}<tool_call|>',
		);
		expect(calls).toEqual([
			{ name: "read", arguments: { path: "a" } },
			{ name: "write", arguments: { path: "b" } },
		]);
	});

	it("yields the same call when streamed character by character", () => {
		const text = '<|tool_call>call:read{path:<|"|>a.ts<|"|>,count:7}<tool_call|>';
		expect(parsedCalls("gemma", text, true)).toEqual([{ name: "read", arguments: { path: "a.ts", count: 7 } }]);
	});

	it("renders calls that round-trip through the scanner", () => {
		const definition = getDialectDefinition("gemma");
		const rendered = definition.renderAssistantToolCalls([
			call("read", { path: "a" }),
			call("write", { path: "b", content: "c" }),
		]);
		expect(rendered).toBe(
			'<|tool_call>call:read{path:<|"|>a<|"|>}<tool_call|><|tool_call>call:write{path:<|"|>b<|"|>,content:<|"|>c<|"|>}<tool_call|>',
		);
		expect(parsedCalls("gemma", rendered)).toEqual([
			{ name: "read", arguments: { path: "a" } },
			{ name: "write", arguments: { path: "b", content: "c" } },
		]);
	});
});
