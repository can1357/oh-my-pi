import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, isRecord, logger, pathIsWithin, relativePathWithinRoot, type WhichOptions } from "@oh-my-pi/pi-utils";
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

// =============================================================================
// Per-server file gates
// =============================================================================

/**
 * Directory segments that conventionally hold Ansible YAML. A YAML file under
 * one of these is treated as Ansible without reading it. Container directories
 * with mixed contents are deliberately absent: a role's `files/` and
 * `templates/` subdirectories hold arbitrary payloads (OpenAPI specs, chart
 * values), and `collections/ansible_collections` nests that same role layout,
 * so only the structural subdirectories below (tasks, handlers, vars,
 * defaults, meta) grant the signal, never the container root.
 */
const ANSIBLE_PATH_SEGMENTS: Record<string, true> = {
	tasks: true,
	handlers: true,
	vars: true,
	defaults: true,
	meta: true,
	inventories: true,
	inventory: true,
	playbooks: true,
	playbook: true,
	group_vars: true,
	host_vars: true,
	ansible: true,
};

/**
 * Role sections in a `roles/<name>/<section>` span (CONTRACT.md §1b; Ansible
 * roles docs, "Role directory structure": seven main standard directories).
 * `<name>` is an opaque role name — a role literally named `files`,
 * `templates`, or `vars` is legal — and `<section>` decides: the structural
 * sections hold play content (tasks/handlers lists, vars/defaults variables,
 * meta dependencies) while `files/` (copy-resource payloads) and
 * `templates/` (.j2 templates) hold arbitrary non-Ansible bytes. Any other
 * section word (`library`, `molecule`, …) is a non-YAML-ansible position and
 * leaves the decision to the general scan and the content signals.
 */
const ANSIBLE_ROLE_STRUCTURAL_SECTIONS: Record<string, true> = {
	tasks: true,
	handlers: true,
	vars: true,
	defaults: true,
	meta: true,
};
const ANSIBLE_ROLE_PAYLOAD_SECTIONS: Record<string, true> = {
	files: true,
	templates: true,
};

/** Basenames that are Ansible entry points regardless of directory. */
const ANSIBLE_BASENAMES: Record<string, true> = {
	"playbook.yml": true,
	"playbook.yaml": true,
	"site.yml": true,
	"site.yaml": true,
};
/** Taskfile basenames reserved by Task (taskfile.dev). A Taskfile's top-level `tasks:` map is Task syntax, never Ansible. */
const TASKFILE_BASENAMES: Record<string, true> = {
	"taskfile.yml": true,
	"taskfile.yaml": true,
	"taskfile.dist.yml": true,
	"taskfile.dist.yaml": true,
};

/** First bytes read when sniffing a YAML file for Ansible markers. */
const ANSIBLE_SNIFF_BYTES = 8192;

/** Ansible play/task keys. Indentation is capped at two spaces so play/task roots match while deeply nested keys in unrelated YAML (Spring, Helm values) do not. Residual markers are line-anchored like the first alternation so comments and prose cannot match: `become:` must start a YAML key line, `ansible.builtin.<module>:` must start a module invocation, and `action: ansible.builtin.<module>` covers the action-form module spelling (no trailing colon; arguments follow the name). */
const ANSIBLE_CONTENT_SIGNAL =
	/(^|\n) {0,2}(-\s+)?(hosts|tasks|roles|handlers|pre_tasks|post_tasks|gather_facts|import_playbook)\s*:|(^|\n)[ \t]*(-\s+)?become\s*:\s*(true|yes)\b|(^|\n)[ \t]*(-\s+)?ansible\.builtin\.[a-z0-9_]+\s*:|(^|\n)[ \t]*(-\s+)?action\s*:\s*ansible\.builtin\.[a-z0-9_]+\b/;

/** Top-level Kubernetes manifest keys, tested independently so key order cannot matter. Both stay anchored to column 0 so playbooks that embed an inline manifest under `definition:` (indented keys) are not mistaken for manifests. */
const KUBERNETES_API_SIGNAL = /^apiVersion\s*:\s*\S/m;
const KUBERNETES_KIND_SIGNAL = /^kind\s*:\s*\S/m;
/**
 * Top-level GitHub Actions keys, anchored to column 0 like the Kubernetes and
 * Compose vetoes. A playbook may embed a workflow document in a block scalar
 * (`content: |`); the indented `on:`/`jobs:` lines inside that scalar must not
 * veto the enclosing playbook.
 */
const WORKFLOW_SIGNAL = /^on\s*:/m;
const WORKFLOW_JOBS_SIGNAL = /^jobs\s*:/m;
/** Top-level Compose key, anchored to column 0 so nested `services:` keys inside playbooks cannot veto them. */
const COMPOSE_SIGNAL = /^services\s*:/m;
/**
 * YAML block-scalar headers (YAML 1.2 §8.1 rule [162] `c-b-block-header`;
 * CONTRACT-COMBO.md §1). Three block-node positions open a scalar region: a
 * mapping value (`key: |`, `docs: >- # comment`, `docs: &anchor |`,
 * `"quoted: key": |`, `'it''s': |`), a sequence entry (`- |`, `- >+`,
 * `- |2`, `- &anchor |`), and a bare document-root scalar (`|`, `> # docs`).
 * The header production — not indentation alone — opens the region, so this
 * is structural detection, not a whitespace heuristic: indentation only
 * delimits a region the header already proved. Indicators are spec-exact
 * (one chomping `-`/`+` and one indent `1`-`9` in either order). In-tree YAML
 * owner is `YAML` from `"bun"` (this file's `parseConfigContent`), whose API
 * is parse/stringify only and drops scalar style on parse, and no
 * CST-capable YAML package is imported anywhere in `packages/coding-agent`
 * (CONTRACT-COMBO.md §1); the truncated 8192-byte sniff head additionally
 * cannot feed a whole-document parser. Hence this line filter.
 */
const YAML_BLOCK_SCALAR_MAP_HEADER = /^([ ]*)(-\s+)?((?:"(?:[^"\n]|"")*"|'(?:[^'\n]|'')*'|[^#:\n][^:\n]*)):\s*(?:[&!][^\s:,<>\[\]{},"]+(?:\s+[&!][^\s:,<>\[\]{},"]+)?\s+)?([|>])([-+]?[1-9]?|[1-9][-+]?)?\s*(#.*)?$/;
const YAML_BLOCK_SCALAR_SEQ_HEADER = /^([ ]*)-\s+(?:[&!][^\s:,<>\[\]{},"]+(?:\s+[&!][^\s:,<>\[\]{},"]+)?\s+)?([|>])([-+]?[1-9]?|[1-9][-+]?)?\s*(#.*)?$/;
const YAML_BLOCK_SCALAR_ROOT_HEADER = /^([ ]*)([|>])([-+]?[1-9]?|[1-9][-+]?)?\s*(#.*)?$/;

function countLeadingSpaces(line: string): number {
	let count = 0;
	while (count < line.length && line.charCodeAt(count) === 32) count++;
	return count;
}

/**
 * Blank the bodies of YAML literal (`|`) and folded (`>`) block scalars,
 * keeping newlines so `^`/`$`-anchored signals see identical line structure.
 * Headers cover mapping values (plain, `"quoted: colon"`, and `'esc''aped'`
 * keys, each with optional `&anchor`/`!tag` properties), bare sequence
 * entries (`- |`, `- &anchor |`), and bare document-root scalars (`|`).
 * An explicit indent digit fixes the body indent (key column + digit, where
 * the key column sits past any sequence marker).
 * Otherwise the first non-blank line after the header fixes it (spec §8.1:
 * auto-detected from content), so a sibling key dedented past that indent
 * (e.g. a 2-space module key after a 4-space scalar body) closes the scalar
 * instead of being swallowed. A body line is a blank line or a line indented
 * at/past the fixed indent; the first other line closes the scalar (content
 * outdents to end it, and `---` at column 0 therefore also closes it). Only
 * bodies are blanked: the header line itself stays, so structural keys are
 * never removed.
 */
export function stripYamlBlockScalarBodies(head: string): string {
	const lines = head.split("\n");
	let bodyIndent = -1;
	let pendingIndent = -1;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (bodyIndent >= 0) {
			if (line.trim() === "" || countLeadingSpaces(line) >= bodyIndent) {
				lines[index] = "";
				continue;
			}
			bodyIndent = -1;
		} else if (pendingIndent >= 0) {
			if (line.trim() === "") {
				lines[index] = "";
				continue;
			}
			if (countLeadingSpaces(line) > pendingIndent) {
				bodyIndent = countLeadingSpaces(line);
				pendingIndent = -1;
				lines[index] = "";
				continue;
			}
			pendingIndent = -1;
		}
		const mapHeader = YAML_BLOCK_SCALAR_MAP_HEADER.exec(line);
		if (mapHeader) {
			// Key column, not leading indent: in `- name: |` the key sits
			// past the sequence marker, so an explicit digit counts from
			// there (`- name: |2` bodies run at key-column + 2) and the
			// auto-detect reference does too.
			const keyColumn = mapHeader[1].length + (mapHeader[2] ?? "").length;
			const digit = /[1-9]/.exec(mapHeader[5] ?? "")?.[0];
			if (digit !== undefined) bodyIndent = keyColumn + Number(digit);
			else pendingIndent = keyColumn;
			continue;
		}
		const seqHeader = YAML_BLOCK_SCALAR_SEQ_HEADER.exec(line);
		if (seqHeader) {
			const indent = seqHeader[1].length;
			const digit = /[1-9]/.exec(seqHeader[3] ?? "")?.[0];
			if (digit !== undefined) bodyIndent = indent + Number(digit);
			else pendingIndent = indent;
			continue;
		}
		const rootHeader = YAML_BLOCK_SCALAR_ROOT_HEADER.exec(line);
		if (rootHeader) {
			const indent = rootHeader[1].length;
			const digit = /[1-9]/.exec(rootHeader[3] ?? "")?.[0];
			if (digit !== undefined) bodyIndent = indent + Number(digit);
			else pendingIndent = indent;
		}
	}
	return lines.join("\n");
}

/**
 * Optional classifier inputs for Ansible file detection.
 *
 * - `content`: in-memory file text. The disk read is only a fallback, so
 *   callers holding pending (not-yet-committed) text classify what will be
 *   written instead of the stale or missing bytes on disk.
 * - `projectRoot`: config root the path scan is scoped to. Only segments of
 *   the project-relative path count, so an absolute prefix outside the
 *   project (temporary directories, home folders) can never contribute an
 *   Ansible segment. Files outside the root get no path signal.
 */
export interface AnsibleFileOptions {
	content?: string;
	projectRoot?: string;
}

function projectRelativeDirSegments(filePath: string, projectRoot?: string): string[] | null {
	let relative = filePath;
	if (projectRoot !== undefined) {
		// Containment is computed from the original paths: folding case before
		// `path.relative` aliases distinct siblings on case-sensitive
		// filesystems (root `/tmp/Project` vs `/tmp/project/...`). Only the
		// resulting segments are lowercased for the directory match.
		const scoped = relativePathWithinRoot(projectRoot, filePath);
		if (scoped === null) return null;
		relative = scoped;
	}
	return path.dirname(relative.toLowerCase()).split(path.sep);
}

interface AnsiblePathClass {
	/** File sits in a structural Ansible position (inventory subtree, role section, bare structural dir). */
	ansiblePath: boolean;
	/** File is a vars file: `apiVersion`/`kind` are ordinary variable names here, not a manifest. */
	varsFile: boolean;
}

/**
 * Classify the project-relative dirname segments positionally (CONTRACT.md
 * §3). Words are meaningless outside their grammatical positions: the
 * segment below `group_vars`/`host_vars` is an opaque group/host name
 * (inventory docs: directories named after groups/hosts read in
 * lexicographical order), and in a `roles/<name>/<section>` span the name
 * is opaque while the section decides (roles docs: seven standard
 * directories). Bare structural words elsewhere keep the head table's
 * conventional meaning.
 */
function classifyAnsiblePathSegments(segments: string[]): AnsiblePathClass {
	let path = false;
	let vars = false;
	let i = 0;
	while (i < segments.length) {
		const segment = segments[i];
		if (segment === "group_vars" || segment === "host_vars") {
			// Inventory subtree: the next segment is a group/host name and
			// everything below is vars files for it (e.g.
			// `group_vars/raleigh/db_settings`, `group_vars/files/main.yml`
			// for a group named `files`). No deeper word can overrule this.
			return { ansiblePath: true, varsFile: true };
		}
		if (segment === "roles" && i + 1 < segments.length) {
			const section = segments[i + 2];
			if (section !== undefined) {
				if (ANSIBLE_ROLE_STRUCTURAL_SECTIONS[section]) {
					// `roles/<name>/<section>`: the leaf section decides the
					// file kind, defeating any section word in name position
					// (`roles/vars/tasks/…` is a task list, not vars).
					return { ansiblePath: true, varsFile: section === "vars" || section === "defaults" };
				}
				if (ANSIBLE_ROLE_PAYLOAD_SECTIONS[section]) {
					// Payload subtree (copy/template resources): arbitrary
					// bytes, defeating outer container words (e.g. `ansible/`
					// in `ansible/roles/web/files/openapi.yaml`) and any
					// structural-looking word nested inside the payload.
					return { ansiblePath: false, varsFile: false };
				}
			}
			// Unknown section (`library`, `molecule`, …) or a bare
			// `roles/<name>/` file: the name is opaque, keep scanning.
			i += 2;
			continue;
		}
		if (ANSIBLE_PATH_SEGMENTS[segment]) {
			path = true;
			if (segment === "vars" || segment === "defaults") vars = true;
		}
		i++;
	}
	return { ansiblePath: path, varsFile: vars };
}

function classifyAnsiblePath(filePath: string, projectRoot?: string): AnsiblePathClass {
	const segments = projectRelativeDirSegments(filePath, projectRoot);
	if (segments === null) return { ansiblePath: false, varsFile: false };
	return classifyAnsiblePathSegments(segments);
}

function readFileHead(filePath: string): string | null {
	let fd = -1;
	try {
		fd = fs.openSync(filePath, "r");
		const buf = Buffer.alloc(ANSIBLE_SNIFF_BYTES);
		const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
		return buf.subarray(0, bytesRead).toString("utf-8");
	} catch {
		return null;
	} finally {
		if (fd !== -1) {
			try {
				fs.closeSync(fd);
			} catch {
				// Ignore close errors; the read result (or null) stands.
			}
		}
	}
}

export function isAnsibleFile(filePath: string, options?: AnsibleFileOptions): boolean {
	const lowered = filePath.toLowerCase();
	const base = path.basename(lowered);
	if (TASKFILE_BASENAMES[base]) return false;
	const head = options?.content ?? readFileHead(filePath);
	// One positional classification per call: the structural signal and the
	// vars-file flag come from the same segment scan (CONTRACT.md §3).
	const cls = classifyAnsiblePath(filePath, options?.projectRoot);
	const ansiblePath = cls.ansiblePath;
	// Unreadable files carry no vetoes, so a conventional entry-point name
	// still counts alongside the path signal.
	if (head === null) return ANSIBLE_BASENAMES[base] || ansiblePath;
	if (KUBERNETES_API_SIGNAL.test(head) && KUBERNETES_KIND_SIGNAL.test(head)) {
		// Only vars files outrank the manifest guess: the leaf role section
		// decides the file kind, so a manifest under `tasks/` (even a
		// `tasks/` nested under a role named `vars`) stays a manifest,
		// while `apiVersion`/`kind` under `group_vars/`, `host_vars/`,
		// `vars/`, or `defaults/` are ordinary variable names.
		if (!cls.varsFile) return false;
	}
	if (WORKFLOW_SIGNAL.test(head) && WORKFLOW_JOBS_SIGNAL.test(head)) return false;
	// `services:` is also an ordinary Ansible variable name (a `defaults/main.yml`
	// services map), so a file already under a structural Ansible directory
	// outranks the Compose guess; the key only vetoes otherwise.
	if (COMPOSE_SIGNAL.test(head) && !ansiblePath) return false;
	// The conventional basenames accept only after the document vetoes above:
	// a manifest, workflow, or Compose file named `playbook.yml`/`site.yml`
	// stays with the generic YAML server.
	if (ANSIBLE_BASENAMES[base]) return true;
	// Block-scalar bodies are documentation text, not structure: a `docs: |`
	// scalar quoting `become:`/`ansible.builtin.*` lines must not count as
	// Ansible markers (thread :587; CONTRACT-C12.md §2). Vetoes above keep
	// the raw head — they are column-0 anchored and scalar bodies always
	// carry indent, so a body line can never match them.
	if (ANSIBLE_CONTENT_SIGNAL.test(stripYamlBlockScalarBodies(head))) return true;
	return ansiblePath;
}


/**
 * Find all servers that can handle a file based on extension.
 * Returns servers sorted with primary (non-linter) servers first.
 */
export function getServersForFile(
	config: LspConfig,
	filePath: string,
	options?: AnsibleFileOptions,
): Array<[string, ServerConfig]> {
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

		// The ansible server claims the shared .yml/.yaml extensions but only
		// serves Ansible files. Without this gate every YAML file in an Ansible
		// project (manifests, workflows, Compose) would take the ansible slot
		// for single-server operations instead of the generic YAML server.
		if (supportsFile && !(name === "ansible" && !isAnsibleFile(filePath, options))) {
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
export function getServerForFile(
	config: LspConfig,
	filePath: string,
	options?: AnsibleFileOptions,
): [string, ServerConfig] | null {
	const servers = getServersForFile(config, filePath, options);
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
