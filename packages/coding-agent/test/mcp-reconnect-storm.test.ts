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
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

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
