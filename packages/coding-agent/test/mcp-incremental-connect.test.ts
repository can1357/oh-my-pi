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
import { applyMcpToggleRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MANY_TOOL_COUNT, manyToolName } from "./fixtures/many-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");

const SERVER_A = "alpha";
const SERVER_B = "bravo";
const TOOL_A = `mcp__${SERVER_A}_${manyToolName(0)}`;
const TOOL_B = `mcp__${SERVER_B}_${manyToolName(0)}`;

function fixtureConfig(initializeDelayMs?: number): MCPStdioServerConfig {
	const args = [FIXTURE_PATH];
	if (initializeDelayMs !== undefined) args.push("--delay", String(initializeDelayMs));
	return { type: "stdio", command: process.execPath, args };
}

function waitUntil(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const start = Date.now();
	const tick = () => {
		if (predicate()) {
			resolve();
			return;
		}
		if (Date.now() - start > timeoutMs) {
			reject(new Error(`timed out waiting for ${label}`));
			return;
		}
		setTimeout(tick, 15);
	};
	tick();
	return promise;
}

const DELAYED_INITIALIZE_MS = 400;

describe("MCP incremental connectServers", () => {
	let workDir: string;
	let manager: MCPManager;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-incremental-"));
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	it("keeps server A tools after incrementally connecting server B", async () => {
		await manager.connectServers({ [SERVER_A]: fixtureConfig() }, {});
		await waitUntil(
			() =>
				manager.getConnectionStatus(SERVER_A) === "connected" &&
				manager.getTools().some(tool => tool.name === TOOL_A),
			"server A tools",
		);

		expect(manager.getConnectionStatus(SERVER_A)).toBe("connected");
		const afterA = manager.getTools();
		expect(afterA.map(t => t.name)).toContain(TOOL_A);
		expect(afterA).toHaveLength(MANY_TOOL_COUNT);
		expect(afterA.every(t => t.mcpServerName === SERVER_A)).toBe(true);

		await manager.connectServers({ [SERVER_B]: fixtureConfig(DELAYED_INITIALIZE_MS) }, {});
		await waitUntil(
			() =>
				manager.getConnectionStatus(SERVER_A) === "connected" &&
				manager.getConnectionStatus(SERVER_B) === "connected" &&
				manager.getTools().some(tool => tool.name === TOOL_A) &&
				manager.getTools().some(tool => tool.name === TOOL_B),
			"server A+B tools",
		);

		const tools = manager.getTools();
		expect(tools.map(t => t.name)).toContain(TOOL_A);
		expect(tools.map(t => t.name)).toContain(TOOL_B);
		expect(tools).toHaveLength(MANY_TOOL_COUNT * 2);
		expect(tools.filter(t => t.mcpServerName === SERVER_A)).toHaveLength(MANY_TOOL_COUNT);
		expect(tools.filter(t => t.mcpServerName === SERVER_B)).toHaveLength(MANY_TOOL_COUNT);
	}, 20_000);

	it("applyMcpToggleRuntime enable of B refreshes the A+B union", async () => {
		await manager.connectServers({ [SERVER_A]: fixtureConfig() }, {});
		await waitUntil(
			() =>
				manager.getConnectionStatus(SERVER_A) === "connected" &&
				manager.getTools().some(tool => tool.name === TOOL_A),
			"server A tools",
		);

		const refreshed: string[][] = [];
		const session = {
			refreshMCPTools: (tools: Array<{ name: string }>) => {
				refreshed.push(tools.map(tool => tool.name));
			},
		};
		// Match the SDK's live manager-to-session bridge so a background tool load
		// refreshes the session after connectServers' bounded startup window.
		manager.setOnToolsChanged(async tools => {
			await session.refreshMCPTools(tools);
		});

		await applyMcpToggleRuntime({
			name: SERVER_B,
			enabled: true,
			cwd: workDir,
			manager,
			session,
			loadConfigs: async () => ({
				configs: { [SERVER_B]: fixtureConfig(DELAYED_INITIALIZE_MS) },
				sources: {},
				exaApiKeys: [],
			}),
		});

		await waitUntil(() => {
			const names = manager.getTools().map(tool => tool.name);
			const latestRefresh = refreshed.at(-1) ?? [];
			return (
				manager.getConnectionStatus(SERVER_A) === "connected" &&
				manager.getConnectionStatus(SERVER_B) === "connected" &&
				names.includes(TOOL_A) &&
				names.includes(TOOL_B) &&
				names.length === MANY_TOOL_COUNT * 2 &&
				latestRefresh.includes(TOOL_A) &&
				latestRefresh.includes(TOOL_B) &&
				latestRefresh.length === MANY_TOOL_COUNT * 2
			);
		}, "server A+B session refresh");

		expect(manager.getConnectionStatus(SERVER_A)).toBe("connected");
		expect(manager.getConnectionStatus(SERVER_B)).toBe("connected");
		const names = manager.getTools().map(t => t.name);
		expect(names).toContain(TOOL_A);
		expect(names).toContain(TOOL_B);
		expect(manager.getTools()).toHaveLength(MANY_TOOL_COUNT * 2);
		expect(refreshed.at(-1)).toContain(TOOL_A);
		expect(refreshed.at(-1)).toContain(TOOL_B);
		expect(refreshed.at(-1)).toHaveLength(MANY_TOOL_COUNT * 2);
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
		await waitUntil(
			() => events.some(event => event.type === "connected" && event.name === SERVER_A),
			"server A connected",
		);

		expect(events.some(event => event.type === "connecting" && event.name === SERVER_A)).toBe(true);
		expect(events.some(event => event.type === "connected" && event.name === SERVER_A)).toBe(true);

		const connection = manager.getConnection(SERVER_A);
		expect(connection).toBeDefined();
		connection?.transport.onClose?.();
		await waitUntil(
			() => events.some(event => event.type === "reconnecting" && event.name === SERVER_A),
			"server A reconnecting",
		);

		expect(events.some(event => event.type === "reconnecting" && event.name === SERVER_A)).toBe(true);
		stop();
	}, 20_000);
});
