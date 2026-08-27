import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

/**
 * Connect real (subprocess-backed) MCP servers and wait until each one is
 * actually usable.
 *
 * `MCPManager.connectServers` deliberately resolves after a fixed 250 ms
 * startup budget (`STARTUP_TIMEOUT_MS`) so the UI is never gated on a slow
 * server: anything still in flight keeps connecting in a background
 * continuation that registers the server's tools later. Its returned
 * `connectedServers` — and `getConnectedServers()`/`getConnection()`/
 * `getTools()` read right after it — are therefore a *latency snapshot*, not a
 * contract. A test that asserts on them passes on an idle dev box and fails on
 * a loaded CI runner where spawning `bun <fixture>` plus the initialize
 * handshake takes longer than 250 ms.
 *
 * This waits deterministically instead:
 * - `waitForConnection` resolves once the connection is registered, and
 *   rejects with the real spawn/handshake error if the server failed.
 * - `refreshServerTools` re-lists tools and awaits the `onToolsChanged`
 *   handler, so `getTools()` is populated for the server on return.
 *
 * Only pass servers expected to connect; configs meant to fail (validation
 * errors, crashing fixtures) must be asserted through `connectServers`' own
 * result or its status events.
 */
export async function connectServersAndWaitReady(
	manager: MCPManager,
	configs: Record<string, MCPServerConfig>,
): Promise<void> {
	await manager.connectServers(configs, {});
	for (const name of Object.keys(configs)) {
		await manager.waitForConnection(name);
		await manager.refreshServerTools(name);
	}
}
