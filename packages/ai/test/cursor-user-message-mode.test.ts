import { describe, expect, it } from "bun:test";
import { buildGrpcRequest, type CursorOptions } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type AgentRunRequest, AgentClientMessageSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

function cursorModel(): Model<"cursor-agent"> {
	return buildModel({
		id: "auto",
		name: "Cursor Auto",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
	});
}

async function capture(options?: CursorOptions): Promise<AgentRunRequest> {
	const { requestBytes } = await buildGrpcRequest(
		cursorModel(),
		{ messages: [{ role: "user", content: "pong", timestamp: 0 }] } satisfies Context,
		options,
		{ conversationId: "wire-test", blobStore: new Map() },
	);
	const message = fromBinary(AgentClientMessageSchema, requestBytes).message;
	if (message.case !== "runRequest") throw new Error("Expected Cursor run request");
	return message.value;
}

describe("Cursor user message wire shape", () => {
	it("sends AgentMode.AGENT (1), never UNSPECIFIED (0)", async () => {
		const payload = await capture();
		const action = payload.action?.action;
		expect(action?.case).toBe("userMessageAction");
		if (action?.case !== "userMessageAction") return;
		expect(action.value.userMessage?.text).toBe("pong");
		expect(action.value.userMessage?.mode).toBe(1);
	});
});

// Losing these fields during encoding silently disables negotiated capabilities
// and disconnects a run from the caller's session.
it("encodes negotiated capabilities and caller session identity on the wire", async () => {
	const payload = await capture({
		cursorClientSupportsInlineImages: true,
		cursorClientSupportsRoutedModelUpdate: true,
		cursorClientSupportsPromptContextUsageRpc: true,
		cursorRunId: "run-123",
		cursorAgentSessionId: "session-456",
	});
	expect(payload).toMatchObject({
		clientSupportsInlineImages: true,
		clientSupportsRoutedModelUpdate: true,
		clientSupportsPromptContextUsageRpc: true,
		runId: "run-123",
		agentSessionId: "session-456",
	});
});
