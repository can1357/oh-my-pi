/**
 * End to end through the daemon `mcp` module: `MCPManager` → `HostLink` →
 * a real daemon in a private runtime dir → real fixture server processes. The
 * servers are units on the daemon board, one modern server serves sessions of
 * separate OS processes, and nothing outlives the sessions that used it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { daemonClient } from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { holdSharedMcp } from "@oh-my-pi/pi-coding-agent/mcp/host/access";
import { MCP_MODULE_KIND } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { disposeLocalMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { IsolatedDaemon, isAlive, waitFor } from "../fixtures/daemon-harness";
import { TOOL_NAME as LEGACY_TOOL, TOOL_RESULT as LEGACY_RESULT } from "../fixtures/instructions-mcp";

const MODERN_FIXTURE = path.join(import.meta.dir, "..", "fixtures", "modern-mcp.ts");
const LEGACY_FIXTURE = path.join(import.meta.dir, "..", "fixtures", "instructions-mcp.ts");
const SRC = path.join(import.meta.dir, "..", "..", "src");
const MODERN = "modern";
const LEGACY = "legacy";
const DAEMON_TEST_TIMEOUT_MS = 60_000;
const WAIT_MS = 15_000;
/** Linger of the unleased modern unit: long enough to observe it running, short enough to wait out. */
const IDLE_MS = 1_500;

const noop = () => {};
const noCtx = {} as Parameters<MCPTool["execute"]>[3];

const CONFIGS: Record<string, MCPStdioServerConfig> = {
	[MODERN]: { type: "stdio", command: process.execPath, args: [MODERN_FIXTURE] },
	[LEGACY]: { type: "stdio", command: process.execPath, args: [LEGACY_FIXTURE] },
};

/**
 * A session in an OS process of its own: attaches to the modern server through
 * the daemon, prints the pid `whoami` reported, and stays attached until its
 * stdin closes.
 */
const PEER_SCRIPT = `
import { holdSharedMcp } from ${JSON.stringify(path.join(SRC, "mcp", "host", "access.ts"))};
import { MCPManager } from ${JSON.stringify(path.join(SRC, "mcp", "manager.ts"))};

const [cwd, idleMs, configs] = JSON.parse(process.argv[2]);
const shared = holdSharedMcp(true);
const manager = new MCPManager(cwd, undefined, idleMs);
await manager.connectServers(configs, {});
const tool = manager.getTools().find(tool => tool.mcpToolName === "whoami");
if (!tool) throw new Error("whoami is not registered");
const result = await tool.execute("peer-call", {}, () => {}, {});
const { pid } = JSON.parse(result.content[0].text);
console.log(JSON.stringify({ pid, links: manager.getServerRuntime(${JSON.stringify(MODERN)})?.links }));
for await (const _ of Bun.stdin.stream()) {
	// Attached until the test closes stdin.
}
await manager.disconnectAll();
shared.release();
process.exit(0);
`;

describe.skipIf(process.platform === "win32")("MCP through the daemon", () => {
	let harness: IsolatedDaemon;
	let shared: { release(): void };
	let manager: MCPManager;
	let callSeq = 0;
	const children: Bun.Subprocess[] = [];

	beforeEach(async () => {
		harness = await IsolatedDaemon.create();
		shared = holdSharedMcp(true);
		manager = new MCPManager(harness.dir, undefined, IDLE_MS);
	});

	afterEach(async () => {
		for (const child of children.splice(0)) child.kill("SIGKILL");
		await manager.disconnectAll();
		shared.release();
		await disposeLocalMcpHost();
		await harness.dispose();
	});

	async function connect(): Promise<void> {
		harness.track((await daemonClient()).welcome.daemon.pid);
		await manager.connectServers(CONFIGS, {});
		expect((await manager.waitForStartup(0)).connected.sort()).toEqual([LEGACY, MODERN]);
	}

	async function call(server: string, toolName: string): Promise<string> {
		const tool = manager.getTools().find(tool => tool.mcpServerName === server && tool.mcpToolName === toolName);
		if (!tool) throw new Error(`${server} has no tool ${toolName}`);
		const result = await tool.execute(`call-${++callSeq}`, {}, noop, noCtx);
		const first = result.content[0];
		if (first?.type !== "text") throw new Error(`${toolName} returned no text`);
		expect(result.details?.isError).toBeFalsy();
		return first.text;
	}

	async function whoami(): Promise<number> {
		const { pid } = JSON.parse(await call(MODERN, "whoami")) as { pid: number };
		harness.track(pid);
		return pid;
	}

	/** Runs the handshake-era tool; returns the pid of the process the daemon started for this session. */
	async function legacyPid(): Promise<number> {
		expect(await call(LEGACY, LEGACY_TOOL)).toBe(LEGACY_RESULT);
		const pid = await waitFor(
			() => {
				const runtime = manager.getServerRuntime(LEGACY);
				return runtime?.state === "running" ? runtime.pid : undefined;
			},
			"handshake-era server running",
			WAIT_MS,
		);
		harness.track(pid);
		return pid;
	}

	async function mcpUnits(): Promise<UnitSnapshot[]> {
		const client = await daemonClient();
		const { units } = await client.request({ op: "list", kind: MCP_MODULE_KIND });
		for (const unit of units) harness.track(...unit.pids);
		return units;
	}

	it(
		"lists a manager's servers as leased mcp units carrying the server pids",
		async () => {
			await connect();
			const modernPid = await whoami();
			const oldPid = await legacyPid();

			const units = await waitFor(
				async () => {
					const listed = await mcpUnits();
					return listed.some(unit => unit.pids.includes(oldPid)) ? listed : undefined;
				},
				"both server pids on the board",
				WAIT_MS,
			);
			expect(units).toHaveLength(2);
			const modernUnit = units.find(unit => unit.label === `mcp ${MODERN}`);
			const legacyUnit = units.find(unit => unit.label === `mcp ${LEGACY}`);
			expect(modernUnit).toMatchObject({ kind: MCP_MODULE_KIND, state: "ready", leases: 1, pids: [modernPid] });
			expect(legacyUnit).toMatchObject({ kind: MCP_MODULE_KIND, state: "ready", leases: 1, pids: [oldPid] });
			expect(manager.getServerRuntime(MODERN)).toMatchObject({ state: "running", pid: modernPid, links: 1 });
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	it(
		"a session in another OS process is served by the same modern server process",
		async () => {
			await connect();
			const modernPid = await whoami();
			const script = path.join(harness.dir, "peer-session.ts");
			await Bun.write(script, PEER_SCRIPT);

			const child = Bun.spawn(
				[process.execPath, script, JSON.stringify([harness.dir, IDLE_MS, { [MODERN]: CONFIGS[MODERN] }])],
				// Explicit: the harness repointed the daemon dir after this process started.
				{ cwd: path.join(SRC, ".."), env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "inherit" },
			);
			children.push(child);
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			let printed = "";
			while (!printed.includes("\n")) {
				const { done, value } = await reader.read();
				if (done) break;
				printed += decoder.decode(value, { stream: true });
			}
			reader.releaseLock();
			const peer = JSON.parse(printed) as { pid: number; links: number };
			harness.track(peer.pid);

			expect(peer.pid).toBe(modernPid);
			// Both sessions are attached right now, and the server did not restart for the second.
			await waitFor(() => manager.getServerRuntime(MODERN)?.links === 2, "two links on the modern unit", WAIT_MS);
			expect(await whoami()).toBe(modernPid);

			child.stdin.end();
			expect(await child.exited).toBe(0);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	it(
		"after the manager disconnects the handshake-era process dies at once and the modern one after the idle window",
		async () => {
			await connect();
			const modernPid = await whoami();
			const oldPid = await legacyPid();
			expect(isAlive(modernPid)).toBe(true);
			expect(isAlive(oldPid)).toBe(true);

			await manager.disconnectAll();
			const disconnectedAt = Date.now();

			await waitFor(() => !isAlive(oldPid), "handshake-era server exit", IDLE_MS / 2);
			expect(isAlive(modernPid)).toBe(true);
			await waitFor(() => !isAlive(modernPid), "modern server exit after the idle window", WAIT_MS);
			expect(Date.now() - disconnectedAt).toBeGreaterThanOrEqual(IDLE_MS - 100);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);
});
