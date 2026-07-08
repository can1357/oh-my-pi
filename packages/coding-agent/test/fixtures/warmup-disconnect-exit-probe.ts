#!/usr/bin/env bun
/**
 * Test probe: arm the empty-toolset recovery loop against a live stdio MCP
 * server, then `disconnectAll()` and let `main` return. The recovery loop parks
 * in a backoff wait pinned far longer than any test (`OMP_MCP_EMPTY_RETRY_MS`);
 * the ONLY way this process exits promptly is if `disconnectAll()` tears the
 * pending backoff timer down (both `unref()`'ing it and cancelling the wait).
 * If it does not, the live timer keeps the event loop alive until the pinned
 * delay elapses — a one-shot/SDK consumer that shuts down blocks on it.
 *
 * Event-loop keep-alive is only observable across a process boundary (the test
 * runner's own loop stays alive regardless), so the disconnect-tears-down
 * contract is asserted by the parent spawning this probe and checking that it
 * exits rather than hanging. Prints `DISCONNECTED` once shutdown returns.
 *
 * Env: OMP_MCP_PROBE_WORKDIR (manager work dir), OMP_MCP_PROBE_FIXTURE (path to
 * the warmup-empty-tools stdio server), OMP_MCP_PROBE_LIST_LOG (its list log),
 * OMP_MCP_EMPTY_RETRY_MS (pinned backoff, set by the parent).
 */
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";

const workDir = Bun.env.OMP_MCP_PROBE_WORKDIR;
const fixture = Bun.env.OMP_MCP_PROBE_FIXTURE;
const listLog = Bun.env.OMP_MCP_PROBE_LIST_LOG;
if (!workDir || !fixture || !listLog) {
	throw new Error("probe requires OMP_MCP_PROBE_WORKDIR, OMP_MCP_PROBE_FIXTURE, OMP_MCP_PROBE_LIST_LOG");
}

const manager = new MCPManager(workDir);
const changed = Promise.withResolvers<void>();
manager.setOnToolsChanged(() => changed.resolve());
await manager.connectServers(
	{
		warmup: {
			type: "stdio",
			command: process.execPath,
			args: [fixture],
			env: { OMP_TEST_TOOLS_PER_LIST: "0,1", OMP_TEST_LIST_LOG: listLog },
		},
	},
	{},
);
// The empty first list armed the recovery loop; it is now parked in its backoff.
await changed.promise;

await manager.disconnectAll();
process.stdout.write("DISCONNECTED\n");
// main returns here: a correctly torn-down loop leaves no live timer, so the
// process exits. A retained backoff timer would hold it for OMP_MCP_EMPTY_RETRY_MS.
