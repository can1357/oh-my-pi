/**
 * End to end through the in-process MCP host: `MCPManager` → `HostLink` →
 * `LocalMcpHost` → real fixture server processes. What sessions of one process
 * share (a modern server, a cached catalog) and what each keeps to itself (a
 * handshake-era server), plus the idle stop and MRTR across the whole stack.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { disposeLocalMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { isAlive, waitFor } from "../fixtures/daemon-harness";
import { TOOL_NAME as LEGACY_TOOL, TOOL_RESULT as LEGACY_RESULT } from "../fixtures/instructions-mcp";
import { LOG_ENV } from "../fixtures/modern-mcp";

const MODERN_FIXTURE = path.join(import.meta.dir, "..", "fixtures", "modern-mcp.ts");
const LEGACY_FIXTURE = path.join(import.meta.dir, "..", "fixtures", "instructions-mcp.ts");
const MODERN = "modern";
const LEGACY = "legacy";
const TEST_TIMEOUT_MS = 30_000;
const IDLE_MS = 300;

const noop = () => {};
const noCtx = {} as Parameters<MCPTool["execute"]>[3];

interface LogLine {
	pid: number;
	method: string;
}

describe("MCP through the in-process host", () => {
	let cwd = "";
	let logFile = "";
	let callSeq = 0;
	const managers: MCPManager[] = [];
	const pids = new Set<number>();

	beforeEach(async () => {
		cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-local-")));
		logFile = path.join(cwd, "requests.jsonl");
	});

	afterEach(async () => {
		for (const manager of managers.splice(0)) await manager.disconnectAll();
		await disposeLocalMcpHost();
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already exited.
			}
		}
		pids.clear();
		await removeWithRetries(cwd);
	});

	function modernConfig(): MCPStdioServerConfig {
		return { type: "stdio", command: process.execPath, args: [MODERN_FIXTURE], env: { [LOG_ENV]: logFile } };
	}

	function legacyConfig(): MCPStdioServerConfig {
		return { type: "stdio", command: process.execPath, args: [LEGACY_FIXTURE] };
	}

	async function connected(configs: Record<string, MCPStdioServerConfig>, idleMs?: number): Promise<MCPManager> {
		const manager = new MCPManager(cwd, undefined, idleMs);
		managers.push(manager);
		await manager.connectServers(configs, {});
		expect((await manager.waitForStartup(0)).connected.sort()).toEqual(Object.keys(configs).sort());
		return manager;
	}

	async function call(manager: MCPManager, server: string, toolName: string): Promise<string> {
		const tool = manager.getTools().find(tool => tool.mcpServerName === server && tool.mcpToolName === toolName);
		if (!tool) throw new Error(`${server} has no tool ${toolName}`);
		const result = await tool.execute(`call-${++callSeq}`, {}, noop, noCtx);
		const first = result.content[0];
		if (first?.type !== "text") throw new Error(`${toolName} returned no text`);
		expect(result.details?.isError).toBeFalsy();
		return first.text;
	}

	async function whoami(manager: MCPManager): Promise<number> {
		const { pid } = JSON.parse(await call(manager, MODERN, "whoami")) as { pid: number };
		pids.add(pid);
		return pid;
	}

	/** Pid of the running upstream `manager` is attached to, once the host reported it. */
	async function runningPid(manager: MCPManager, server: string): Promise<number> {
		const pid = await waitFor(() => {
			const runtime = manager.getServerRuntime(server);
			return runtime?.state === "running" ? runtime.pid : undefined;
		}, `${server} running`);
		pids.add(pid);
		return pid;
	}

	async function requestLog(): Promise<LogLine[]> {
		const text = await fs.readFile(logFile, "utf8");
		const lines = text
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => JSON.parse(line) as LogLine);
		for (const line of lines) pids.add(line.pid);
		return lines;
	}

	it(
		"two managers on one modern stdio config share a single server process",
		async () => {
			const first = await connected({ [MODERN]: modernConfig() });
			const second = await connected({ [MODERN]: modernConfig() });

			for (const manager of [first, second]) {
				expect(manager.getTools().map(tool => tool.mcpToolName)).toContain("whoami");
			}
			const firstPid = await whoami(first);
			expect(await whoami(second)).toBe(firstPid);

			await waitFor(
				() => first.getServerRuntime(MODERN)?.links === 2 && second.getServerRuntime(MODERN)?.links === 2,
				"both links counted",
			);
			expect(first.getServerRuntime(MODERN)).toMatchObject({ state: "running", pid: firstPid, links: 2 });
			expect(second.getServerRuntime(MODERN)).toMatchObject({ state: "running", pid: firstPid, links: 2 });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a handshake-era server runs once per calling manager and not at all for one that only lists the cached catalog",
		async () => {
			const first = await connected({ [LEGACY]: legacyConfig() });
			expect(await call(first, LEGACY, LEGACY_TOOL)).toBe(LEGACY_RESULT);
			const firstPid = await runningPid(first, LEGACY);

			const second = await connected({ [LEGACY]: legacyConfig() });
			const lister = await connected({ [LEGACY]: legacyConfig() });
			for (const manager of [second, lister]) {
				expect(manager.getTools().map(tool => tool.mcpToolName)).toEqual([LEGACY_TOOL]);
				expect(manager.getServerRuntime(LEGACY)?.state).toBe("idle");
				expect(manager.getServerRuntime(LEGACY)?.pid).toBeUndefined();
			}

			expect(await call(second, LEGACY, LEGACY_TOOL)).toBe(LEGACY_RESULT);
			const secondPid = await runningPid(second, LEGACY);

			expect(secondPid).not.toBe(firstPid);
			expect(isAlive(firstPid)).toBe(true);
			expect(isAlive(secondPid)).toBe(true);
			expect(first.getServerRuntime(LEGACY)).toMatchObject({ state: "running", pid: firstPid });
			expect(lister.getServerRuntime(LEGACY)?.state).toBe("idle");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a second manager's connect is served from the catalog store without another tools/list",
		async () => {
			await connected({ [MODERN]: modernConfig() });
			const before = (await requestLog()).filter(line => line.method === "tools/list");
			expect(before).toHaveLength(1);

			const second = await connected({ [MODERN]: modernConfig() });

			expect(second.getTools().map(tool => tool.mcpToolName)).toContain("whoami");
			expect((await requestLog()).filter(line => line.method === "tools/list")).toEqual(before);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"an unused modern server stops after the idle window and the next call starts a new process",
		async () => {
			const manager = await connected({ [MODERN]: modernConfig() }, IDLE_MS);
			const firstPid = await whoami(manager);

			await waitFor(() => manager.getServerRuntime(MODERN)?.state === "idle", "idle stop");
			await waitFor(() => !isAlive(firstPid), "idle server exit");
			expect(manager.getServerRuntime(MODERN)?.pid).toBeUndefined();

			const secondPid = await whoami(manager);
			expect(secondPid).not.toBe(firstPid);
			expect(isAlive(secondPid)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"answers a modern server's roots/list input request with the manager's cwd",
		async () => {
			const manager = await connected({ [MODERN]: modernConfig() });

			const answer = JSON.parse(await call(manager, MODERN, "needs_roots")) as {
				roots: Array<{ uri: string }> | null;
				state: string | null;
			};

			expect(answer.roots?.map(root => root.uri)).toEqual([pathToFileURL(cwd).href]);
			expect(answer.state).toBe("fixture-state");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"disconnecting every manager leaves no server process behind",
		async () => {
			const first = await connected({ [MODERN]: modernConfig(), [LEGACY]: legacyConfig() });
			const second = await connected({ [MODERN]: modernConfig(), [LEGACY]: legacyConfig() });
			const started = [await whoami(first)];
			for (const manager of [first, second]) {
				await call(manager, LEGACY, LEGACY_TOOL);
				started.push(await runningPid(manager, LEGACY));
			}
			expect(new Set(started).size).toBe(3);
			// The era probe ran in a process of its own: it must be gone too.
			for (const line of await requestLog()) started.push(line.pid);
			expect(started.slice(0, 3).every(isAlive)).toBe(true);

			await first.disconnectAll();
			await second.disconnectAll();

			await waitFor(() => started.every(pid => !isAlive(pid)), "every fixture process to exit", 5_000);
		},
		TEST_TIMEOUT_MS,
	);
});
