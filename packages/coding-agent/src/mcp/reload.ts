import { clearCache as clearFsCache } from "../capability/fs";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { MCPDiscoverOptions, MCPLoadResult, MCPManager } from "./manager";

/** The session surface an MCP reconnect rebinds. */
export interface MCPReloadHost {
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void;
	refreshMCPTools(mcpTools: CustomTool[]): Promise<void>;
}

/**
 * Reconnect every configured server of `manager` and rebind `host`'s MCP tools, so
 * config edits (and a cwd the manager was re-pointed at) take effect without a restart.
 */
export async function reconnectMCPServers(
	manager: MCPManager,
	host: MCPReloadHost,
	options: MCPDiscoverOptions,
): Promise<MCPLoadResult> {
	await manager.disconnectAll();
	// Prompt enrichment is asynchronous. Clear commands before rediscovery so
	// removed/disabled servers cannot leave stale `/server:prompt` entries;
	// newly loaded prompts repopulate them through the manager callback.
	host.setMCPPromptCommands([]);
	// External edits to mcp.json (not via writeMCPConfigFile) otherwise
	// keep stale env/command after reload.
	clearFsCache();
	const result = await manager.discoverAndConnect(options);
	await host.refreshMCPTools(manager.getTools());
	return result;
}
