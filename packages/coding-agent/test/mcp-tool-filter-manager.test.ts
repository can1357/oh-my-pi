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
 *   entry — the server is not reported as silently healthy.
 * - A server with no filter is unaffected: all tools register.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { manyToolName } from "./fixtures/many-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const SERVER = "filtered";

function fixtureConfig(filters?: { enabledTools?: string[]; disabledTools?: string[] }): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH], ...filters };
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
});
