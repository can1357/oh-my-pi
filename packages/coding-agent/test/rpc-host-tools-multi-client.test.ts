import { describe, expect, it } from "bun:test";
import { RpcClientConnection } from "@oh-my-pi/pi-coding-agent/modes/rpc/client-connection";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

type HostFrames = Array<RpcHostToolCallRequest | RpcHostToolCancelRequest>;

function hostTool(name: string, description = `${name} runs in the host process`): RpcHostToolDefinition {
	return {
		name,
		description,
		parameters: { type: "object", properties: {}, additionalProperties: false },
	};
}

function connection(frames: HostFrames): RpcClientConnection {
	return new RpcClientConnection({
		send: frame => {
			frames.push(frame as RpcHostToolCallRequest | RpcHostToolCancelRequest);
		},
	});
}

describe("RpcHostToolBridge per-connection tools", () => {
	it("merges tools registered by two connections instead of replacing them", () => {
		const framesA: HostFrames = [];
		const framesB: HostFrames = [];
		const connA = connection(framesA);
		const connB = connection(framesB);
		const bridge = new RpcHostToolBridge(connA);
		bridge.registerClient(connB);

		bridge.setTools([hostTool("alpha_tool")]);
		bridge.setTools([hostTool("beta_tool")], connB);

		expect(bridge.getToolNames()).toEqual(["alpha_tool", "beta_tool"]);
	});

	it("delivers a host tool call only to the connection that registered the tool", () => {
		const framesA: HostFrames = [];
		const framesB: HostFrames = [];
		const connA = connection(framesA);
		const connB = connection(framesB);
		const bridge = new RpcHostToolBridge(connA);
		bridge.registerClient(connB);

		bridge.setTools([hostTool("alpha_tool")]);
		const merged = bridge.setTools([hostTool("beta_tool")], connB);
		const beta = merged.find(tool => tool.name === "beta_tool");
		if (!beta) throw new Error("Expected the merged union to expose beta_tool");

		void beta.execute("toolu_beta", {});

		expect(framesA).toEqual([]);
		expect(framesB).toHaveLength(1);
		expect(framesB[0]).toMatchObject({ type: "host_tool_call", toolName: "beta_tool" });
	});

	it("lets the latest registration of a duplicated tool name own that tool", () => {
		const framesA: HostFrames = [];
		const framesB: HostFrames = [];
		const connA = connection(framesA);
		const connB = connection(framesB);
		const bridge = new RpcHostToolBridge(connA);
		bridge.registerClient(connB);

		bridge.setTools([hostTool("shared_tool", "from connection A")]);
		const merged = bridge.setTools([hostTool("shared_tool", "from connection B")], connB);
		const shared = merged.find(tool => tool.name === "shared_tool");
		if (!shared) throw new Error("Expected the merged union to expose shared_tool");

		expect(bridge.getToolNames()).toEqual(["shared_tool"]);
		expect(shared.description).toBe("from connection B");
		void shared.execute("toolu_shared", {});

		expect(framesA).toEqual([]);
		expect(framesB).toHaveLength(1);
	});

	it("fails only the disconnected connection's in-flight call and drops only its tools", async () => {
		const framesA: HostFrames = [];
		const framesB: HostFrames = [];
		const connA = connection(framesA);
		const connB = connection(framesB);
		const bridge = new RpcHostToolBridge(connA);
		bridge.registerClient(connB);

		const [alpha] = bridge.setTools([hostTool("alpha_tool")]);
		const merged = bridge.setTools([hostTool("beta_tool")], connB);
		const beta = merged.find(tool => tool.name === "beta_tool");
		if (!alpha || !beta) throw new Error("Expected both host tools in the merged union");

		const outcomes = Promise.allSettled([alpha.execute("toolu_alpha", {}), beta.execute("toolu_beta", {})]);
		const disconnectMessage = "RPC client disconnected before host tool execution completed";
		const remaining = bridge.removeClient(connA, disconnectMessage);

		expect(bridge.getToolNames()).toEqual(["beta_tool"]);
		expect(remaining.map(tool => tool.name)).toEqual(["beta_tool"]);

		const betaCall = framesB[0];
		if (betaCall?.type !== "host_tool_call") throw new Error("Expected beta's host_tool_call frame");
		expect(bridge.handleResult({ type: "host_tool_result", id: betaCall.id, result: { content: [] } })).toBe(true);

		const [alphaOutcome, betaOutcome] = await outcomes;
		expect(alphaOutcome.status).toBe("rejected");
		if (alphaOutcome.status === "rejected") {
			expect(alphaOutcome.reason.message).toBe(disconnectMessage);
		}
		expect(betaOutcome.status).toBe("fulfilled");
		expect(framesA).toHaveLength(1);
		expect(framesA[0]).toMatchObject({ type: "host_tool_call", toolName: "alpha_tool" });
	});
	it("unicasts host tool cancellation to the connection that owns the call", async () => {
		const framesA: HostFrames = [];
		const framesB: HostFrames = [];
		const connA = connection(framesA);
		const connB = connection(framesB);
		const bridge = new RpcHostToolBridge(connB);
		bridge.registerClient(connA);

		const [alpha] = bridge.setTools([hostTool("alpha_tool")], connA);
		if (!alpha) throw new Error("Expected connection A's host tool");
		const controller = new AbortController();
		const execution = alpha.execute("toolu_alpha", {}, controller.signal);
		const call = framesA[0];
		if (call?.type !== "host_tool_call") throw new Error("Expected alpha's host_tool_call frame");
		controller.abort();

		expect(framesA).toHaveLength(2);
		expect(framesA[1]).toMatchObject({ type: "host_tool_cancel", targetId: call.id });
		expect(framesB).toEqual([]);
		await expect(execution).rejects.toThrow('Host tool "alpha_tool" was aborted');
	});
});

describe("RpcHostToolBridge single-connection compatibility", () => {
	it("keeps one connection's set_host_tools a replacement, not an accumulation", () => {
		const frames: HostFrames = [];
		const bridge = new RpcHostToolBridge(connection(frames));

		bridge.setTools([hostTool("first_tool")]);
		const second = bridge.setTools([hostTool("second_tool")]);

		expect(bridge.getToolNames()).toEqual(["second_tool"]);
		expect(second.map(tool => tool.name)).toEqual(["second_tool"]);
	});
});
