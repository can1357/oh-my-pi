import { describe, expect, it } from "bun:test";
import { convertMessages, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { isSurvivingAssistant, transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Context, Message, Model, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Type } from "@sinclair/typebox";

const completionsModel: Model<"openai-completions"> = buildModel({
	id: "local/assistant",
	name: "Local Assistant",
	api: "openai-completions",
	provider: "local-openai",
	baseUrl: "http://127.0.0.1:18080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_384,
	maxTokens: 4096,
});

function makeTool(name: string): Tool {
	return {
		name,
		description: `Run ${name}`,
		parameters: Type.Object({}),
	};
}

function assistantToolCalls(
	calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>,
	timestamp = 2,
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: completionsModel.provider,
		model: completionsModel.id,
		content: calls.map(call => ({
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: call.arguments ?? {},
		})),
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

function toolResult(id: string, name: string, text: string, timestamp = 3): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

describe("openai-completions dotted declared tool-name replay", () => {
	it.each(["power.state", "display.list", "power__state", "audio__mute-toggle"])(
		"preserves assistant tool_call and tool result in wire payload for declared tool %s",
		async toolName => {
			const context: Context = {
				systemPrompt: ["You are a local assistant."],
				tools: [makeTool(toolName)],
				messages: [
					{ role: "user", content: "run it", timestamp: 1 },
					assistantToolCalls([{ id: "tc_0", name: toolName }]),
					toolResult("tc_0", toolName, `RESULT:${toolName}`),
				],
			};

			const controller = new AbortController();
			controller.abort();
			const { promise, resolve } = Promise.withResolvers<unknown>();
			void streamOpenAICompletions(completionsModel, context, {
				apiKey: "test-key",
				signal: controller.signal,
				onPayload: payload => resolve(payload),
			});

			const payload = (await promise) as {
				tools?: Array<{ type: string; function?: { name?: string } }>;
				messages?: Array<{
					role: string;
					content?: unknown;
					tool_call_id?: string;
					tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
				}>;
			};

			expect(payload.tools?.map(tool => tool.function?.name)).toEqual([toolName]);
			expect(payload.messages?.map(message => message.role)).toEqual(["system", "user", "assistant", "tool"]);

			const assistantWire = payload.messages?.find(message => message.role === "assistant");
			expect(assistantWire?.tool_calls).toEqual([
				{
					id: "tc_0",
					type: "function",
					function: { name: toolName, arguments: "{}" },
				},
			]);

			const toolWire = payload.messages?.find(message => message.role === "tool");
			expect(toolWire).toMatchObject({
				role: "tool",
				tool_call_id: "tc_0",
				content: `RESULT:${toolName}`,
			});
		},
	);

	it("still drops undeclared dotted or malformed tool names and empty-id calls", () => {
		const context: Context = {
			tools: [makeTool("power.state"), makeTool("display.list")],
			messages: [
				{ role: "user", content: "check state", timestamp: 1 },
				assistantToolCalls([
					{ id: "tc_declared", name: "power.state" },
					{ id: "tc_undeclared_dot", name: "functions.read" },
					{ id: "tc_url", name: "proc://*" },
					{ id: "", name: "display.list" },
					{ id: "tc_overlong", name: "t".repeat(65) },
				]),
				toolResult("tc_declared", "power.state", "RESULT:power.state", 3),
				toolResult("tc_undeclared_dot", "functions.read", "Tool functions.read not found", 4),
				toolResult("tc_url", "proc://*", "Tool proc://* not found", 5),
				toolResult("", "display.list", "empty id result", 6),
				toolResult("tc_overlong", "t".repeat(65), "Tool not found", 7),
			],
		};

		const wire = convertMessages(completionsModel, context, completionsModel.compat);
		expect(wire.map(message => message.role)).toEqual(["user", "assistant", "tool"]);

		const assistantWire = wire[1] as { tool_calls?: Array<{ id: string; function: { name: string } }> };
		expect(assistantWire.tool_calls?.map(call => ({ id: call.id, name: call.function.name }))).toEqual([
			{ id: "tc_declared", name: "power.state" },
		]);

		const toolWire = wire[2] as { tool_call_id?: string; content?: unknown };
		expect(toolWire).toMatchObject({
			role: "tool",
			tool_call_id: "tc_declared",
			content: "RESULT:power.state",
		});
	});

	it("treats turns with declared dotted tool calls as surviving assistants", () => {
		const turn = assistantToolCalls([{ id: "tc_0", name: "power.state" }]);
		const declared = new Set(["power.state"]);

		expect(isSurvivingAssistant(turn, completionsModel)).toBe(false);
		expect(isSurvivingAssistant(turn, completionsModel, declared)).toBe(true);

		const messages: Message[] = [
			{ role: "user", content: "run it", timestamp: 1 },
			turn,
			toolResult("tc_0", "power.state", "RESULT:power.state"),
		];
		const transformed = transformMessages(
			messages,
			completionsModel,
			undefined,
			undefined,
			undefined,
			completionsModel.compat,
			undefined,
			declared,
		);
		expect(transformed.map(message => message.role)).toEqual(["user", "assistant", "toolResult"]);
	});
});
