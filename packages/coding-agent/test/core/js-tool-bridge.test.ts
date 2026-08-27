import { describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

function createTool(name: string, execute: AgentTool["execute"]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		concurrency: "parallel",
		execute,
	} as unknown as AgentTool;
}

function createSession(tools: AgentTool[]): ToolSession {
	const registry = new Map(tools.map(tool => [tool.name, tool]));
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getToolByName: name => registry.get(name),
	};
}

describe("callSessionTool", () => {
	it("injects js intent and summarizes text results", async () => {
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "hello" }],
		});
		const session = createSession([createTool("read", execute)]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"read",
			{ path: "/tmp/demo.txt" },
			{
				session,
				emitStatus: event => {
					statuses.push(event);
				},
			},
		);

		expect(result).toBe("hello");
		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-read-/),
			{ path: "/tmp/demo.txt", [INTENT_FIELD]: "js prelude" },
			undefined,
			undefined,
			undefined,
		);
		expect(statuses).toEqual([expect.objectContaining({ op: "read", path: "/tmp/demo.txt", chars: 5 })]);
	});

	it("passes the session tool context to bridged executions", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const context = { settings: Settings.isolated() } as AgentToolContext;
		const session = {
			...createSession([createTool("bash", execute)]),
			getToolContext: () => context,
		};

		await callSessionTool("bash", { command: "true" }, { session });

		expect(execute).toHaveBeenCalledWith(
			expect.stringMatching(/^js-bash-/),
			{ command: "true", [INTENT_FIELD]: "js prelude" },
			undefined,
			undefined,
			context,
		);
	});

	it("returns structured tool results when details or images are present", async () => {
		const session = createSession([
			createTool("custom", async () => ({
				content: [
					{ type: "text", text: "done" },
					{ type: "image", mimeType: "image/png", data: "abc123" },
				],
				details: { ok: true },
			})),
		]);

		const result = await callSessionTool("custom", {}, { session });

		expect(result).toEqual({
			text: "done",
			details: { ok: true },
			images: [{ mimeType: "image/png", data: "abc123" }],
		});
	});

	it("marks structured results when the underlying tool reports an error", async () => {
		const session = createSession([
			createTool("mcp__demo_fail", async () => ({
				content: [{ type: "text", text: "Error: bad input" }],
				details: { serverName: "demo", mcpToolName: "fail", isError: true },
			})),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool(
			"mcp__demo_fail",
			{},
			{ session, emitStatus: event => statuses.push(event) },
		);

		expect(result).toEqual({
			text: "Error: bad input",
			details: { serverName: "demo", mcpToolName: "fail", isError: true },
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "mcp__demo_fail",
				chars: 16,
				hasError: true,
				error: "Error: bad input",
			}),
		]);
	});

	it("marks results with top-level isError", async () => {
		const session = createSession([
			createTool(
				"custom",
				async () =>
					({
						content: [{ type: "text", text: "preview mismatch" }],
						isError: true,
					}) as AgentToolResult,
			),
		]);
		const statuses: Array<Record<string, unknown>> = [];

		const result = await callSessionTool("custom", {}, { session, emitStatus: event => statuses.push(event) });

		expect(result).toEqual({
			text: "preview mismatch",
			details: undefined,
			hasError: true,
		});
		expect(statuses).toEqual([
			expect.objectContaining({
				op: "custom",
				chars: 16,
				hasError: true,
				error: "preview mismatch",
			}),
		]);
	});

	it("throws when the requested tool is not available in the session registry", async () => {
		const session = createSession([]);

		await expect(callSessionTool("missing", {}, { session })).rejects.toThrow("Unknown tool from js runtime");
	});

	it("executes the bridge-authorized tool instead of the raw registry tool", async () => {
		const rawExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "raw" }] });
		const authorizedExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "authorized" }] });
		const session = {
			...createSession([createTool("write", rawExecute)]),
			getToolForEvalBridge: () => createTool("write", authorizedExecute),
		};

		const result = await callSessionTool("write", { path: "out.txt", content: "data" }, { session });

		expect(result).toBe("authorized");
		expect(authorizedExecute).toHaveBeenCalledTimes(1);
		expect(rawExecute).not.toHaveBeenCalled();
	});

	it("rejects checkpoint and rewind before reaching the registry", async () => {
		const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		const session = createSession([createTool("checkpoint", execute), createTool("rewind", execute)]);

		await expect(callSessionTool("checkpoint", { goal: "g" }, { session })).rejects.toThrow(
			"cannot run through the eval bridge",
		);
		await expect(callSessionTool("rewind", { report: "r" }, { session })).rejects.toThrow(
			"cannot run through the eval bridge",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects a registry tool excluded from the eval bridge", async () => {
		const rawExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "raw" }] });
		const session = {
			...createSession([createTool("write", rawExecute)]),
			getToolForEvalBridge: () => undefined,
		};

		await expect(callSessionTool("write", { path: "out.txt", content: "data" }, { session })).rejects.toThrow(
			"Unknown tool from js runtime",
		);
		expect(rawExecute).not.toHaveBeenCalled();
	});
});
