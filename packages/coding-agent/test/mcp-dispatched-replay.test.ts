import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { connectToServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { DeferredMCPTool, MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const TOOL_DEF = { name: "record_effect", inputSchema: { type: "object" as const } };
const connections: MCPServerConnection[] = [];
let tempDir: string;
let effectsPath: string;
let auth: AuthStorage;
let context: CustomToolContext;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-no-replay-"));
	effectsPath = path.join(tempDir, "effects.txt");
	auth = await AuthStorage.create(":memory:");
	context = {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: new ModelRegistry(auth),
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
});

afterEach(async () => {
	for (const connection of connections) await connection.transport.close();
	connections.length = 0;
	auth.close();
	await removeWithRetries(tempDir);
});

async function openConnection(): Promise<MCPServerConnection> {
	const connection = await connectToServer("side-effect", {
		type: "stdio",
		command: process.execPath,
		args: [path.join(import.meta.dir, "fixtures", "side-effect-mcp.ts"), effectsPath],
		timeout: 300,
	});
	connections.push(connection);
	return connection;
}

async function effects(): Promise<string[]> {
	return (await Bun.file(effectsPath).text()).trimEnd().split("\n");
}

describe("MCP tool calls after dispatch", () => {
	it("does not replay a crashed MCPTool call and recovers for the next call", async () => {
		let reconnects = 0;
		const tool = new MCPTool(await openConnection(), TOOL_DEF, async () => {
			reconnects++;
			return openConnection();
		});

		const failed = await tool.execute("crash", { crash: true }, undefined, context);

		expect(failed.details?.isError).toBe(true);
		const diagnostic = failed.content[0];
		if (diagnostic?.type !== "text") throw new Error("Expected MCP failure diagnostics");
		expect(diagnostic.text).toContain("retryable: no");
		expect(diagnostic.text).toContain("may already have run; check its effect before retrying");
		expect(reconnects).toBe(0);
		expect(await effects()).toEqual(["record_effect"]);

		const recovered = await tool.execute("recover", {}, undefined, context);

		expect(recovered.details?.isError).toBeFalsy();
		expect(recovered.content).toEqual([{ type: "text", text: "effect recorded" }]);
		expect(reconnects).toBe(1);
		expect(await effects()).toEqual(["record_effect", "record_effect"]);
	});

	it("does not replay a crashed DeferredMCPTool call", async () => {
		const connection = await openConnection();
		let reconnects = 0;
		const tool = new DeferredMCPTool(
			"side-effect",
			TOOL_DEF,
			async () => connection,
			undefined,
			async () => {
				reconnects++;
				return openConnection();
			},
		);

		const result = await tool.execute("crash", { crash: true }, undefined, context);

		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("retryable: no"),
		});
		expect(reconnects).toBe(0);
		expect(await effects()).toEqual(["record_effect"]);
	});

	it("reconnects and retries a definitely unsent call exactly once", async () => {
		const connection = await openConnection();
		let reconnects = 0;
		const tool = new MCPTool(connection, TOOL_DEF, async () => {
			reconnects++;
			return openConnection();
		});
		await connection.transport.close();

		const result = await tool.execute("unsent", {}, undefined, context);

		expect(result.details?.isError).toBeFalsy();
		expect(result.content).toEqual([{ type: "text", text: "effect recorded" }]);
		expect(reconnects).toBe(1);
		expect(await effects()).toEqual(["record_effect"]);
	});
});
