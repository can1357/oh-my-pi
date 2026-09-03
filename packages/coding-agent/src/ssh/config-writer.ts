/**
 * SSH Configuration File Writer
 *
 * Utilities for reading/writing ssh.json files at user or project level.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { resolveSymlinkWriteTarget, withConfigFileLock } from "../utils/atomic-file";

export interface SSHHostConfig {
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	description?: string;
	compat?: boolean;
}

export interface SSHConfigFile {
	hosts?: Record<string, SSHHostConfig>;
}

/**
 * Read an SSH config file.
 * Returns empty config if file doesn't exist.
 */
export async function readSSHConfigFile(filePath: string): Promise<SSHConfigFile> {
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as SSHConfigFile;
		return parsed;
	} catch (error) {
		if (isEnoent(error)) {
			// File doesn't exist, return empty config
			return { hosts: {} };
		}
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse SSH config file ${filePath}: ${error.message}`);
		}
		throw error;
	}
}

/**
 * Write an SSH config file atomically.
 * Creates parent directories if they don't exist.
 */
export async function writeSSHConfigFile(filePath: string, config: SSHConfigFile): Promise<void> {
	const writePath = await resolveSymlinkWriteTarget(filePath);
	await publishSSHConfig(writePath, config);
}

/**
 * Stage and publish against an ALREADY-RESOLVED target — the path pinned by
 * `withConfigFileLock`. No re-resolution happens here, so a symlink swapped in
 * at the target mid-lock cannot redirect the write to a file this lock does
 * not cover. The temp file is staged in the target's own directory so the
 * atomic rename can never fail with EXDEV across mounts.
 */
async function publishSSHConfig(writePath: string, config: SSHConfigFile): Promise<void> {
	const dir = path.dirname(writePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	// ssh.json is credential-adjacent (hosts, usernames, key paths), so the
	// published mode keeps only the owner bits of the referent's current mode —
	// stricter-than-600 owner modes survive, group/world bits are dropped like
	// the unconditional 0o600 always did — and a new file falls back to the
	// private default.
	let mode = 0o600;
	try {
		mode = (await fs.promises.stat(writePath)).mode & 0o700;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	// Write to a per-writer temp file, then atomically rename into place. The
	// temp name is unique (pid + random) so two concurrent writers — e.g. the
	// user- and project-level paths aliasing one referent — never share one
	// `.tmp` path and rename each other's file out from under them.
	const tmpPath = `${writePath}.${process.pid}.${randomUUID()}.tmp`;
	const content = JSON.stringify(config, null, 2);
	try {
		await fs.promises.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
		// Creation modes pass through umask; restore the preserved mode.
		await fs.promises.chmod(tmpPath, mode);
		// Rename to final path (atomic on most systems)
		await fs.promises.rename(tmpPath, writePath);
	} catch (error) {
		await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Validate host name.
 * @returns Error message if invalid, undefined if valid
 */
export function validateHostName(name: string): string | undefined {
	if (!name) {
		return "Host name cannot be empty";
	}
	if (name.length > 100) {
		return "Host name is too long (max 100 characters)";
	}
	// Check for invalid characters (only allow alphanumeric, dash, underscore, dot)
	if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
		return "Host name can only contain letters, numbers, dash, underscore, and dot";
	}
	return undefined;
}

/**
 * Add an SSH host to a config file.
 *
 * @throws Error if host name already exists or validation fails
 */
export async function addSSHHost(filePath: string, name: string, hostConfig: SSHHostConfig): Promise<void> {
	// Validate host name
	const nameError = validateHostName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// Validate host field
	if (!hostConfig.host) {
		throw new Error("Host address cannot be empty");
	}

	// Read, duplicate-check, and write under the resolved-target lock so
	// concurrent mutations (including paths aliasing one referent) serialize.
	await withConfigFileLock(filePath, async writePath => {
		const existing = await readSSHConfigFile(writePath);

		// Check for duplicate name
		if (existing.hosts?.[name]) {
			throw new Error(`Host "${name}" already exists in ${filePath}`);
		}

		// Add host
		const updated: SSHConfigFile = {
			...existing,
			hosts: {
				...existing.hosts,
				[name]: hostConfig,
			},
		};

		// Write back (against the pinned, already-resolved target)
		await publishSSHConfig(writePath, updated);
	});
}

/**
 * Update an existing SSH host in a config file.
 * If the host doesn't exist, this will add it.
 *
 * @throws Error if validation fails
 */
export async function updateSSHHost(filePath: string, name: string, hostConfig: SSHHostConfig): Promise<void> {
	// Validate host name
	const nameError = validateHostName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// Validate host field
	if (!hostConfig.host) {
		throw new Error("Host address cannot be empty");
	}

	await withConfigFileLock(filePath, async writePath => {
		// Read existing config
		const existing = await readSSHConfigFile(writePath);

		// Update host
		const updated: SSHConfigFile = {
			...existing,
			hosts: {
				...existing.hosts,
				[name]: hostConfig,
			},
		};

		// Write back (against the pinned, already-resolved target)
		await publishSSHConfig(writePath, updated);
	});
}

/**
 * Remove an SSH host from a config file.
 *
 * @throws Error if host doesn't exist
 */
export async function removeSSHHost(filePath: string, name: string): Promise<void> {
	await withConfigFileLock(filePath, async writePath => {
		// Read existing config
		const existing = await readSSHConfigFile(writePath);

		// Check if host exists
		if (!existing.hosts?.[name]) {
			throw new Error(`Host "${name}" not found in ${filePath}`);
		}

		// Remove host
		const { [name]: _removed, ...remaining } = existing.hosts;
		const updated: SSHConfigFile = {
			...existing,
			hosts: remaining,
		};

		// Write back (against the pinned, already-resolved target)
		await publishSSHConfig(writePath, updated);
	});
}

/**
 * List all host names in a config file.
 */
export async function listSSHHosts(filePath: string): Promise<string[]> {
	const config = await readSSHConfigFile(filePath);
	return Object.keys(config.hosts ?? {});
}
