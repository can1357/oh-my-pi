/**
 * Shared MCP server reload sequence.
 *
 * A single reconnect-and-rebind path reused by every in-session MCP refresh
 * surface (`/mcp reload`, `/reload-plugins`, config-mutation flows, and the
 * `refresh` tool). Centralizing it keeps those callers from drifting apart —
 * notably the `setMCPPromptCommands([])` clear (so a removed server cannot leave
 * a stale `/server:prompt` command) and the `extensionRoots` pass-through (so an
 * extension-declared server survives a reconnect instead of vanishing until
 * restart).
 */
import { $env } from "@oh-my-pi/pi-utils";
import { clearCache as clearFsCache } from "../capability/fs";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { MCPLoadResult, MCPManager } from "./manager";

/** Inputs for a shared MCP reload, sourced from the live session/settings. */
export interface ReloadMcpServersOptions {
	/** The manager to disconnect and rediscover against. */
	manager: MCPManager;
	/** Clears the MCP prompt command list before rediscovery repopulates it. */
	setMCPPromptCommands: (commands: LoadedCustomCommand[]) => void;
	/** Rebinds the freshly discovered tools onto the live session. */
	refreshMCPTools: (tools: CustomTool[]) => Promise<void>;
	/** Session-local extension roots so extension-declared servers reconnect. */
	extensionRoots: EffectiveExtensionRoots | undefined;
	/** `mcp.enableProjectConfig` — keeps opted-out project servers from starting. */
	enableProjectConfig: boolean;
	/** `browser.enabled` — mirrors startup's browser-server filter. */
	filterBrowser: boolean;
}

/**
 * Disconnect all MCP servers, then rediscover and reconnect them, rebinding the
 * resulting tools onto the session. Mirrors startup's discovery filters so a
 * reload honors the same opt-outs (`mcp.enableProjectConfig: false`, browser
 * gating) and the same extension roots. Returns the load result so the caller
 * can surface connection errors.
 */
/**
 * The Exa key value THIS helper last installed into the process environment,
 * or `undefined` when it has installed none. Module-scoped because the thing
 * whose ownership it tracks — `Bun.env` — is itself process-global: a
 * per-session record could not tell an operator's launch value from another
 * session's injection.
 */
let helperInjectedExaApiKey: string | undefined;

/**
 * Adopt credentials MCP discovery extracted from config. Exa ships as both a
 * native integration and an MCP server: discovery filters the redundant server
 * out and hands back its key, so the key must be applied or the native path is
 * left unauthenticated with no server to fall back to.
 *
 * Ownership, not mere presence, decides whether the environment may be written.
 * This runs on EVERY reload, so a plain "skip when `EXA_API_KEY` is set" guard
 * mistakes a key THIS helper injected on an earlier refresh for an operator
 * override, and a rotated or deleted config key can never displace it — the
 * native integration keeps authenticating with an obsolete credential, or
 * retains one the operator removed from config.
 *
 * The current value is helper-owned only when it is byte-identical to what this
 * helper last installed. Anything else — a launch-time export, a value some
 * other subsystem set — is foreign and authoritative: the operator's
 * environment always wins, and at launch this helper has injected nothing, so
 * any pre-existing value is foreign by construction. Helper-owned state is
 * replaced when config yields a new key and CLEARED when config yields none,
 * which is what makes a removed key actually take effect.
 */
export function applyMCPEnvironment(result: { exaApiKeys?: string[] }): void {
	// `exaApiKeys` is optional rather than required: `MCPManager` implementations
	// used by the TUI reload path resolve discovery results without it, and this
	// helper now runs on every reload, not just the startup path that always
	// populates it. An absent field is "this manager reported no credentials",
	// NOT "config removed the key", so it must never clear helper-owned state.
	const keys = result.exaApiKeys;
	if (keys === undefined) return;
	const key = keys[0];
	// `$env` is typed as a total string map; read through a widened local so the
	// genuinely-absent case is expressible without a cast.
	const currentValue: string | undefined = $env.EXA_API_KEY;
	// An empty string is treated as unset, matching how the environment is read
	// everywhere else (an empty key authenticates nothing).
	const current = currentValue ? currentValue : undefined;
	if (current !== undefined && current !== helperInjectedExaApiKey) return;
	if (key !== undefined) {
		Bun.env.EXA_API_KEY = key;
		helperInjectedExaApiKey = key;
		return;
	}
	// Config no longer carries an Exa key. Retract only what this helper put
	// there; with nothing of ours installed there is nothing to retract.
	if (helperInjectedExaApiKey === undefined) return;
	delete Bun.env.EXA_API_KEY;
	helperInjectedExaApiKey = undefined;
}

export async function reloadMcpServers(options: ReloadMcpServersOptions): Promise<MCPLoadResult> {
	const { manager } = options;

	// Disconnect all existing servers.
	await manager.disconnectAll();
	// Prompt enrichment is asynchronous. Clear commands before rediscovery so
	// removed/disabled servers cannot leave stale `/server:prompt` entries;
	// newly loaded prompts repopulate them through the manager callback.
	options.setMCPPromptCommands([]);
	// External edits to mcp.json (not via writeMCPConfigFile) otherwise keep
	// stale env/command after reload.
	clearFsCache();

	// Rediscover and connect, mirroring startup's discovery filters.
	// The rebind is in a `finally` because `disconnectAll()` above has already
	// emptied the manager: if discovery throws (a hand-edited malformed
	// mcp.json), returning without reconciling would leave the session
	// advertising tools whose transports are all disconnected, so every later
	// call hits a dead tool. Reconciling the now-empty set first means a failed
	// refresh degrades to "no MCP tools" rather than "phantom MCP tools".
	try {
		const result = await manager.discoverAndConnect({
			enableProjectConfig: options.enableProjectConfig,
			filterExa: true,
			filterBrowser: options.filterBrowser,
			extensionRoots: options.extensionRoots,
		});
		// Startup applies the credentials discovery extracted (`applyMCPEnvironment`);
		// a refresh that skips it would filter out a newly added Exa MCP server
		// while leaving the native integration unauthenticated — the config would
		// be strictly worse off after the reload than before it.
		applyMCPEnvironment(result);
		return result;
	} finally {
		await options.refreshMCPTools(manager.getTools());
	}
}
