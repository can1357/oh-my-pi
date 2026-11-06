/**
 * Regression test for issue #1592: an MCP stdio server that exits immediately
 * after completing initialize + tools/list must not trigger an unbounded
 * respawn loop.
 *
 * The reporter's agent forked 66 487 PHP child processes in ~7 minutes
 * (~158 spawns/sec) before macOS force-rebooted. The crashing fixture below
 * models that pathology: each spawn answers the handshake and exits cleanly,
 * which fires `transport.onClose` → `reconnectServer` with no rate limiter
 * in the unpatched build.
 *
 * The contract this test defends: per-server crash bursts are capped so that
 * even a fast-crashing stdio server stays well below the OS process budget.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import "@oh-my-pi/pi-coding-agent/discovery";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager, type MCPReconnectPolicy } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { DeferredMCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPStdioServerConfig, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getConfigRootDir, removeSyncWithRetries, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "crash-after-init-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCP reconnect storm (issue #1592)", () => {
	let workDir: string;
	let spawnLog: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-storm-"));
		spawnLog = path.join(workDir, "spawns.log");
		fs.writeFileSync(spawnLog, "");
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	function countSpawns(): number {
		const text = fs.readFileSync(spawnLog, "utf8");
		return text.split("\n").filter(line => line.trim().length > 0).length;
	}

	it("stops respawning after a burst of immediate exits", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: BUN_EXEC,
			args: [FIXTURE_PATH],
			env: { OMP_TEST_SPAWN_LOG: spawnLog },
		};

		try {
			await manager.connectServers({ crashy: config }, {});
			// Wait for the circuit breaker to trip rather than blind-sleeping a
			// fixed budget. During the storm `getConnectionStatus` is always
			// "connected" or "connecting" (`#pendingReconnections` is set
			// synchronously before any await in `#doReconnect`); it only reports
			// "disconnected" once `#tripReconnectBreaker` opens, tears down the
			// stale connection, and detaches `onClose` so no further spawns fire.
			// That makes the terminal state a race-free signal: poll for it and
			// return the instant the storm is capped instead of waiting out a
			// fixed 3s. Generous deadline stays well under the 15s test timeout.
			const deadline = Date.now() + 10_000;
			while (manager.getConnectionStatus("crashy") !== "disconnected" && Date.now() < deadline) {
				await Bun.sleep(5);
			}

			const spawns = countSpawns();
			// `RECONNECT_BURST_LIMIT` (5) is the per-server reconnect cap inside
			// the burst window. The initial connect from `connectServers` adds
			// one more spawn. On the "initialize + tools/list succeed, then
			// exit" path the inner retry-with-backoff in `#doReconnect` never
			// fires, so the steady-state ceiling is
			// `1 + RECONNECT_BURST_LIMIT + 1` ≈ 7 spawns. 10 leaves room for
			// scheduling jitter without weakening the bound.
			expect(spawns).toBeLessThanOrEqual(10);
			// Sanity check: we did spawn at least once. If the fixture never ran
			// the regression target is wrong and the test is meaningless.
			expect(spawns).toBeGreaterThan(0);

			// Once the breaker trips, the stale connection must be torn down so
			// `getConnectionStatus`/`waitForConnection` cannot hand callers a
			// dead transport. Tools stay registered in the manager's tool list
			// so the user can recover via `/mcp reconnect`.
			expect(manager.getConnectionStatus("crashy")).toBe("disconnected");
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);
});

/**
 * The crash-burst window is keyed on the server's *name*, and
 * `#holdServerConfig` retires it when the definition the manager holds is
 * replaced — so a user who fixes a crashing server is not refused the connect
 * their new definition deserves.
 *
 * Round 10 (OpenAI arm, F1). "Replaced" was spelled as object inequality, so
 * any rewrite of the config file bought another full budget, including one
 * that changed nothing a process can crash on. Three rounds alternating only
 * `timeout` between 1000 and 1001 spawned 15 processes against a per-name
 * budget of 5.
 *
 * Driven through the real discovery pipeline and a real `.omp/mcp.json`,
 * because the rewrite is the input: it is the file round-tripping through
 * `discoverAndConnect` that hands `connectServers` a fresh object.
 */
describe("a policy-only rewrite does not replenish the crash-burst budget", () => {
	const SPAWN_FIXTURE = path.join(import.meta.dir, "fixtures", "spawn-and-exit-mcp.ts");
	/** One connect attempt per reconnect, so the spawn count is the reconnect count. */
	const SINGLE_ATTEMPT: MCPReconnectPolicy = { ladderMs: [], retryBaseMs: 60_000, retryMaxMs: 60_000 };
	/** Mirrors `RECONNECT_BURST_LIMIT` in `src/mcp/manager.ts`. */
	const BURST_LIMIT = 5;
	const TOOL_DEF: MCPToolDefinition = {
		name: "ping",
		description: "Answers pong",
		inputSchema: { type: "object", properties: {} },
	};
	const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

	let projectDir: string;
	let tempHome: string;
	let userAgentDir: string;
	let spawnLog: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-mcp-rewrite-proj-"));
		tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-mcp-rewrite-home-"));
		userAgentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-mcp-rewrite-agent-"));
		spawnLog = path.join(projectDir, "spawns.log");
		await Bun.write(spawnLog, "");
		originalHome = process.env.HOME;
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(userAgentDir);
		clearFsCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalAgentDirEnv) setAgentDir(originalAgentDirEnv);
		else setAgentDir(path.join(getConfigRootDir(), "agent"));
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(projectDir);
		await removeWithRetries(tempHome);
		await removeWithRetries(userAgentDir);
	});

	it("spends one budget across rounds that alternate only the timeout", async () => {
		const store = new Map<string, string>();
		const cache = new MCPToolCache({
			getCache: (key: string) => store.get(key) ?? null,
			setCache: (key: string, value: string) => void store.set(key, value),
		} as unknown as AgentStorage);
		const manager = new MCPManager(projectDir, cache, undefined, SINGLE_ATTEMPT);
		const spawnsByRound: number[] = [];
		try {
			for (let round = 0; round < 3; round++) {
				// Policy, and only policy: 1000 and 1001 describe the same
				// process with the same arguments in the same directory.
				await Bun.write(
					path.join(projectDir, ".omp", "mcp.json"),
					JSON.stringify({
						mcpServers: {
							stormy: {
								command: process.execPath,
								args: [SPAWN_FIXTURE],
								env: { OMP_TEST_SPAWN_LOG: spawnLog },
								lazy: true,
								timeout: 1_000 + (round % 2),
							},
						},
					}),
				);
				clearFsCache();
				await manager.discoverAndConnect({ filterExa: false });
				if (round === 0) {
					// Seed the catalogue the way a previous successful connect
					// would have, so the lazy server registers a deferred tool
					// to invoke. `timeout` is policy for the cache too, so one
					// seeding covers every round.
					const { configs } = await loadAllMCPConfigs(projectDir, { filterExa: false });
					await cache.set("stormy", configs.stormy!, [TOOL_DEF]);
					clearFsCache();
					await manager.discoverAndConnect({ filterExa: false });
				}

				const deferred = manager.getTools().find(tool => tool.mcpServerName === "stormy");
				expect(deferred).toBeInstanceOf(DeferredMCPTool);
				// Ordinary model traffic: one call more than the budget, every
				// one of them a non-manual reconnect.
				for (let call = 0; call <= BURST_LIMIT; call++) {
					await (deferred as DeferredMCPTool).execute(
						`r${round}-${call}`,
						{},
						undefined,
						{} as CustomToolContext,
						undefined,
					);
				}
				const log = await Bun.file(spawnLog).text();
				spawnsByRound.push(log.split("\n").filter(line => line.trim().length > 0).length);
			}

			// Cumulative: the budget is per name per window, not per rewrite,
			// so the first round spends it and the next two buy nothing.
			expect(spawnsByRound).toEqual([BURST_LIMIT, BURST_LIMIT, BURST_LIMIT]);
		} finally {
			await manager.disconnectAll();
		}
	}, 60_000);
});
