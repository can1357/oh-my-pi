import { expect, it } from "bun:test";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { processResponsesStream } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Model, ModelSpec, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"openai-responses"> = buildModel({
	id: "anthropic/claude-sonnet-5.5",
	name: "Claude Sonnet 5.5",
	api: "openai-responses",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
} as ModelSpec<"openai-responses">);

function emptyAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

async function* events(list: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of list) yield event as ResponseStreamEvent;
}

function functionCallEvents(outputIndex: number, callId: string, name: string, args: string): unknown[] {
	const item = { type: "function_call", id: `fc_${callId}`, call_id: callId, name };
	return [
		{ type: "response.output_item.added", output_index: outputIndex, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: outputIndex, item_id: item.id, delta: args },
		{ type: "response.function_call_arguments.done", output_index: outputIndex, item_id: item.id, arguments: args },
		{ type: "response.output_item.done", output_index: outputIndex, item: { ...item, arguments: args } },
	];
}

it("replays a lenient-repaired function call with the arguments that were executed", async () => {
	// Invalid JSON as streamed by OpenRouter/Claude for a strict nullable arg (#14155).
	const brokenArgs = '{"command": "pwd; ls -a", "name": , "ready": null}';
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	await processResponsesStream(
		events([
			...functionCallEvents(0, "call_read", "read", JSON.stringify({ path: "." })),
			...functionCallEvents(1, "call_bash", "bash", brokenArgs),
		]),
		output,
		{ push: () => {}, end: () => {} } as never,
		model,
		{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
	);
	output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeItems);

	const bash = output.content.find(block => block.type === "toolCall" && block.name === "bash");
	if (bash?.type !== "toolCall") throw new Error("expected bash tool call");
	const results: ToolResultMessage[] = output.content.flatMap(block =>
		block.type === "toolCall"
			? [
					{
						role: "toolResult",
						toolCallId: block.id,
						toolName: block.name,
						content: [{ type: "text", text: `${block.name} output` }],
						isError: false,
						timestamp: 2,
					},
				]
			: [],
	);

	const input = buildParams(model, { messages: [output, ...results] }, { reasoning: "high" }, undefined).params
		.input as unknown as Array<Record<string, unknown>>;

	const bashCall = input.find(item => item.type === "function_call" && item.call_id === "call_bash");
	expect(bashCall).toBeDefined();
	expect(JSON.parse(String(bashCall?.arguments))).toEqual(bash.arguments);
	expect(input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_bash" }));
	expect(input.at(-1)).toMatchObject({ type: "function_call_output" });
	expect(JSON.stringify(input)).not.toContain("Orphan");
});

it("does not crash on a relaxed scalar function-call argument", async () => {
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	await processResponsesStream(
		events(functionCallEvents(0, "call_scalar", "bash", "'hello'")),
		output,
		{ push: () => {}, end: () => {} } as never,
		model,
		{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
	);

	const toolCall = output.content.find(block => block.type === "toolCall");
	if (toolCall?.type !== "toolCall") throw new Error("expected a finalized toolCall block");
	expect(JSON.stringify(toolCall.arguments)).toBe('"hello"');
	const nativeCall = nativeItems.find(item => item.type === "function_call");
	expect(JSON.parse(String(nativeCall?.arguments))).toBe("hello");
});
