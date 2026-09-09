import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import { defineRpcClientTool, RpcClient } from "@oh-my-pi/pi-coding-agent/modes";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolUpdate,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempPaths.splice(0).map(async filePath => {
			try {
				await removeWithRetries(filePath);
			} catch {}
		}),
	);
});

describe("RpcHostToolBridge", () => {
	it("forwards host tool updates and results to the pending execution", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_sum",
				label: "Host Sum",
				description: "Adds numbers in the host process",
				parameters: {
					type: "object",
					properties: {
						left: { type: "number" },
						right: { type: "number" },
					},
					required: ["left", "right"],
					additionalProperties: false,
				},
			},
		]);

		const updates: RpcHostToolUpdate["partialResult"][] = [];
		const execution = tool.execute("toolu_1", { left: 2, right: 3 }, undefined, update => {
			updates.push(update);
		});

		expect(frames).toHaveLength(1);
		const request = frames[0];
		if (request?.type !== "host_tool_call") {
			throw new Error("Expected host_tool_call frame");
		}

		bridge.handleUpdate({
			type: "host_tool_update",
			id: request.id,
			partialResult: {
				content: [{ type: "text", text: "working" }],
			},
		});
		expect(updates).toHaveLength(1);
		expect(updates[0]?.content[0]).toEqual({ type: "text", text: "working" });

		bridge.handleResult({
			type: "host_tool_result",
			id: request.id,
			result: {
				content: [{ type: "text", text: "5" }],
			},
		});

		await expect(execution).resolves.toEqual({
			content: [{ type: "text", text: "5" }],
		});
	});

	it("emits a cancel frame when the host tool execution is aborted", async () => {
		const frames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			frames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_wait",
				description: "Waits in the host process",
				parameters: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		]);

		const controller = new AbortController();
		const execution = tool.execute("toolu_2", {}, controller.signal);
		const request = frames[0];
		if (request?.type !== "host_tool_call") {
			throw new Error("Expected host_tool_call frame");
		}

		controller.abort();

		expect(frames[1]).toMatchObject({
			type: "host_tool_cancel",
			targetId: request.id,
		});
		await expect(execution).rejects.toThrow('Host tool "host_wait" was aborted');
	});
});

describe("RpcClient custom tools", () => {
	it("registers host custom tools and serves tool calls over the RPC transport", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-host-tools-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		await Bun.write(
			scriptPath,
			`
const encoder = new TextEncoder();
let buffer = "";

function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}

write({ type: "ready" });

process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});

function handle(frame) {
	if (frame.type === "set_host_tools") {
		write({
			id: frame.id,
			type: "response",
			command: "set_host_tools",
			success: true,
			data: { toolNames: frame.tools.map(tool => tool.name) },
		});
		return;
	}
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "agent_start" });
		write({
			type: "host_tool_call",
			id: "host-call-1",
			toolCallId: "toolu_host_1",
			toolName: "echo_host",
			arguments: { message: "hello" },
		});
		return;
	}
	if (frame.type === "host_tool_update") {
		write({
			type: "tool_execution_update",
			toolCallId: "toolu_host_1",
			toolName: "echo_host",
			args: { message: "hello" },
			partialResult: frame.partialResult,
		});
		return;
	}
	if (frame.type === "host_tool_result") {
		write({
			type: "tool_execution_end",
			toolCallId: "toolu_host_1",
			toolName: "echo_host",
			result: frame.result,
			isError: frame.isError === true,
		});
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		const client = new RpcClient({
			cliPath: scriptPath,
			customTools: [
				defineRpcClientTool<{ message: string }>({
					name: "echo_host",
					description: "Echo a value from the embedding host",
					parameters: {
						type: "object",
						properties: {
							message: { type: "string" },
						},
						required: ["message"],
						additionalProperties: false,
					},
					async execute(args, context) {
						context.sendUpdate(`working:${args.message}`);
						return `host:${args.message}`;
					},
				}),
			],
		});

		try {
			await client.start();
			const events = await client.promptAndWait("Trigger host tool");
			const toolEnd = events.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
					event.type === "tool_execution_end",
			);
			expect(toolEnd?.toolName).toBe("echo_host");
			expect(toolEnd?.result).toEqual({
				content: [{ type: "text", text: "host:hello" }],
			});

			const toolUpdate = events.find(
				(event): event is Extract<AgentEvent, { type: "tool_execution_update" }> =>
					event.type === "tool_execution_update",
			);
			expect(toolUpdate?.partialResult).toEqual({
				content: [{ type: "text", text: "working:hello" }],
			});
		} finally {
			await client.stop();
		}
	});
});
