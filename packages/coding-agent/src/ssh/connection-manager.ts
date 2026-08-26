import * as fs from "node:fs";
import * as path from "node:path";
import { $which, getRemoteHostDir, getSshControlDir, isEnoent, logger, postmortem, ptree } from "@oh-my-pi/pi-utils";
import { buildPowerShellCommand, buildSshTarget, type PowerShellShell, sanitizeHostName } from "./utils";

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
	/**
	 * Shell OMP verified can execute the `ssh://` transfer snippets — a POSIX
	 * shell (`head`/`cat`/`mv`/`test`/`ls`) via `sh`/`bash`/`zsh` on POSIX
	 * remotes, or PowerShell (`-EncodedCommand` channel) on Windows remotes.
	 * Probed by round-tripping a known marker under each candidate; the first
	 * hit wins (`sh`→`bash`→`zsh` for POSIX, `powershell`→`pwsh` for Windows).
	 * Independent of `shell` (the self-reported login shell), which may be
	 * noisy, exotic, or simply mis-classified — only `transferShell` gates
	 * ssh:// transfers (#3719).
	 */
	transferShell?: "sh" | "bash" | "zsh" | PowerShellShell;
	compatShell?: "bash" | "sh";
	compatEnabled: boolean;
}

/**
 * OpenSSH ControlPath sizing.
 *
 * The multiplexing master binds its listening socket at `ControlPath`, but
 * `muxserver_listen` first binds a *temporary* path — the expanded `ControlPath`
 * plus a "." and a 16-char random suffix — before atomically renaming it into
 * place. That temporary path, not the final `%C.sock`, is what OpenSSH's
 * `unix_listener()` length-checks against `sizeof(sockaddr_un.sun_path)`, so the
 * budget below reserves it (issue #9070). A path whose length reaches the
 * platform limit is rejected outright ("... too long for Unix domain socket").
 */
const CONTROL_SOCKET_BASENAME = "%C.sock";
/** Bytes `%C.sock` expands to: a 40-char connection digest plus ".sock". */
const CONTROL_SOCKET_NAME_BYTES = 40 + ".sock".length;
/** "." + 16 random chars appended by `muxserver_listen` while binding. */
const MUX_TEMP_SUFFIX_BYTES = 1 + 16;

/**
 * Whether `controlDir` leaves room for the whole `%C.sock` plus OpenSSH's mux
 * temp bind within `sun_path` (104 bytes on macOS, 108 elsewhere; OpenSSH
 * rejects lengths >= that). The worst case is dir + "/" + expanded `%C.sock`
 * (40-hex digest + ".sock") + the mux temp suffix.
 */
export function controlPathFitsBudget(controlDir: string, platform: SshPlatform): boolean {
	const sunPathLimit = platform === "darwin" ? 104 : 108;
	const worstCase = Buffer.byteLength(controlDir) + 1 + CONTROL_SOCKET_NAME_BYTES + MUX_TEMP_SUFFIX_BYTES;
	return worstCase < sunPathLimit;
}

/**
 * Deterministic, depth-bounded control directory used when the canonical
 * control directory would overflow `sun_path` (#9070). The digest keys both
 * uid and the fully resolved canonical control directory, separated by NUL so
 * their boundaries are unambiguous. This preserves isolation when the same
 * profile resolves through different XDG state roots without spending variable
 * path bytes on the decimal uid.
 */
export function sshControlFallbackDir(canonicalDir: string, uid: number, tmpBase = "/tmp"): string {
	const key = new Bun.CryptoHasher("sha256")
		.update(String(uid))
		.update("\0")
		.update(canonicalDir)
		.digest("hex")
		.slice(0, 20);
	return path.join(tmpBase, `omp-${key}`);
}

interface ControlDirChoice {
	dir: string;
	/** True when `dir` is the shared-temp fallback and needs owner-private hardening. */
	shared: boolean;
}

/**
 * Choose the SSH control directory. Prefers the canonical profile-rooted path
 * and only relocates to {@link sshControlFallbackDir} when the canonical path
 * cannot hold the full `%C.sock` + mux temp bind within `sun_path`. Platforms
 * without ControlMaster (Windows) or without a uid keep the canonical path.
 */
export function resolveSshControlDir(opts: {
	canonicalDir: string;
	platform: SshPlatform;
	uid: number | undefined;
	tmpBase?: string;
}): ControlDirChoice {
	const { canonicalDir, platform, uid, tmpBase } = opts;
	if (!supportsSshControlMaster(platform) || uid === undefined) return { dir: canonicalDir, shared: false };
	if (controlPathFitsBudget(canonicalDir, platform)) return { dir: canonicalDir, shared: false };
	return { dir: sshControlFallbackDir(canonicalDir, uid, tmpBase), shared: true };
}

interface ControlDirGuardStat {
	isSymlink: boolean;
	isDir: boolean;
	uid: number;
	mode: number;
}

/**
 * Reject reasons for an owner-private control directory reused from a shared
 * temp base: it must be a real directory (not a symlink an attacker planted),
 * owned by us, with no group/other access. Returns `null` when the directory is
 * safe to use. Pure so the rejection matrix is testable without root.
 */
export function controlDirGuardError(stat: ControlDirGuardStat, expectedUid: number | undefined): string | null {
	if (stat.isSymlink) return "is a symlink";
	if (!stat.isDir) return "is not a directory";
	if (expectedUid !== undefined && stat.uid !== expectedUid) {
		return `is owned by uid ${stat.uid}, not ${expectedUid}`;
	}
	if ((stat.mode & 0o777) !== 0o700) return `must be mode 0700, got ${(stat.mode & 0o777).toString(8)}`;
	return null;
}

const { dir: CONTROL_DIR, shared: CONTROL_DIR_SHARED } = resolveSshControlDir({
	canonicalDir: getSshControlDir(),
	platform: process.platform,
	uid: process.getuid?.(),
});
const CONTROL_PATH = path.join(CONTROL_DIR, CONTROL_SOCKET_BASENAME);
const HOST_INFO_DIR = getRemoteHostDir();
const HOST_INFO_VERSION = 5;

const activeHosts = new Map<string, SSHConnectionTarget>();
const pendingConnections = new Map<string, Promise<void>>();
const hostInfoCache = new Map<string, SSHHostInfo>();

interface SSHArgsOptions {
	platform?: SshPlatform;
	/** When true, omit `-n` so the remote command can read from our piped stdin. */
	allowStdin?: boolean;
}

/**
 * Create the shared SSH ControlMaster directory and enforce its trust boundary.
 *
 * Both direct SSH connections and sshfs mounts MUST call this before launching
 * OpenSSH so the bounded `/tmp` fallback cannot bypass the symlink, owner, or
 * mode checks.
 */
export function ensureSshControlDir(): void {
	fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
	if (CONTROL_DIR_SHARED) {
		assertOwnerPrivateDir(CONTROL_DIR);
		return;
	}
	try {
		fs.chmodSync(CONTROL_DIR, 0o700);
	} catch (err) {
		logger.debug("SSH control dir chmod failed", { path: CONTROL_DIR, error: String(err) });
	}
}

/**
 * Harden a control directory pulled from a shared temp base ({@link CONTROL_DIR_SHARED}).
 *
 * Opens the final path component with `O_NOFOLLOW | O_DIRECTORY` so a symlink or
 * non-directory is refused atomically at open time, then inspects and normalizes
 * that one pinned inode through the fd (`fstat`/`fchmod`) — never a second
 * pathname lookup. This closes the swap window where another local user could
 * replace the entry with a symlink between two `stat`s and slip a victim-owned
 * 0700 target past the checks (#9070). Rejects a symlink, a non-directory, a
 * foreign owner, or lingering group/other access via {@link controlDirGuardError}.
 * Exported as a test seam.
 */
export function assertOwnerPrivateDir(dir: string): void {
	const uid = process.getuid?.();
	let fd: number;
	try {
		fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// O_NOFOLLOW rejects a symlinked final component; kernels report it as
		// either ELOOP or (with O_DIRECTORY) ENOTDIR. Either way the entry is
		// already refused — we only lstat here to label the failure precisely, so
		// a swap after this point cannot weaken the (already-final) rejection.
		if (code === "ELOOP" || code === "ENOTDIR") {
			let isSymlink = false;
			try {
				isSymlink = fs.lstatSync(dir).isSymbolicLink();
			} catch {}
			throw new Error(`SSH control directory ${dir} ${isSymlink ? "is a symlink" : "is not a directory"}`);
		}
		throw err;
	}
	try {
		let st = fs.fstatSync(fd);
		// Normalize perms on the pinned inode only when it is ours; never fchmod a
		// directory another user owns.
		if ((uid === undefined || st.uid === uid) && (st.mode & 0o777) !== 0o700) {
			try {
				fs.fchmodSync(fd, 0o700);
				st = fs.fstatSync(fd);
			} catch (err) {
				logger.debug("SSH control dir chmod failed", { path: dir, error: String(err) });
			}
		}
		const reason = controlDirGuardError(
			{ isSymlink: false, isDir: st.isDirectory(), uid: st.uid, mode: st.mode },
			uid,
		);
		if (reason) {
			throw new Error(`SSH control directory ${dir} ${reason}`);
		}
	} finally {
		fs.closeSync(fd);
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

/**
 * Per-call timeout for the pre-command SSH setup/probe helpers. These sit on
 * the `ensureHostInfo` → `probeHostInfo` / `ensureConnection` path that runs
 * *before* `SshTool.execute` applies the user-provided command timeout, so an
 * unreachable host or wedged control-master would otherwise hang forever
 * (#4232). `allowNonZero`/`allowAbort` keep the "return a failure result"
 * contract that these helpers had under `.quiet().nothrow()`.
 */
const SSH_HELPER_TIMEOUT_MS = 30_000;

async function runSshSync(
	args: string[],
	timeoutMs = SSH_HELPER_TIMEOUT_MS,
): Promise<{ exitCode: number | null; stderr: string }> {
	const result = await ptree.exec(["ssh", ...args], {
		timeout: timeoutMs,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full",
	});
	return { exitCode: result.exitCode, stderr: result.stderr.trim() };
}

async function runSshCaptureSync(
	args: string[],
	timeoutMs = SSH_HELPER_TIMEOUT_MS,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const result = await ptree.exec(["ssh", ...args], {
		timeout: timeoutMs,
		allowNonZero: true,
		allowAbort: true,
		stderr: "full",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.trim(),
		stderr: result.stderr.trim(),
	};
}

/**
 * Test-only surface for exercising the pre-command SSH helpers against a
 * fake `ssh` binary with a shortened timeout. External code MUST NOT depend
 * on this — call `ensureConnection` / `ensureHostInfo` instead.
 * @internal
 */
export const _sshHelpersForTests = { runSshSync, runSshCaptureSync };

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

function parseTransferShell(value: unknown): SSHHostInfo["transferShell"] {
	if (value === "sh" || value === "bash" || value === "zsh" || value === "powershell" || value === "pwsh") {
		return value;
	}
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

/**
 * Parse a raw cache-file value (or any unknown) into a normalized
 * {@link SSHHostInfo}, dropping fields that don't pass the per-field guards.
 * Exported so cache-layer round-tripping (incl. the new `transferShell`
 * field, #3719) is testable without touching disk.
 */
export function parseHostInfo(value: unknown): SSHHostInfo | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const os = parseOs(record.os) ?? "unknown";
	const shell = parseShell(record.shell) ?? "unknown";
	const compatShell = parseCompatShell(record.compatShell);
	const transferShell = parseTransferShell(record.transferShell);
	const compatEnabled = typeof record.compatEnabled === "boolean" ? record.compatEnabled : false;
	const version = typeof record.version === "number" ? record.version : 0;
	return {
		version,
		os,
		shell,
		transferShell,
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
	// A Windows host with no PowerShell-family transfer shell is the same
	// ambiguity as the POSIX case below: re-probe rather than refuse forever
	// (pwsh may have been installed since the last attempt).
	if (info.os === "windows" && !info.transferShell) return true;
	// A non-Windows host with no verified POSIX transfer shell is ambiguous —
	// either the probe never ran capability checks, or every candidate failed.
	// Re-probe rather than letting the ssh:// transfer guard reject it on a
	// stale `shell: "unknown"` classification (#3719).
	if (info.os !== "windows" && !info.transferShell) return true;
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

/**
 * Frame marker emitted by the remote OS/shell probe. The probe wraps its
 * payload in this prefix so the parser can ignore startup-file noise (banners,
 * `motd`, login messages, `Last login: …`) instead of trusting only the first
 * line of stdout. See #3719.
 */
export const HOST_PROBE_MARKER = "PI_HOST_PROBE=";

/** Marker for the transfer-shell capability probe. */
export const TRANSFER_PROBE_MARKER = "PI_TRANSFER_OK|";

/** sh / bash / zsh, in the order we'll try as `transferShell` candidates. */
const TRANSFER_SHELL_CANDIDATES = ["sh", "bash", "zsh"] as const;

/**
 * Find the first line of `stdout`/`stderr` that begins with `marker` and
 * return everything after it. Used by the SSH host probe so noisy login
 * dotfiles can't corrupt OS/shell classification by emitting text on the
 * first line of `ssh` output.
 *
 * Returns `null` when no marker line is found in either stream.
 */
export function extractProbePayload(stdout: string, stderr: string, marker = HOST_PROBE_MARKER): string | null {
	for (const blob of [stdout, stderr]) {
		if (!blob) continue;
		for (const line of blob.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith(marker)) {
				return trimmed.slice(marker.length);
			}
		}
	}
	return null;
}

/**
 * Find `marker` anywhere in `stdout` or `stderr` and return everything that
 * follows it, scanning stdout first. Returns `null` when the marker is in
 * neither stream.
 *
 * Used by the transfer-shell capability probe. Some remotes have broken
 * login dotfiles that swap fd 1/2, so the marker can land on stderr even
 * though the probe ran the printf successfully (matches the host-info
 * probe's stderr fallback). See #3719.
 */
export function findProbeMarker(stdout: string, stderr: string, marker: string): string | null {
	for (const blob of [stdout, stderr]) {
		if (!blob) continue;
		const idx = blob.indexOf(marker);
		if (idx !== -1) return blob.slice(idx + marker.length);
	}
	return null;
}

/** Classify a POSIX-ish `uname -s` payload from the transfer-shell probe. */
export function osFromUname(value: string): SSHHostOs | undefined {
	const uname = value.toLowerCase();
	if (uname.includes("darwin")) return "macos";
	if (uname.includes("linux") || uname.includes("gnu")) return "linux";
	if (uname.includes("mingw") || uname.includes("msys") || uname.includes("cygwin") || uname.includes("windows")) {
		return "windows";
	}
	return undefined;
}

async function probeTransferShell(
	host: SSHConnectionTarget,
): Promise<{ shell: SSHHostInfo["transferShell"]; uname: string }> {
	for (const candidate of TRANSFER_SHELL_CANDIDATES) {
		// `printf` is POSIX and emits no trailing newline, so we can pin the
		// marker right against the uname output and split on it cleanly.
		const remote = `${candidate} -lc 'printf "${TRANSFER_PROBE_MARKER}"; uname -s 2>/dev/null || true'`;
		const probe = await runSshCaptureSync(await buildRemoteCommand(host, remote));
		if (probe.exitCode !== 0) continue;
		const tail = findProbeMarker(probe.stdout, probe.stderr, TRANSFER_PROBE_MARKER);
		if (tail === null) continue;
		return { shell: candidate, uname: tail.trim() };
	}
	return { shell: undefined, uname: "" };
}

/** Marker round-tripped by the Windows PowerShell transfer-shell probe. */
export const POWERSHELL_PROBE_MARKER = "PI_PS_OK";

/** powershell.exe ships with every Windows; pwsh covers PS7-only machines. */
const WINDOWS_TRANSFER_CANDIDATES: readonly PowerShellShell[] = ["powershell", "pwsh"];

async function probePowershellTransferShell(host: SSHConnectionTarget): Promise<SSHHostInfo["transferShell"]> {
	for (const candidate of WINDOWS_TRANSFER_CANDIDATES) {
		const remote = buildPowerShellCommand(candidate, `Write-Output '${POWERSHELL_PROBE_MARKER}'`);
		const probe = await runSshCaptureSync(await buildRemoteCommand(host, remote));
		if (probe.exitCode !== 0) continue;
		if (findProbeMarker(probe.stdout, probe.stderr, POWERSHELL_PROBE_MARKER) === null) continue;
		return candidate;
	}
	return undefined;
}

async function probeHostInfo(host: SSHConnectionTarget): Promise<SSHHostInfo> {
	const command = `echo "${HOST_PROBE_MARKER}$OSTYPE|$SHELL|$BASH_VERSION" 2>/dev/null || echo "${HOST_PROBE_MARKER}%OS%|%COMSPEC%|"`;
	const result = await runSshCaptureSync(await buildRemoteCommand(host, command));
	const payload = extractProbePayload(result.stdout, result.stderr);
	if (payload === null) {
		logger.debug("SSH host probe failed", { host: host.name, error: result.stderr });
		const transferProbe = await probeTransferShell(host);
		let fallbackOs: SSHHostOs = "unknown";
		let transferShell: SSHHostInfo["transferShell"];
		if (transferProbe.shell) {
			const probed = osFromUname(transferProbe.uname);
			if (probed === "windows") {
				// msys/cygwin sh answered the classification probe, but transfer
				// never rides an msys sh (its /g/ ↔ G:\ path translation is
				// unreliable and it is not a stock component) — route through
				// PowerShell like every other Windows host.
				fallbackOs = "windows";
				transferShell = await probePowershellTransferShell(host);
			} else {
				fallbackOs = probed ?? "unknown";
				transferShell = transferProbe.shell;
			}
		} else {
			// No POSIX shell answered. Windows hosts whose default shell is
			// cmd, or whose SSH session PATH lacks every sh, land here — probe
			// PowerShell before giving up (powershell.exe is a stock component).
			transferShell = await probePowershellTransferShell(host);
			if (transferShell) fallbackOs = "windows";
		}
		const fallback: SSHHostInfo = {
			version: HOST_INFO_VERSION,
			os: fallbackOs,
			shell: "unknown",
			transferShell,
			compatShell: undefined,
			compatEnabled: false,
		};
		await persistHostInfo(host, fallback);
		return fallback;
	}

	const [rawOs = "", rawShell = "", rawBash = ""] = payload.split("|");
	const ostype = rawOs.trim();
	const shellRaw = rawShell.trim();
	const bashVersion = rawBash.trim();
	const payloadLower = payload.toLowerCase();
	const osLower = ostype.toLowerCase();
	const shellLower = shellRaw.toLowerCase();
	const unexpandedPosixVars =
		payload.includes("$OSTYPE") || payload.includes("$SHELL") || payload.includes("$BASH_VERSION");
	const windowsDetected =
		osLower.includes("windows") ||
		osLower.includes("msys") ||
		osLower.includes("cygwin") ||
		osLower.includes("mingw") ||
		payloadLower.includes("windows_nt") ||
		payloadLower.includes("comspec") ||
		shellLower.includes("cmd") ||
		shellLower.includes("powershell") ||
		unexpandedPosixVars ||
		payload.includes("%OS%");

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

	// For any non-Windows host (including `unknown`, which is often a misclassified
	// POSIX remote with noisy login output) verify a working transfer shell by
	// running `sh -lc` / `bash -lc` / `zsh -lc` against it. The first one whose
	// printf round-trips becomes `transferShell`; ssh:// gates on this rather
	// than the self-reported login-shell name (#3719).
	let transferShell: SSHHostInfo["transferShell"];
	if (os !== "windows") {
		const probe = await probeTransferShell(host);
		transferShell = probe.shell;
		// `uname -s` from the same probe lets us recover the OS when the first
		// probe couldn't classify it (e.g. the remote silently nuked `$OSTYPE`).
		if (transferShell && os === "unknown") {
			os = osFromUname(probe.uname) ?? os;
			if (os === "windows") {
				// The shell that answered was an msys/cygwin sh: it recovered
				// the OS as windows, but transfer never rides an msys sh (its
				// /g/ ↔ G:\ path translation is unreliable and it is not a
				// stock component) — discard it and re-probe through
				// PowerShell like every other Windows host.
				transferShell = await probePowershellTransferShell(host);
			}
		} else if (!transferShell && os === "unknown") {
			// No POSIX shell answered and the compound probe left the OS
			// unclassifiable. A Windows host whose default shell is cmd and
			// whose session PATH lacks every sh lands here — probe PowerShell
			// before leaving the host unknown forever (mirrors the
			// payload-null fallback's else-arm).
			transferShell = await probePowershellTransferShell(host);
			if (transferShell) os = "windows";
		}
	} else {
		transferShell = await probePowershellTransferShell(host);
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
		transferShell,
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
		ensureSshControlDir();
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
