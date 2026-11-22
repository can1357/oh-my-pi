/**
 * MCP stdio units declare `survive: "exec"`: a daemon that re-execs itself in
 * place keeps the server processes, and a session that was attached finds them
 * again by itself. End to end: `MCPManager` → `HostLink` → a real daemon in a
 * private runtime dir → real fixture server processes, with the upgrade forced
 * the way a newer install's client forces it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { daemonClient, probeDaemon } from "@oh-my-pi/pi-coding-agent/daemon/client";
import {
	DAEMON_RESUME_LEASE_GRACE_ENV,
	type DaemonClient,
	type UnitSnapshot,
} from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { holdSharedMcp } from "@oh-my-pi/pi-coding-agent/mcp/host/access";
import { MCP_MODULE_KIND } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { disposeLocalMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { IsolatedDaemon, isAlive, waitFor } from "../fixtures/daemon-harness";
import { type LegacyServerState, STATE_TOOL } from "./reexec-legacy-server";
import { forceDaemonReexec } from "./reexec-support";

const MODERN_FIXTURE = path.join(import.meta.dir, "..", "fixtures", "modern-mcp.ts");
const LEGACY_FIXTURE = path.join(import.meta.dir, "reexec-legacy-server.ts");
const MODERN = "modern";
const LEGACY = "legacy";
const REEXEC_TEST_TIMEOUT_MS = 90_000;
const WAIT_MS = 20_000;
/**
 * Linger of the unleased modern unit: long enough to observe it running across the re-exec (the restored
 * endpoint re-arms it; the next call follows ~0.1s later locally), short enough to wait out.
 */
const IDLE_MS = 1_000;
/**
 * The daemon's reconnect grace, shortened from its 15s default so the resumed daemon's idle hold can be
 * waited out: still ample for the links to retake their leases (~0.1s after the resume locally).
 */
const RESUME_GRACE_MS = 1_000;

const noop = () => {};
const noCtx = {} as Parameters<MCPTool["execute"]>[3];

const CONFIGS: Record<string, MCPStdioServerConfig> = {
	[MODERN]: { type: "stdio", command: process.execPath, args: [MODERN_FIXTURE] },
	[LEGACY]: { type: "stdio", command: process.execPath, args: [LEGACY_FIXTURE] },
};

/** What the modern fixture's `whoami` reports. */
interface ModernServerState {
	pid: number;
	calls: number;
}

describe.skipIf(process.platform === "win32")("MCP across a daemon re-exec", () => {
	let harness: IsolatedDaemon;
	let shared: { release(): void };
	let manager: MCPManager;
	let callSeq = 0;
	let previousGrace: string | undefined;

	beforeEach(async () => {
		// Read by the daemon this test spawns and carried across its re-exec.
		previousGrace = process.env[DAEMON_RESUME_LEASE_GRACE_ENV];
		process.env[DAEMON_RESUME_LEASE_GRACE_ENV] = String(RESUME_GRACE_MS);
		harness = await IsolatedDaemon.create();
		shared = holdSharedMcp(true);
		manager = new MCPManager(harness.dir, undefined, IDLE_MS);
	});

	// Past the harness's 10s lock wait: a daemon stuck mid-exec is killed before the next test swaps
	// `OMP_DAEMON_DIR`, instead of a timed-out teardown restoring the env and removing the dir under it.
	afterEach(async () => {
		if (previousGrace === undefined) delete process.env[DAEMON_RESUME_LEASE_GRACE_ENV];
		else process.env[DAEMON_RESUME_LEASE_GRACE_ENV] = previousGrace;
		await manager.disconnectAll();
		shared.release();
		await disposeLocalMcpHost();
		await harness.dispose();
	}, 30_000);

	async function call<T>(server: string, toolName: string): Promise<T> {
		const tool = manager.getTools().find(tool => tool.mcpServerName === server && tool.mcpToolName === toolName);
		if (!tool) throw new Error(`${server} has no tool ${toolName}`);
		const result = await tool.execute(`call-${++callSeq}`, {}, noop, noCtx);
		const first = result.content[0];
		if (first?.type !== "text") throw new Error(`${toolName} returned no text`);
		if (result.details?.isError) throw new Error(`${toolName} failed: ${first.text}`);
		return JSON.parse(first.text) as T;
	}

	async function mcpUnits(client: DaemonClient): Promise<UnitSnapshot[]> {
		const { units } = await client.request({ op: "list", kind: MCP_MODULE_KIND });
		for (const unit of units) harness.track(...unit.pids);
		return units;
	}

	it(
		"keeps both server processes and their sessions, and the manager's links re-attach by themselves",
		async () => {
			const daemon = await daemonClient();
			const daemonPid = daemon.welcome.daemon.pid;
			const firstStartedAt = daemon.welcome.daemon.startedAt;
			harness.track(daemonPid);
			await manager.connectServers(CONFIGS, {});
			expect((await manager.waitForStartup(0)).connected.sort()).toEqual([LEGACY, MODERN]);

			const modernBefore = await call<ModernServerState>(MODERN, "whoami");
			harness.track(modernBefore.pid);
			const legacyBefore = await call<LegacyServerState>(LEGACY, STATE_TOOL);
			harness.track(legacyBefore.pid);
			expect(legacyBefore).toEqual({ pid: legacyBefore.pid, initializes: 1, calls: 1 });
			await waitFor(() => manager.getServerRuntime(LEGACY)?.pid === legacyBefore.pid, "the legacy pid", WAIT_MS);
			expect(manager.getServerRuntime(MODERN)).toMatchObject({ state: "running", pid: modernBefore.pid });
			const unitsBefore = await mcpUnits(daemon);
			expect(unitsBefore.map(unit => unit.pids).sort()).toEqual([[modernBefore.pid], [legacyBefore.pid]].sort());

			expect(await forceDaemonReexec()).toBe(true);

			let resumedAt = 0;

			const after = await waitFor(() => probeDaemon(), "the re-exec'd daemon to answer", WAIT_MS);
			try {
				expect(after.welcome.daemon.pid).toBe(daemonPid);
				// A new image answered, not the old one.
				expect(after.welcome.daemon.startedAt).not.toBe(firstStartedAt);
				resumedAt = after.welcome.daemon.startedAt;
				expect(isAlive(modernBefore.pid)).toBe(true);
				expect(isAlive(legacyBefore.pid)).toBe(true);

				// Nothing reconnects the manager: its links take their leases back on their own,
				// on the very units (and processes) they held before the exec.
				const unitsAfter = await waitFor(
					async () => {
						const units = await mcpUnits(after);
						return units.length === 2 && units.every(unit => unit.leases === 1) ? units : undefined;
					},
					"both mcp units leased again",
					WAIT_MS,
				);
				expect(
					unitsAfter.map(unit => ({ id: unit.id, pids: unit.pids })).sort((a, b) => a.id.localeCompare(b.id)),
				).toEqual(
					unitsBefore.map(unit => ({ id: unit.id, pids: unit.pids })).sort((a, b) => a.id.localeCompare(b.id)),
				);
			} finally {
				after.close();
			}

			// Same processes, counters continued; the handshake-era session was not initialized again.
			const lastModernCallAt = Date.now();
			expect(await call<ModernServerState>(MODERN, "whoami")).toMatchObject({
				pid: modernBefore.pid,
				calls: modernBefore.calls + 1,
			});
			expect(await call<LegacyServerState>(LEGACY, STATE_TOOL)).toEqual({
				pid: legacyBefore.pid,
				initializes: 1,
				calls: 2,
			});
			await waitFor(
				() =>
					manager.getServerRuntime(MODERN)?.pid === modernBefore.pid &&
					manager.getServerRuntime(LEGACY)?.pid === legacyBefore.pid,
				"both runtimes reported again after the re-attach",
				WAIT_MS,
			);

			await manager.disconnectAll();

			// The modern server stops once it went unused for the idle window, counted from its last request.
			await waitFor(() => !isAlive(modernBefore.pid), "modern server exit after the idle window", WAIT_MS);
			expect(Date.now() - lastModernCallAt).toBeGreaterThanOrEqual(IDLE_MS - 100);
			// The handshake-era server stops with its last lease, but a resumed daemon stops no unit
			// for idleness before its clients had the reconnect grace to come back.
			await waitFor(
				() => !isAlive(legacyBefore.pid),
				"handshake-era server exit",
				Math.max(0, resumedAt + RESUME_GRACE_MS - Date.now()) + 5_000,
			);
			expect(Date.now() - resumedAt).toBeGreaterThanOrEqual(RESUME_GRACE_MS);
		},
		REEXEC_TEST_TIMEOUT_MS,
	);
});
