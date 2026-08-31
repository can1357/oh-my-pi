import { describe, expect, it } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { classifyAssignmentTool } from "@oh-my-pi/pi-coding-agent/assignment-capability/gate";
import type { AssignmentCapabilityRuntime } from "@oh-my-pi/pi-coding-agent/assignment-capability/runtime";
import type { AssignmentExecuteInput } from "@oh-my-pi/pi-coding-agent/assignment-capability/types";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";

function tool(name: string, tier: "read" | "write", calls: unknown[]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: Type.Object({ value: Type.String() }),
		strict: true,
		approval: tier,
		execute: async (_id: string, params: unknown) => {
			calls.push(params);
			return { content: [{ type: "text", text: "local" }] };
		},
	} as AgentTool;
}

function runner(runtime?: AssignmentCapabilityRuntime): ExtensionRunner {
	return {
		sessionId: "discussion-session",
		consumeToolCallEmitted: () => false,
		hasHandlers: () => false,
		getAssignmentCapability: () => runtime,
	} as unknown as ExtensionRunner;
}

function capabilityRuntime(
	requests: AssignmentExecuteInput[],
	completions: string[] = [],
): AssignmentCapabilityRuntime {
	return {
		digest: async () => "digest",
		execute: async (input: AssignmentExecuteInput) => {
			requests.push(input);
			return {
				toolResult: { content: [{ type: "text", text: "brokered" }] },
				receipt: {
					attempt: "attempt-1",
					launchDigest: "digest",
					disposition: "succeeded",
					checkpointDigest: "digest",
					promotion: "promoted",
					cleanup: "completed",
					fenceGeneration: 1,
					fencePhase: "released",
					reconciliation: {},
				},
			};
		},
		complete: async (toolCall: string) => {
			completions.push(toolCall);
			return {
				toolResult: { content: [{ type: "text", text: "completed" }] },
				completion: {
					capability: "capability-1",
					generation: 1,
					revocationGeneration: 1,
					state: "revoked",
					assignmentState: "completed-unlanded",
					denialProofDigest: "sha256:proof",
					requestAttempt: "request-1",
				},
			};
		},
	} as unknown as AssignmentCapabilityRuntime;
}

describe("Assignment capability classification", () => {
	it("keeps trusted reads available and denies mutating or unknown bypasses", () => {
		expect(classifyAssignmentTool("read", "core", "read", { path: "x" })).toEqual({ kind: "read" });
		expect(classifyAssignmentTool("hub", "core", "read", { op: "jobs" })).toEqual({ kind: "read" });
		expect(classifyAssignmentTool("hub", "core", "write", { op: "send" })).toEqual({ kind: "denied" });
		expect(classifyAssignmentTool("write", "core-readonly", "write", { path: "x" })).toEqual({ kind: "denied" });
		expect(classifyAssignmentTool("custom", "external", "read", {})).toEqual({ kind: "denied" });
		expect(classifyAssignmentTool("bash", "core", "exec", { command: "true" })).toEqual({ kind: "denied" });
		expect(classifyAssignmentTool("write", "core", "write", { path: "xd://browser" })).toEqual({ kind: "denied" });
		for (const [name, trust, tier, args] of [
			["eval", "core", "exec", { code: "write()" }],
			["github", "core", "write", { op: "pr_create" }],
			["browser", "external", "write", { action: "run" }],
			["mcp_tool", "external", "write", {}],
			["host_tool_call", "external", "write", {}],
			["task", "core", "exec", { tasks: [] }],
		] as const) {
			expect(classifyAssignmentTool(name, trust, tier, args)).toEqual({ kind: "denied" });
		}
	});

	it("admits only the four v1 mutation families at write tier", () => {
		for (const name of ["write", "edit", "ast_edit", "lsp"] as const) {
			expect(classifyAssignmentTool(name, "core", "write", {})).toEqual({ kind: "mutation", family: name });
		}
	});

	it("admits only the trusted explicit completion boundary", () => {
		expect(classifyAssignmentTool("assignment_complete", "core", "write", {})).toEqual({ kind: "completion" });
		expect(classifyAssignmentTool("assignment_complete", "external", "write", {})).toEqual({ kind: "denied" });
		expect(classifyAssignmentTool("assignment_complete", "core", "read", {})).toEqual({ kind: "denied" });
	});
});

describe("Assignment capability wrapper", () => {
	it("brokers a final-argument mutation without executing the discussion Session tool", async () => {
		const localCalls: unknown[] = [];
		const requests: AssignmentExecuteInput[] = [];
		const wrapped = new ExtensionToolWrapper(
			tool("write", "write", localCalls),
			runner(capabilityRuntime(requests)),
			"core",
		);

		const result = await wrapped.execute("call-1", { value: "final" } as never);

		expect(result.content).toEqual([{ type: "text", text: "brokered" }]);
		expect(localCalls).toEqual([]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.effectiveArgs).toEqual({ value: "final" });
		expect(requests[0]?.tool).toBe("write");
		expect(requests[0]?.effectiveArgsDigest).toBe("digest");
	});

	it("routes explicit completion to the authenticated runtime without executing locally", async () => {
		const localCalls: unknown[] = [];
		const completions: string[] = [];
		const wrapped = new ExtensionToolWrapper(
			tool("assignment_complete", "write", localCalls),
			runner(capabilityRuntime([], completions)),
			"core",
		);

		const result = await wrapped.execute("complete-call-1", { value: "complete" } as never);

		expect(result.content).toEqual([{ type: "text", text: "completed" }]);
		expect(localCalls).toEqual([]);
		expect(completions).toEqual(["complete-call-1"]);
	});

	it("denies external mutation even in yolo mode", async () => {
		const localCalls: unknown[] = [];
		const wrapped = new ExtensionToolWrapper(tool("custom", "write", localCalls), runner(capabilityRuntime([])));

		await expect(wrapped.execute("call-2", { value: "no" } as never)).rejects.toThrow("not authorized by v1");
		expect(localCalls).toEqual([]);
	});

	it("executes trusted reads locally while an Assignment is active", async () => {
		const localCalls: unknown[] = [];
		const wrapped = new ExtensionToolWrapper(tool("read", "read", localCalls), runner(capabilityRuntime([])), "core");

		const result = await wrapped.execute("call-3", { value: "read" } as never);

		expect(result.content).toEqual([{ type: "text", text: "local" }]);
		expect(localCalls).toEqual([{ value: "read" }]);
	});

	it("leaves ordinary non-Assignment Sessions unchanged", async () => {
		const localCalls: unknown[] = [];
		const wrapped = new ExtensionToolWrapper(tool("write", "write", localCalls), runner(), "core");

		const result = await wrapped.execute("call-4", { value: "ordinary" } as never);

		expect(result.content).toEqual([{ type: "text", text: "local" }]);
		expect(localCalls).toEqual([{ value: "ordinary" }]);
	});
});
