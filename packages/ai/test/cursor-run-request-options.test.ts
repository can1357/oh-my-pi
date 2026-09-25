// Contract: SimpleStreamOptions / CursorOptions capability and session fields
// must populate AgentRunRequest protobuf members (not just be allowlisted).
import { describe, expect, it } from "bun:test";
import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AgentClientMessageSchema, type AgentRunRequest } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { fromBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

function cursorModel(): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-composer-2.5",
		name: "Cursor Composer 2.5",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

async function capture(options: {
	cursorClientSupportsInlineImages?: boolean;
	cursorClientSupportsRoutedModelUpdate?: boolean;
	cursorClientSupportsPromptContextUsageRpc?: boolean;
	cursorRunId?: string;
	cursorAgentSessionId?: string;
	conversationId?: string;
}): Promise<AgentRunRequest> {
	const { requestBytes } = await buildGrpcRequest(
		cursorModel(),
		{ messages: [{ role: "user", content: "pong", timestamp: 0 }] } satisfies Context,
		options,
		{ conversationId: options.conversationId ?? "fixture-conversation", blobStore: new Map() },
	);
	const message = fromBinary(AgentClientMessageSchema, requestBytes).message;
	if (message.case !== "runRequest") throw new Error("Expected serialized RunRequest");
	return message.value;
}

describe("Cursor AgentRunRequest option wiring", () => {
	it("serializes capability flags and session ids onto the run request", async () => {
		const payload = await capture({
			cursorClientSupportsInlineImages: true,
			cursorClientSupportsRoutedModelUpdate: true,
			cursorClientSupportsPromptContextUsageRpc: true,
			cursorRunId: "run-abc",
			cursorAgentSessionId: "sess-xyz",
		});
		expect(payload).toMatchObject({
			clientSupportsInlineImages: true,
			clientSupportsRoutedModelUpdate: true,
			clientSupportsPromptContextUsageRpc: true,
			runId: "run-abc",
			agentSessionId: "sess-xyz",
		});
	});

	it("leaves capability flags false and session ids empty when unset", async () => {
		const payload = await capture({});
		expect(payload).toMatchObject({
			clientSupportsInlineImages: false,
			clientSupportsRoutedModelUpdate: false,
			clientSupportsPromptContextUsageRpc: false,
			agentSessionId: "",
		});
	});

	it("mints a fresh run id per request when cursorRunId is unset", async () => {
		const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
		const first = await capture({});
		const second = await capture({});
		expect(first.runId).toMatch(uuidPattern);
		expect(second.runId).toMatch(uuidPattern);
		expect(second.runId).not.toBe(first.runId);
	});

	it("defaults conversationGroupId to the request conversation", async () => {
		const payload = await capture({ conversationId: "conv-group-check" });
		expect(payload.conversationGroupId).toBe("conv-group-check");
	});
});
