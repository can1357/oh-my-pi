import { expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { CursorInferenceMapper } from "@oh-my-pi/pi-ai/providers/cursor/response";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { InferenceStreamResponse } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	InferenceStreamResponseSchema,
	InferenceTextStreamPartSchema,
	InferenceToolCallStreamPartSchema,
	RunInferenceInvocationResponseSchema,
	RunInferenceServerMessageSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";

function output(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function cursorResponse(response: Partial<InferenceStreamResponse>) {
	return create(RunInferenceServerMessageSchema, {
		message: {
			case: "invocationResponse",
			value: create(RunInferenceInvocationResponseSchema, {
				invocationId: "invocation",
				response: create(InferenceStreamResponseSchema, response),
			}),
		},
	});
}

test("Cursor streamed tool calls execute once through the normal agent loop and continue", async () => {
	const model = buildModel({
		id: "composer-2.5",
		name: "Composer 2.5",
		provider: "cursor",
		api: "cursor-agent",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
	const schema = type({ left: "string", right: "string" });
	let executions = 0;
	const tool: AgentTool<typeof schema, { left: string; right: string }> = {
		name: "join_fragments",
		label: "Join Fragments",
		description: "Join two strings",
		parameters: schema,
		execute: async (_id, params) => {
			executions++;
			return { content: [{ type: "text", text: `${params.left}${params.right}` }] };
		},
	};
	let providerTurns = 0;
	let continuedWithResult = false;
	const streamFn: StreamFn = (requestModel, context) => {
		const stream = new AssistantMessageEventStream();
		const message = output(requestModel);
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			const mapper = new CursorInferenceMapper(stream, message, new Set([tool.name]), "invocation", () => undefined);
			if (providerTurns++ === 0) {
				mapper.handle(
					cursorResponse({
						response: {
							case: "toolCallPart",
							value: create(InferenceToolCallStreamPartSchema, {
								toolCallId: "tool-1",
								toolName: tool.name,
								args: '{"left":"A","right":"B"}',
								isComplete: true,
							}),
						},
					}),
				);
			} else {
				continuedWithResult = context.messages.some(
					item =>
						item.role === "toolResult" &&
						item.toolCallId === "tool-1" &&
						item.content.some(part => part.type === "text" && part.text === "AB"),
				);
				mapper.handle(
					cursorResponse({
						response: {
							case: "textPart",
							value: create(InferenceTextStreamPartSchema, { text: "joined", isFinal: false }),
						},
					}),
				);
				mapper.handle(
					cursorResponse({
						response: {
							case: "textPart",
							value: create(InferenceTextStreamPartSchema, { text: "joined", isFinal: true }),
						},
					}),
				);
			}
			const terminal = mapper.finish();
			message.stopReason = terminal.stopReason;
			stream.push({ type: "done", reason: terminal.stopReason as "stop" | "toolUse", message });
			stream.end();
		});
		return stream;
	};
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Use the tool"], tools: [tool], messages: [] },
		streamFn,
	});

	await agent.prompt("join");

	expect(executions).toBe(1);
	expect(continuedWithResult).toBe(true);
	expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	expect(agent.state.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "joined" }] });
});
