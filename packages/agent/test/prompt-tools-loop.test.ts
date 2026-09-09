import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Context, Message, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function wireText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return (message.content as (TextContent | { type: string })[])
		.map(b => (b.type === "text" ? (b as TextContent).text : ""))
		.join("");
}

describe("agentLoop with owned in-band tool calls", () => {
	it("executes <tool_call> text, strips native tools from the wire, and re-encodes history as text", async () => {
		const echoArgs: Array<{ msg: string }> = [];
		const toolSchema = type({ msg: "string" });
		const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				echoArgs.push(params);
				return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
			},
		};

		const captured: Context[] = [];
		const mock = createMockModel({
			responses: [
				context => {
					captured.push(context);
					return {
						content: [
							"on it\n<tool_call>echo\n<arg_key>msg</arg_key>\n<arg_value>hello world</arg_value>\n</tool_call>",
						],
					};
				},
				context => {
					captured.push(context);
					return { content: ["all done"] };
				},
			],
		});

		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, dialect: "glm" };

		const messages = await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

		// The tool was actually executed with the parsed (verbatim) argument.
		expect(echoArgs).toEqual([{ msg: "hello world" }]);
		expect(captured).toHaveLength(2);

		// First request: no native tools on the wire; catalog + grammar injected.
		expect(captured[0].tools).toBeUndefined();
		const sys0 = captured[0].systemPrompt ?? [];
		expect(sys0[0]).toBe("BASE PROMPT");
		const promptSection = sys0.join("\n");
		expect(promptSection).toContain("<tools>");
		expect(promptSection).toContain('"name":"echo"');
		expect(promptSection).toContain("<arg_key>name</arg_key>");

		// Second request: the wire carries NO native tool blocks — prior call/result
		// are plain <tool_call> / <tool_response> text, and tools are still stripped.
		const wire2 = captured[1].messages;
		expect(captured[1].tools).toBeUndefined();
		for (const m of wire2) {
			expect(m.role).not.toBe("toolResult");
			if (m.role === "assistant") {
				expect((m.content as { type: string }[]).some(b => b.type === "toolCall")).toBe(false);
			}
		}
		const wireAssistant = wire2.find(m => m.role === "assistant");
		expect(wireAssistant).toBeDefined();
		const at = wireText(wireAssistant!);
		expect(at).toContain("on it");
		expect(at).toContain("<tool_call>echo");
		expect(at).toContain("<arg_value>hello world</arg_value>");
		const resultsText = wire2
			.filter(m => m.role === "user")
			.map(wireText)
			.join("\n");
		expect(resultsText).toContain("<tool_response>");
		expect(resultsText).toContain("echoed:hello world");

		// The internal store stays canonical: native toolCall block + toolResult message.
		const internalAssistant = messages.find(
			(m): m is AssistantMessage => m.role === "assistant" && m.content.some(b => b.type === "toolCall"),
		);
		expect(internalAssistant).toBeDefined();
		const internalResult = messages.find((m): m is ToolResultMessage => m.role === "toolResult");
		expect(internalResult).toBeDefined();
		expect(internalResult!.toolName).toBe("echo");
		expect(wireText(internalResult!)).toBe("echoed:hello world");
	});

	it("prunes native tool descriptions from the wire when pruneToolDescriptions is set", async () => {
		const toolSchema = type({ msg: type("string").describe("the message to echo") });
		const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
			},
		};
		const captured: Context[] = [];
		const mock = createMockModel({
			responses: [
				context => {
					captured.push(context);
					return { content: ["done"] };
				},
			],
		});
		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			pruneToolDescriptions: true,
		};
		await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

		const wireTools = captured[0]?.tools;
		expect(wireTools).toHaveLength(1);
		expect(wireTools?.[0].name).toBe("echo");
		// Native tool calling: spec ships with no description text (top-level or nested).
		expect(wireTools?.[0].description).toBe("");
		expect(JSON.stringify(wireTools?.[0].parameters)).not.toContain("the message to echo");
	});

	it("keeps in-band tool descriptions for owned dialects even when pruneToolDescriptions is set", async () => {
		const toolSchema = type({ msg: "string" });
		const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
			},
		};
		const captured: Context[] = [];
		const mock = createMockModel({
			responses: [
				context => {
					captured.push(context);
					return { content: ["done"] };
				},
			],
		});
		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			dialect: "glm",
			pruneToolDescriptions: true,
		};
		await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

		// Owned dialect carries the catalog in the prompt as text and sends no native
		// tools, so pruning must not strip its descriptions.
		expect(captured[0]?.tools).toBeUndefined();
		const promptSection = (captured[0]?.systemPrompt ?? []).join("\n");
		expect(promptSection).toContain("<tools>");
		expect(promptSection).toContain("Echo a message back");
	});

	it("executes Hermes/Qwen JSON tool calls when that dialect is selected", async () => {
		const echoArgs: Array<{ msg: string }> = [];
		const toolSchema = type({ msg: "string" });
		const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				echoArgs.push(params);
				return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
			},
		};

		const captured: Context[] = [];
		const mock = createMockModel({
			responses: [
				context => {
					captured.push(context);
					return { content: ['<tool_call>\n{"name":"echo","arguments":{"msg":"hi"}}\n</tool_call>'] };
				},
				context => {
					captured.push(context);
					return { content: ["done"] };
				},
			],
		});

		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, dialect: "hermes" };

		await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

		expect(echoArgs).toEqual([{ msg: "hi" }]);
		expect(captured[0].tools).toBeUndefined();
		expect((captured[0].systemPrompt ?? []).join("\n")).toContain('"name":"function_name","arguments"');
		const resultsText = captured[1].messages
			.filter(m => m.role === "user")
			.map(wireText)
			.join("\n");
		expect(resultsText).toContain("<tool_response>");
		expect(resultsText).toContain("echoed:hi");
	});

	it("uses PI_DIALECT=minimax when config.dialect is unset", async () => {
		const before = Bun.env.PI_DIALECT;
		Bun.env.PI_DIALECT = "minimax";
		try {
			const echoArgs: Array<{ msg: string }> = [];
			const toolSchema = type({ msg: "string" });
			const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
				name: "echo",
				label: "Echo",
				description: "Echo a message back",
				parameters: toolSchema,
				async execute(_toolCallId, params) {
					echoArgs.push(params);
					return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
				},
			};

			const captured: Context[] = [];
			const mock = createMockModel({
				responses: [
					context => {
						captured.push(context);
						return {
							content: [
								'<minimax:tool_call>\n<invoke name="echo"><parameter name="msg">from env</parameter></invoke>\n</minimax:tool_call>',
							],
						};
					},
					context => {
						captured.push(context);
						return { content: ["done"] };
					},
				],
			});

			const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
			const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

			await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

			expect(echoArgs).toEqual([{ msg: "from env" }]);
			expect(captured[0].tools).toBeUndefined();
			expect((captured[0].systemPrompt ?? []).join("\n")).toContain("<minimax:tool_call>");
		} finally {
			if (before === undefined) delete Bun.env.PI_DIALECT;
			else Bun.env.PI_DIALECT = before;
		}
	});
});
