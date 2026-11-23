/**
 * MCP configuration loader.
 *
 * Uses the capability system to load MCP servers from multiple sources.
 */

import { getMCPConfigPath, logger } from "@oh-my-pi/pi-utils";
import { clearCache as clearFsCache } from "../capability/fs";
import { mcpCapability } from "../capability/mcp";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import type { MCPServer } from "../discovery";
import { loadCapability } from "../discovery";
import { readDisabledServers, readEnabledServers, readMCPConfigFile } from "./config-writer";
import { builtinDropFor, type MCPDroppedServer, type MCPTransformContext } from "./transforms";
import type { MCPConfigFile, MCPServerConfig } from "./types";

/** Options for loading MCP configs */
export interface LoadMCPConfigsOptions {
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when the built-in browser capability is enabled (default: false) */
	filterBrowser?: boolean;
	/** Session-local extension roots for post-startup rediscovery (explicit + mode + configured). */
	extensionRoots?: EffectiveExtensionRoots;
	/**
	 * What the session offers natively, so built-in transforms (`./transforms`) can drop
	 * the servers it makes redundant. Omitted: no built-in transform applies.
	 */
	builtinTransforms?: MCPTransformContext;
}

/** Result of loading MCP configs */
export interface LoadMCPConfigsResult {
	/** Loaded server configs */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any were filtered) */
	exaApiKeys: string[];
	/** Source metadata for each server */
	sources: Record<string, SourceMeta>;
	/** Servers a built-in transform dropped, by name; absent when there are none. */
	dropped?: Record<string, MCPDroppedServer>;
}

/**
 * Convert canonical MCPServer to legacy MCPServerConfig.
 */
function convertToLegacyConfig(server: MCPServer): MCPServerConfig {
	// Determine transport type
	const transport = server.transport ?? (server.command ? "stdio" : server.url ? "http" : "stdio");
	const shared = {
		enabled: server.enabled,
		timeout: server.timeout,
		requestIdFormat: server.requestIdFormat,
		instructions: server.instructions,
		auth: server.auth,
		oauth: server.oauth,
	};

	if (transport === "stdio") {
		const config: MCPServerConfig = {
			...shared,
			type: "stdio" as const,
			command: server.command ?? "",
		};
		if (server.args) config.args = server.args;
		if (server.env) config.env = server.env;
		if (server.envPolicy) config.envPolicy = server.envPolicy;
		if (server.envLiteralKeys) config.envLiteralKeys = server.envLiteralKeys;
		if (server.cwd) config.cwd = server.cwd;
		return config;
	}

	if (transport === "http") {
		const config: MCPServerConfig = {
			...shared,
			type: "http" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		if (server.headerPolicy) config.headerPolicy = server.headerPolicy;
		return config;
	}

	if (transport === "sse") {
		const config: MCPServerConfig = {
			...shared,
			type: "sse" as const,
			url: server.url ?? "",
		};
		if (server.headers) config.headers = server.headers;
		if (server.headerPolicy) config.headerPolicy = server.headerPolicy;
		return config;
	}

	// Fallback to stdio
	return {
		...shared,
		type: "stdio" as const,
		command: server.command ?? "",
	};
}

/**
 * Load all MCP server configs from standard locations.
 * Uses the capability system for multi-source discovery.
 *
 * @param cwd Working directory (project root)
 * @param options Load options
 */
export async function loadAllMCPConfigs(cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> {
	const enableProjectConfig = options?.enableProjectConfig ?? true;
	const filterExa = options?.filterExa ?? true;
	const filterBrowser = options?.filterBrowser ?? false;

	// Load user-level disable/force-enable lists. The denylist always wins; the
	// allowlist overrides a non-writable source config's `enabled: false`.
	// A malformed or unreadable user mcp.json must not take down the whole MCP
	// stack (docs/mcp-config.md: the file simply contributes no entries): its
	// servers are already skipped by the mcp-json provider with a warning, so
	// the lists degrade to empty here instead of rejecting every source.
	const userPath = getMCPConfigPath("user", cwd);
	let userConfig: MCPConfigFile;
	try {
		const config: unknown = await readMCPConfigFile(userPath);
		// JSON.parse also accepts bare `null`, numbers, strings, and arrays;
		// only an object carries the server map and the lists read below.
		if (config === null || typeof config !== "object" || Array.isArray(config)) {
			throw new Error("user MCP config must be a JSON object");
		}
		userConfig = config as MCPConfigFile;
	} catch (error) {
		logger.warn("Ignoring unreadable user MCP config for server lists", { path: userPath, error: String(error) });
		userConfig = { mcpServers: {} };
	}
	const disabledServers = new Set(Array.isArray(userConfig.disabledServers) ? userConfig.disabledServers : []);
	const forcedEnabled = new Set(Array.isArray(userConfig.enabledServers) ? userConfig.enabledServers : []);

	// Scope exclusions drop entries entirely BEFORE deduplication: with project
	// config disabled, a project entry must not shadow anything.
	const includeServer = (server: MCPServer & { _source: SourceMeta }): boolean =>
		enableProjectConfig || server._source.level !== "project";

	// Disabled servers are suppressed rather than dropped: they still own their
	// name at key-level dedupe (a disabled project `foo` keeps a same-named,
	// lower-priority user `foo` disabled), but never equivalence-shadow a
	// differently-named enabled server — otherwise the disabled alias would be
	// removed downstream and starve the surviving connection.
	//
	// A built-in drop suppresses the same way, as if the entry said
	// `enabled: false`, except that an explicit enable outranks it. Items arrive
	// highest priority first, so only the first entry of a name is the one that
	// would have connected; a drop of a later one is not worth reporting.
	const transformContext = options?.builtinTransforms;
	const claimed = new Set<string>();
	let dropped: Record<string, MCPDroppedServer> | undefined;
	const suppressServer = (server: MCPServer & { _source: SourceMeta }): boolean => {
		const owner = !claimed.has(server.name);
		claimed.add(server.name);
		if (disabledServers.has(server.name)) return true;
		const forced = forcedEnabled.has(server.name);
		if (server.enabled === false && !forced) return true;
		if (!transformContext || forced || server.enabled === true) return false;
		const drop = builtinDropFor(server, transformContext);
		if (!drop) return false;
		if (owner) {
			dropped ??= {};
			dropped[server.name] = { reason: drop.reason, source: server._source };
			logger.debug("Built-in MCP transform dropped a server", { server: server.name, transform: drop.id });
		}
		return true;
	};

	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		extensionRoots: options?.extensionRoots,
		filter: includeServer,
		suppress: suppressServer,
	});

	// Discovery warnings (e.g. a Claude plugin manifest timeout below Claude
	// Code's 1000ms minimum) must reach the user, not vanish with the
	// CapabilityResult.
	for (const warning of result.warnings) logger.warn(warning);

	// Convert to legacy format and preserve source metadata.
	let configs: Record<string, MCPServerConfig> = {};
	let sources: Record<string, SourceMeta> = {};
	for (const server of result.items) {
		configs[server.name] = convertToLegacyConfig(server);
		sources[server.name] = server._source;
	}

	let exaApiKeys: string[] = [];

	if (filterExa) {
		const exaResult = filterExaMCPServers(configs, sources);
		configs = exaResult.configs;
		sources = exaResult.sources;
		exaApiKeys = exaResult.exaApiKeys;
	}

	if (filterBrowser) {
		const browserResult = filterBrowserMCPServers(configs, sources);
		configs = browserResult.configs;
		sources = browserResult.sources;
	}

	const loaded: LoadMCPConfigsResult = { configs, exaApiKeys, sources };
	if (dropped) loaded.dropped = dropped;
	return loaded;
}

/** Manager surface consulted when resolving a server for `/mcp enable|disable`. */
export interface McpServerToggleManager {
	getServerConfig(name: string): MCPServerConfig | undefined;
	getSource(name: string): SourceMeta | undefined;
	getBuiltinDrops?(): ReadonlyMap<string, MCPDroppedServer>;
}

export interface ResolveMcpServerForToggleOptions {
	cwd: string;
	enableProjectConfig?: boolean;
	mcpManager?: McpServerToggleManager;
	extensionRoots?: EffectiveExtensionRoots;
	builtinTransforms?: MCPTransformContext;
}

export interface ResolvedMcpServerToggle {
	/** True when an ACP client (`session/new` `mcpServers`) owns `name`. */
	acpOwned: boolean;
	/** True when discovery, the live manager, a built-in drop, or a user override list knows `name`. */
	known: boolean;
	/** True when a server definition exists in discovery or the live manager. */
	hasConfig: boolean;
	/** Startup-interpreted `enabled` flag on the owning definition (`undefined` means default on). */
	enabledFlag?: boolean;
	/**
	 * Writable OMP-owned source file when an OMP-owned format (`native` or
	 * `mcp-json`) is the startup owner of `name`. Undefined when a tool-owned
	 * provider wins or the server is only in the manager/override lists.
	 */
	writableSource?: {
		filePath: string;
		scope: "user" | "project";
	};
	denied: boolean;
	forced: boolean;
	builtinDropped: boolean;
	userPath: string;
	projectPath: string;
}

/**
 * Resolve the effective owner and override state of `name` for `/mcp enable` and
 * `/mcp disable`.
 *
 * Uses `loadCapability` so ownership follows startup provider priority (e.g.
 * Cursor priority 50 beats standalone `mcp.json` priority 5), disabled entries
 * in tool-owned configs such as `opencode.json` are still found, and each
 * provider's startup-interpreted `enabled` flag is used verbatim.
 */
export async function resolveMcpServerForToggle(
	name: string,
	options: ResolveMcpServerForToggleOptions,
): Promise<ResolvedMcpServerToggle> {
	const { cwd, mcpManager } = options;
	const enableProjectConfig = options.enableProjectConfig ?? true;
	const userPath = getMCPConfigPath("user", cwd);
	const projectPath = getMCPConfigPath("project", cwd);

	// ACP sessions connect the client's `session/new` `mcpServers` list
	// directly and ignore file configs and `disabledServers`/`enabledServers`.
	// Check the live ACP manager ahead of files so a colliding file entry is
	// not mistaken for the active server.
	if (mcpManager?.getSource(name)?.provider === "acp") {
		return {
			acpOwned: true,
			known: true,
			hasConfig: true,
			denied: false,
			forced: false,
			builtinDropped: false,
			userPath,
			projectPath,
		};
	}

	// Refresh cached reads so edits made outside writeMCPConfigFile (such as
	// opencode.json, .cursor/mcp.json, or hand-edited mcp.json) are visible.
	clearFsCache();
	const includeServer = (server: MCPServer & { _source: SourceMeta }): boolean =>
		enableProjectConfig || server._source.level !== "project";

	const [capabilityResult, disabledServers, enabledServers] = await Promise.all([
		loadCapability<MCPServer>(mcpCapability.id, {
			cwd,
			extensionRoots: options.extensionRoots,
			filter: includeServer,
		}),
		readDisabledServers(userPath),
		readEnabledServers(userPath),
	]);

	const discoveredItem = capabilityResult.all.find(item => item.name === name);
	const managerDrop = mcpManager?.getBuiltinDrops?.()?.get(name);
	const managerDropMatchesOwner =
		managerDrop !== undefined &&
		(discoveredItem === undefined || managerDrop.source.path === discoveredItem._source.path);
	const transformDrop =
		discoveredItem !== undefined && options.builtinTransforms !== undefined
			? builtinDropFor(discoveredItem, options.builtinTransforms)
			: undefined;
	const builtinDropped = managerDropMatchesOwner || transformDrop !== undefined;

	const writableSource =
		discoveredItem !== undefined &&
		(discoveredItem._source.provider === "native" || discoveredItem._source.provider === "mcp-json")
			? {
					filePath: discoveredItem._source.path,
					scope: discoveredItem._source.level === "user" ? ("user" as const) : ("project" as const),
				}
			: undefined;

	const managerConfig = discoveredItem === undefined ? mcpManager?.getServerConfig(name) : undefined;
	const managerSource =
		discoveredItem === undefined ? (mcpManager?.getSource(name) ?? managerDrop?.source) : undefined;
	const hasConfig = discoveredItem !== undefined || managerConfig !== undefined || managerSource !== undefined;
	const enabledFlag = discoveredItem !== undefined ? discoveredItem.enabled : managerConfig?.enabled;
	const denied = disabledServers.includes(name);
	const forced = enabledServers.includes(name);
	const known = hasConfig || builtinDropped || denied || forced;

	return {
		acpOwned: false,
		known,
		hasConfig,
		enabledFlag,
		writableSource,
		denied,
		forced,
		builtinDropped,
		userPath,
		projectPath,
	};
}

/** Pattern to match Exa MCP servers */
const EXA_MCP_URL_PATTERN = /mcp\.exa\.ai/i;
const EXA_API_KEY_PATTERN = /exaApiKey=([^&\s]+)/i;

/**
 * Check if a server config is an Exa MCP server.
 */
export function isExaMCPServer(name: string, config: MCPServerConfig): boolean {
	// Check by server name
	if (name.toLowerCase() === "exa") {
		return true;
	}

	// Check by URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url && EXA_MCP_URL_PATTERN.test(httpConfig.url)) {
			return true;
		}
	}

	// Check by args for stdio servers (e.g., mcp-remote to exa)
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { args?: string[] };
		if (stdioConfig.args?.some(arg => EXA_MCP_URL_PATTERN.test(arg))) {
			return true;
		}
	}

	return false;
}

/**
 * Extract Exa API key from an MCP server config.
 */
export function extractExaApiKey(config: MCPServerConfig): string | undefined {
	// Check URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url) {
			const match = EXA_API_KEY_PATTERN.exec(httpConfig.url);
			if (match) return match[1];
		}
	}

	// Check args for stdio servers
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { args?: string[] };
		if (stdioConfig.args) {
			for (const arg of stdioConfig.args) {
				const match = EXA_API_KEY_PATTERN.exec(arg);
				if (match) return match[1];
			}
		}
	}

	// Check env vars
	if ("env" in config && config.env) {
		const envConfig = config as { env: Record<string, string> };
		if (envConfig.env.EXA_API_KEY) {
			return envConfig.env.EXA_API_KEY;
		}
	}

	return undefined;
}

/** Exa MCP tools already covered by the native Exa integration. */
const NATIVE_EXA_MCP_TOOLS: Record<string, true> = { web_search_exa: true };

/**
 * Parse the comma-separated `tools` restriction from an Exa MCP config.
 * Returns `null` when the config does not restrict its tool set.
 */
function getRequestedExaMcpTools(config: MCPServerConfig): string[] | null {
	const raw = (() => {
		if (config.type === "http" || config.type === "sse") {
			const httpConfig = config as { url?: string };
			if (!httpConfig.url) return undefined;
			try {
				return new URL(httpConfig.url).searchParams.get("tools") ?? undefined;
			} catch {
				return undefined;
			}
		}
		if (!config.type || config.type === "stdio") {
			const stdioConfig = config as { args?: string[] };
			const args = stdioConfig.args ?? [];
			for (let i = 0; i < args.length; i++) {
				if (/^--?tools$/i.test(args[i])) return args[i + 1];
				const match = args[i].match(/(?:^|[\s?&])tools=([^&\s]+)/i) ?? args[i].match(/--?tools[=\s]([^\s]+)/i);
				if (match) return match[1];
			}
		}
		return undefined;
	})();
	if (!raw) return null;
	const tools = raw
		.split(",")
		.map(tool => tool.trim())
		.filter(tool => tool.length > 0);
	return tools.length > 0 ? tools : null;
}

/** Result of filtering Exa MCP servers */
export interface ExaFilterResult {
	/** Configs with Exa servers removed */
	configs: Record<string, MCPServerConfig>;
	/** Extracted Exa API keys (if any) */
	exaApiKeys: string[];
	/** Source metadata for remaining servers */
	sources: Record<string, SourceMeta>;
}

/**
 * Filter out Exa MCP servers and extract their API keys.
 * Since we have native Exa integration, we don't need the MCP server —
 * unless the config explicitly requests Exa tools the native integration
 * does not provide (e.g. `web_fetch_exa`, `web_search_advanced_exa`).
 */
export function filterExaMCPServers(
	configs: Record<string, MCPServerConfig>,
	sources: Record<string, SourceMeta>,
): ExaFilterResult {
	const filtered: Record<string, MCPServerConfig> = {};
	const filteredSources: Record<string, SourceMeta> = {};
	const exaApiKeys: string[] = [];

	for (const [name, config] of Object.entries(configs)) {
		if (isExaMCPServer(name, config)) {
			// Extract API key for the native Exa integration even when the MCP
			// server is kept below for its extra tools.
			const apiKey = extractExaApiKey(config);
			if (apiKey) {
				exaApiKeys.push(apiKey);
			}
			const requested = getRequestedExaMcpTools(config);
			const hasExtraTools = requested?.some(tool => !NATIVE_EXA_MCP_TOOLS[tool.toLowerCase()]) ?? false;
			if (!hasExtraTools) {
				continue;
			}
		}
		filtered[name] = config;
		if (sources[name]) {
			filteredSources[name] = sources[name];
		}
	}

	return { configs: filtered, exaApiKeys, sources: filteredSources };
}

/**
 * Validate server config has required fields.
 */
export function validateServerConfig(name: string, config: MCPServerConfig): string[] {
	const errors: string[] = [];

	const serverType = config.type ?? "stdio";

	// Check for conflicting transport fields
	const hasCommand = "command" in config && config.command;
	const hasUrl = "url" in config && (config as { url?: string }).url;
	if (hasCommand && hasUrl) {
		errors.push(
			`Server "${name}": both "command" and "url" are set - server should be either stdio (command) OR http/sse (url), not both`,
		);
	}

	if (serverType === "stdio") {
		const stdioConfig = config as { command?: string };
		if (!stdioConfig.command) {
			errors.push(`Server "${name}": stdio server requires "command" field`);
		}
	} else if (serverType === "http" || serverType === "sse") {
		const httpConfig = config as { url?: string };
		if (!httpConfig.url) {
			errors.push(`Server "${name}": ${serverType} server requires "url" field`);
		}
	} else {
		errors.push(`Server "${name}": unknown server type "${serverType}"`);
	}

	return errors;
}

export interface BrowserMCPPreludeFilterOptions {
	restrictToolNames: boolean;
	browserEnabled: boolean;
	evalRegistered: boolean;
	evalActive: boolean;
}

/** Browser MCP filtering is valid only when the built-in prelude is callable. */
export function shouldFilterBrowserMCPForPrelude(options: BrowserMCPPreludeFilterOptions): boolean {
	return !options.restrictToolNames && options.browserEnabled && options.evalRegistered && options.evalActive;
}

/** Known browser automation MCP server names (lowercase) */
const BROWSER_MCP_NAMES = new Set([
	"puppeteer",
	"playwright",
	"browserbase",
	"browser-tools",
	"browser-use",
	"browser",
]);

/** Patterns matching browser MCP package names in command/args */
const BROWSER_MCP_PKG_PATTERN =
	// Official packages
	// - @modelcontextprotocol/server-puppeteer
	// - @playwright/mcp
	// - @browserbasehq/mcp-server-browserbase
	// - @agentdeskai/browser-tools-mcp
	// - @agent-infra/mcp-server-browser
	// Community packages: puppeteer-mcp-server, playwright-mcp, pptr-mcp, etc.
	/(?:@modelcontextprotocol\/server-puppeteer|@playwright\/mcp|@browserbasehq\/mcp-server-browserbase|@agentdeskai\/browser-tools-mcp|@agent-infra\/mcp-server-browser|puppeteer-mcp|playwright-mcp|pptr-mcp|browser-use-mcp|mcp-browser-use)/i;

/** URL patterns for hosted browser MCP services */
const BROWSER_MCP_URL_PATTERN = /browserbase\.com|browser-use\.com/i;

/**
 * Check if a server config is a browser automation MCP server.
 */
export function isBrowserMCPServer(name: string, config: MCPServerConfig): boolean {
	// Check by server name
	if (BROWSER_MCP_NAMES.has(name.toLowerCase())) {
		return true;
	}

	// Check by URL for HTTP/SSE servers
	if (config.type === "http" || config.type === "sse") {
		const httpConfig = config as { url?: string };
		if (httpConfig.url && BROWSER_MCP_URL_PATTERN.test(httpConfig.url)) {
			return true;
		}
	}

	// Check by command/args for stdio servers
	if (!config.type || config.type === "stdio") {
		const stdioConfig = config as { command?: string; args?: string[] };
		if (stdioConfig.command && BROWSER_MCP_PKG_PATTERN.test(stdioConfig.command)) {
			return true;
		}
		if (stdioConfig.args?.some(arg => BROWSER_MCP_PKG_PATTERN.test(arg))) {
			return true;
		}
	}

	return false;
}

/** Result of filtering browser MCP servers */
export interface BrowserFilterResult {
	/** Configs with browser servers removed */
	configs: Record<string, MCPServerConfig>;
	/** Source metadata for remaining servers */
	sources: Record<string, SourceMeta>;
}

/**
 * Filter out browser automation MCP servers.
 * Since we have a native browser capability, we don't need these MCP servers.
 */
export function filterBrowserMCPServers(
	configs: Record<string, MCPServerConfig>,
	sources: Record<string, SourceMeta>,
): BrowserFilterResult {
	const filtered: Record<string, MCPServerConfig> = {};
	const filteredSources: Record<string, SourceMeta> = {};

	for (const [name, config] of Object.entries(configs)) {
		if (!isBrowserMCPServer(name, config)) {
			filtered[name] = config;
			if (sources[name]) {
				filteredSources[name] = sources[name];
			}
		}
	}

	return { configs: filtered, sources: filteredSources };
}
