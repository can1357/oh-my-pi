// Contract: SimpleStreamOptions / CursorOptions capability and session fields
// must populate AgentRunRequest protobuf members (not just be allowlisted).
import { describe, expect, it } from "bun:test";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AgentRunRequest } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

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

function capture(options: {
	cursorClientSupportsInlineImages?: boolean;
	cursorClientSupportsRoutedModelUpdate?: boolean;
	cursorClientSupportsPromptContextUsageRpc?: boolean;
	cursorRunId?: string;
	cursorAgentSessionId?: string;
}): Promise<AgentRunRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentRunRequest>();
	streamCursor(cursorModel(), { messages: [{ role: "user", content: "pong", timestamp: 0 }] } satisfies Context, {
		apiKey: "test-token",
		...options,
		onPayload: payload => {
			if (payload && typeof payload === "object" && "conversationState" in payload) {
				resolve(payload as AgentRunRequest);
			} else {
				reject(new Error("Cursor payload was not an AgentRunRequest"));
			}
			throw new Error("stop after capturing Cursor payload");
		},
	});
	return promise;
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
			runId: "",
			agentSessionId: "",
		});
	});
});
