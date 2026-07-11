import * as fs from "node:fs";
import * as path from "node:path";
import { $which, getRemoteHostDir, getSshControlDir, isEnoent, logger, postmortem } from "@pk-nerdsaver-ai/pi-utils";
import { $ } from "bun";
import { buildSshTarget, sanitizeHostName } from "./utils";

export interface SSHConnectionTarget {
	name: string;
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	compat?: boolean;
}

export type SSHHostOs = "windows" | "linux" | "macos" | "unknown";
export type SSHHostShell = "cmd" | "powershell" | "bash" | "zsh" | "sh" | "unknown";
export type SshPlatform = typeof process.platform;

export function supportsSshControlMaster(platform: SshPlatform = process.platform): boolean {
	return platform !== "win32";
}

export interface SSHHostInfo {
	version: number;
	os: SSHHostOs;
	shell: SSHHostShell;
	compatShell?: "bash" | "sh";
	compatEnabled: boolean;
}

const CONTROL_DIR = getSshControlDir();
const CONTROL_PATH = path.join(CONTROL_DIR, "%C.sock");
const HOST_INFO_DIR = getRemoteHostDir();
const HOST_INFO_VERSION = 3;

const activeHosts = new Map<string, SSHConnectionTarget>();
const pendingConnections = new Map<string, Promise<void>>();
const hostInfoCache = new Map<string, SSHHostInfo>();

interface SSHArgsOptions {
	platform?: SshPlatform;
	/** When true, omit `-n` so the remote command can read from our piped stdin. */
	allowStdin?: boolean;
}

function ensureControlDir() {
	fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(CONTROL_DIR, 0o700);
	} catch (err) {
		logger.debug("SSH control dir chmod failed", { path: CONTROL_DIR, error: String(err) });
	}
}

function getHostInfoPath(name: string): string {
	return path.join(HOST_INFO_DIR, `${sanitizeHostName(name)}.json`);
}

async function deleteHostInfoFromDisk(hostName: string): Promise<void> {
	const path = getHostInfoPath(hostName);
	try {
		await fs.promises.unlink(path);
	} catch (err) {
		if (isEnoent(err)) return;
		logger.warn("Failed to delete SSH host info", { host: hostName, error: String(err) });
	}
}

async function validateKeyPermissions(keyPath?: string, platform: SshPlatform = process.platform): Promise<void> {
	if (!keyPath) return;
	let stats: fs.Stats;
	try {
		stats = await fs.promises.stat(keyPath);
	} catch (err) {
		if (isEnoent(err)) {
			throw new Error(`SSH key not found: ${keyPath}`);
		}
		throw err;
	}
	if (!stats.isFile()) {
		throw new Error(`SSH key is not a file: ${keyPath}`);
	}
	if (platform === "win32") return;
	const mode = stats.mode & 0o777;
	if ((mode & 0o077) !== 0) {
		throw new Error(`SSH key permissions must be 600 or stricter: ${keyPath}`);
	}
}

function buildCommonArgs(host: SSHConnectionTarget, options?: SSHArgsOptions): string[] {
	const args = options?.allowStdin ? [] : ["-n"];

	if (supportsSshControlMaster(options?.platform)) {
		args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${CONTROL_PATH}`, "-o", "ControlPersist=3600");
	}

	args.push("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new");

	if (host.port) {
		args.push("-p", String(host.port));
	}
	if (host.keyPath) {
		args.push("-i", host.keyPath);
	}

	return args;
}

async function runSshSync(args: string[]): Promise<{ exitCode: number | null; stderr: string }> {
	const result = await $`ssh ${args}`.quiet().nothrow();
	return { exitCode: result.exitCode, stderr: result.stderr.toString().trim() };
}

async function runSshCaptureSync(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const result = await $`ssh ${args}`.quiet().nothrow();
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
	};
}

function ensureSshBinary(): void {
	if (!$which("ssh")) {
		throw new Error("ssh binary not found on PATH");
	}
}

function parseOs(value: unknown): SSHHostOs | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "windows":
			return "windows";
		case "linux":
			return "linux";
		case "macos":
		case "darwin":
			return "macos";
		case "unknown":
			return "unknown";
		default:
			return null;
	}
}

function parseShell(value: unknown): SSHHostShell | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return "unknown";
	if (normalized.includes("bash")) return "bash";
	if (normalized.includes("zsh")) return "zsh";
	if (normalized.includes("pwsh") || normalized.includes("powershell")) return "powershell";
	if (normalized.includes("cmd.exe") || normalized === "cmd") return "cmd";
	// Only genuine POSIX sh-family by basename — fish/csh/tcsh also end in "sh"
	// but are non-POSIX (csh/tcsh history-expand `!`), so they fall through to
	// "unknown" and are refused by the ssh:// transfer guard.
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	if (base === "sh" || base === "dash" || base === "ash" || base === "ksh" || base === "mksh") return "sh";
	return "unknown";
}

function parseCompatShell(value: unknown): "bash" | "sh" | undefined {
	if (value === "bash" || value === "sh") return value;
	return undefined;
}

function applyCompatOverride(host: SSHConnectionTarget, info: SSHHostInfo): SSHHostInfo {
	const compatShell =
		info.compatShell ??
		(info.os === "windows" && info.shell === "bash"
			? "bash"
			: info.os === "windows" && info.shell === "sh"
				? "sh"
				: undefined);
	const compatEnabled = host.compat === false ? false : info.os === "windows" && compatShell !== undefined;
	if (host.compat === true && !compatShell) {
		logger.warn("SSH compat requested but no compatible shell detected", {
			host: host.name,
			shell: info.shell,
		});
	}
	return { ...info, version: info.version ?? 0, compatShell, compatEnabled };
}

function parseHostInfo(value: unknown): SSHHostInfo | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const os = parseOs(record.os) ?? "unknown";
	const shell = parseShell(record.shell) ?? "unknown";
	const compatShell = parseCompatShell(record.compatShell);
	const compatEnabled = typeof record.compatEnabled === "boolean" ? record.compatEnabled : false;
	const version = typeof record.version === "number" ? record.version : 0;
	return {
		version,
		os,
		shell,
		compatShell,
		compatEnabled,
	};
}

function shouldRefreshHostInfo(host: SSHConnectionTarget, info: SSHHostInfo): boolean {
	if (info.version !== HOST_INFO_VERSION) return true;
	if (info.os === "unknown") return true;
	if (info.os !== "windows" && info.compatEnabled) return true;
	if (info.os === "windows" && info.compatEnabled && !info.compatShell) return true;
	if (info.os === "windows" && info.compatShell === "bash" && info.shell === "unknown") return true;
	if (host.compat === true && info.os === "windows" && !info.compatShell) return true;
	return false;
}

async function loadHostInfoFromDisk(host: SSHConnectionTarget): Promise<SSHHostInfo | undefined> {
	const path = getHostInfoPath(host.name);
	try {
		const raw = await fs.promises.readFile(path, "utf-8");
		const parsed = parseHostInfo(JSON.parse(raw));
		if (!parsed) return undefined;
		const resolved = applyCompatOverride(host, parsed);
		hostInfoCache.set(host.name, resolved);
		return resolved;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		logger.warn("Failed to load SSH host info", { host: host.name, error: String(err) });
		return undefined;
	}
}

async function loadHostInfoFromDiskByName(hostName: string): Promise<SSHHostInfo | undefined> {
	const path = getHostInfoPath(hostName);
	try {
		const raw = await fs.promises.readFile(path, "utf-8");
		const parsed = parseHostInfo(JSON.parse(raw));
		if (!parsed) return undefined;
		return parsed;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		logger.warn("Failed to load SSH host info", { host: hostName, error: String(err) });
		return undefined;
	}
}

async function persistHostInfo(host: SSHConnectionTarget, info: SSHHostInfo): Promise<void> {
	try {
		const path = getHostInfoPath(host.name);
		const payload = { ...info, version: HOST_INFO_VERSION };
		hostInfoCache.set(host.name, payload);
		await Bun.write(path, JSON.stringify(payload, null, 2), { createPath: true });
	} catch (err) {
		logger.warn("Failed to persist SSH host info", { host: host.name, error: String(err) });
	}
}

async function probeHostInfo(host: SSHConnectionTarget): Promise<SSHHostInfo> {
	const command = 'echo "$OSTYPE|$SHELL|$BASH_VERSION" 2>/dev/null || echo "%OS%|%COMSPEC%|"';
	const result = await runSshCaptureSync(await buildRemoteCommand(host, command));
	if (result.exitCode !== 0 && !result.stdout) {
		logger.debug("SSH host probe failed", { host: host.name, error: result.stderr });
		const fallback: SSHHostInfo = {
			version: HOST_INFO_VERSION,
			os: "unknown",
			shell: "unknown",
			compatShell: undefined,
			compatEnabled: false,
		};
		hostInfoCache.set(host.name, fallback);
		return fallback;
	}

	const output = (result.stdout || result.stderr).split("\n")[0]?.trim() ?? "";
	const [rawOs = "", rawShell = "", rawBash = ""] = output.split("|");
	const ostype = rawOs.trim();
	const shellRaw = rawShell.trim();
	const bashVersion = rawBash.trim();
	const outputLower = output.toLowerCase();
	const osLower = ostype.toLowerCase();
	const shellLower = shellRaw.toLowerCase();
	const unexpandedPosixVars =
		output.includes("$OSTYPE") || output.includes("$SHELL") || output.includes("$BASH_VERSION");
	const windowsDetected =
		osLower.includes("windows") ||
		osLower.includes("msys") ||
		osLower.includes("cygwin") ||
		osLower.includes("mingw") ||
		outputLower.includes("windows_nt") ||
		outputLower.includes("comspec") ||
		shellLower.includes("cmd") ||
		shellLower.includes("powershell") ||
		unexpandedPosixVars ||
		output.includes("%OS%");

	let os: SSHHostOs = "unknown";
	if (windowsDetected) {
		os = "windows";
	} else if (osLower.includes("darwin")) {
		os = "macos";
	} else if (osLower.includes("linux") || osLower.includes("gnu")) {
		os = "linux";
	}

	// Reuse parseShell so probe-time and cached classification stay identical.
	let shell = parseShell(shellLower) ?? "unknown";
	if (shell === "unknown" && os === "windows" && !shellLower) {
		shell = "cmd";
	}

	const hasBash = !unexpandedPosixVars && (Boolean(bashVersion) || shell === "bash");
	let compatShell: SSHHostInfo["compatShell"];
	if (os === "windows" && host.compat !== false) {
		const bashProbe = await runSshCaptureSync(await buildRemoteCommand(host, 'bash -lc "echo PI_BASH_OK"'));
		if (bashProbe.exitCode === 0 && bashProbe.stdout.includes("PI_BASH_OK")) {
			compatShell = "bash";
		} else {
			const shProbe = await runSshCaptureSync(await buildRemoteCommand(host, 'sh -lc "echo PI_SH_OK"'));
			if (shProbe.exitCode === 0 && shProbe.stdout.includes("PI_SH_OK")) {
				compatShell = "sh";
			}
		}
	} else if (os === "windows" && hasBash) {
		compatShell = "bash";
	} else if (os === "windows" && shell === "sh") {
		compatShell = "sh";
	}
	const compatEnabled = host.compat === false ? false : os === "windows" && compatShell !== undefined;

	const info: SSHHostInfo = applyCompatOverride(host, {
		version: HOST_INFO_VERSION,
		os,
		shell,
		compatShell,
		compatEnabled,
	});

	hostInfoCache.set(host.name, info);
	await persistHostInfo(host, info);
	return info;
}

export async function getHostInfo(hostName: string): Promise<SSHHostInfo | undefined> {
	const cached = hostInfoCache.get(hostName);
	if (cached) return cached;
	return loadHostInfoFromDiskByName(hostName);
}

export async function getHostInfoForHost(host: SSHConnectionTarget): Promise<SSHHostInfo | undefined> {
	const cached = hostInfoCache.get(host.name);
	if (cached) {
		const resolved = applyCompatOverride(host, cached);
		if (resolved !== cached) hostInfoCache.set(host.name, resolved);
		return resolved;
	}
	return await loadHostInfoFromDisk(host);
}

/**
 * Synchronous, probe-free host info lookup for startup paths.
 *
 * Checks the in-memory cache, then falls back to a synchronous read of the
 * persisted host-info cache file. Never opens a connection or probes the
 * remote host — callers get `undefined` when nothing is cached yet.
 */
export function getCachedHostInfoSync(host: SSHConnectionTarget): SSHHostInfo | undefined {
	const cached = hostInfoCache.get(host.name);
	if (cached) {
		const resolved = applyCompatOverride(host, cached);
		if (resolved !== cached) hostInfoCache.set(host.name, resolved);
		return resolved;
	}
	try {
		const parsed = parseHostInfo(JSON.parse(fs.readFileSync(getHostInfoPath(host.name), "utf-8")));
		if (!parsed) return undefined;
		const resolved = applyCompatOverride(host, parsed);
		hostInfoCache.set(host.name, resolved);
		return resolved;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		logger.warn("Failed to load SSH host info", { host: host.name, error: String(err) });
		return undefined;
	}
}

export async function ensureHostInfo(host: SSHConnectionTarget): Promise<SSHHostInfo> {
	const cached = hostInfoCache.get(host.name);
	if (cached) {
		const resolved = applyCompatOverride(host, cached);
		hostInfoCache.set(host.name, resolved);
		if (!shouldRefreshHostInfo(host, resolved)) return resolved;
	}
	const fromDisk = await loadHostInfoFromDisk(host);
	if (fromDisk && !shouldRefreshHostInfo(host, fromDisk)) return fromDisk;
	await ensureConnection(host);
	const current = hostInfoCache.get(host.name);
	if (current && !shouldRefreshHostInfo(host, current)) return current;
	return probeHostInfo(host);
}

export async function buildRemoteCommand(
	host: SSHConnectionTarget,
	command: string,
	options?: SSHArgsOptions,
): Promise<string[]> {
	await validateKeyPermissions(host.keyPath, options?.platform);
	return [...buildCommonArgs(host, options), buildSshTarget(host.username, host.host), command];
}

let registered = false;

export async function ensureConnection(host: SSHConnectionTarget): Promise<void> {
	const key = host.name;
	const pending = pendingConnections.get(key);
	if (pending) {
		await pending;
		return;
	}

	const promise = (async () => {
		ensureSshBinary();
		ensureControlDir();
		await validateKeyPermissions(host.keyPath);

		if (!registered) {
			registered = true;
			postmortem.register("ssh-cleanup", async () => {
				await closeAllConnections();
			});
		}

		const target = buildSshTarget(host.username, host.host);
		if (!supportsSshControlMaster()) {
			activeHosts.set(key, host);
			if (!hostInfoCache.has(key) && !(await loadHostInfoFromDisk(host))) {
				await probeHostInfo(host);
			}
			return;
		}

		const check = await runSshSync(["-O", "check", ...buildCommonArgs(host), target]);
		if (check.exitCode === 0) {
			activeHosts.set(key, host);
			if (!hostInfoCache.has(key) && !(await loadHostInfoFromDisk(host))) {
				await probeHostInfo(host);
			}
			return;
		}

		const start = await runSshSync(["-M", "-N", "-f", ...buildCommonArgs(host), target]);
		if (start.exitCode !== 0) {
			const detail = start.stderr ? `: ${start.stderr}` : "";
			throw new Error(`Failed to start SSH master for ${target}${detail}`);
		}

		activeHosts.set(key, host);
		if (!hostInfoCache.has(key) && !(await loadHostInfoFromDisk(host))) {
			await probeHostInfo(host);
		}
	})();

	pendingConnections.set(key, promise);
	try {
		await promise;
	} finally {
		pendingConnections.delete(key);
	}
}

export async function invalidateHostMetadata(hostNames: Iterable<string>): Promise<void> {
	const names = [...hostNames];
	for (const hostName of names) {
		hostInfoCache.delete(hostName);
		await deleteHostInfoFromDisk(hostName);
	}
	for (const hostName of names) {
		const activeHost = activeHosts.get(hostName);
		if (activeHost) {
			await closeConnectionInternal(activeHost);
			activeHosts.delete(hostName);
			continue;
		}
		await closeConnectionInternal({ name: hostName, host: hostName });
	}
}

async function closeConnectionInternal(host: SSHConnectionTarget): Promise<void> {
	if (!supportsSshControlMaster()) return;
	const target = buildSshTarget(host.username, host.host);
	await runSshSync(["-O", "exit", ...buildCommonArgs(host), target]);
}

export async function closeConnection(hostName: string): Promise<void> {
	await invalidateHostMetadata([hostName]);
}

export async function closeAllConnections(): Promise<void> {
	for (const [name, host] of Array.from(activeHosts.entries())) {
		await closeConnectionInternal(host);
		activeHosts.delete(name);
	}
}

export function getControlPathTemplate(): string {
	return CONTROL_PATH;
}

export function getControlDir(): string {
	return CONTROL_DIR;
}
