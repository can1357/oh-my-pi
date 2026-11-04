import * as fs from "node:fs";
import * as path from "node:path";
import { $which, isRecord, logger, pathIsWithin, type WhichOptions } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { ClaudePluginRoot } from "../discovery/helpers";
import {
	type ConfigFileAdapter,
	type ConfigFileSource,
	configFileSources,
	readConfigFile,
} from "../utils/config-file-sources";
import { BiomeClient } from "./clients/biome-client";
import { linterFilePath } from "./clients/cli-process";
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

/** Parse a config file as YAML (`.yaml`/`.yml`) or JSON. */
export function parseConfigContent(content: string, filePath: string): unknown {
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

const adaptConfig: ConfigFileAdapter<NormalizedConfig> = (content, filePath) =>
	normalizeConfig(parseConfigContent(content, filePath));

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
 * Nearest directory, starting at the file's own directory and walking up, that
 * holds one of `markers`; null when no ancestor does. This is the file's own
 * project root for a server, independent of the session cwd.
 */
export function findRootMarkerAncestor(filePath: string, markers: string[]): string | null {
	if (markers.length === 0) return null;

	let dir = path.dirname(path.resolve(filePath));
	while (true) {
		if (hasRootMarkers(dir, markers)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * The linter root for `filePath`: the nearest ancestor of the file's physical
 * location holding one of `markers`. Symlinks are resolved, a dangling one to
 * the target it will create, and a missing tail is kept. A symlink into another
 * repository therefore yields that repository's root, not the root of the
 * directory the link sits in. Null when no ancestor has one.
 */
export function findLinterRoot(filePath: string, markers: string[]): string | null {
	return findRootMarkerAncestor(linterFilePath(filePath), markers);
}

/**
 * Whether a server's lint/format pass may act on `filePath` in a session at `cwd`.
 *
 * A linter applies only to a file whose own project root ({@link findLinterRoot},
 * found from the file, not from the cwd) selects it, so the cwd repository's
 * linter and config never judge a file of another repository. A CLI linter then
 * runs from that root with the executable {@link resolveLinterCommand} picks
 * for it, so it also needs one. An LSP linter is a single server started in the cwd
 * with the cwd's binary, so it serves only files whose root lies inside the
 * cwd. Type checkers, and servers without root markers, are not gated.
 */
export function linterAppliesToFile(config: ServerConfig, filePath: string, cwd: string): boolean {
	if (!config.isLinter && !config.createClient) return true;
	if (config.rootMarkers.length === 0) return true;
	const root = findLinterRoot(filePath, config.rootMarkers);
	if (root === null) return false;
	if (config.createClient) return resolveLinterCommand(config, root, cwd) !== null;
	return pathIsWithin(linterFilePath(cwd), root);
}

/** Drop the linters {@link linterAppliesToFile} rules out for `filePath`; keeps order. */
export function filterLintersForFile(
	servers: Array<[string, ServerConfig]>,
	filePath: string,
	cwd: string,
): Array<[string, ServerConfig]> {
	return servers.filter(([, config]) => linterAppliesToFile(config, filePath, cwd));
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

/** Whether `command` names a file (`./tools/biome`, `/opt/biome`) rather than a name to search for. */
function commandNamesPath(command: string): boolean {
	return command.includes("/") || (process.platform === "win32" && command.includes("\\"));
}

/**
 * First executable named `command` in `cwd`'s local bin directories. With
 * `requireProjectMarkers`, a directory counts only beside its project marker
 * (`node_modules/.bin` beside `package.json`, …); a bare `bin/` always needs it.
 * A command that names a path (`./tools/biome`, `/opt/biome`) is never looked
 * up there: it means that file, which `$which` resolves.
 */
function resolveCommandFromLocalRoot(command: string, cwd: string, requireProjectMarkers: boolean): string | null {
	if (commandNamesPath(command)) return null;
	for (const { markers, binDir } of LOCAL_BIN_PATHS) {
		const markerRequired = requireProjectMarkers || binDir === "bin";
		if (markerRequired && !hasRootMarkers(cwd, markers)) continue;
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
 * Resolve a command to an executable path for a session at `cwd`.
 * Checks project-local bin directories first, then `$PATH`. A relative command
 * (`./tools/biome`) and a relative `PATH` entry resolve against `cwd`, the
 * session's own directory, never against the process's working directory; an
 * empty entry is skipped.
 *
 * @param command - The command name (e.g., "typescript-language-server")
 * @param cwd - Working directory to search from
 * @returns Absolute path to the executable, or null if not found
 */
export function resolveCommand(command: string, cwd: string, options?: ResolveCommandOptions): string | null {
	for (const root of options?.localRoots ?? [cwd]) {
		const resolved = resolveCommandFromLocalRoot(command, root, true);
		if (resolved) return resolved;
	}
	return $which(command, { cache: options?.cache, PATH: options?.PATH, cwd });
}

/**
 * Resolve a linter's executable for the project rooted at `root`: the local bin
 * directories of `root` and then of each ancestor (the lookup Node itself does
 * for a package at `root`, which needs no `package.json`), then PATH. The
 * session cwd plays no part, so a file of another repository never runs the
 * cwd repository's binary.
 *
 * A command that names a path is that file, a relative one resolved against
 * `root`, whatever `PATH` holds. A bare name is searched only in the absolute
 * `PATH` entries: an empty or relative entry would make `root`, which may be
 * any repository the agent writes into, a search directory, so a checkout
 * could supply the executable that runs on it.
 */
export function resolveCommandForRoot(command: string, root: string): string | null {
	for (let dir = root; ;) {
		const resolved = resolveCommandFromLocalRoot(command, dir, false);
		if (resolved) return resolved;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return $which(command, { cwd: root, requireAbsolutePaths: !commandNamesPath(command) });
}

/**
 * The executable a CLI linter runs for a file whose linter root is `root`, in a
 * session at `cwd`. Both the decision whether the linter applies and the client
 * that runs it use this, so they never disagree.
 *
 * The session's own root (the cwd itself) keeps the executable the session's
 * configuration already resolved ({@link resolveCommand}, at load), under the
 * session's rules: a relative `PATH` entry or command there is the session's
 * own choice. Any other root is resolved under the foreign-root rules of
 * {@link resolveCommandForRoot}.
 */
export function resolveLinterCommand(config: ServerConfig, root: string, cwd: string): string | null {
	if (root === linterFilePath(cwd)) return config.resolvedCommand ?? resolveCommand(config.command, cwd);
	return resolveCommandForRoot(config.command, root);
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
 * `tsc --lsp --stdio` instead; older releases reject the flag with TS5023.
 * Outside an npm layout (e.g. nixpkgs) ask the compiler for its version, run in
 * `cwd` so version-manager shims resolve the project's pinned TypeScript.
 */
function typescriptSpeaksLsp(tscPath: string, cwd: string): boolean {
	const packageDir = typescriptPackageDir(tscPath);
	if (packageDir !== null) return !fs.existsSync(path.join(packageDir, "lib", "tsserver.js"));
	try {
		const { stdout } = Bun.spawnSync([tscPath, "--version"], { cwd, stderr: "ignore", timeout: 3_000 });
		const major = /^Version (\d+)\./.exec(stdout.toString())?.[1];
		return major !== undefined && Number(major) >= 7;
	} catch {
		return false;
	}
}

/**
 * Keep exactly one TypeScript server. `typescript-language-server` needs
 * `lib/tsserver.js`, which a TypeScript 7 workspace no longer ships, so it fails
 * at initialize there; `tsc --lsp` exits on older TypeScript.
 */
function selectTypescriptServer(servers: Record<string, ServerConfig>, cwd: string): void {
	const native = servers["typescript-native"];
	if (!native?.resolvedCommand) return;
	if (typescriptSpeaksLsp(native.resolvedCommand, cwd)) {
		delete servers["typescript-language-server"];
	} else {
		delete servers["typescript-native"];
	}
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
					return readConfigFile(configPath, adaptConfig);
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

function marketplaceConfigSource(root: ClaudePluginRoot): ConfigFileSource<NormalizedConfig> {
	return {
		read: () => readMarketplaceLspConfig(root),
	};
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

	const configSources = configFileSources("lsp", cwd, adaptConfig, {
		pluginRootSource: marketplaceConfigSource,
	}).reverse();

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
	selectTypescriptServer(servers, cwd);

	return { servers, idleTimeoutMs };
}

// Cache config per cwd to avoid repeated file I/O
export const configCache = new Map<string, LspConfig>();

export function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		configCache.set(cwd, config);
	}
	return config;
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
