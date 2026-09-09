import { describe, expect, it } from "bun:test";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AgentRunRequest } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";

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

function capture(): Promise<AgentRunRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<AgentRunRequest>();
	streamCursor(cursorModel(), { messages: [{ role: "user", content: "pong", timestamp: 0 }] } satisfies Context, {
		apiKey: "test-token",
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
