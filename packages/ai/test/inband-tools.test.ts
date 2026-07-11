import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, ToolCall, ToolResultMessage, Usage } from "@pk-nerdsaver-ai/pi-ai";
import {
	createInbandScanner,
	type Dialect,
	type DialectToolResult,
	encodeInbandToolHistory,
	getDialectDefinition,
	type InbandScanEvent,
	parseInbandToolMessage,
	renderInbandToolPrompt,
} from "@pk-nerdsaver-ai/pi-ai/dialect";

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

const DIALECTS: readonly Dialect[] = [
	"glm",
	"hermes",
	"kimi",
	"xml",
	"anthropic",
	"minimax",
	"deepseek",
	"harmony",
	"qwen3",
	"gemini",
	"gemma",
];

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

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function result(toolCallId: string, toolName: string, text: string, isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 0 };
}

function feedText(dialect: Dialect, text: string): InbandScanEvent[] {
	const scanner = createInbandScanner(dialect, { tools: TOOLS, parseThinking: true });
	const events: InbandScanEvent[] = [];
	for (const char of text) events.push(...scanner.feed(char));
	events.push(...scanner.flush());
	return events;
}

function toolEnds(events: readonly InbandScanEvent[]): Extract<InbandScanEvent, { type: "toolEnd" }>[] {
	return events.filter((event): event is Extract<InbandScanEvent, { type: "toolEnd" }> => event.type === "toolEnd");
}

function firstRawBlock(dialect: Dialect, text: string): string | undefined {
	return toolEnds(feedText(dialect, text))[0]?.rawBlock;
}

function expectRawBlock(dialect: Dialect, text: string, expected: string): void {
	expect(firstRawBlock(dialect, text), dialect).toBe(expected);
}

describe("in-band tool dialects", () => {
	it("renders a tool prompt for every dialect", () => {
		for (const dialect of DIALECTS) {
			const prompt = renderInbandToolPrompt(TOOLS, dialect);
			expect(prompt).toContain("<tools>");
			expect(prompt).toContain("</tools>");
			expect(prompt).toContain('"name":"read"');
			expect(prompt).toContain(getDialectDefinition(dialect).prompt.trim().split("\n", 1)[0]!);
		}
	});

	it("each dialect renders calls that its scanner parses back", () => {
		const call: ToolCall = {
			type: "toolCall",
			id: "functions.read:0",
			name: "read",
			arguments: { path: "src/a.ts", count: 2 },
		};
		for (const dialect of DIALECTS) {
			const definition = getDialectDefinition(dialect);
			const rendered = definition.renderAssistantToolCalls([call], { tools: TOOLS });
			const calls = toolEnds(feedText(dialect, rendered));
			expect(calls, dialect).toHaveLength(1);
			expect(calls[0]!.name).toBe("read");
			expect(calls[0]!.arguments).toEqual({ path: "src/a.ts", count: 2 });
		}
	});

	it("captures exact raw tool call blocks for debugging", () => {
		expectRawBlock(
			"glm",
			"<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>src/a.ts</arg_value>\n</tool_call>",
			"<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>src/a.ts</arg_value>\n</tool_call>",
		);
		expectRawBlock(
			"kimi",
			'<|tool_calls_section_begin|><|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>  {"path":"src/a.ts"}\n<|tool_call_end|><|tool_calls_section_end|>',
			'<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>  {"path":"src/a.ts"}\n<|tool_call_end|>',
		);
		expectRawBlock(
			"deepseek",
			'<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read">\n <｜DSML｜parameter name="path" string="true">src/a.ts</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
			'<｜DSML｜invoke name="read">\n <｜DSML｜parameter name="path" string="true">src/a.ts</｜DSML｜parameter>\n</｜DSML｜invoke>',
		);
		expectRawBlock(
			"xml",
			'<function_calls>\n<invoke name="read"><parameter name="path" string="true">src/a.ts</parameter></invoke>\n</function_calls>',
			'<invoke name="read"><parameter name="path" string="true">src/a.ts</parameter></invoke>',
		);
		expectRawBlock(
			"minimax",
			'<minimax:tool_call>\n<invoke name="read"><parameter name="path" string="true">src/a.ts</parameter></invoke>\n</minimax:tool_call>',
			'<invoke name="read"><parameter name="path" string="true">src/a.ts</parameter></invoke>',
		);
		expectRawBlock(
			"harmony",
			'<|start|>assistant<|channel|>commentary to=functions.read<|message|>{"path":"src/a.ts"}<|call|>',
			'<|start|>assistant<|channel|>commentary to=functions.read<|message|>{"path":"src/a.ts"}<|call|>',
		);
	});

	it("projects raw tool blocks onto parsed ToolCall content", () => {
		const raw = '<|start|>assistant<|channel|>commentary to=functions.read<|message|>{"path":"src/a.ts"}<|call|>';
		const parsed = parseInbandToolMessage(assistant([{ type: "text", text: raw }]), "harmony", TOOLS);
		const call = parsed.content.find((block): block is ToolCall => block.type === "toolCall");

		expect(call?.rawBlock).toBe(raw);
	});

	it("parses MiniMax tool-call wrapper arguments without mangling parameter names", () => {
		const raw =
			'<minimax:tool_call>\n<invoke name="read">\n<parameter name="path" string="true">src/a.ts</parameter>\n<parameter name="count" string="false">2</parameter>\n</invoke>\n</minimax:tool_call>';
		const parsed = parseInbandToolMessage(assistant([{ type: "text", text: raw }]), "minimax", TOOLS);
		const calls = parsed.content.filter((block): block is ToolCall => block.type === "toolCall");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("read");
		expect(calls[0]?.arguments).toEqual({ path: "src/a.ts", count: 2 });
		expect(calls[0]?.arguments).not.toHaveProperty('parameter name="path"');
		expect(calls[0]?.arguments).not.toHaveProperty('parameter name="count"');
	});

	it("buffers unprefixed MiniMax wrappers across streaming tag splits", () => {
		const raw =
			'<tool_call>\n<invoke name="read">\n<parameter name="path" string="true">src/a.ts</parameter>\n<parameter name="count" string="false">2</parameter>\n</invoke>\n</tool_call>';
		const events = feedText("minimax", raw);
		const calls = toolEnds(events);
		const visibleText = events
			.filter((event): event is Extract<InbandScanEvent, { type: "text" }> => event.type === "text")
			.map(event => event.text)
			.join("");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("read");
		expect(calls[0]?.arguments).toEqual({ path: "src/a.ts", count: 2 });
		expect(visibleText).toBe("");
	});

	it("stops before hallucinated Anthropic function results", () => {
		const parsed = parseInbandToolMessage(
			assistant([
				{
					type: "text",
					text: '<invoke name="read"><parameter name="path">rubygems.ts:85-93</parameter></invoke>\n<function_results>\n<result>\n<tool_name>read</tool_name>\n<stdout>[rubygems.ts#A1B2]</stdout>\n</result>\n</function_results>\n<invoke name="edit"><parameter name="input">[rubygems.ts#A1B2]\nSWAP 89..89:\n+ fake</parameter></invoke>',
				},
			]),
			"anthropic",
			TOOLS,
		);
		const calls = parsed.content.filter((block): block is ToolCall => block.type === "toolCall");

		expect(calls.map(call => call.name)).toEqual(["read"]);
		expect(calls[0]?.arguments).toEqual({ path: "rubygems.ts:85-93" });
	});

	it("keeps result rendering in the owning dialect", () => {
		const resultBlock: DialectToolResult = {
			id: "functions.read:0",
			name: "read",
			index: 0,
			text: "FILE",
			isError: false,
		};
		expect(getDialectDefinition("glm").renderToolResults([resultBlock])).toBe(
			"<observation>\n<tool_response>\nFILE\n</tool_response>\n</observation>",
		);
		expect(getDialectDefinition("deepseek").renderToolResults([resultBlock])).toBe(
			"<｜tool▁output▁begin｜>FILE<｜tool▁output▁end｜>",
		);
		expect(getDialectDefinition("kimi").renderToolResults([resultBlock])).toBe(
			"<|im_system|>read<|im_middle|>## Return of functions.read:0\nFILE<|im_end|>",
		);
		expect(getDialectDefinition("harmony").renderToolResults([resultBlock])).toBe(
			"<|start|>functions.read to=assistant<|channel|>commentary<|message|>FILE<|end|>",
		);
		expect(getDialectDefinition("anthropic").renderToolResults([resultBlock])).toBe(
			"<function_results>\n<result>\n<tool_name>read</tool_name>\n<stdout>FILE</stdout>\n</result>\n</function_results>",
		);
		expect(getDialectDefinition("minimax").renderToolResults([resultBlock])).toBe(
			"<function_results>\n<result>\n<tool_name>read</tool_name>\n<stdout>FILE</stdout>\n</result>\n</function_results>",
		);
		expect(getDialectDefinition("qwen3").renderToolResults([resultBlock])).toBe(
			"<tool_response>\nFILE\n</tool_response>",
		);
		expect(getDialectDefinition("gemini").renderToolResults([resultBlock])).toBe("```tool_outputs\nFILE\n```");
		expect(getDialectDefinition("gemma").renderToolResults([resultBlock])).toBe(
			'<|tool_response>response:read{output:<|"|>FILE<|"|>}<tool_response|>',
		);
	});

	it("encodes assistant calls and tool results through the selected dialect", () => {
		const history: Context["messages"] = [
			{ role: "user", content: "hi", timestamp: 0 },
			assistant([
				{ type: "text", text: "let me read" },
				{ type: "toolCall", id: "functions.read:0", name: "read", arguments: { path: "a.ts" } },
			]),
			result("functions.read:0", "read", "FILE A"),
		];
		const enc = encodeInbandToolHistory(history, "kimi", TOOLS);
		expect(enc[0]).toBe(history[0]);
		expect(enc[1]!.role).toBe("assistant");
		expect(enc[2]!.role).toBe("user");
		const assistantBlock = (enc[1] as AssistantMessage).content[0]!;
		const assistantText = assistantBlock.type === "text" ? assistantBlock.text : "";
		expect(assistantText).toContain("<|tool_calls_section_begin|>");
		expect(assistantText).toContain("functions.read:0");
		const resultText =
			Array.isArray(enc[2]!.content) && enc[2]!.content[0]!.type === "text" ? enc[2]!.content[0]!.text : "";
		expect(resultText).toBe("<|im_system|>read<|im_middle|>## Return of functions.read:0\nFILE A<|im_end|>");
	});

	it("streams string arguments incrementally for GLM", () => {
		const text = getDialectDefinition("glm").renderAssistantToolCalls(
			[
				{
					type: "toolCall",
					id: "c1",
					name: "write",
					arguments: { path: "out.ts", content: "line1\nconst x = `a`;" },
				},
			],
			{ tools: TOOLS },
		);
		const deltas = feedText("glm", text)
			.filter(
				(event): event is Extract<InbandScanEvent, { type: "toolArgDelta" }> =>
					event.type === "toolArgDelta" && event.key === "content",
			)
			.map(event => event.delta)
			.join("");
		expect(deltas).toBe("line1\nconst x = `a`;");
	});
});
