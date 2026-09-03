import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, isRecord, logger, pathIsWithin, type WhichOptions } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { getConfigDirPaths } from "../config";
import { type ClaudePluginRoot, getPreloadedPluginRoots } from "../discovery/helpers";
import { BiomeClient } from "./clients/biome-client";
import { SwiftLintClient } from "./clients/swiftlint-client";
import DEFAULTS from "./defaults.json" with { type: "json" };
import type { ServerConfig } from "./types";

export interface LspConfig {
	servers: Record<string, ServerConfig>;
	/** Idle timeout in milliseconds. If set, LSP clients will be shutdown after this period of inactivity. Disabled by default. */
	idleTimeoutMs?: number;
}

// =============================================================================
// Default Server Configuration Loading
// =============================================================================

const PID_TOKEN = "$PID";

interface RawServerConfig extends Partial<ServerConfig> {
	extensionToLanguage?: unknown;
	initializationOptions?: unknown;
}

interface NormalizedConfig {
	servers: Record<string, RawServerConfig>;
	idleTimeoutMs?: number;
}

function parseConfigContent(content: string, filePath: string): unknown {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml") {
		return YAML.parse(content) as unknown;
	}
	return JSON.parse(content) as unknown;
}

function normalizeConfig(value: unknown): NormalizedConfig | null {
	if (!isRecord(value)) return null;

	const idleTimeoutMs = typeof value.idleTimeoutMs === "number" ? value.idleTimeoutMs : undefined;
	const rawServers = value.servers;

	if (isRecord(rawServers)) {
		return { servers: rawServers as Record<string, RawServerConfig>, idleTimeoutMs };
	}

	const servers = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "idleTimeoutMs")) as Record<
		string,
		RawServerConfig
	>;

	return { servers, idleTimeoutMs };
}

function normalizeStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return items.length > 0 ? items : null;
}
function normalizeExtensionToFileTypes(value: unknown): string[] | null {
	if (!isRecord(value)) return null;
	const extensions = Object.keys(value).filter(extension => extension.length > 0);
	return extensions.length > 0 ? extensions : null;
}

function normalizeServerConfig(name: string, config: RawServerConfig): ServerConfig | null {
	const command = typeof config.command === "string" && config.command.length > 0 ? config.command : null;
	const fileTypes =
		normalizeStringArray(config.fileTypes) ?? normalizeExtensionToFileTypes(config.extensionToLanguage);
	const rootMarkers = normalizeStringArray(config.rootMarkers) ?? (config.extensionToLanguage ? ["."] : null);
	const languageId =
		typeof config.languageId === "string" && config.languageId.length > 0 ? config.languageId : undefined;

	if (!command || !fileTypes || !rootMarkers) {
		logger.warn("Ignoring invalid LSP server config (missing required fields).", { name });
		return null;
	}

	const args = Array.isArray(config.args)
		? config.args.filter((entry): entry is string => typeof entry === "string")
		: undefined;
	const initOptions = isRecord(config.initOptions)
		? config.initOptions
		: isRecord(config.initializationOptions)
			? config.initializationOptions
			: undefined;

	return {
		...config,
		command,
		args,
		fileTypes,
		rootMarkers,
		languageId,
		...(initOptions ? { initOptions } : {}),
	};
}

function readConfigFile(filePath: string): NormalizedConfig | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = parseConfigContent(content, filePath);
		return normalizeConfig(parsed);
	} catch {
		return null;
	}
}

function coerceServerConfigs(servers: Record<string, RawServerConfig>): Record<string, ServerConfig> {
	const result: Record<string, ServerConfig> = {};
	for (const [name, config] of Object.entries(servers)) {
		const normalized = normalizeServerConfig(name, config);
		if (normalized) {
			result[name] = normalized;
		}
	}
	return result;
}

function mergeServers(
	base: Record<string, ServerConfig>,
	overrides: Record<string, RawServerConfig>,
): Record<string, ServerConfig> {
	const merged: Record<string, ServerConfig> = { ...base };
	for (const [name, config] of Object.entries(overrides)) {
		if (merged[name]) {
			const candidate = { ...merged[name], ...config };
			const normalized = normalizeServerConfig(name, candidate);
			if (normalized) {
				merged[name] = normalized;
			} else {
				logger.warn("Ignoring invalid LSP overrides (keeping previous config).", { name });
			}
		} else {
			const normalized = normalizeServerConfig(name, config);
			if (normalized) {
				merged[name] = normalized;
			}
		}
	}
	return merged;
}

function applyRuntimeDefaults(servers: Record<string, ServerConfig>): Record<string, ServerConfig> {
	const updated: Record<string, ServerConfig> = { ...servers };

	if (updated.biome) {
		updated.biome = { ...updated.biome, createClient: BiomeClient.create };
	}

	if (updated.swiftlint) {
		updated.swiftlint = { ...updated.swiftlint, createClient: SwiftLintClient.create };
	}

	if (updated.omnisharp?.args) {
		const args = updated.omnisharp.args.map(arg => (arg === PID_TOKEN ? String(process.pid) : arg));
		updated.omnisharp = { ...updated.omnisharp, args };
	}

	return updated;
}

// =============================================================================
// Configuration Loading
// =============================================================================

/**
 * Check if any root marker file exists in the directory
 */
export function hasRootMarkers(cwd: string, markers: string[]): boolean {
	let entries: string[] | null = null;
	for (const marker of markers) {
		// Handle glob-like patterns (e.g., "*.cabal"). Root markers live at the
		// project root, so a one-level readdir is sufficient — and avoids
		// Bun.Glob descending into node_modules for patterns like "**/*.cabal".
		if (marker.includes("*")) {
			if (entries === null) {
				try {
					entries = fs.readdirSync(cwd);
				} catch {
					entries = [];
					logger.warn("Failed to list directory for glob root marker.", { marker, cwd });
				}
			}
			const glob = new Bun.Glob(marker);
			for (const entry of entries) {
				if (glob.match(entry)) {
					return true;
				}
			}
			continue;
		}
		const filePath = path.join(cwd, marker);
		if (fs.existsSync(filePath)) {
			return true;
		}
	}
	return false;
}

/**
 * Check whether any ancestor directory of a file is an LSP project root.
 */
export function hasRootMarkerAncestor(filePath: string, markers: string[]): boolean {
	if (markers.length === 0) return false;

	let dir = path.dirname(path.resolve(filePath));
	while (true) {
		if (hasRootMarkers(dir, markers)) return true;
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

// =============================================================================
// Local Binary Resolution
// =============================================================================

/**
 * Local bin directories to check before $PATH, ordered by priority.
 * Each entry maps a root marker to the bin directory to check.
 */
const PYTHON_ROOT_MARKERS = [
	"pyproject.toml",
	"ty.toml",
	"requirements.txt",
	"setup.py",
	"setup.cfg",
	"Pipfile",
	"pyrightconfig.json",
	"ruff.toml",
	".ruff.toml",
];

const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDir: string }> = [
	// Node.js - check node_modules/.bin/
	{ markers: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"], binDir: "node_modules/.bin" },
	// Python - check virtual environment bin directories
	{ markers: PYTHON_ROOT_MARKERS, binDir: ".venv/bin" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: ".venv/Scripts" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: "venv/bin" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: "venv/Scripts" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: ".env/bin" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: ".env/Scripts" },
	// Ruby - check vendor bundle and binstubs
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "vendor/bundle/bin" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "bin" },
	// Go - check project-local bin
	{ markers: ["go.mod", "go.sum", "go.work"], binDir: "bin" },
];

const WINDOWS_LOCAL_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat"] as const;

function resolveLocalCommand(basePath: string): string | null {
	if (fs.existsSync(basePath)) return basePath;
	if (process.platform !== "win32") return null;

	// Package managers write Windows launchers with executable suffixes in node_modules/.bin.
	for (const extension of WINDOWS_LOCAL_EXECUTABLE_EXTENSIONS) {
		const candidate = `${basePath}${extension}`;
		if (fs.existsSync(candidate)) return candidate;
	}

	return null;
}

function resolveCommandFromLocalRoot(command: string, cwd: string): string | null {
	for (const { markers, binDir } of LOCAL_BIN_PATHS) {
		if (!hasRootMarkers(cwd, markers)) continue;
		const resolved = resolveLocalCommand(path.join(cwd, binDir, command));
		if (resolved) return resolved;
	}
	return null;
}

/** Controls project-local and PATH executable lookup. */
export interface ResolveCommandOptions extends Pick<WhichOptions, "cache" | "PATH"> {
	/** Ordered project roots checked before PATH; defaults to the command cwd. */
	localRoots?: readonly string[];
}

/**
 * Resolve a command to an executable path.
 * Checks project-local bin directories first, then falls back to $PATH.
 *
 * @param command - The command name (e.g., "typescript-language-server")
 * @param cwd - Working directory to search from
 * @returns Absolute path to the executable, or null if not found
 */
export function resolveCommand(command: string, cwd: string, options?: ResolveCommandOptions): string | null {
	if (options?.localRoots) {
		for (const root of options.localRoots) {
			const resolved = resolveCommandFromLocalRoot(command, root);
			if (resolved) return resolved;
		}
	} else {
		const resolved = resolveCommandFromLocalRoot(command, cwd);
		if (resolved) return resolved;
	}

	if (!options) return $which(command);
	return $which(command, { cache: options.cache, PATH: options.PATH });
}

// =============================================================================
// TypeScript Server Selection
// =============================================================================

/**
 * Directory of the package that owns a resolved `tsc`/`tsgo` launcher, or null
 * when the layout is not a recognizable npm install.
 */
function typescriptPackageDir(tscPath: string): string | null {
	let realPath = tscPath;
	try {
		realPath = fs.realpathSync(tscPath);
	} catch {}
	const binDir = path.dirname(tscPath);
	const candidates = [
		// <pkg>/bin/tsc: symlinked node_modules/.bin and global installs
		...(path.basename(path.dirname(realPath)) === "bin" ? [path.dirname(path.dirname(realPath))] : []),
		// node_modules/.bin/tsc.cmd on Windows
		path.join(binDir, "..", "typescript"),
		// npm global prefix on Windows
		path.join(binDir, "node_modules", "typescript"),
	];
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
	}
	return null;
}

/**
 * Whether the `tsc` at `tscPath` speaks LSP itself. TypeScript 7 dropped the JS
 * `lib/tsserver.js` that typescript-language-server wraps and exposes
 * `tsc --lsp --stdio` from its native binary instead; older releases reject the
 * flag with TS5023.
 */
function typescriptSpeaksLsp(tscPath: string): boolean {
	const packageDir = typescriptPackageDir(tscPath);
	return packageDir !== null && !fs.existsSync(path.join(packageDir, "lib", "tsserver.js"));
}

/**
 * Keep exactly one TypeScript server. `typescript-language-server` needs
 * `lib/tsserver.js`, which a TypeScript 7 workspace no longer ships, so it fails
 * at initialize there; `tsc --lsp` exits on older TypeScript. Pick by inspecting
 * the resolved `tsc` install rather than spawning both.
 */
function selectTypescriptServer(servers: Record<string, ServerConfig>): void {
	const native = servers["typescript-native"];
	if (!native?.resolvedCommand) return;
	if (typescriptSpeaksLsp(native.resolvedCommand)) {
		delete servers["typescript-language-server"];
	} else {
		delete servers["typescript-native"];
	}
}

interface ConfigSource {
	read(): NormalizedConfig | null;
}

function fileConfigSource(filePath: string): ConfigSource {
	return {
		read: () => readConfigFile(filePath),
	};
}

function readMarketplaceLspConfig(root: ClaudePluginRoot): NormalizedConfig | null {
	const catalogPaths = [
		path.resolve(root.path, "..", "..", "marketplace.json"),
		path.resolve(root.path, "..", "..", ".claude-plugin", "marketplace.json"),
	];

	for (const catalogPath of catalogPaths) {
		try {
			const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as unknown;
			if (!isRecord(catalog) || !Array.isArray(catalog.plugins)) continue;

			for (const plugin of catalog.plugins) {
				if (!isRecord(plugin) || plugin.name !== root.plugin) continue;

				const lspServers = plugin.lspServers;
				if (typeof lspServers === "string") {
					const configPath = path.resolve(root.path, lspServers);
					if (!pathIsWithin(root.path, configPath)) return null;
					return readConfigFile(configPath);
				}
				if (isRecord(lspServers)) {
					return normalizeConfig({ servers: lspServers });
				}
				return null;
			}
		} catch {}
	}

	return null;
}

function marketplaceConfigSource(root: ClaudePluginRoot): ConfigSource {
	return {
		read: () => readMarketplaceLspConfig(root),
	};
}

/**
 * Configuration sources in priority order.
 * Supports both visible and hidden variants at each config location.
 */
function getConfigSources(cwd: string): ConfigSource[] {
	const filenames = ["lsp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml"];
	const sources: ConfigSource[] = [];

	// Project root files (highest priority)
	for (const filename of filenames) {
		sources.push(fileConfigSource(path.join(cwd, filename)));
	}

	// Project config directories (.omp/, .pi/, .claude/)
	const projectDirs = getConfigDirPaths("", { user: false, project: true, cwd });
	for (const dir of projectDirs) {
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(dir, filename)));
		}
	}

	// User config directories (~/.omp/agent/, ~/.pi/agent/, ~/.claude/)
	const userDirs = getConfigDirPaths("", { user: true, project: false });
	for (const dir of userDirs) {
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(dir, filename)));
		}
	}

	// Plugin LSP configs (from marketplace/--plugin-dir roots)
	const pluginRoots = getPreloadedPluginRoots();
	for (const root of pluginRoots) {
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(root.path, filename)));
		}
		sources.push(marketplaceConfigSource(root));
	}

	// User home root files (lowest priority fallback)
	for (const filename of filenames) {
		sources.push(fileConfigSource(path.join(os.homedir(), filename)));
	}

	return sources;
}

/**
 * Load LSP configuration.
 *
 * Priority (highest to lowest):
 * 1. Project root: lsp.json/.lsp.json/lsp.yml/.lsp.yml/lsp.yaml/.lsp.yaml
 * 2. Project config dirs: .omp/lsp.*, .pi/lsp.*, .claude/lsp.* (+ hidden variants)
 * 3. User config dirs: ~/.omp/agent/lsp.*, ~/.pi/agent/lsp.*, ~/.claude/lsp.* (+ hidden variants)
 * 4. User home root: ~/lsp.*, ~/.lsp.*
 * 5. Auto-detect from project markers + available binaries
 *
 * Config files are merged from lowest to highest priority; later files override earlier settings.
 *
 * Config file format (JSON or YAML):
 * ```json
 * {
 *   "servers": {
 *     "typescript-language-server": {
 *       "command": "typescript-language-server",
 *       "args": ["--stdio", "--log-level", "4"],
 *       "disabled": false
 *     },
 *     "my-custom-server": {
 *       "command": "/path/to/server",
 *       "args": ["--stdio"],
 *       "fileTypes": [".xyz"],
 *       "languageId": "xyz",
 *       "rootMarkers": [".xyz-project"]
 *     }
 *   }
 * }
 * ```
 */
export function loadConfig(cwd: string): LspConfig {
	let mergedServers = coerceServerConfigs(DEFAULTS);

	const configSources = getConfigSources(cwd).reverse();

	let idleTimeoutMs: number | undefined;
	for (const source of configSources) {
		const parsed = source.read();
		if (!parsed) continue;
		mergedServers = mergeServers(mergedServers, parsed.servers);
		if (parsed.idleTimeoutMs !== undefined) {
			idleTimeoutMs = parsed.idleTimeoutMs;
		}
	}

	// Filter to servers whose project markers exist and whose binary resolves (local or $PATH)
	const servers: Record<string, ServerConfig> = {};
	const candidates = applyRuntimeDefaults(mergedServers);
	for (const name in candidates) {
		const config = candidates[name];
		if (config.disabled) continue;
		if (!hasRootMarkers(cwd, config.rootMarkers)) continue;
		const resolved = resolveCommand(config.command, cwd);
		if (!resolved) continue;
		servers[name] = { ...config, resolvedCommand: resolved };
	}
	selectTypescriptServer(servers);

	return { servers, idleTimeoutMs };
}

// =============================================================================
// Server Selection
// =============================================================================

/**
 * Find all servers that can handle a file based on extension.
 * Returns servers sorted with primary (non-linter) servers first.
 */
export function getServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	const ext = path.extname(filePath).toLowerCase();
	const extNoDot = ext.startsWith(".") ? ext.slice(1) : ext;
	const fileName = path.basename(filePath).toLowerCase();
	const matches: Array<[string, ServerConfig]> = [];

	for (const [name, serverConfig] of Object.entries(config.servers)) {
		const supportsFile = serverConfig.fileTypes.some(fileType => {
			// Accept both `.ts` and `ts` forms in user config / fixtures so a
			// missing dot in `fileTypes` doesn't silently exclude the server
			// from extension-based routing (e.g. rename_file's relevance filter).
			const normalized = fileType.toLowerCase();
			const normalizedNoDot = normalized.startsWith(".") ? normalized.slice(1) : normalized;
			return (
				normalized === ext ||
				normalized === fileName ||
				normalizedNoDot === extNoDot ||
				normalizedNoDot === fileName
			);
		});

		if (supportsFile) {
			matches.push([name, serverConfig]);
		}
	}

	// Sort: primary servers (non-linters) first, then linters
	return matches.sort((a, b) => {
		const aIsLinter = a[1].isLinter ? 1 : 0;
		const bIsLinter = b[1].isLinter ? 1 : 0;
		return aIsLinter - bIsLinter;
	});
}

/**
 * Find the primary server for a file (prefers type-checkers over linters).
 * Used for operations like definition, hover, references that need type intelligence.
 */
export function getServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}

/**
 * Check if a server has a specific capability
 */
export function hasCapability(
	config: ServerConfig,
	capability: keyof NonNullable<ServerConfig["capabilities"]>,
): boolean {
	return config.capabilities?.[capability] === true;
}
