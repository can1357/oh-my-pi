/**
 * Hand a server the user just tested (`/mcp test`, the add wizard) to the
 * session's MCP manager, the same way from every host (TUI, RPC).
 *
 * The test itself may reach any configured server. Only a server the
 * session's own discovery includes may join the session: the definition handed
 * to the manager is the one discovery produces with the session's options
 * (project opt-out, Exa and browser filters, extension roots), never the raw
 * file entry the test used.
 */
import type { SourceMeta } from "../capability/types";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { type LoadMCPConfigsOptions, loadAllMCPConfigs } from "./config";
import type { MCPManager } from "./manager";

/**
 * - `synced`: the session holds the server (or needs nothing from the test).
 * - `seed-failed`: the server is lazy and the seeding connect left it without
 *   a live connection, so its current tools did not load.
 * - `excluded`: the session's discovery does not include the server; nothing
 *   was handed to the manager.
 */
export type TestedServerSync = "synced" | "seed-failed" | "excluded";

/**
 * Longest wait for a test's temporary connection to close before the session
 * connects the same server (a server may allow one client at a time). An HTTP
 * server that never answers its DELETE would otherwise hold the command
 * forever under `timeout: 0`; the close carries on in the background.
 */
export const TESTED_SERVER_CLOSE_WAIT_MS = 2_000;

export interface SyncTestedServerOptions {
	manager: MCPManager;
	name: string;
	cwd: string;
	discovery: LoadMCPConfigsOptions;
	refreshTools: (tools: CustomTool[]) => Promise<void>;
}

export async function syncTestedServer(options: SyncTestedServerOptions): Promise<TestedServerSync> {
	const { manager, name } = options;
	if (manager.getConnectionStatus(name) === "connected") return "synced";
	const discovered = await loadAllMCPConfigs(options.cwd, options.discovery);
	const config = discovered.configs[name];
	if (!config) return "excluded";
	const status = manager.getConnectionStatus(name);
	// A connected server needs nothing from the test, and neither does an
	// eager server that is still connecting. A lazy server is "connecting"
	// only during an automatic reconnect (a deferred tool's first use, or a
	// dropped transport). That attempt can still fail, so the seed below
	// waits for it.
	if (status === "connected" || (status === "connecting" && !config.lazy)) return "synced";
	const source = discovered.sources[name];
	const sources: Record<string, SourceMeta> = source ? { [name]: source } : {};
	// An attempt that started in the meantime owns the server. `connectServers`
	// would skip it, but it would still list the server in the startup barrier.
	if (manager.getConnectionStatus(name) === "disconnected") {
		await manager.connectServers({ [name]: config }, sources);
	}
	// A lazy server never connects through `connectServers`: with no cache it
	// stays tool-less, and with a cache it serves the last connect's catalog,
	// which the test may just have proved stale. The user explicitly exercised
	// this server, so spend one forced connect through the seeding path: it
	// registers the live catalog and rewrites the cache for future startups.
	let result: TestedServerSync = "synced";
	if (config.lazy) {
		try {
			// `manual` resets the crash-burst window like `/mcp reconnect`, or a
			// server that already tripped the breaker reports a passing test while
			// this seed silently does nothing. `reconnectServer` also joins an
			// attempt already in flight; that attempt's failure is not this seed's
			// result, so start the seed's own attempt after it.
			const joined = manager.getConnectionStatus(name) === "connecting";
			let connection = await manager.reconnectServer(name, { manual: true });
			if (!connection && joined) connection = await manager.reconnectServer(name, { manual: true });
			if (!connection) result = "seed-failed";
		} catch {
			result = "seed-failed";
		}
	}
	// A lazy server keeps status "disconnected" even after `connectServers`
	// installed its cached tools as deferred entries. Gate the refresh on tools
	// held for this server, not on the connection status alone.
	if (
		manager.getConnectionStatus(name) === "connected" ||
		manager.getTools().some(tool => tool.mcpServerName === name)
	) {
		await options.refreshTools(manager.getTools());
	}
	return result;
}

/** What to tell the user after a passing test, when the session did not take the server's tools. */
export function describeTestedServerSync(
	name: string,
	result: TestedServerSync,
): { problem: string; next: string } | undefined {
	if (result === "seed-failed") {
		return {
			problem: `The test passed, but this session could not connect "${name}" to load its current tools.`,
			next: `Run /mcp reconnect ${name} to retry.`,
		};
	}
	if (result === "excluded") {
		return {
			problem: `The test passed, but this session does not load "${name}", so its tools were not added.`,
			next: "Its discovery settings exclude it (mcp.enableProjectConfig, a built-in filter, or a disabled entry).",
		};
	}
	return undefined;
}
