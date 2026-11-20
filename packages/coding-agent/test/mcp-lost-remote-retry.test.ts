/**
 * A remote (`http`/`sse`) MCP server that was connected and then lost comes
 * back on its own schedule — a redeploy, a laptop waking. The session keeps its
 * link to the MCP host through the outage, and the host reaches the server
 * again on the next request.
 *
 * Contracts defended here:
 * - a tool call on a lost server fails promptly with a diagnostic instead of
 *   waiting for the server to return;
 * - once the server is back, the next tool call reaches it with no reconnect
 *   command and no user action, on a new server session;
 * - a reconnect that never replaced the live connection (a declined auth
 *   challenge) leaves a working server connected and usable.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { disposeLocalMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPHttpServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { type FlakyHttpMcpServer, startFlakyHttpMcpServer } from "./fixtures/flaky-http-mcp";

const GUARD_MS = 5_000;
const noop = () => {};
const noCtx = {} as Parameters<MCPTool["execute"]>[3];

describe("MCP lost remote server", () => {
	let workDir: string;
	let manager: MCPManager | undefined;
	let flaky: FlakyHttpMcpServer | undefined;

	afterEach(async () => {
		await manager?.disconnectAll();
		flaky?.stop();
		manager = undefined;
		flaky = undefined;
		await disposeLocalMcpHost();
		if (workDir) removeSyncWithRetries(workDir);
	});

	async function connected() {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lost-remote-"));
		flaky = startFlakyHttpMcpServer();
		manager = new MCPManager(workDir);
		const statuses: McpConnectionStatusEvent["type"][] = [];
		manager.addConnectionStatusListener(event => statuses.push(event.type));
		const config: MCPHttpServerConfig = { type: "http", url: flaky.url, timeout: GUARD_MS };
		await manager.connectServers({ flaky: config }, {});
		// connectServers returns after a short non-blocking window; a loaded machine can leave the
		// server connected with `tools/list` still in flight. Settle startup before reading tools.
		expect((await manager.waitForStartup(0)).connected).toEqual(["flaky"]);
		const ping = manager.getTools().find(tool => tool.mcpServerName === "flaky");
		if (!ping) throw new Error("ping tool not registered");
		return { manager, flaky, statuses, ping };
	}

	it("fails a tool call on a lost server promptly, then reaches the returned server on the next call", async () => {
		const { flaky, ping } = await connected();
		const before = await ping.execute("call-1", {}, noop, noCtx);
		expect(before.content[0]).toEqual({ type: "text", text: flaky.pong });
		const initializesBefore = flaky.initializes;

		flaky.setDown(true);
		const started = Date.now();
		const lost = await ping.execute("call-2", {}, noop, noCtx);

		expect(lost.isError).toBe(true);
		expect(lost.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("HTTP 503") });
		expect(Date.now() - started).toBeLessThan(GUARD_MS / 2);

		flaky.setDown(false);
		const back = await ping.execute("call-3", {}, noop, noCtx);

		expect(back.isError).toBeFalsy();
		// The redeployed server is a new generation, reached through a new session.
		expect(back.content[0]).toEqual({ type: "text", text: flaky.pong });
		expect(back.content[0]).not.toEqual(before.content[0]);
		expect(flaky.initializes).toBeGreaterThan(initializesBefore);
	});

	it("a declined auth challenge on a working server leaves it connected and usable", async () => {
		const { manager, flaky, statuses, ping } = await connected();
		const initializesBefore = flaky.initializes;
		manager.setAuthHandler(async () => undefined);

		expect(await manager.reconnectServer("flaky", { authChallenge: { wwwAuthenticate: ["Bearer"] } })).toBeNull();

		expect(manager.getConnectionStatus("flaky")).toBe("connected");
		expect(statuses.filter(status => status === "connected")).toHaveLength(1);
		const result = await ping.execute("call-1", {}, noop, noCtx);
		expect(result.content[0]).toEqual({ type: "text", text: flaky.pong });
		// The server session was not torn down and opened again.
		expect(flaky.initializes).toBe(initializesBefore);
	});
});
