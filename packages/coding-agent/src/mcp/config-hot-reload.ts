/**
 * Polls MCP configuration files (`mcp.json`, `.mcp.json`, and discovered provider
 * configs) and reconciles added, updated, or removed MCP servers once the session
 * is idle.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { getConfigDirPaths } from "../config";
import type { HotReloadSubsystem } from "../session/hot-reload";

export const MCP_CONFIG_HOT_RELOAD_POLL_MS = 1_500;
const DIGEST_ALGORITHM = "blake2b256";

export type McpConfigRefreshError = { serverName: string; error: string } | { server: string; error: string };

export interface McpConfigRefreshSummary {
	added: string[];
	updated: string[];
	removed: string[];
	errors: McpConfigRefreshError[];
}

export interface McpConfigNotice {
	level: "info" | "warning";
	message: string;
}

/**
 * Candidate MCP configuration file paths for a working directory and agent profile.
 */
export function defaultMcpConfigPaths(cwd: string, agentDir: string = getAgentDir()): string[] {
	return [
		path.join(agentDir, "mcp.json"),
		path.join(agentDir, ".mcp.json"),
		path.join(cwd, "mcp.json"),
		path.join(cwd, ".mcp.json"),
		...getConfigDirPaths("mcp.json", { user: false, cwd }),
		...getConfigDirPaths(".mcp.json", { user: false, cwd }),
	];
}

/**
 * Formats a concise notice for what an MCP config refresh changed. Returns
 * `undefined` when nothing changed and no server failed to connect.
 */
export function describeMcpConfigRefresh(summary: McpConfigRefreshSummary): McpConfigNotice | undefined {
	const changed = summary.added.length + summary.updated.length + summary.removed.length > 0;
	if (!changed && summary.errors.length === 0) return undefined;

	const counts = `+${summary.added.length} ~${summary.updated.length} -${summary.removed.length}`;
	const head = changed ? `mcp config reloaded: ${counts}` : `mcp config unchanged: ${counts}`;
	if (summary.errors.length === 0) {
		return { level: "info", message: head };
	}

	const failureLines = summary.errors.map(entry => {
		const name = "serverName" in entry ? entry.serverName : entry.server;
		return `  ${name}: ${entry.error}`;
	});
	return {
		level: "warning",
		message: [`${head}, ${summary.errors.length} failed`, ...failureLines].join("\n"),
	};
}

interface CachedFileDigest {
	size: number;
	mtimeMs: number;
	ino: number;
	digest: string;
}

const fileDigestCache = new Map<string, CachedFileDigest>();

async function fileDigest(filePath: string): Promise<string | undefined> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) {
			fileDigestCache.delete(filePath);
			return undefined;
		}
		const cached = fileDigestCache.get(filePath);
		if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ino === stat.ino) {
			return cached.digest;
		}
		const hasher = new Bun.CryptoHasher(DIGEST_ALGORITHM);
		for await (const chunk of Bun.file(filePath).stream()) {
			hasher.update(chunk);
		}
		const digest = `${stat.size}:${hasher.digest("hex")}`;
		fileDigestCache.set(filePath, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ino: stat.ino,
			digest,
		});
		return digest;
	} catch {
		fileDigestCache.delete(filePath);
		return undefined;
	}
}

/**
 * Deterministic content signature of the watched MCP configuration file paths.
 * Missing files record `missing` so creating or deleting a config file changes
 * the signature; touching a file without changing its contents keeps it stable.
 */
export async function mcpConfigSignature(paths: readonly string[]): Promise<string> {
	const unique = [...new Set(paths)].sort();
	const lines: string[] = [];
	for (const filePath of unique) {
		const digest = await fileDigest(filePath);
		lines.push(`${filePath}:${digest ?? "missing"}`);
	}
	return lines.join("\n");
}

export interface McpConfigHotReloadSubsystemOptions {
	/** Config file paths to watch (existing or candidate). */
	paths?: () => readonly string[];
	/** Working directory provider when `paths` is omitted. */
	cwd?: () => string;
	/** Agent config directory (`~/.omp/agent`) when `paths` is omitted. */
	agentDir?: string;
	/** Whether MCP config sources should be polled (default: true). */
	enabled?: () => boolean;
	/** Reconcile MCP servers and refresh the session's MCP tools. */
	reload?: () => Promise<McpConfigRefreshSummary | void>;
	/** Alias for `reload` used by SDK session wiring. */
	reconcile?: () => Promise<McpConfigRefreshSummary | void>;
}

export function createMcpConfigHotReloadSubsystem(
	options: McpConfigHotReloadSubsystemOptions,
): HotReloadSubsystem<McpConfigRefreshSummary | void> {
	const watchedPaths = (): readonly string[] => {
		if (typeof options.paths === "function") {
			return options.paths();
		}
		const cwd = typeof options.cwd === "function" ? options.cwd() : process.cwd();
		return defaultMcpConfigPaths(cwd, options.agentDir);
	};
	return {
		id: "mcpConfig",
		source: "mcp",
		enabled: options.enabled,
		signature: () => mcpConfigSignature(watchedPaths()),
		reload: async () => {
			if (typeof options.reload === "function") return options.reload();
			if (typeof options.reconcile === "function") return options.reconcile();
			return undefined;
		},
		describe: summary => (summary ? describeMcpConfigRefresh(summary) : undefined),
		deferredMessage: "MCP config changed; reload deferred until the current turn ends",
		errorPrefix: "mcp config hot reload failed",
	};
}

export interface McpServersHotReloadSubsystemOptions {
	enabled?: () => boolean;
	poll: () => Promise<void>;
	takeChangedServers: () => string[];
	reconnectServers: (names: readonly string[]) => Promise<McpConfigRefreshSummary | void>;
}

/**
 * Creates the `mcpServers` {@link HotReloadSubsystem} that polls connected stdio MCP
 * server executables/scripts through {@link HotReloadCoordinator}, defers reconnects
 * while a turn is streaming, and refreshes session MCP tools once idle.
 */
export function createMcpServersHotReloadSubsystem(
	options: McpServersHotReloadSubsystemOptions,
): HotReloadSubsystem<McpConfigRefreshSummary | void> {
	const pending = new Set<string>();
	return {
		id: "mcpServers",
		source: "mcp",
		enabled: () => {
			const isEnabled = options.enabled ? options.enabled() : true;
			if (!isEnabled) pending.clear();
			return isEnabled;
		},
		shouldReload: async () => {
			await options.poll();
			for (const name of options.takeChangedServers()) pending.add(name);
			return pending.size > 0;
		},
		reload: async () => {
			const names = [...pending];
			pending.clear();
			if (names.length === 0) return undefined;
			return options.reconnectServers(names);
		},
		describe: summary => (summary ? describeMcpConfigRefresh(summary) : undefined),
		deferredMessage: "MCP server binary changed; reload deferred until the current turn ends",
		errorPrefix: "mcp server hot reload failed",
	};
}
