/**
 * Per-server tool filtering end-to-end through `MCPManager.connectServers`
 * against the real 45-tool `many-tools-mcp` stdio fixture.
 *
 * Contracts defended here:
 * - `enabledTools`/`disabledTools` in a server config restrict which advertised
 *   tools are registered (name-minted `mcp__server_tool` session names), on the
 *   startup path.
 * - A filter that excludes every advertised tool leaves zero tools registered
 *   AND surfaces a per-server `failed` status event plus a `result.errors`
 *   entry — the server is not reported as silently healthy, and the status
 *   never flips back to `connected` while the filter still excludes everything.
 * - An empty cached tool list (a server that previously advertised zero tools)
 *   is NOT a filter failure: no filter configured, no failure surfaced.
 * - A server with no filter is unaffected: all tools register.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { manyToolName } from "./fixtures/many-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const SERVER = "filtered";

function fixtureConfig(filters?: { enabledTools?: string[]; disabledTools?: string[] }): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH], ...filters };
}

function stalledConfig(config: MCPStdioServerConfig): MCPStdioServerConfig {
	return { ...config, args: [FIXTURE_PATH, "--delay", "3000"] };
}

describe("MCP tool filtering through the manager", () => {
	let workDir: string;
	let manager: MCPManager;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-tool-filter-"));
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	it("allowlist registers only the matching subset", async () => {
		const result = await manager.connectServers(
			{ [SERVER]: fixtureConfig({ enabledTools: [manyToolName(0), "tool_b*"] }) },
			{},
		);
		expect(manager.getConnectionStatus(SERVER)).toBe("connected");
		const names = manager.getTools().map(t => t.name);
		expect(names).toContain(`mcp__${SERVER}_${manyToolName(0)}`);
		expect(names).toContain(`mcp__${SERVER}_${manyToolName(26)}`); // tool_ba
		expect(names).not.toContain(`mcp__${SERVER}_${manyToolName(1)}`); // tool_ab
		expect(names).toHaveLength(1 + 19); // aa + ba..bt
		expect(result.errors.has(SERVER)).toBe(false);
		expect(result.connectedServers).toContain(SERVER);
	}, 20_000);

	it("denylist removes only the denied tools", async () => {
		await manager.connectServers({ [SERVER]: fixtureConfig({ disabledTools: [manyToolName(0)] }) }, {});
		expect(manager.getConnectionStatus(SERVER)).toBe("connected");
		const names = manager.getTools().map(t => t.name);
		expect(names).not.toContain(`mcp__${SERVER}_${manyToolName(0)}`);
		expect(names).toContain(`mcp__${SERVER}_${manyToolName(1)}`);
	}, 20_000);

	it("without filters all advertised tools register", async () => {
		await manager.connectServers({ [SERVER]: fixtureConfig() }, {});
		expect(manager.getTools()).toHaveLength(45);
	}, 20_000);

	it("a filter excluding every tool yields zero tools plus failed status and error", async () => {
		const events: string[] = [];
		const stop = manager.addConnectionStatusListener(event => {
			if (event.type === "failed" && event.serverName === SERVER) events.push(event.error);
		});

		const result = await manager.connectServers(
			{ [SERVER]: fixtureConfig({ enabledTools: ["zzz_nonexistent"] }) },
			{},
		);

		stop();
		expect(manager.getTools()).toHaveLength(0);
		const message = result.errors.get(SERVER);
		expect(message).toBeDefined();
		expect(message).toContain("tool filter excludes all");
		expect(events[0]).toContain("tool filter excludes all");
	}, 20_000);

	it("an empty cached list never reports a filter failure (no filter configured)", async () => {
		// Regression: the deferred-cache branch used to classify an empty
		// cached list as "filter excludes all 0 tools" even with no filter.
		const config = fixtureConfig();
		const stalled = stalledConfig(config);
		const storage = await AgentStorage.open(path.join(workDir, "agent.db"));
		const cache = new MCPToolCache(storage);
		// Prime with the exact config object the manager will hash: the cache
		// entry simulates the previous session's tools/list under this config.
		await cache.set(SERVER, stalled, []);
		manager = new MCPManager(workDir, cache);
		const events: string[] = [];
		const stop = manager.addConnectionStatusListener(event => {
			if (event.type === "failed" && event.serverName === SERVER) events.push(event.error);
		});
		try {
			await manager.connectServers({ [SERVER]: stalled }, {});
			expect(manager.getTools()).toHaveLength(0);
			expect(events).toEqual([]);
		} finally {
			stop();
		}
	}, 20_000);

	it("a filter-empty failure is never followed by a connected event", async () => {
		// Regression: after the deferred branch reported the failure, the
		// background continuation used to emit `connected` for the same
		// still-empty server, flipping the status back to healthy.
		const config = fixtureConfig({ enabledTools: ["zzz_nonexistent"] });
		const stalled = stalledConfig(config);
		const storage = await AgentStorage.open(path.join(workDir, "agent.db"));
		const cache = new MCPToolCache(storage);
		// Prime with the exact config object the manager will hash: the cache
		// entry simulates the previous session's tools/list under this config.
		await cache.set(SERVER, stalled, [{ name: "tool_aa", inputSchema: { type: "object" } }]);
		manager = new MCPManager(workDir, cache);
		const events: string[] = [];
		const stop = manager.addConnectionStatusListener(event => {
			if (
				event.type !== "connecting" &&
				event.serverName === SERVER &&
				(event.type === "failed" || event.type === "connected")
			) {
				events.push(event.type);
			}
		});
		try {
			await manager.connectServers({ [SERVER]: stalled }, {});
			// The flip arrived with the background fulfillment (after the
			// stalled initialize): wait past the 3 s fixture delay, then poll
			// briefly so the regression window covers the real flip arrival.
			await Bun.sleep(3200);
			for (let i = 0; i < 8 && !events.includes("connected"); i++) {
				await Bun.sleep(100);
			}
			expect(events[0]).toBe("failed");
			expect(events).not.toContain("connected");
		} finally {
			stop();
		}
	}, 20_000);

	it("a reconnect keeps the server failed while the filter still excludes everything", async () => {
		// Regression: a transport restart used to flip a filter-empty server
		// back to `connected` — #doReconnect emitted connected unconditionally
		// even though the filtered registration contributed zero tools.
		const config = fixtureConfig({ enabledTools: ["zzz_nonexistent"] });
		await manager.connectServers({ [SERVER]: config }, {});
		expect(manager.getConnectionStatus(SERVER)).toBe("connected");

		const events: string[] = [];
		const stop = manager.addConnectionStatusListener(event => {
			if (event.type !== "connecting" && event.serverName === SERVER) {
				events.push(event.type);
			}
		});
		try {
			// Simulate a transport restart: reconnect while the filter (still)
			// matches nothing.
			await manager.reconnectServer(SERVER);
			// The reconnected transport is healthy and KEPT (resources/prompts
			// stay available), the status stays failed, and `connected` never
			// appears while the filter still excludes everything.
			await Bun.sleep(400);
			expect(manager.getTools()).toHaveLength(0);
			expect(events).not.toContain("connected");
			expect(events).toContain("failed");
			expect(manager.getConnectionStatus(SERVER)).toBe("connected");
			expect(manager.getConnection(SERVER)).toBeDefined();
		} finally {
			stop();
		}
	}, 30_000);
	it("an incremental connectServers preserves the standing filter-empty failure", async () => {
		// Regression: the already-connected fast path reported every connected
		// server as success, so a second connectServers pass for the same
		// server flipped a standing filter-empty failure to success.
		await manager.connectServers({ [SERVER]: fixtureConfig({ enabledTools: ["zzz_nonexistent"] }) }, {});
		expect(manager.getFilterEmptyToolCount(SERVER)).toBe(45);
		expect(manager.getTools()).toHaveLength(0);

		const result = await manager.connectServers(
			{ [SERVER]: fixtureConfig({ enabledTools: ["zzz_nonexistent"] }) },
			{},
		);
		expect(result.errors.get(SERVER)).toContain("tool filter excludes all");
		expect(result.connectedServers).not.toContain(SERVER);
		expect(manager.getFilterEmptyToolCount(SERVER)).toBe(45);
	}, 20_000);

	it("a healthy server re-passed through connectServers stays in connectedServers", async () => {
		await manager.connectServers({ [SERVER]: fixtureConfig({ enabledTools: ["tool_a*"] }) }, {});
		expect(manager.getTools().length).toBeGreaterThan(0);
		const result = await manager.connectServers({ [SERVER]: fixtureConfig({ enabledTools: ["tool_a*"] }) }, {});
		expect(result.errors.has(SERVER)).toBe(false);
		expect(result.connectedServers).toContain(SERVER);
	}, 20_000);
});
