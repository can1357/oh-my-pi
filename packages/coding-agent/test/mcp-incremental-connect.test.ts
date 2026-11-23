/**
 * Incremental `connectServers` must keep tools for already-owned connections.
 *
 * `/mcp enable` and `/extensions` enable one server by calling
 * `connectServers({ [name]: config })` while others are already live. The
 * startup race used to assign `this.#tools = allTools` from only this call's
 * tasks, dropping every other server's tools even though those connections
 * stayed open.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
	applyMcpToggleRuntime,
	type MCPToggleSession,
} from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MANY_TOOL_COUNT, manyToolName } from "./fixtures/many-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");

const SERVER_A = "alpha";
const SERVER_B = "bravo";

function fixtureConfig(delay = 0): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH, "--delay", String(delay)] };
}

type ToolSnapshot = Array<{ name: string; mcpServerName: string }>;

function expectedToolSnapshot(servers: string[]): ToolSnapshot {
	return servers
		.flatMap(server =>
			Array.from({ length: MANY_TOOL_COUNT }, (_, index) => ({
				name: `mcp__${server}_${manyToolName(index)}`,
				mcpServerName: server,
			})),
		)
		.sort((left, right) => left.name.localeCompare(right.name));
}

function snapshotTools(tools: Array<{ name: string; mcpServerName?: string }>): ToolSnapshot {
	return tools
		.map(tool => ({ name: tool.name, mcpServerName: tool.mcpServerName ?? "" }))
		.sort((left, right) => left.name.localeCompare(right.name));
}

// These subprocess fixtures use a separate real clock for delayed initialization.
async function waitFor(predicate: () => boolean): Promise<boolean> {
	const deadline = Date.now() + 10_000;
	while (true) {
		if (predicate()) return true;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await Bun.sleep(Math.min(10, remaining));
	}
}

async function waitForTools(manager: MCPManager, servers: string[]): Promise<void> {
	await waitFor(() => servers.every(server => manager.getTools().some(tool => tool.mcpServerName === server)));
}

describe("MCP incremental connectServers", () => {
	let workDir: string;
	let manager: MCPManager;
	let originalStartupTimeout: string | undefined;
	let originalRequestTimeout: string | undefined;

	beforeEach(() => {
		originalStartupTimeout = Bun.env.OMP_MCP_STARTUP_TIMEOUT_MS;
		delete Bun.env.OMP_MCP_STARTUP_TIMEOUT_MS;
		originalRequestTimeout = Bun.env.OMP_MCP_TIMEOUT_MS;
		delete Bun.env.OMP_MCP_TIMEOUT_MS;
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-incremental-"));
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		try {
			await manager.disconnectAll();
			removeSyncWithRetries(workDir);
		} finally {
			if (originalStartupTimeout === undefined) delete Bun.env.OMP_MCP_STARTUP_TIMEOUT_MS;
			else Bun.env.OMP_MCP_STARTUP_TIMEOUT_MS = originalStartupTimeout;
			if (originalRequestTimeout === undefined) delete Bun.env.OMP_MCP_TIMEOUT_MS;
			else Bun.env.OMP_MCP_TIMEOUT_MS = originalRequestTimeout;
		}
	});

	it("keeps server A tools after incrementally connecting server B", async () => {
		await manager.connectServers({ [SERVER_A]: fixtureConfig() }, {});
		await waitForTools(manager, [SERVER_A]);
		expect(manager.getConnectionStatus(SERVER_A)).toBe("connected");
		expect(snapshotTools(manager.getTools())).toEqual(expectedToolSnapshot([SERVER_A]));

		await manager.connectServers({ [SERVER_B]: fixtureConfig(400) }, {});
		await waitForTools(manager, [SERVER_A, SERVER_B]);
		expect(manager.getConnectionStatus(SERVER_A)).toBe("connected");
		expect(manager.getConnectionStatus(SERVER_B)).toBe("connected");
		expect(snapshotTools(manager.getTools())).toEqual(expectedToolSnapshot([SERVER_A, SERVER_B]));
	}, 20_000);

	it("returns the full union and only newly connected servers for an in-window incremental connect", async () => {
		await manager.connectServers({ [SERVER_A]: fixtureConfig() }, {}, undefined, 0);
		const result = await manager.connectServers({ [SERVER_B]: fixtureConfig() }, {}, undefined, 0);

		expect(snapshotTools(result.tools)).toEqual(expectedToolSnapshot([SERVER_A, SERVER_B]));
		expect(result.connectedServers).toEqual([SERVER_B]);
	}, 20_000);

	it("applyMcpToggleRuntime enable of B refreshes the A+B union", async () => {
		await manager.connectServers({ [SERVER_A]: fixtureConfig() }, {}, undefined, 0);
		await waitForTools(manager, [SERVER_A]);
		const expectedA = expectedToolSnapshot([SERVER_A]);
		const expectedAB = expectedToolSnapshot([SERVER_A, SERVER_B]);
		expect(snapshotTools(manager.getTools())).toEqual(expectedA);

		const refreshed: ToolSnapshot[] = [];
		const session: MCPToggleSession = {
			refreshMCPTools: next => {
				refreshed.push(snapshotTools(next));
			},
		};
		manager.setOnToolsChanged(async tools => session.refreshMCPTools(tools));
		await applyMcpToggleRuntime({
			name: SERVER_B,
			enabled: true,
			cwd: workDir,
			manager,
			session,
			loadConfigs: async () => ({
				configs: { [SERVER_B]: fixtureConfig(400) },
				sources: {},
				exaApiKeys: [],
			}),
		});

		// The toggle's direct refresh must not lose A while delayed B is still starting.
		expect(refreshed).toEqual([expectedA]);
		await waitFor(() => manager.getTools().some(tool => tool.mcpServerName === SERVER_B));

		expect(manager.getConnectionStatus(SERVER_A)).toBe("connected");
		expect(manager.getConnectionStatus(SERVER_B)).toBe("connected");
		expect(snapshotTools(manager.getTools())).toEqual(expectedAB);
		expect(refreshed.slice(1).map(snapshot => snapshot.filter(tool => tool.mcpServerName === SERVER_A))).toEqual(
			refreshed.slice(1).map(() => expectedA.filter(tool => tool.mcpServerName === SERVER_A)),
		);
		expect(refreshed.at(-1)).toEqual(expectedAB);
	}, 20_000);

	it("notifies connection-status listeners on connect and transport loss", async () => {
		const events: Array<{ type: string; name?: string }> = [];
		const stop = manager.addConnectionStatusListener(event => {
			events.push({
				type: event.type,
				name: event.type === "connecting" ? event.serverNames[0] : event.serverName,
			});
		});
		await manager.connectServers({ [SERVER_A]: fixtureConfig() }, {});
		await waitFor(() => events.some(event => event.type === "connected" && event.name === SERVER_A));
		expect(events.some(event => event.type === "connecting" && event.name === SERVER_A)).toBe(true);
		expect(events.some(event => event.type === "connected" && event.name === SERVER_A)).toBe(true);

		const connection = manager.getConnection(SERVER_A);
		expect(connection).toBeDefined();
		connection?.transport.onClose?.();
		await waitFor(() => events.some(event => event.type === "reconnecting" && event.name === SERVER_A));
		expect(events.some(event => event.type === "reconnecting" && event.name === SERVER_A)).toBe(true);
		stop();
	}, 20_000);
});
