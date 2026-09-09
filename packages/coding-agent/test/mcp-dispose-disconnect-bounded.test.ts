/**
 * Regression guard for the dispose-path MCP teardown (PR #2839).
 *
 * `AgentSession.dispose()` disconnects the MCP manager it OWNS so stdio
 * subprocesses are reaped instead of orphaned. That disconnect MUST be
 * BOUNDED: an owned manager may hold an HTTP/SSE server whose
 * session-termination DELETE blocks up to the MCP request timeout (30s
 * default, unbounded when `OMP_MCP_TIMEOUT_MS=0`). `dispose()` wraps the
 * disconnect in `withTimeout(...)`; this test proves that when the underlying
 * `MCPManager.disconnectAll()` stalls on a stuck transport close, the bound
 * returns promptly so `/exit` and print-mode shutdown are never gated on a
 * broken remote endpoint.
 *
 * Shutdown-side analog of the startup bound defended by
 * `mcp-startup-no-block.test.ts` (issue #2100): the same unbounded
 * `Promise.allSettled` over MCP transports must never gate a lifecycle
 * transition. Like that test, this is an integration test against a real MCP
 * subprocess and the real `withTimeout` clock, so it asserts elapsed wall time
 * rather than driving fake timers — fake timers cannot advance the subprocess
 * transport and would neutralize the very bound under test.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import { MCPManager } from "../src/mcp/manager";
import type { MCPStdioServerConfig } from "../src/mcp/types";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");
const BUN_EXEC = process.execPath;

describe("owned-manager dispose disconnect is bounded (PR #2839)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-dispose-"));
	});

	afterEach(() => {
		removeSyncWithRetries(workDir);
	});

	it("bounds the owned disconnect when a transport close stalls", async () => {
		const manager = new MCPManager(workDir);
		const config: MCPStdioServerConfig = { type: "stdio", command: BUN_EXEC, args: [FIXTURE_PATH] };
		const result = await manager.connectServers({ instr: config }, {});
		expect(result.errors.has("instr")).toBe(false);
		expect(manager.getConnectedServers()).toContain("instr");

		const connection = manager.getConnection("instr");
		if (!connection) throw new Error("expected a live connection to the fixture server");

		// Stand in for an HTTP/SSE transport whose termination DELETE never
		// returns. A controllable gate keeps cleanup deterministic — no
		// forever-pending promise and no orphaned subprocess once the test ends.
		const realClose = connection.transport.close.bind(connection.transport);
		let releaseClose: () => void = () => {};
		const closeGate = new Promise<void>(resolve => {
			releaseClose = resolve;
		});
		connection.transport.close = () => closeGate;

		try {
			// `disconnectAll()` is exactly what `dispose()` invokes; with a stuck
			// close it never settles on its own. The dispose bound (`withTimeout`)
			// MUST reject within its deadline — a rejection here proves the
			// disconnect did not settle in time and that shutdown is not blocked
			// on the 30s request timeout.
			const disconnect = manager.disconnectAll();
			const start = performance.now();
			await expect(withTimeout(disconnect, 250, "owned MCP disconnect timed out during dispose")).rejects.toThrow(
				/timed out/i,
			);
			expect(performance.now() - start).toBeLessThan(3_000);

			// Release the gate so the detached disconnect finishes cleanly.
			releaseClose();
			await disconnect;
		} finally {
			await realClose();
		}
	}, 20_000);
});
