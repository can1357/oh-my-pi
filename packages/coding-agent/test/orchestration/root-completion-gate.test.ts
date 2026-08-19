import { describe, expect, it } from "bun:test";
import type { Message, ToolResultMessage } from "@pk-nerdsaver-ai/pi-ai";
import { evaluateCompletionGate } from "../../src/orchestration/completion-gate";
import { buildCompletionGateInputFromTranscript } from "../../src/orchestration/root-completion-gate";
import { compileTaskContractFromRequest, toActiveTaskContractSnapshot } from "../../src/orchestration/task-contract";

function toolResult(toolName: string, timestamp: number, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${toolName}-${timestamp}`,
		toolName,
		content: [{ type: "text", text: isError ? "failed" : "ok" }],
		isError,
		timestamp,
	};
}

describe("root completion gate transcript", () => {
	it("passes when ledger-backed verification evidence exists since activation", () => {
		const contract = toActiveTaskContractSnapshot(compileTaskContractFromRequest("implement auth flow"));
		const messages: Message[] = [toolResult("bash", 100), toolResult("read", 101)];
		const input = buildCompletionGateInputFromTranscript(contract, messages, 50);
		const evaluation = evaluateCompletionGate(input);
		expect(input.criteriaEvidence).toEqual({
			targeted_verification: "pass",
			deliverables_present: "pass",
		});
		expect(evaluation.outcome).toBe("pass");
	});

	it("is recoverable when no verification evidence exists", () => {
		const contract = toActiveTaskContractSnapshot(compileTaskContractFromRequest("implement auth flow"));
		const input = buildCompletionGateInputFromTranscript(contract, [], 0);
		const evaluation = evaluateCompletionGate(input);
		expect(input.criteriaEvidence).toEqual({
			targeted_verification: "unproven",
			deliverables_present: "pass",
		});
		expect(evaluation.outcome).toBe("recoverable");
		expect(evaluation.reminder).toBeDefined();
	});

	it("requires separate deliverable evidence when the contract names deliverables", () => {
		const compiled = toActiveTaskContractSnapshot(compileTaskContractFromRequest("implement auth flow"));
		const contract = { ...compiled, deliverables: ["auth implementation"] };
		const input = buildCompletionGateInputFromTranscript(contract, [toolResult("read", 100)], 50);
		const evaluation = evaluateCompletionGate(input);

		expect(input.criteriaEvidence).toEqual({
			targeted_verification: "pass",
			deliverables_present: "unproven",
		});
		expect(input.deliverablesPresent).toEqual([]);
		expect(evaluation.outcome).toBe("recoverable");
	});

	it("does not accept failed or pre-activation tool results as evidence", () => {
		const compiled = toActiveTaskContractSnapshot(compileTaskContractFromRequest("implement auth flow"));
		const contract = { ...compiled, deliverables: ["auth implementation"] };
		const messages: Message[] = [toolResult("bash", 25), toolResult("write", 100, true)];
		const input = buildCompletionGateInputFromTranscript(contract, messages, 50);
		const evaluation = evaluateCompletionGate(input);

		expect(input.criteriaEvidence).toEqual({
			targeted_verification: "unproven",
			deliverables_present: "unproven",
		});
		expect(evaluation.outcome).toBe("recoverable");
	});
});
