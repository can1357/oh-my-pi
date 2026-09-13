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
 * The Exa injection this helper currently owns: the exact value it installed
 * into the process environment, and WHICH caller installed it. `undefined`
 * when the helper has installed nothing.
 *
 * Module-scoped because the thing whose ownership it tracks — `Bun.env` — is
 * itself process-global, so a per-session record could not tell an operator's
 * launch value from a helper injection. But value alone is not ownership: with
 * several top-level SDK/ACP sessions on different project MCP configurations,
 * session A's installed key made session B's call look helper-owned, so B
 * replaced A's credential with its own — or DELETED it when B's config carried
 * no Exa key. Exa tools read `EXA_API_KEY` at call time, so A then
 * authenticated as the wrong account or lost authentication entirely.
 *
 * The `owner` is the calling session's own `MCPManager`, which is exactly the
 * per-session identity `createAgentSessionScoped` gives each top-level session
 * (and which a subagent deliberately SHARES with its parent, so an inherited
 * manager is correctly the same owner).
 */
let helperInjectedExa: { key: string; owner: object | undefined } | undefined;

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
 * Two conditions must BOTH hold for the environment to be writable: the current
 * value is byte-identical to what this helper installed, AND `owner` is the
 * caller that installed it. Anything else is foreign and authoritative —
 * a launch-time export, a value another subsystem set, or another session's
 * injection. The operator's environment always wins (at launch this helper has
 * injected nothing, so any pre-existing value is foreign by construction), and
 * a session never overwrites a peer session's credential. Its OWN state is
 * replaced when config yields a new key and CLEARED when config yields none,
 * which is what makes a removed key actually take effect.
 *
 * `owner` is optional so a caller with no session identity (a startup path that
 * has not built its manager yet) still authenticates the native integration; an
 * ownerless injection is simply never reclaimed by a later owned call.
 */
export function applyMCPEnvironment(result: { exaApiKeys?: string[] }, owner?: object): void {
	// `exaApiKeys` is optional rather than required: `MCPManager` implementations
	// used by the TUI reload path resolve discovery results without it, and this
	// helper now runs on every reload, not just the startup path that always
	// populates it. An absent field is "this manager reported no credentials",
	// NOT "config removed the key", so it must never clear helper-owned state.
	const keys = result.exaApiKeys;
	if (keys === undefined) return;
	const key = keys[0];
	// Record this session's OWN credential first, unconditionally: it is
	// session-scoped state, so the process-global ownership guard below — which
	// exists only to stop one session clobbering another's `EXA_API_KEY` — must
	// not decide whether this session gets a credential path at all. Without
	// this, the second session to discover a key was left authenticating as the
	// first, because the guard returned before recording anything.
	if (owner !== undefined) {
		if (key !== undefined) sessionExaKeys.set(owner, key);
		// Config no longer carries a key for THIS session: drop the record so a
		// removed key actually stops authenticating.
		else sessionExaKeys.delete(owner);
	}
	// `$env` is typed as a total string map; read through a widened local so the
	// genuinely-absent case is expressible without a cast.
	const currentValue: string | undefined = $env.EXA_API_KEY;
	// An empty string is treated as unset, matching how the environment is read
	// everywhere else (an empty key authenticates nothing).
	const current = currentValue ? currentValue : undefined;
	const owned =
		helperInjectedExa !== undefined && current === helperInjectedExa.key && owner === helperInjectedExa.owner;
	if (current !== undefined && !owned) return;
	if (key !== undefined) {
		Bun.env.EXA_API_KEY = key;
		helperInjectedExa = { key, owner };
		return;
	}
	// Config no longer carries an Exa key. Retract only what THIS caller put
	// there; with nothing of ours installed there is nothing to retract.
	if (!owned) return;
	delete Bun.env.EXA_API_KEY;
	helperInjectedExa = undefined;
}

/**
 * Every Exa key MCP discovery extracted, keyed by the owning session identity
 * (its own `MCPManager`). Populated on every reload alongside the environment
 * injection above, and read by the native Exa integration through
 * {@link getSessionExaApiKey}.
 *
 * This exists because `EXA_API_KEY` is process-global while Exa credentials are
 * per-session config. The ownership guard above correctly stops session B from
 * REPLACING session A's injected key — but that left B with no credential path
 * at all: the native client reads the environment at execution time, so B
 * authenticated as A's account. A session-scoped lookup gives the later owner
 * its OWN key without either session touching the other's environment.
 *
 * Keyed weakly so a disposed session's manager does not pin its credential (or
 * the manager itself) for the process lifetime.
 */
const sessionExaKeys = new WeakMap<object, string>();

/**
 * This session's own discovered Exa key, or `undefined` when its config carried
 * none. Preferred over `EXA_API_KEY` by the native Exa paths: with several
 * top-level sessions the environment holds whichever session injected FIRST, so
 * reading it alone makes every later session authenticate as that one.
 *
 * `owner` is the calling session's `MCPManager` — the same identity
 * `applyMCPEnvironment` records, and one a subagent deliberately shares with
 * its parent.
 */
export function getSessionExaApiKey(owner: object | undefined): string | undefined {
	return owner === undefined ? undefined : sessionExaKeys.get(owner);
}

/**
 * Whether the live `EXA_API_KEY` is a value {@link applyMCPEnvironment}
 * injected — as opposed to a FOREIGN one: an operator's launch export, or a
 * value some other subsystem set.
 *
 * This is exactly the distinction a session key may supersede. `EXA_API_KEY` is
 * process-global while Exa credentials are per-session config, so a session
 * must outrank an environment value ANOTHER session injected — otherwise every
 * later session authenticates as whichever one injected first. It must NOT
 * outrank the operator's own export, which is documented to win and which
 * `applyMCPEnvironment` deliberately leaves in place even while recording the
 * config-discovered key for this session.
 *
 * Decided by the same byte-compare `applyMCPEnvironment` already uses to decide
 * writability: {@link helperInjectedExa} records the exact value this helper
 * installed, so a live value identical to it is ours and anything else is
 * foreign. Ownership of the record (WHICH session injected) is deliberately not
 * consulted — a peer's injection and our own are equally "not the operator's",
 * and only the operator's value takes precedence.
 */
export function isExaEnvHelperInjected(): boolean {
	if (helperInjectedExa === undefined) return false;
	const currentValue: string | undefined = $env.EXA_API_KEY;
	return currentValue ? currentValue === helperInjectedExa.key : false;
}

/**
 * Disconnect all MCP servers, then rediscover and reconnect them, rebinding the
 * resulting tools onto the session. Mirrors startup's discovery filters so a
 * reload honors the same opt-outs (`mcp.enableProjectConfig: false`, browser
 * gating) and the same extension roots. Returns the load result so the caller
 * can surface connection errors.
 */
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
		// Keyed on this session's own manager, so one session's refresh can
		// neither replace nor delete a PEER session's injected key.
		applyMCPEnvironment(result, manager);
		return result;
	} finally {
		await options.refreshMCPTools(manager.getTools());
	}
}
