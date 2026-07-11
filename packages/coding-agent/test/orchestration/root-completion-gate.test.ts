import { describe, expect, it } from "bun:test";
import type { Message, ToolResultMessage } from "@pk-nerdsaver-ai/pi-ai";
import { evaluateCompletionGate } from "../../src/orchestration/completion-gate";
import { buildCompletionGateInputFromTranscript } from "../../src/orchestration/root-completion-gate";
import { compileTaskContractFromRequest, toActiveTaskContractSnapshot } from "../../src/orchestration/task-contract";

function toolResult(toolName: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${toolName}`,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp,
	};
}

describe("root completion gate transcript", () => {
	it("passes when verification tools ran since contract activation", () => {
		const contract = toActiveTaskContractSnapshot(compileTaskContractFromRequest("implement auth flow"));
		const messages: Message[] = [toolResult("bash", 100), toolResult("read", 101)];
		const input = buildCompletionGateInputFromTranscript(contract, messages, 50);
		const evaluation = evaluateCompletionGate(input);
		expect(evaluation.outcome).toBe("pass");
	});

	it("is recoverable when no verification tools ran", () => {
		const contract = toActiveTaskContractSnapshot(compileTaskContractFromRequest("implement auth flow"));
		const input = buildCompletionGateInputFromTranscript(contract, [], 0);
		const evaluation = evaluateCompletionGate(input);
		expect(evaluation.outcome).toBe("recoverable");
		expect(evaluation.reminder).toBeDefined();
	});
});
