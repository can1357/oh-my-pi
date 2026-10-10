import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { describe, expect, test } from "bun:test";
import { authorizeToolWithoutExecution, ExtensionToolWrapper } from "../src/extensibility/extensions/wrapper.ts";

type RecordingTool = AgentTool & { executions: number };

function recordingTool(name: string, approval: "read" | "write" | "exec"): RecordingTool {
	const tool = {
		name,
		description: name,
		label: name,
		parameters: { type: "object", properties: {} },
		approval,
		executions: 0,
		execute: async () => {
			tool.executions += 1;
			return { content: [{ type: "text" as const, text: "executed" }] };
		},
	};
	return tool as RecordingTool;
}

function runner(options?: {
	hasUI?: boolean;
	select?: (prompt: string, choices: string[], selectOptions?: { signal?: AbortSignal }) => Promise<string>;
	rewriteInput?: unknown;
}) {
	return {
		consumeLoopToolCall: () => false,
		consumeToolCallEmitted: () => false,
		hasHandlers: (event: string) => event === "tool_call" && options?.rewriteInput !== undefined,
		hasUI: () => options?.hasUI === true,
		getUIContext: () => ({ select: options?.select ?? (async () => "Deny") }),
		cancelToolCallPreflight: () => {},
		emitToolCall: async () => (options?.rewriteInput === undefined ? undefined : { input: options.rewriteInput }),
	};
}

const context = {} as AgentToolContext;

describe("provider-owned authorization", () => {
	test("allows a read-tier tool without prompting or executing it", async () => {
		const tool = recordingTool("read", "read");
		const wrapped = new ExtensionToolWrapper(tool, runner() as never);
		await authorizeToolWithoutExecution(
			wrapped,
			"read-1",
			{ path: "README.md" },
			new AbortController().signal,
			context,
		);
		expect(tool.executions).toBe(0);
	});

	test("returns after an exec approval without executing the tool", async () => {
		const tool = recordingTool("bash", "exec");
		let prompted = false;
		const wrapped = new ExtensionToolWrapper(
			tool,
			runner({
				hasUI: true,
				select: async () => {
					prompted = true;
					return "Approve";
				},
			}) as never,
		);
		await authorizeToolWithoutExecution(
			wrapped,
			"exec-1",
			{ command: "printf ok" },
			new AbortController().signal,
			context,
		);
		expect(prompted).toBe(true);
		expect(tool.executions).toBe(0);
	});

	test("prompts for a write-tier tool and does not execute it", async () => {
		const tool = recordingTool("write", "write");
		let prompted = false;
		const wrapped = new ExtensionToolWrapper(
			tool,
			runner({
				hasUI: true,
				select: async () => {
					prompted = true;
					return "Approve";
				},
			}) as never,
		);
		await authorizeToolWithoutExecution(
			wrapped,
			"write-1",
			{ path: "notes.txt", content: "kept" },
			new AbortController().signal,
			context,
		);
		expect(prompted).toBe(true);
		expect(tool.executions).toBe(0);
	});

	test("rejects an exec denial and does not execute the tool", async () => {
		const tool = recordingTool("bash", "exec");
		const wrapped = new ExtensionToolWrapper(
			tool,
			runner({
				hasUI: true,
				select: async () => "Deny",
			}) as never,
		);
		await expect(
			authorizeToolWithoutExecution(
				wrapped,
				"exec-2",
				{ command: "printf no" },
				new AbortController().signal,
				context,
			),
		).rejects.toThrow("denied by user");
		expect(tool.executions).toBe(0);
	});

	test("rejects when approval is required and no interactive channel is available", async () => {
		const tool = recordingTool("bash", "exec");
		const wrapped = new ExtensionToolWrapper(tool, runner({ hasUI: false }) as never);
		await expect(
			authorizeToolWithoutExecution(
				wrapped,
				"exec-3",
				{ command: "printf unavailable" },
				new AbortController().signal,
				context,
			),
		).rejects.toThrow("no interactive UI available");
		expect(tool.executions).toBe(0);
	});

	test("rejects a cancelled approval wait without executing the tool", async () => {
		const tool = recordingTool("bash", "exec");
		const controller = new AbortController();
		const wrapped = new ExtensionToolWrapper(
			tool,
			runner({
				hasUI: true,
				select: async (_prompt, _choices, selectOptions) => {
					selectOptions?.signal?.throwIfAborted();
					controller.abort();
					selectOptions?.signal?.throwIfAborted();
					return "Approve";
				},
			}) as never,
		);
		await expect(
			authorizeToolWithoutExecution(wrapped, "exec-4", { command: "printf cancelled" }, controller.signal, context),
		).rejects.toThrow();
		expect(tool.executions).toBe(0);
	});

	test("refuses authorization when the tool input changes before execution", async () => {
		const tool = recordingTool("bash", "exec");
		const wrapped = new ExtensionToolWrapper(
			tool,
			runner({
				hasUI: true,
				rewriteInput: { command: "printf changed" },
				select: async () => "Approve",
			}) as never,
		);
		await expect(
			authorizeToolWithoutExecution(
				wrapped,
				"exec-5",
				{ command: "printf original" },
				new AbortController().signal,
				context,
			),
		).rejects.toThrow("Tool input changed during authorization");
		expect(tool.executions).toBe(0);
	});
});
