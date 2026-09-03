/**
 * SSH Configuration File Writer
 *
 * Utilities for reading/writing ssh.json files at user or project level.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { resolveSymlinkWriteTarget } from "../utils/atomic-file";

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
	// Stage the temp and the rename against the symlink referent so a
	// user-managed link (dotfiles checkout) is preserved, and temp and target
	// share a directory so the rename cannot fail with EXDEV across mounts.
	const writePath = await resolveSymlinkWriteTarget(filePath);
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

	// Write to temp file first (atomic write)
	const tmpPath = `${writePath}.tmp`;
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

	// Read existing config
	const existing = await readSSHConfigFile(filePath);

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

	// Write back
	await writeSSHConfigFile(filePath, updated);
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

	// Read existing config
	const existing = await readSSHConfigFile(filePath);

	// Update host
	const updated: SSHConfigFile = {
		...existing,
		hosts: {
			...existing.hosts,
			[name]: hostConfig,
		},
	};

	// Write back
	await writeSSHConfigFile(filePath, updated);
}

/**
 * Remove an SSH host from a config file.
 *
 * @throws Error if host doesn't exist
 */
export async function removeSSHHost(filePath: string, name: string): Promise<void> {
	// Read existing config
	const existing = await readSSHConfigFile(filePath);

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

	// Write back
	await writeSSHConfigFile(filePath, updated);
}

/**
 * List all host names in a config file.
 */
export async function listSSHHosts(filePath: string): Promise<string[]> {
	const config = await readSSHConfigFile(filePath);
	return Object.keys(config.hosts ?? {});
}
