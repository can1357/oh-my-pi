import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "../packages/ai/src/types";
import type { AgentSessionEvent } from "../packages/coding-agent/src/session/agent-session";
import { inspectWorkflow } from "./provider-tool-smoke/evidence";

const input = "input-token\n";
const challenge = "verified-shell-token";
function tool(name: string, text = "ok"): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolName: name,
		toolCallId: name,
		isError: false,
		result: { content: [{ type: "text", text }], details: {} },
	};
}
function final(stopReason: AssistantMessage["stopReason"] = "stop"): AgentSessionEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: challenge }],
			api: "grokbot-sand",
			provider: "grokbot",
			model: "default",
			stopReason,
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

describe("provider tool smoke evidence", () => {
	it("requires ordered execution, exact file bytes, and a final answer grounded in bash output", () => {
		const events = [tool("read", input), tool("write"), tool("bash", challenge), final()];
		expect(inspectWorkflow(events, input, input, challenge, 0).pass).toBe(true);
		expect(inspectWorkflow(events, input, input.trim(), challenge, 0).pass).toBe(false);
		expect(inspectWorkflow(events, input, input, challenge, 1).pass).toBe(false);
	});
	it("rejects an existing file and model claim when no write tool executed", () => {
		expect(inspectWorkflow([tool("read"), tool("bash", challenge), final()], input, input, challenge, 0).pass).toBe(
			false,
		);
	});
	it("rejects a bash workaround before the write tool", () => {
		expect(
			inspectWorkflow([tool("read"), tool("bash", challenge), tool("write"), final()], input, input, challenge, 0)
				.pass,
		).toBe(false);
	});
	it("rejects an echoed final token without corresponding shell output", () => {
		expect(
			inspectWorkflow([tool("read"), tool("write"), tool("bash"), final()], input, input, challenge, 0).pass,
		).toBe(false);
	});
	it("rejects a provider error even if the process exits zero", () => {
		expect(
			inspectWorkflow(
				[tool("read"), tool("write"), tool("bash", challenge), final("error")],
				input,
				input,
				challenge,
				0,
			).pass,
		).toBe(false);
	});
});
