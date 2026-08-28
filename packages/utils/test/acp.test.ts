import { describe, expect, it } from "bun:test";
import {
	type Agent,
	AgentSideConnection,
	type AnyMessage,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	RequestError,
	RpcConnection,
	schema,
} from "../src/acp";

function transportPair() {
	const leftToRight = new TransformStream<Uint8Array, Uint8Array>();
	const rightToLeft = new TransformStream<Uint8Array, Uint8Array>();
	return {
		left: ndJsonStream(leftToRight.writable, rightToLeft.readable),
		right: ndJsonStream(rightToLeft.writable, leftToRight.readable),
	};
}

describe("ACP JSON-RPC transport", () => {
	it("round-trips requests, notifications, and errors", async () => {
		const pair = transportPair();
		const updates: unknown[] = [];
		const updateReceived = Promise.withResolvers<void>();
		const client: Client = {
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			sessionUpdate: async update => {
				updates.push(update);
				updateReceived.resolve();
			},
		};
		const clientConnection = new ClientSideConnection(() => client, pair.left);
		let agentConnection: AgentSideConnection;
		const agent: Agent = {
			initialize: params => ({ protocolVersion: params.protocolVersion }),
			newSession: async () => ({ sessionId: "session-1" }),
			prompt: async params => {
				if (params.prompt.length === 0) throw RequestError.invalidParams({ field: "prompt" });
				await agentConnection.requestPermission({
					sessionId: params.sessionId,
					toolCall: { toolCallId: "tool-1" },
					options: [],
				});
				return { stopReason: "end_turn" };
			},
			cancel: async () => {},
		};
		agentConnection = new AgentSideConnection(() => agent, pair.right);

		await expect(clientConnection.initialize({ protocolVersion: 1, clientCapabilities: {} })).resolves.toEqual({
			protocolVersion: 1,
		});
		await agentConnection.sessionUpdate({ sessionId: "session-1", update: { sessionUpdate: "plan", entries: [] } });
		await updateReceived.promise;
		expect(updates).toHaveLength(1);
		await expect(
			clientConnection.prompt({
				sessionId: "session-1",
				prompt: [{ type: "text", text: "nested request" }],
			}),
		).resolves.toEqual({ stopReason: "end_turn" });
		await expect(clientConnection.prompt({ sessionId: "session-1", prompt: [] })).rejects.toMatchObject({
			code: -32602,
			data: { field: "prompt" },
		});
	});

	it("correlates out-of-order responses", async () => {
		const requests = new TransformStream<AnyMessage, AnyMessage>();
		const responses = new TransformStream<AnyMessage, AnyMessage>();
		const connection = new RpcConnection(
			{ writable: requests.writable, readable: responses.readable },
			() => undefined,
		);
		const reader = requests.readable.getReader();
		const writer = responses.writable.getWriter();
		const first = connection.request<string>("first");
		const second = connection.request<string>("second");
		const firstMessage = await reader.read();
		const secondMessage = await reader.read();
		if (firstMessage.done || secondMessage.done || !("id" in firstMessage.value) || !("id" in secondMessage.value))
			throw new Error("Expected requests");
		await writer.write({ jsonrpc: "2.0", id: secondMessage.value.id, result: "two" });
		await writer.write({ jsonrpc: "2.0", id: firstMessage.value.id, result: "one" });
		await expect(Promise.all([first, second])).resolves.toEqual(["one", "two"]);
		reader.releaseLock();
		writer.releaseLock();
	});

	it("decodes split and batched NDJSON frames", async () => {
		const bytes = new TransformStream<Uint8Array, Uint8Array>();
		const output = new TransformStream<Uint8Array, Uint8Array>();
		const stream = ndJsonStream(output.writable, bytes.readable);
		const writer = bytes.writable.getWriter();
		const reader = stream.readable.getReader();
		await writer.write(new TextEncoder().encode('{"jsonrpc":"2.0","method":"a","par'));
		await writer.write(new TextEncoder().encode('ams":{}}\n{"jsonrpc":"2.0","method":"b"}\n'));
		expect(await reader.read()).toMatchObject({ value: { method: "a", params: {} } });
		expect(await reader.read()).toMatchObject({ value: { method: "b" } });
		writer.releaseLock();
		reader.releaseLock();
	});
	it("matches the SDK error-code fixtures", () => {
		expect([
			RequestError.parseError().toErrorResponse(),
			RequestError.invalidRequest().toErrorResponse(),
			RequestError.methodNotFound("missing").toErrorResponse(),
			RequestError.invalidParams().toErrorResponse(),
			RequestError.internalError().toErrorResponse(),
			RequestError.requestCancelled().toErrorResponse(),
			RequestError.authRequired().toErrorResponse(),
			RequestError.resourceNotFound("file:///missing").toErrorResponse(),
			RequestError.sessionBusy("Agent is already processing.", { reason: "session_busy" }).toErrorResponse(),
		]).toEqual([
			{ code: -32700, message: "Parse error" },
			{ code: -32600, message: "Invalid request" },
			{ code: -32601, message: '"Method not found": missing', data: { method: "missing" } },
			{ code: -32602, message: "Invalid params" },
			{ code: -32603, message: "Internal error" },
			{ code: -32800, message: "Request cancelled" },
			{ code: -32000, message: "Authentication required" },
			{ code: -32002, message: "Resource not found: file:///missing", data: { uri: "file:///missing" } },
			{ code: -32003, message: "Agent is already processing.", data: { reason: "session_busy" } },
		]);
	});
});

describe("ACP runtime schemas", () => {
	it("accepts valid protocol vectors", () => {
		expect(schema.zNewSessionResponse.safeParse({ sessionId: "s" }).success).toBe(true);
		expect(schema.zPromptResponse.safeParse({ stopReason: "end_turn" }).success).toBe(true);
		expect(
			schema.zSessionNotification.safeParse({
				sessionId: "s",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
			}).success,
		).toBe(true);
	});

	it("rejects malformed protocol vectors", () => {
		expect(schema.zNewSessionResponse.safeParse({ sessionId: 4 }).success).toBe(false);
		expect(schema.zPromptResponse.safeParse({ stopReason: "done" }).success).toBe(false);
		expect(
			schema.zSessionNotification.safeParse({
				sessionId: "s",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text" } },
			}).success,
		).toBe(false);
	});
});
