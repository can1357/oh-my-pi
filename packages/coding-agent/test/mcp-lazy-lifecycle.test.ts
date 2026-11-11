/**
 * `lifecycle: "lazy"` defers a server's process to its first tool call.
 *
 * The contract under test is the reason the option exists: a session that never
 * calls a lazy server must not pay for its process, while the server's tools
 * stay visible through the tool cache written by an earlier session.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPStdioServerConfig, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MANY_TOOL_COUNT, manyToolName } from "./fixtures/many-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const SERVER = "lazy";

function fixtureConfig(lifecycle: "eager" | "lazy"): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH], lifecycle };
}

/** Stand-in for the agent.db-backed cache: only `get` matters here. */
class StubToolCache {
	tools: MCPToolDefinition[] | null = null;
	async get(): Promise<MCPToolDefinition[] | null> {
		return this.tools;
	}
	async set(): Promise<void> {}
}

const cachedTools: MCPToolDefinition[] = Array.from({ length: MANY_TOOL_COUNT }, (_, index) => ({
	name: manyToolName(index),
	inputSchema: { type: "object" as const },
}));

const expectedToolNames = cachedTools.map(tool => `mcp__${SERVER}_${tool.name}`).sort();
// The fixture is a real subprocess, so its handshake has no event to await
// through the manager's API; polling the observable state is the only signal.

async function waitFor(predicate: () => boolean): Promise<boolean> {
	const deadline = Date.now() + 10_000;
	while (true) {
		if (predicate()) return true;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await Bun.sleep(Math.min(10, remaining));
	}
}

describe("MCP lazy lifecycle", () => {
	let workDir: string;
	let cache: StubToolCache;
	let manager: MCPManager;

	beforeEach(() => {
		delete Bun.env.OMP_MCP_STARTUP_TIMEOUT_MS;
		delete Bun.env.OMP_MCP_TIMEOUT_MS;
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lazy-"));
		cache = new StubToolCache();
		manager = new MCPManager(workDir, cache as unknown as MCPToolCache);
	});

	afterEach(async () => {
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	it("advertises cached tools without starting the process", async () => {
		cache.tools = cachedTools;

		await manager.connectServers({ [SERVER]: fixtureConfig("lazy") }, {});

		expect(
			manager
				.getTools()
				.map(tool => tool.name)
				.sort(),
		).toEqual(expectedToolNames);
		expect(manager.getConnectionStatus(SERVER)).toBe("disconnected");
		expect(manager.getConnectedServers()).toEqual([]);
	}, 20_000);

	it("starts the process on the first tool call", async () => {
		cache.tools = cachedTools;
		await manager.connectServers({ [SERVER]: fixtureConfig("lazy") }, {});
		const tool = manager.getTools().find(entry => entry.name === expectedToolNames[0]);
		if (!tool) throw new Error("cached tool was not registered");

		const ctx = { sessionManager: { getCwd: () => workDir } } as unknown as CustomToolContext;
		await tool.execute("call-1", {}, undefined, ctx, undefined);

		expect(await waitFor(() => manager.getConnectionStatus(SERVER) === "connected")).toBe(true);
		expect(manager.getConnectedServers()).toEqual([SERVER]);
	}, 20_000);

	it("connects eagerly when no cache entry exists", async () => {
		await manager.connectServers({ [SERVER]: fixtureConfig("lazy") }, {});

		expect(await waitFor(() => manager.getTools().some(tool => tool.mcpServerName === SERVER))).toBe(true);
		expect(manager.getConnectionStatus(SERVER)).toBe("connected");
	}, 20_000);

	it("keeps eager servers unchanged", async () => {
		cache.tools = cachedTools;

		await manager.connectServers({ [SERVER]: fixtureConfig("eager") }, {});

		expect(await waitFor(() => manager.getConnectionStatus(SERVER) === "connected")).toBe(true);
		expect(manager.getTools()).toHaveLength(MANY_TOOL_COUNT);
	}, 20_000);
});
