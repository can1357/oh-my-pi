import type { SourceMeta } from "../../../capability/types";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { type LoadMCPConfigsOptions, loadAllMCPConfigs } from "../../../mcp/config";
import type { MCPLoadResult } from "../../../mcp/manager";
import type { McpConnectionStatusEvent } from "../../../mcp/startup-events";
import type { MCPServerConfig } from "../../../mcp/types";

/** Manager methods `/extensions` needs to match `/mcp enable` / `/mcp disable`. */
export interface MCPToggleManager {
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected";
	getTools(): CustomTool[];
	getServerConfig?(name: string): MCPServerConfig | undefined;
	disconnectServer(name: string): Promise<void>;
	connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onStatus?: (event: McpConnectionStatusEvent) => void,
	): Promise<Pick<MCPLoadResult, "errors"> | MCPLoadResult>;
}

export interface MCPToggleSession {
	refreshMCPTools(tools: CustomTool[]): Promise<void> | void;
}

export interface ApplyMcpToggleRuntimeOptions {
	name: string;
	enabled: boolean;
	cwd: string;
	manager?: MCPToggleManager;
	session?: MCPToggleSession;
	/** Same discovery filters as session startup (`sdk.ts` / `/mcp reload`). */
	discovery?: LoadMCPConfigsOptions;
	loadConfigs?: typeof loadAllMCPConfigs;
	onStatus?: (event: McpConnectionStatusEvent) => void;
}

/**
 * After `/extensions` persists an MCP enable/disable, apply the same live
 * connect/disconnect + session tool refresh that `/mcp enable` / `/mcp disable`
 * already do. Config persistence stays in `setMcpServerEnabled`.
 */
export async function applyMcpToggleRuntime(options: ApplyMcpToggleRuntimeOptions): Promise<void> {
	const { name, enabled, cwd, manager, session, discovery, loadConfigs = loadAllMCPConfigs, onStatus } = options;
	if (!manager) return;

	if (!enabled) {
		await manager.disconnectServer(name);
		await session?.refreshMCPTools(manager.getTools());
		return;
	}

	if (manager.getConnectionStatus(name) !== "disconnected") {
		await session?.refreshMCPTools(manager.getTools());
		return;
	}

	const { configs, sources } = await loadConfigs(cwd, discovery);
	const config = configs[name];
	if (!config) {
		await session?.refreshMCPTools(manager.getTools());
		return;
	}
	const source = sources[name];
	await manager.connectServers({ [name]: config }, source ? { [name]: source } : {}, onStatus);
	await session?.refreshMCPTools(manager.getTools());
}

/**
 * Whether a provider-level disable must tear down `name`'s live MCP state.
 *
 * `getConnectionStatus` intentionally reports `"disconnected"` for a dormant
 * lazy server whose tools were installed from a cache hit at startup (it has
 * never actually connected), so connection status alone is not a valid
 * ownership test — a bulk provider disable that gates on it skips those
 * servers entirely, leaving their cached tools registered and able to
 * reconnect on invocation despite the provider being disabled. A server with
 * any tools currently registered under its name needs teardown regardless of
 * connection status. A lazy server with no cached tools *yet* looks
 * identical to one the manager never touched (disconnected, no tools), but
 * the manager still preserves its config in `#serverConfigs` for a later
 * `/mcp reconnect` — without checking that too, the same bulk disable would
 * skip it and leave `/mcp reconnect <name>` able to start it after its
 * provider was disabled.
 */
export function mcpServerNeedsProviderTeardown(manager: MCPToggleManager | undefined, name: string): boolean {
	if (!manager) return true;
	return (
		manager.getConnectionStatus(name) !== "disconnected" ||
		manager.getTools().some(tool => tool.mcpServerName === name) ||
		manager.getServerConfig?.(name) !== undefined
	);
}
