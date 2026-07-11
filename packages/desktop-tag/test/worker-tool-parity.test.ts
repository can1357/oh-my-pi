import { describe, expect, it } from "bun:test";

import type { CreateAgentSessionOptions } from "@pk-nerdsaver-ai/pi-coding-agent";
import type { GatewayCommand, GatewayEventListener } from "@pk-nerdsaver-ai/pi-coding-agent/gateway/types";
import type { ClientBridge } from "@pk-nerdsaver-ai/pi-coding-agent/session/client-bridge";
import { filterToolCapabilities, type ToolCapability } from "@pk-nerdsaver-ai/pi-coding-agent/tools";

import type { TaskInput } from "../src/types";
import { PiWorker } from "../src/worker";

const representativeNormalRegistry = [
	{ source: "builtin", name: "task" },
	{ source: "builtin", name: "job" },
	{ source: "builtin", name: "irc" },
	{ source: "builtin", name: "browser" },
	{ source: "builtin", name: "ix_bridge" },
	{ source: "builtin", name: "search_tool_bm25" },
	{ source: "mcp", name: "mcp__future_service" },
	{ source: "extension", name: "future_extension_tool" },
	{ source: "custom", name: "future_custom_tool" },
	{ source: "hidden", name: "future_hidden_tool" },
] as const satisfies readonly ToolCapability[];

const taskInput: TaskInput = {
	contextPacket: {
		captureId: "parity-capture",
		timestamp: "2026-07-11T00:00:00.000Z",
		userRequest: "Use all normal tools",
		captureMode: "screen",
		visual: { displayScale: 1, annotations: [] },
		foregroundApp: {},
		browser: {},
		selection: {},
		availableCapabilities: [],
	},
	routing: {
		executorId: "answer-only",
		suggestedTools: ["inspect_image"],
		message: "Answer from captured context",
		level: 0,
	},
};

class ParitySession {
	clientBridge?: ClientBridge;
	readonly sessionManager = { flush: async () => {} };

	setClientBridge(bridge: ClientBridge | undefined): void {
		this.clientBridge = bridge;
	}

	async backgroundCurrentSession(): Promise<boolean> {
		return true;
	}

	async dispose(): Promise<void> {}
}

class ParityGateway {
	async dispatch(_command: GatewayCommand): Promise<void> {}

	subscribe(_listener: GatewayEventListener): () => void {
		return () => {};
	}

	dispose(): void {}
}

describe("Desktop worker tool parity", () => {
	it("keeps normal builtin and discovered source entries through the injectable runtime", async () => {
		let desktopRegistry: readonly ToolCapability[] = [];
		let desktopOptions: CreateAgentSessionOptions | undefined;
		const worker = new PiWorker(async options => {
			desktopOptions = options;
			if (!options.toolProfile) throw new Error("Desktop profile was not provided");
			desktopRegistry = filterToolCapabilities(options.toolProfile, representativeNormalRegistry);
			return { session: new ParitySession(), gateway: new ParityGateway() };
		});

		const handle = await worker.createSession("tool-parity", taskInput);

		expect(desktopOptions?.toolNames).toBeUndefined();
		expect(desktopRegistry).toEqual(representativeNormalRegistry);
		expect(desktopRegistry.map(tool => tool.name)).toEqual(
			expect.arrayContaining(["task", "job", "irc", "browser", "ix_bridge", "mcp__future_service"]),
		);
		await worker.cancel(handle.sessionId);
	});
});
