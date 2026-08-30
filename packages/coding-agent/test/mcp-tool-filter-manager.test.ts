import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { manyToolName } from "./fixtures/many-tools-mcp";
import { FIRST_TOOL, SECOND_TOOL } from "./fixtures/tool-list-change-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const CHANGE_FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "tool-list-change-mcp.ts");
const BUN_EXEC = process.execPath;

// Issue #6299: per-server `enabledTools`/`disabledTools` filter raw advertised
// tool names before they reach the model context, on EVERY registration path
// (initial connect, reconnect, refresh) so excluded tools can never be
// restored into the session. The fixture advertises `tool_aa`..`tool_bs`
// (45 tools): `tool_a*` matches indices 0-25, `tool_b*` indices 26-44.

function config(tools?: { enabledTools?: string[]; disabledTools?: string[] }) {
	return {
		type: "stdio" as const,
		command: BUN_EXEC,
		args: [FIXTURE_PATH],
		...tools,
	};
}

/** Tool names currently registered under a server, in `#tools` order. */
function registeredToolNames(manager: MCPManager): string[] {
	return manager.getTools().map(tool => tool.mcpToolName ?? "");
}

/**
 * `connectServers` returns after a 250ms startup window; a server slower than
 * that registers its (filtered) tools via a background continuation. Wait for
 * the expected registration instead of racing it.
 */
async function waitForRegistered(manager: MCPManager, expected: string[], timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const names = registeredToolNames(manager);
		if (names.length === expected.length) {
			expect(names).toEqual(expected);
			return;
		}
		await Bun.sleep(25);
	}
	expect(registeredToolNames(manager)).toEqual(expected);
}

describe("per-server MCP tool filtering", () => {
	let workDir: string;
	let manager: MCPManager;

	beforeEach(async () => {
		workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-tool-filter-"));
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		await manager.disconnectAll();
		await fs.rm(workDir, { recursive: true, force: true });
	});

	it("registers only allowlisted tools (literals and globs) on initial connect", async () => {
		const result = await manager.connectServers({ many: config({ enabledTools: [manyToolName(0), "tool_b*"] }) }, {});
		expect(result.errors.size).toBe(0);
		// `tool_b*` matches tool_ba..tool_bs (indices 26-44); tool_aa sorts first.
		await waitForRegistered(manager, [
			manyToolName(0),
			...Array.from({ length: 19 }, (_, i) => manyToolName(26 + i)),
		]);
	});

	it("registers all tools except denylisted ones (denylist subtracts from allow)", async () => {
		const result = await manager.connectServers(
			{
				many: config({
					enabledTools: ["tool_*"],
					disabledTools: ["tool_a*", manyToolName(44)],
				}),
			},
			{},
		);
		expect(result.errors.size).toBe(0);
		// All 45 minus tool_aa..tool_az (26) minus tool_bs (1) = 18.
		await waitForRegistered(
			manager,
			Array.from({ length: 18 }, (_, i) => manyToolName(26 + i)),
		);
	});

	it("keeps excluded tools out after a reconnect (tools/list_changed path)", async () => {
		await manager.connectServers({ many: config({ enabledTools: [manyToolName(0)] }) }, {});
		await waitForRegistered(manager, [manyToolName(0)]);

		// The fixture restarts the tool list identically; a reconnect must not
		// restore tools the allowlist excludes.
		await manager.reconnectServer("many");
		await waitForRegistered(manager, [manyToolName(0)]);
	});

	it("keeps excluded tools out after a refresh", async () => {
		await manager.connectServers({ many: config({ enabledTools: [manyToolName(0)] }) }, {});
		await waitForRegistered(manager, [manyToolName(0)]);

		await manager.refreshServerTools("many");
		await waitForRegistered(manager, [manyToolName(0)]);
	});

	it("clears previously-registered tools when a refresh empties the filtered set", async () => {
		// The fixture advertises [alpha, beta] on the first tools/list and only
		// [beta] afterwards, and fires tools/list_changed right after
		// initialize. With enabledTools ["alpha"], the initial connect
		// registers alpha; the refresh (auto-triggered by list_changed or our
		// explicit call below) then filters the shrunk set down to nothing, so
		// alpha must be cleared rather than left stale for the model.
		const changeConfig: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [CHANGE_FIXTURE_PATH],
			enabledTools: [FIRST_TOOL],
		};
		// The refresh path emits through #emitConnectionStatus, which reaches
		// both the connection-status listeners and the caller's onStatus bridge.
		const statusEvents: McpConnectionStatusEvent[] = [];
		const unsubscribe = manager.addConnectionStatusListener(event => statusEvents.push(event));
		try {
			await manager.connectServers({ change: changeConfig }, {});
			// Wait for the initial connect to register alpha before refreshing:
			// refreshServerTools no-ops while the connection is still pending.
			await waitForRegistered(manager, [FIRST_TOOL]);
			await manager.refreshServerTools("change");
			await waitForRegistered(manager, []);
			// The refresh that empties the filtered set must surface a per-server
			// failure (consistent with the initial-connect path), not a silent
			// empty refresh.
			expect(statusEvents.some(e => e.type === "failed" && e.serverName === "change")).toBe(true);
		} finally {
			unsubscribe();
		}
	});

	// Interactive status UI receives events only through the callback passed
	// to connectServers (sdk → eventBus → interactive-status). A server that
	// starts filter-empty (failed) and later recovers via a `tools/list`
	// refresh must emit `connected` to that SAME callback, or the UI keeps
	// the server in its failed list forever. Regression: the refresh path
	// emitted only to direct addConnectionStatusListener subscribers, so the
	// startup callback never learned about the recovery.
	it("routes a refresh recovery (failed → connected) into the caller's onStatus bridge", async () => {
		const events: McpConnectionStatusEvent[] = [];
		// The change fixture serves [alpha, beta] on the first tools/list and
		// only [beta] afterwards. enabledTools ["alpha"] connects fine, then
		// the fixture's shrink makes the refresh's filtered set empty → the
		// refresh surface emits `failed`.
		const changeConfig: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [CHANGE_FIXTURE_PATH],
			enabledTools: [FIRST_TOOL],
		};
		await manager.connectServers({ change: changeConfig }, {}, event => events.push(event));
		await waitForRegistered(manager, [FIRST_TOOL]);
		// The shrink refresh: filtered set [beta] ∩ allow {"alpha"} = ∅ → failed
		// must reach the caller's callback (pre-fix: listener-only).
		await manager.refreshServerTools("change");
		await waitForRegistered(manager, []);
		expect(events.some(e => e.type === "failed" && e.serverName === "change")).toBe(true);

		// Recovery on the same channel: swap the stored config to re-allow beta
		// (disconnect first — connectServers is incremental and keeps the live
		// connection when the server name is already connected), then let the
		// refresh register tools again → `connected` must reach the same
		// original callback.
		await manager.disconnectServer("change");
		await manager.connectServers({ change: { ...changeConfig, enabledTools: [SECOND_TOOL] } }, {});
		await manager.refreshServerTools("change");
		await waitForRegistered(manager, [SECOND_TOOL]);
		expect(events.some(e => e.type === "connected" && e.serverName === "change")).toBe(true);
	});

	it("reports a server whose filter excludes every tool without failing the batch", async () => {
		const events: McpConnectionStatusEvent[] = [];
		const result = await manager.connectServers(
			{ empty: config({ enabledTools: ["never_advertised"] }), many: config() },
			{},
			event => events.push(event),
		);
		// The filter-empty failure surfaces either synchronously in the errors
		// map (server resolved within the 250 ms startup window) or as a
		// background `failed` status event (server slower than the window).
		const deadline = Date.now() + 10_000;
		while (
			Date.now() < deadline &&
			!result.errors.has("empty") &&
			!events.some(e => e.type === "failed" && e.serverName === "empty")
		) {
			await Bun.sleep(25);
		}
		const failedEvent = events.find(
			(e): e is Extract<McpConnectionStatusEvent, { type: "failed" }> =>
				e.type === "failed" && e.serverName === "empty",
		);
		const message = result.errors.get("empty") ?? failedEvent?.error;
		expect(message).toMatch(/excludes all 45 advertised tools/);
		// The sibling server still connects and contributes its tools.
		await waitForRegistered(
			manager,
			Array.from({ length: 45 }, (_, i) => manyToolName(i)),
		);
	});
});
