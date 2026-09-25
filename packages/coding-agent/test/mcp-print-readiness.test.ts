import * as path from "node:path";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callTool } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { resolveMCPStartupTimeoutMs } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TempDir } from "@oh-my-pi/pi-utils";

const FIXTURE = path.join(import.meta.dir, "fixtures", "readiness-mcp.ts");
const SLOW_START_MS = 1_100;
const expectedTools = ["mcp__instant_marker", "mcp__slowcall_marker", "mcp__slowstart_marker"];
const managers: MCPManager[] = [];
const originalTimeout = Bun.env.OMP_MCP_TIMEOUT_MS;
const originalStartup = Bun.env.OMP_MCP_STARTUP_TIMEOUT_MS;
const originalStrict = Bun.env.OMP_MCP_REQUIRE_READY;

afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.disconnectAll()));
	if (originalTimeout === undefined) delete Bun.env.OMP_MCP_TIMEOUT_MS;
	else Bun.env.OMP_MCP_TIMEOUT_MS = originalTimeout;
	if (originalStartup === undefined) delete Bun.env.OMP_MCP_STARTUP_TIMEOUT_MS;
	else Bun.env.OMP_MCP_STARTUP_TIMEOUT_MS = originalStartup;
	if (originalStrict === undefined) delete Bun.env.OMP_MCP_REQUIRE_READY;
	else Bun.env.OMP_MCP_REQUIRE_READY = originalStrict;
});

function server(name: string, startupMs = 0, callMs = 0): MCPStdioServerConfig {
	return {
		type: "stdio",
		command: process.execPath,
		args: [FIXTURE],
		env: { SRV_NAME: name, DELAY_STARTUP: String(startupMs), DELAY_CALL: String(callMs) },
	};
}

async function startServers(): Promise<{ manager: MCPManager; elapsedMs: number }> {
	const manager = new MCPManager(import.meta.dir);
	managers.push(manager);
	const start = Date.now();
	await manager.connectServers(
		{
			instant: server("instant"),
			slowcall: server("slowcall", 0, 320),
			slowstart: server("slowstart", SLOW_START_MS),
		},
		{},
	);
	return { manager, elapsedMs: Date.now() - start };
}

function printSession(manager: MCPManager, refreshGate?: Promise<void>, onRefreshStarted?: () => void) {
	let offered: string[] = [];
	let prompted: string[] | undefined;
	let disposed = false;
	const session = {
		extensionRunner: undefined,
		subscribe: () => {},
		settings: Settings.isolated(),
		sessionManager: {
			buildSessionContext: () => ({ messages: [] }),
			getHeader: () => undefined,
			getEntries: () => [],
			onPersistenceError: () => () => {},
		},
		refreshMCPTools: async (tools: Array<{ name: string }>) => {
			onRefreshStarted?.();
			await refreshGate;
			offered = tools.map(tool => tool.name);
		},
		prompt: async () => {
			prompted = [...offered];
		},
		getLastAssistantMessage: () => undefined,
		prepareForHeadlessAdvisorDrain: () => {},
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose: async () => {
			disposed = true;
			await manager.disconnectAll();
		},
	} as unknown as AgentSession;
	return { session, offered: () => offered, prompted: () => prompted, disposed: () => disposed };
}

describe("headless MCP readiness", () => {
	it("offers all three tools to the first print prompt, independent of a slow tools/call", async () => {
		const { manager } = await startServers();
		const slowConnection = manager.getConnection("slowcall");
		if (!slowConnection) throw new Error("slowcall did not complete its handshake");
		const slowCall = callTool(slowConnection, "slowcall_marker");
		const refreshStarted = Promise.withResolvers<void>();
		const refreshGate = Promise.withResolvers<void>();
		const capture = printSession(manager, refreshGate.promise, refreshStarted.resolve);
		Bun.env.OMP_MCP_TIMEOUT_MS = "2500";
		delete Bun.env.OMP_MCP_REQUIRE_READY;
		const run = runPrintMode(capture.session, { mode: "text", initialMessage: "use tools", mcpManager: manager });
		await refreshStarted.promise;
		expect(capture.prompted()).toBeUndefined();
		refreshGate.resolve();
		const code = await run;
		expect(code).toBe(0);
		expect(capture.prompted()).toEqual(expectedTools);
		expect(await slowCall).toMatchObject({ content: [{ text: "MARKER_OK::slowcall" }] });
		expect(capture.disposed()).toBe(true);
	}, 4_000);

	it("names slowstart on stderr and skips the turn with exit 1 when strict readiness is required", async () => {
		const { manager } = await startServers();
		const capture = printSession(manager);
		Bun.env.OMP_MCP_TIMEOUT_MS = "100";
		Bun.env.OMP_MCP_REQUIRE_READY = "1";
		const output: string[] = [];
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(String(chunk));
			return true;
		});
		let code: number;
		try {
			code = await runPrintMode(capture.session, { mode: "json", initialMessage: "use tools", mcpManager: manager });
		} finally {
			stderrSpy.mockRestore();
		}
		expect(code).toBe(1);
		expect(capture.prompted()).toBeUndefined();
		expect(capture.disposed()).toBe(true);
		expect(output.join("")).toContain('Warning: MCP server "slowstart" not ready after 100ms');
		expect(output.join("")).toContain("Error: MCP servers not ready: slowstart");
	}, 4_000);

	it("warns but still prompts with available tools when strict mode is disabled", async () => {
		const { manager } = await startServers();
		const capture = printSession(manager);
		Bun.env.OMP_MCP_TIMEOUT_MS = "80";
		delete Bun.env.OMP_MCP_REQUIRE_READY;
		const output: string[] = [];
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(String(chunk));
			return true;
		});
		let code: number;
		try {
			code = await runPrintMode(capture.session, { mode: "text", initialMessage: "use tools", mcpManager: manager });
		} finally {
			stderrSpy.mockRestore();
		}
		expect(code).toBe(0);
		expect(capture.prompted()).toEqual(expectedTools.slice(0, 2));
		expect(output.join("")).toContain('Warning: MCP server "slowstart" not ready after 80ms');
	}, 3_000);

	it("reports a failed configured server and rejects strict print startup", async () => {
		const manager = new MCPManager(import.meta.dir);
		managers.push(manager);
		await manager.connectServers({ broken: { type: "stdio", command: "" } }, {});
		const capture = printSession(manager);
		Bun.env.OMP_MCP_REQUIRE_READY = "1";
		const output: string[] = [];
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			output.push(String(chunk));
			return true;
		});
		try {
			expect(
				await runPrintMode(capture.session, { mode: "text", initialMessage: "use tools", mcpManager: manager }),
			).toBe(1);
		} finally {
			stderrSpy.mockRestore();
		}
		expect(capture.prompted()).toBeUndefined();
		expect(output.join("")).toContain('Warning: MCP server "broken" failed to connect:');
		expect(output.join("")).toContain("Error: MCP servers not ready: broken");
	}, 2_000);

	it("returns from interactive discovery around the startup window with slowstart pending", async () => {
		const { manager, elapsedMs } = await startServers();
		expect(elapsedMs).toBeLessThan(900);
		const status = await manager.waitForStartup(40);
		expect(status.pending).toContain("slowstart");
		expect(manager.getTools().map(tool => tool.name)).not.toContain("mcp__slowstart_marker");
	}, 3_000);

	it("waits through a timed-out handshake's reconnect before reporting readiness", async () => {
		using tempDir = TempDir.createSync("@omp-mcp-reconnect-readiness-");
		const manager = new MCPManager(tempDir.path());
		managers.push(manager);
		Bun.env.OMP_MCP_TIMEOUT_MS = "200";
		await manager.connectServers(
			{
				recover: {
					type: "stdio",
					command: process.execPath,
					args: [path.join(import.meta.dir, "fixtures", "delayed-tool-mcp.ts"), tempDir.join("first-launch")],
				},
			},
			{},
		);
		try {
			const status = await manager.waitForStartup(2_000);
			expect(status).toEqual({ connected: ["recover"], pending: [], failed: [] });
			expect(manager.getTools().map(tool => tool.name)).toContain("mcp__recover_late_tool");
		} finally {
			await manager.disconnectAll();
		}
	}, 3_000);

	it("lets the environment startup window override a shorter setting during discovery", async () => {
		Bun.env.OMP_MCP_STARTUP_TIMEOUT_MS = "1500";
		const manager = new MCPManager(import.meta.dir);
		managers.push(manager);
		const result = await manager.connectServers({ slowstart: server("slowstart", 600) }, {}, undefined, 50);
		expect(result.connectedServers).toEqual(["slowstart"]);
		expect(result.tools.map(tool => tool.name)).toEqual(["mcp__slowstart_marker"]);
	}, 2_500);

	it("honors environment precedence over the startup setting, including disabled timeout", () => {
		Bun.env.OMP_MCP_STARTUP_TIMEOUT_MS = "0";
		expect(resolveMCPStartupTimeoutMs(600)).toBe(0);
		Bun.env.OMP_MCP_STARTUP_TIMEOUT_MS = "bad";
		expect(resolveMCPStartupTimeoutMs(600)).toBe(600);
	}, 1_000);
});
