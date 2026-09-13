/**
 * A remote (`http`/`sse`) MCP server that was connected and then lost comes
 * back on its own schedule — a redeploy, a laptop waking. Without a schedule
 * on the client side, the manager's reconnect ladder is the only retry: once
 * it fails the server stays "not connected" until a tool call happens to hit
 * it, and its resource subscriptions are dead for as long as the client idles.
 *
 * Contracts defended here:
 * - a reconnect awaited by a caller (a tool call, `/mcp reconnect`) is still
 *   bounded by the ladder — the schedule never makes a tool call wait for it;
 * - a lost remote server is brought back with no tool call and no user action,
 *   however long it stays down, and the outage is reported once — every
 *   `failed` event repaints the /extensions dashboard and logs at error level;
 * - a server the user disconnected is not reconnected by the schedule;
 * - a server that never connected is not scheduled: a startup failure or a
 *   bad URL stays a one-shot failure;
 * - a reconnect that never replaced the live connection (a declined auth
 *   challenge) does not schedule one that would.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager, type MCPReconnectPolicy } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPHttpServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { type FlakyHttpMcpServer, startFlakyHttpMcpServer } from "./fixtures/flaky-http-mcp";

/** Short ladder, fast schedule: three attempts per reconnect, retries at 20/40/80/80… ms. */
const FAST: MCPReconnectPolicy = { ladderMs: [10, 10], retryBaseMs: 20, retryMaxMs: 80 };
/** Any armed timer fires within `retryMaxMs`; this much silence proves none was armed. */
const QUIET_MS = FAST.retryMaxMs * 4;
const GUARD_MS = 5_000;
const noop = () => {};
const noCtx = {} as Parameters<MCPTool["execute"]>[3];

async function until(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + GUARD_MS;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

describe("MCP lost remote server retry schedule", () => {
	let workDir: string;
	let manager: MCPManager | undefined;
	let flaky: FlakyHttpMcpServer | undefined;

	afterEach(async () => {
		await manager?.disconnectAll();
		flaky?.stop();
		manager = undefined;
		flaky = undefined;
		if (workDir) removeSyncWithRetries(workDir);
	});

	async function connected(policy: MCPReconnectPolicy) {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lost-remote-"));
		flaky = startFlakyHttpMcpServer();
		manager = new MCPManager(workDir, null, undefined, policy);
		const statuses: McpConnectionStatusEvent["type"][] = [];
		manager.addConnectionStatusListener(event => statuses.push(event.type));
		const config: MCPHttpServerConfig = { type: "http", url: flaky.url, timeout: GUARD_MS };
		await manager.connectServers({ flaky: config }, {});
		expect(manager.getConnectionStatus("flaky")).toBe("connected");
		return { manager, flaky, statuses, config };
	}

	it("a tool call on a lost server fails within the ladder instead of waiting for the schedule", async () => {
		// A schedule this slow can only help if the tool call waits for it.
		const { manager, flaky, statuses } = await connected({ ...FAST, retryBaseMs: 60_000, retryMaxMs: 60_000 });
		const ping = manager.getTools().find(tool => tool.mcpServerName === "flaky");
		if (!ping) throw new Error("ping tool not registered");

		flaky.setDown(true);
		await until(() => statuses.includes("failed"), "the reconnect ladder to fail");

		const started = Date.now();
		const result = await ping.execute("call-1", {}, noop, noCtx);
		expect(result.isError).toBe(true);
		expect(Date.now() - started).toBeLessThan(GUARD_MS / 2);
	});

	it("brings a lost server back on its own, however long it stays down, reporting the outage once", async () => {
		const { manager, flaky, statuses } = await connected(FAST);
		const initializesBefore = flaky.initializes;

		flaky.setDown(true);
		await until(() => statuses.includes("failed"), "the reconnect ladder to fail");
		const refusedByLadder = flaky.refusals;
		// Several scheduled attempts land while the server is still down.
		await until(() => flaky.refusals >= refusedByLadder + 3, "scheduled attempts to probe the server");
		expect(manager.getConnectionStatus("flaky")).not.toBe("connected");

		flaky.setDown(false);
		const failedAt = statuses.indexOf("failed");
		await until(() => statuses.indexOf("connected", failedAt) !== -1, "the scheduled reconnect to succeed");

		expect(manager.getConnectionStatus("flaky")).toBe("connected");
		expect(flaky.initializes).toBeGreaterThan(initializesBefore);
		expect(statuses.filter(status => status === "failed")).toHaveLength(1);

		// The session's tools follow the new connection.
		const ping = manager.getTools().find(tool => tool.mcpServerName === "flaky");
		if (!ping) throw new Error("ping tool not registered after reconnect");
		const result = await ping.execute("call-2", {}, noop, noCtx);
		expect(result.isError).toBeFalsy();
		expect(result.content[0]).toEqual({ type: "text", text: flaky.pong });
	});

	it("a disconnected server is not reconnected by the schedule when it comes back", async () => {
		const { manager, flaky, statuses } = await connected(FAST);

		flaky.setDown(true);
		await until(() => statuses.includes("failed"), "the reconnect ladder to fail");
		await manager.disconnectServer("flaky");
		const initializesAtDisconnect = flaky.initializes;

		flaky.setDown(false);
		// Negative contract: there is no event to wait for, so wait out the
		// longest delay the schedule can arm (see QUIET_MS). Fake timers cannot
		// drive a real Bun.serve + fetch round trip.
		await Bun.sleep(QUIET_MS);

		expect(flaky.initializes).toBe(initializesAtDisconnect);
		expect(manager.getConnectionStatus("flaky")).toBe("disconnected");
	});

	it("a declined auth challenge on a working server does not schedule a teardown", async () => {
		const { manager, flaky, statuses } = await connected(FAST);
		const initializesBefore = flaky.initializes;
		manager.setAuthHandler(async () => undefined);

		expect(await manager.reconnectServer("flaky", { authChallenge: { wwwAuthenticate: ["Bearer"] } })).toBeNull();
		expect(manager.getConnectionStatus("flaky")).toBe("connected");

		await Bun.sleep(QUIET_MS); // negative contract, see above

		expect(flaky.initializes).toBe(initializesBefore);
		expect(statuses.filter(status => status === "connected")).toHaveLength(1);
		expect(manager.getConnectionStatus("flaky")).toBe("connected");
	});

	it("does not schedule a server that never connected", async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lost-remote-"));
		flaky = startFlakyHttpMcpServer();
		flaky.setDown(true);
		manager = new MCPManager(workDir, null, undefined, FAST);
		const config: MCPHttpServerConfig = { type: "http", url: flaky.url, timeout: GUARD_MS };
		await manager.connectServers({ flaky: config }, {});
		expect(manager.getConnectionStatus("flaky")).toBe("disconnected");

		// The explicit paths that reach the ladder for a never-connected server.
		expect(await manager.reconnectServer("flaky")).toBeNull();
		expect(await manager.reconnectServer("flaky", { manual: true })).toBeNull();

		flaky.setDown(false);
		await Bun.sleep(QUIET_MS); // negative contract, see above

		expect(flaky.initializes).toBe(0);
		expect(manager.getConnectionStatus("flaky")).toBe("disconnected");
	});
});
