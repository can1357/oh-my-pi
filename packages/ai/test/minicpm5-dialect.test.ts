import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import {
	createInbandScanner,
	getDialectDefinition,
	type InbandScanEvent,
	parseInbandToolMessage,
} from "@oh-my-pi/pi-ai/dialect";

const TOOLS = [
	{
		name: "read",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, count: { type: "number" } },
			required: ["path"],
		},
	},
	{
		name: "write",
		description: "Write a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
] as unknown as NonNullable<Context["tools"]>;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: 0,
	};
}

function feed(text: string, tools: NonNullable<Context["tools"]> = TOOLS): InbandScanEvent[] {
	const scanner = createInbandScanner("minicpm5", { tools, parseThinking: true });
	const events: InbandScanEvent[] = [];
	for (const char of text) events.push(...scanner.feed(char));
	events.push(...scanner.flush());
	return events;
}

function toolEnds(events: readonly InbandScanEvent[]): Extract<InbandScanEvent, { type: "toolEnd" }>[] {
	return events.filter((event): event is Extract<InbandScanEvent, { type: "toolEnd" }> => event.type === "toolEnd");
}

describe("MiniCPM5 dialect", () => {
	it("parses the model's native function/param format", () => {
		const calls = toolEnds(
			feed('<function name="read"><param name="path">src/a.ts</param><param name="count">2</param></function>'),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("read");
		expect(calls[0]?.arguments).toEqual({ path: "src/a.ts", count: 2 });
	});

	it("does not require the harness intent field in model-emitted arguments", () => {
		const tools = [
			{
				name: "read",
				description: "Read a file",
				parameters: {
					type: "object",
					properties: {
						[INTENT_FIELD]: { type: "string" },
						path: { type: "string" },
					},
					required: [INTENT_FIELD, "path"],
				},
			},
		] as unknown as NonNullable<Context["tools"]>;
		const calls = toolEnds(feed('<function name="read"><param name="path">README.md</param></function>', tools));

		expect(calls).toHaveLength(1);
		expect(calls[0]?.arguments).toEqual({ path: "README.md" });
		expect(calls[0]?.arguments).not.toHaveProperty("__parseError");
	});

	it("normalizes tokenizer-space and collapsed attribute forms", () => {
		const calls = toolEnds(feed('<function\u0120name="read"><paramname="path">src/a.ts</param></function>'));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.arguments).toEqual({ path: "src/a.ts" });
	});

	it("preserves CDATA string payloads verbatim", () => {
		const content = "line 1\nif (a < b && c) {}\nline 3";
		const calls = toolEnds(
			feed(
				`<function name="write"><param name="path">out.txt</param><param name="content"><![CDATA[${content}]]></param></function>`,
			),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.arguments).toEqual({ path: "out.txt", content });
	});

	it("preserves whitespace in non-CDATA string parameters", () => {
		const calls = toolEnds(feed('<function name="read"><param name="path">  indented  </param></function>'));
		expect(calls[0]?.arguments).toEqual({ path: "  indented  " });
	});

	it("does not normalize tokenizer text inside CDATA", () => {
		const content = '<functionname="not-a-tag">\u0120<paramname="literal">';
		const calls = toolEnds(
			feed(
				`<function name="write"><param name="path">out.txt</param><param name="content"><![CDATA[${content}]]></param></function>`,
			),
		);
		expect(calls[0]?.arguments).toEqual({ path: "out.txt", content });
	});

	it("renders calls that the scanner parses back", () => {
		const call: ToolCall = {
			type: "toolCall",
			id: "call_1",
			name: "write",
			arguments: { path: "out.txt", content: "a < b\nsecond line" },
		};
		const definition = getDialectDefinition("minicpm5");
		const rendered = definition.renderAssistantToolCalls([call], { tools: TOOLS });
		expect(rendered).toContain('<function name="write">');
		expect(rendered).toContain('<param name="content"><![CDATA[');
		const calls = toolEnds(feed(rendered));
		expect(calls).toHaveLength(1);
		expect(calls[0]?.arguments).toEqual(call.arguments);
	});

	it("keeps exact raw blocks for diagnostics", () => {
		const raw = '<function name="read"><param name="path">src/a.ts</param></function>';
		const calls = toolEnds(feed(raw));
		expect(calls[0]?.rawBlock).toBe(raw);
	});

	it("rejects the invoke/parameter hybrid that MiniCPM produced under generic XML", () => {
		const parsed = parseInbandToolMessage(
			assistant('<function name="read"><parameter name="path">src/a.ts</parameter></function>'),
			"minicpm5",
			TOOLS,
		);
		const call = parsed.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(call?.arguments).toEqual({
			__parseError: expect.any(String),
			__rawJson: expect.any(String),
		});
	});

	it("marks an unfinished function call as invalid instead of executing a preview", () => {
		const parsed = parseInbandToolMessage(
			assistant('<function name="read"><param name="path">src/a.ts</param>'),
			"minicpm5",
			TOOLS,
		);
		const call = parsed.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(call?.arguments).toEqual({
			__parseError: expect.any(String),
			__rawJson: expect.any(String),
		});
	});

	it("renders tool responses in MiniCPM5 format", () => {
		expect(
			getDialectDefinition("minicpm5").renderToolResults([
				{ id: "call_1", name: "read", index: 0, text: "/tmp/project", isError: false },
			]),
		).toBe("<tool_response>\n/tmp/project\n</tool_response>");
	});
});
