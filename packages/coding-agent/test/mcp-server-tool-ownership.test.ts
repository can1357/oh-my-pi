/**
 * Regression test: MCP tool ownership must be tracked via `mcpServerName`,
 * not a `mcp__${serverName}_` tool-name prefix.
 *
 * Tool names are sanitized (server "atlassian:atlassian" mints
 * `mcp__atlassian_atlassian_*`), which breaks prefix matching two ways:
 *
 * 1. Collision: server "atlassian"'s prefix `mcp__atlassian_` also matches
 *    every `mcp__atlassian_atlassian_*` tool, so each reconnect/refresh of
 *    "atlassian" evicted the sibling server's tools and fired
 *    `onToolsChanged` with them missing — the session then steered paired
 *    unmount/mount notices into the conversation on every transport flap.
 * 2. Never-match: the raw prefix `mcp__atlassian:atlassian_` matches no
 *    sanitized tool name, so disconnecting "atlassian:atlassian" left its
 *    tools registered (and callable through a dead connection) and never
 *    notified consumers.
 *
 * Both server names here serve the identical fixture toolset, mirroring the
 * real-world duplicate-config shape (`<name>` plus imported `<source>:<name>`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MANY_TOOL_COUNT, manyToolName } from "./fixtures/many-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");

const SHORT_SERVER = "atlassian";
const COLON_SERVER = "atlassian:atlassian";
/** Sanitized names minted by `createMCPToolName` for the first fixture tool. */
const SHORT_TOOL = `mcp__atlassian_${manyToolName(0)}`;
const COLON_TOOL = `mcp__atlassian_atlassian_${manyToolName(0)}`;

function fixtureConfig(): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] };
}

describe("MCP tool ownership with prefix-colliding server names", () => {
	let workDir: string;
	let manager: MCPManager;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-ownership-"));
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	it("refreshing one server keeps the sibling server's tools registered", async () => {
		await manager.connectServers({ [SHORT_SERVER]: fixtureConfig(), [COLON_SERVER]: fixtureConfig() }, {});
		const names = () => manager.getTools().map(t => t.name);
		expect(names()).toContain(SHORT_TOOL);
		expect(names()).toContain(COLON_TOOL);
		expect(names()).toHaveLength(MANY_TOOL_COUNT * 2);

		const payloads: string[][] = [];
		manager.setOnToolsChanged(tools => {
			payloads.push(tools.map(t => t.name));
		});

		// Same code path a reconnect takes: replace the named server's tools.
		await manager.refreshServerTools(SHORT_SERVER);

		expect(names()).toHaveLength(MANY_TOOL_COUNT * 2);
		expect(names()).toContain(COLON_TOOL);
		// No emitted tool list may ever lose the sibling's tools — that delta is
		// what the session surfaces to the model as unmount/mount churn.
		expect(payloads.length).toBeGreaterThan(0);
		for (const payload of payloads) {
			expect(payload).toContain(COLON_TOOL);
			expect(payload).toHaveLength(MANY_TOOL_COUNT * 2);
		}
	}, 20_000);

	it("disconnecting a server with sanitized name characters removes exactly its tools", async () => {
		await manager.connectServers({ [SHORT_SERVER]: fixtureConfig(), [COLON_SERVER]: fixtureConfig() }, {});
		const payloads: string[][] = [];
		manager.setOnToolsChanged(tools => {
			payloads.push(tools.map(t => t.name));
		});

		await manager.disconnectServer(COLON_SERVER);

		const remaining = manager.getTools();
		expect(remaining.map(t => t.name)).toContain(SHORT_TOOL);
		expect(remaining).toHaveLength(MANY_TOOL_COUNT);
		expect(remaining.every(t => t.mcpServerName === SHORT_SERVER)).toBe(true);
		// Consumers must be told the tools are gone (previously: no event, and
		// the colon-named server's tools lingered as callable zombies).
		expect(payloads.at(-1)?.some(name => name === COLON_TOOL)).toBe(false);
		expect(payloads.at(-1)).toHaveLength(MANY_TOOL_COUNT);
	}, 20_000);
});
