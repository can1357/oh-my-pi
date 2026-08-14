import { describe, expect, it } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { gunzipSync } from "node:zlib";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { Context, Model, ToolCall } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import {
	ChatToolCallSchema,
	StopReason,
} from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";

function frameConnectMessage(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, 0);
	view.setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

/** Capture the protobuf request from a streamDevin call. */
async function captureRequest(context: Context, tools?: Context["tools"]) {
	let requestPayload: Uint8Array | undefined;
	const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
		requestPayload = new Uint8Array(init?.body as ArrayBuffer);
		return new Response(new Uint8Array());
	}) as typeof fetch;

	await streamDevin(devinModel, { ...context, tools }, { apiKey: "token", fetch: fetchImpl }).result();
	if (!requestPayload) throw new Error("Devin chat request was not captured");
	const flag = requestPayload[0];
	const length = new DataView(requestPayload.buffer, requestPayload.byteOffset, requestPayload.byteLength).getUint32(1, false);
	const payload = requestPayload.subarray(5, 5 + length);
	const decoded = flag & 0x01 ? gunzipSync(payload) : payload;
	return fromBinary(GetChatMessageRequestSchema, decoded);
}

describe("streamDevin tool calling", () => {
	it("encodes tool definitions in the request", async () => {
		const request = await captureRequest(
			{ messages: [{ role: "user", content: "run ls", timestamp: 0 }] },
			[
				{
					name: "run_command",
					description: "Run a terminal command",
					parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
				},
			],
		);
		expect(request.tools.length).toBe(1);
		expect(request.tools[0].name).toBe("run_command");
		expect(request.tools[0].description).toBe("Run a terminal command");
		expect(request.tools[0].jsonSchemaString).toContain('"command"');
	});

	it("encodes multiple tool definitions", async () => {
		const request = await captureRequest(
			{ messages: [{ role: "user", content: "run ls and create a file", timestamp: 0 }] },
			[
				{
					name: "run_command",
					description: "Run a terminal command",
					parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
				},
				{
					name: "edit_file",
					description: "Create or edit a file",
					parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
				},
			],
		);
		expect(request.tools.length).toBe(2);
		expect(request.tools[0].name).toBe("run_command");
		expect(request.tools[1].name).toBe("edit_file");
	});

	it("parses tool call deltas from the response stream", async () => {
		// Simulate a response with a tool call: run_command({"command": "ls"})
		const chunks = [
			frameConnectMessage(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, {
				messageId: "msg-1",
				deltaToolCalls: [create(ChatToolCallSchema, { id: "call-1", name: "run_command", argumentsJson: "" })],
			}))),
			frameConnectMessage(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, {
				messageId: "msg-1",
				deltaToolCalls: [create(ChatToolCallSchema, { id: "", name: "", argumentsJson: '{"command": "' })],
			}))),
			frameConnectMessage(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, {
				messageId: "msg-1",
				deltaToolCalls: [create(ChatToolCallSchema, { id: "", name: "", argumentsJson: "ls" })],
			}))),
			frameConnectMessage(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, {
				messageId: "msg-1",
				deltaToolCalls: [create(ChatToolCallSchema, { id: "", name: "", argumentsJson: '"}' })],
				stopReason: StopReason.FUNCTION_CALL,
			}))),
		];

		const fetchImpl = (async (_input: string | URL | Request) => {
			let index = 0;
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						await Bun.sleep(1);
						const chunk = chunks[index++];
						if (chunk) controller.enqueue(chunk);
						else controller.close();
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const stream = streamDevin(devinModel, {
			messages: [{ role: "user", content: "run ls", timestamp: 0 }],
			tools: [{
				name: "run_command",
				description: "Run a terminal command",
				parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
			}],
		}, { apiKey: "token", fetch: fetchImpl });

		const result = await stream.result();
		const toolCall = result.content.find((c): c is ToolCall => c.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall!.name).toBe("run_command");
		expect(toolCall!.id).toBe("call-1");
		expect(toolCall!.arguments).toEqual({ command: "ls" });
	});

	it("parses multiple tool calls from a single response", async () => {
		// Simulate two tool calls: run_command({"command": "ls"}) and edit_file({"path": "hello.txt", "content": "Hello World"})
		const chunks = [
			// First tool call: run_command
			frameConnectMessage(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, {
				messageId: "msg-1",
				deltaToolCalls: [create(ChatToolCallSchema, { id: "call-1", name: "run_command", argumentsJson: "" })],
			}))),
			frameConnectMessage(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, {
				messageId: "msg-1",
				deltaToolCalls: [create(ChatToolCallSchema, { id: "", name: "", argumentsJson: '{"command": "ls"}' })],
			}))),
			// Second tool call: edit_file
			frameConnectMessage(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, {
				messageId: "msg-1",
				deltaToolCalls: [create(ChatToolCallSchema, { id: "call-2", name: "edit_file", argumentsJson: "" })],
			}))),
			frameConnectMessage(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, {
				messageId: "msg-1",
				deltaToolCalls: [create(ChatToolCallSchema, { id: "", name: "", argumentsJson: '{"path": "hello.txt", "content": "Hello World"}' })],
				stopReason: StopReason.FUNCTION_CALL,
			}))),
		];

		const fetchImpl = (async (_input: string | URL | Request) => {
			let index = 0;
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						await Bun.sleep(1);
						const chunk = chunks[index++];
						if (chunk) controller.enqueue(chunk);
						else controller.close();
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const stream = streamDevin(devinModel, {
			messages: [{ role: "user", content: "run ls and create hello.txt", timestamp: 0 }],
			tools: [
				{ name: "run_command", description: "Run a terminal command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
				{ name: "edit_file", description: "Create or edit a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
			],
		}, { apiKey: "token", fetch: fetchImpl });

		const result = await stream.result();
		const toolCalls = result.content.filter((c): c is ToolCall => c.type === "toolCall");
		expect(toolCalls.length).toBe(2);
		expect(toolCalls[0].name).toBe("run_command");
		expect(toolCalls[0].id).toBe("call-1");
		expect(toolCalls[0].arguments).toEqual({ command: "ls" });
		expect(toolCalls[1].name).toBe("edit_file");
		expect(toolCalls[1].id).toBe("call-2");
		expect(toolCalls[1].arguments).toEqual({ path: "hello.txt", content: "Hello World" });
	});
});
