import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isEmptyErrorTurn, sanitizeAssistantForReparentedHistory } from "@oh-my-pi/pi-coding-agent/session/messages";

type Turn = Pick<AssistantMessage, "stopReason" | "content">;

const turn = (stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): Turn => ({
	stopReason,
	content,
});

describe("isEmptyErrorTurn", () => {
	it("flags a content-less provider-rejection turn (the wedge poison that replays on reload)", () => {
		expect(isEmptyErrorTurn(turn("error", []))).toBe(true);
		expect(isEmptyErrorTurn(turn("error", [{ type: "text", text: "   " }]))).toBe(true);
	});

	it("keeps error turns that streamed real text, reasoning, or tool calls", () => {
		expect(isEmptyErrorTurn(turn("error", [{ type: "text", text: "partial answer" }]))).toBe(false);
		expect(isEmptyErrorTurn(turn("error", [{ type: "thinking", thinking: "partial reasoning" }]))).toBe(false);
		expect(isEmptyErrorTurn(turn("error", [{ type: "thinking", thinking: "", thinkingSignature: "sig" }]))).toBe(
			false,
		);
		expect(isEmptyErrorTurn(turn("error", [{ type: "redactedThinking", data: "encrypted" }]))).toBe(false);
		expect(isEmptyErrorTurn(turn("error", [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }]))).toBe(
			false,
		);
	});

	it("never flags non-error turns, even when empty — only the rejection turn is dropped", () => {
		expect(isEmptyErrorTurn(turn("stop", []))).toBe(false);
		expect(isEmptyErrorTurn(turn("aborted", []))).toBe(false);
	});
});

describe("sanitizeAssistantForReparentedHistory", () => {
	it("drops Anthropic server-tool history when moving an assistant turn", () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "search first", thinkingSignature: "signed-thinking" },
				{
					type: "anthropicServerTool",
					block: {
						type: "server_tool_use",
						id: "srvtoolu_search",
						name: "web_search",
						input: { query: "current UTC date" },
					},
				},
				{
					type: "anthropicServerTool",
					block: {
						type: "web_search_tool_result",
						tool_use_id: "srvtoolu_search",
						content: [{ type: "web_search_result", encrypted_content: "opaque-result" }],
					},
				},
				{ type: "text", text: "done" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			providerPayload: { type: "openaiResponsesHistory", items: [{ id: "provider-bound" }] },
			timestamp: 1,
		};

		expect(sanitizeAssistantForReparentedHistory(message)).toEqual({
			...message,
			content: [
				{ type: "thinking", thinking: "search first" },
				{ type: "text", text: "done" },
			],
			providerPayload: undefined,
		});
	});
});
