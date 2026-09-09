/**
 * MCP Configuration File Writer
 *
 * Utilities for reading/writing .omp/mcp.json files at user or project level.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { invalidate as invalidateFsCache } from "../capability/fs";

import { validateServerConfig } from "./config";
import { MCP_CONFIG_SCHEMA_URL, type MCPConfigFile, type MCPServerConfig } from "./types";

function withSchema(config: MCPConfigFile): MCPConfigFile {
	return {
		$schema: config.$schema ?? MCP_CONFIG_SCHEMA_URL,
		...config,
	};
}

/**
 * Serialize a read-modify-write against one config file.
 *
 * Wraps {@link withFileLock} but first ensures the config's parent directory
 * exists, because the lock directory (`${filePath}.lock`) is created with a
 * non-recursive `mkdir` — without this the very first write (before the config
 * file or its parent exists) would fail to acquire the lock with ENOENT.
 */
function withConfigLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	return fs.promises
		.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
		.then(() => withFileLock(filePath, fn));
}

/**
 * Read an MCP config file.
 * Returns empty config if file doesn't exist.
 */
export async function readMCPConfigFile(filePath: string): Promise<MCPConfigFile> {
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as MCPConfigFile;
		return parsed;
	} catch (error) {
		if (isEnoent(error)) {
			// File doesn't exist, return empty config
			return { mcpServers: {} };
		}
		throw error;
	}
}

/**
 * Write an MCP config file atomically.
 * Creates parent directories if they don't exist.
 */
export async function writeMCPConfigFile(filePath: string, config: MCPConfigFile): Promise<void> {
	// Ensure parent directory exists
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	// Write to a per-writer temp file, then atomically rename into place. The
	// temp name is unique (pid + random) so two concurrent writers to the same
	// config never share one `.tmp` path and rename each other's file out from
	// under them (which surfaced as ENOENT or a clobbered final file).
	const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const content = JSON.stringify(withSchema(config), null, 2);
	try {
		await fs.promises.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
		// Rename to final path (atomic on most systems)
		await fs.promises.rename(tmpPath, filePath);
	} catch (error) {
		await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}
	// Invalidate the capability fs cache so subsequent reads see the new content
	invalidateFsCache(filePath);
}

/**
 * Validate server name.
 * @returns Error message if invalid, undefined if valid
 */
export function validateServerName(name: string): string | undefined {
	if (!name) {
		return "Server name cannot be empty";
	}
	if (name.length > 100) {
		return "Server name is too long (max 100 characters)";
	}
	// Check for invalid characters. Colon is allowed so namespaced plugin servers
	// (e.g. "cloudflare:cloudflare-api" from a Claude Code marketplace plugin) can
	// be persisted: the runtime already accepts colons in server names (tool names
	// sanitize them via createMCPToolName) and `/mcp reauth` writes such names back
	// as a user-config override that shadows the discovered entry.
	if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) {
		return "Server name can only contain letters, numbers, dash, underscore, dot, and colon";
	}
	return undefined;
}

/**
 * Add an MCP server to a config file.
 * Validates the config before writing.
 *
 * @throws Error if server name already exists or validation fails
 */
export async function addMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	// Validate server name
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// Validate the config
	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Invalid server config: ${errors.join("; ")}`);
	}

	// Serialize the read-modify-write under a per-file lock so a concurrent
	// mutation cannot overwrite this one (lost update). The lock also guards
	// against cross-process writers sharing the same config file.
	await withConfigLock(filePath, async () => {
		const existing = await readMCPConfigFile(filePath);

		// Check for duplicate name
		if (existing.mcpServers?.[name]) {
			throw new Error(`Server "${name}" already exists in ${filePath}`);
		}

		const updated: MCPConfigFile = {
			...existing,
			mcpServers: {
				...existing.mcpServers,
				[name]: config,
			},
		};
		await writeMCPConfigFile(filePath, updated);
	});
}

/**
 * Update an existing MCP server in a config file.
 * If the server doesn't exist, this will add it.
 *
 * @throws Error if validation fails
 */
export async function updateMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	// Validate server name
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// Validate the config
	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Invalid server config: ${errors.join("; ")}`);
	}

	// Serialize the read-modify-write (see addMCPServer).
	await withConfigLock(filePath, async () => {
		const existing = await readMCPConfigFile(filePath);

		const updated: MCPConfigFile = {
			...existing,
			mcpServers: {
				...existing.mcpServers,
				[name]: config,
			},
		};
		await writeMCPConfigFile(filePath, updated);
	});
}

/**
 * Remove an MCP server from a config file.
 *
 * @throws Error if server doesn't exist
 */
export async function removeMCPServer(filePath: string, name: string): Promise<void> {
	// Serialize the read-modify-write (see addMCPServer).
	await withConfigLock(filePath, async () => {
		const existing = await readMCPConfigFile(filePath);

		if (!existing.mcpServers?.[name]) {
			throw new Error(`Server "${name}" not found in ${filePath}`);
		}

		const { [name]: _removed, ...remaining } = existing.mcpServers;
		const updated: MCPConfigFile = {
			...existing,
			mcpServers: remaining,
		};
		await writeMCPConfigFile(filePath, updated);
	});
}

/**
 * Get a specific server config from a file.
 * Returns undefined if server doesn't exist.
 */
export async function getMCPServer(filePath: string, name: string): Promise<MCPServerConfig | undefined> {
	const config = await readMCPConfigFile(filePath);
	return config.mcpServers?.[name];
}

/**
 * List all server names in a config file.
 */
export async function listMCPServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Object.keys(config.mcpServers ?? {});
}

/**
 * Read the disabled servers list from a config file.
 */
export async function readDisabledServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Array.isArray(config.disabledServers) ? config.disabledServers : [];
}

/**
 * Add or remove a server name from the disabled servers list.
 */
export async function setServerDisabled(filePath: string, name: string, disabled: boolean): Promise<void> {
	// Serialize the read-modify-write (see addMCPServer).
	await withConfigLock(filePath, async () => {
		const config = await readMCPConfigFile(filePath);
		const current = new Set(config.disabledServers ?? []);

		if (disabled) {
			current.add(name);
		} else {
			current.delete(name);
		}

		const updated: MCPConfigFile = {
			...config,
			disabledServers: current.size > 0 ? Array.from(current).sort() : undefined,
		};

		if (!updated.disabledServers) {
			delete updated.disabledServers;
		}

		await writeMCPConfigFile(filePath, updated);
	});
}

/**
 * Read the user-level force-enable list (allowlist that overrides a
 * non-writable source config's `enabled: false`).
 */
export async function readEnabledServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Array.isArray(config.enabledServers) ? config.enabledServers : [];
}

/**
 * Add or remove a server name from the user-level force-enable list.
 * The list overrides a discovered server's `enabled: false` flag but does
 * NOT override the `disabledServers` denylist.
 */
export async function setServerForceEnabled(filePath: string, name: string, force: boolean): Promise<void> {
	// Serialize the read-modify-write (see addMCPServer).
	await withConfigLock(filePath, async () => {
		const config = await readMCPConfigFile(filePath);
		const current = new Set(config.enabledServers ?? []);

		if (force) {
			current.add(name);
		} else {
			current.delete(name);
		}

		const updated: MCPConfigFile = {
			...config,
			enabledServers: current.size > 0 ? Array.from(current).sort() : undefined,
		};

		if (!updated.enabledServers) {
			delete updated.enabledServers;
		}

		await writeMCPConfigFile(filePath, updated);
	});
}

/** Paths and target state for toggling one MCP server across known config files. */
export interface SetMcpServerEnabledOptions {
	userPath: string;
	projectPath: string;
	/**
	 * Absolute path to the loaded row's source mcp.json. Provide ONLY for
	 * formats this codebase owns (native `.omp/mcp.json` and `mcp-json`
	 * `mcp.json`/`.mcp.json`). Tool-owned configs (opencode.json, claude.json,
	 * settings.json …) MUST be omitted; we never mutate another tool's file.
	 */
	sourcePath?: string;
	name: string;
	enabled: boolean;
}

/**
 * Flip a server's enabled/disabled state regardless of where it lives.
 *
 * Resolution order, mirroring `/mcp enable` / `/mcp disable` plus the dashboard
 * fix for non-writable source configs:
 *
 * - Server found in `sourcePath` (writable) → write `enabled` on that entry.
 * - Else server in project mcp.json → write `enabled` there.
 * - Else server in user mcp.json → write `enabled` there.
 * - Else (server defined in a tool-owned source like opencode.json, OR a
 *   purely discovered server):
 *   - Disable → add to the user-level `disabledServers` denylist.
 *   - Enable → add to the user-level `enabledServers` allowlist so the
 *     dashboard / runtime override the non-writable source's
 *     `enabled: false` flag.
 *
 * Cleanup invariants — on every call:
 * - Re-enable clears any stale denylist entry so a server disabled via
 *   `/mcp disable` and re-enabled here doesn't stay suppressed.
 * - Disable clears any stale allowlist entry so re-disabling a
 *   force-enabled server actually takes effect.
 */
export async function setMcpServerEnabled(options: SetMcpServerEnabledOptions): Promise<void> {
	const { userPath, projectPath, sourcePath, name, enabled } = options;
	const candidatePaths = [...new Set([sourcePath, projectPath, userPath].filter(path => path !== undefined))];
	let updatedInConfig = false;

	for (const filePath of candidatePaths) {
		const config = await readMCPConfigFile(filePath);
		const server = config.mcpServers?.[name];
		if (server === undefined) continue;

		await updateMCPServer(filePath, name, { ...server, enabled });
		updatedInConfig = true;
		break;
	}

	if (enabled) {
		// Either we just wrote `enabled: true` on a writable source, or the
		// server lives in a non-writable source whose `enabled: false` flag we
		// need to override via the user allowlist. Either way the denylist
		// entry (if any) must clear so the row becomes active.
		const denied = await readDisabledServers(userPath);
		if (denied.includes(name)) {
			await setServerDisabled(userPath, name, false);
		}

		const forced = await readEnabledServers(userPath);
		const isForced = forced.includes(name);
		if (!updatedInConfig && !isForced) {
			await setServerForceEnabled(userPath, name, true);
		} else if (updatedInConfig && isForced) {
			// Writable source now carries `enabled: true`; the override is
			// redundant. Drop it so the user's allowlist stays tidy.
			await setServerForceEnabled(userPath, name, false);
		}
		return;
	}

	// Disable path. Clear any force-enable override regardless of source so the
	// disable actually sticks.
	const forced = await readEnabledServers(userPath);
	if (forced.includes(name)) {
		await setServerForceEnabled(userPath, name, false);
	}
	if (!updatedInConfig) {
		await setServerDisabled(userPath, name, true);
	}
}
