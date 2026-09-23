/**
 * Byte-preserving remote file I/O over the shared SSH ControlMaster connection.
 *
 * Unlike `executeSSH` (which truncates/sanitizes through an OutputSink) and
 * `runSshCaptureSync` (which `.trim()`s output), these helpers move raw bytes so
 * `ssh://` reads/writes round-trip exactly — leading/trailing whitespace, tabs,
 * and final newlines are preserved.
 */
import { ptree } from "@oh-my-pi/pi-utils";
import { buildRemoteCommand, ensureConnection, ensureHostInfo, type SSHConnectionTarget } from "./connection-manager";
import { quotePosixPath, wrapInPosixShell } from "./utils";

/** Per-operation timeout for remote transfers (matches the ssh tool's grep window). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Ensure the ControlMaster connection and pick the verified POSIX shell to
 * run transfer commands under. Returns the shell name so the caller can
 * wrap its snippet in `<shell> -c '…'`; OpenSSH otherwise hands the command
 * to the user's login shell, which on fish/csh/tcsh hosts can't parse our
 * `if [ … ]; then …` constructs (#3719).
 *
 * Windows hosts are refused up front — `ssh://` runs `head`/`cat`/`mv`/`test`
 * directly and cmd/powershell can't drive those. Everywhere else, we require
 * a non-empty `transferShell` (set by `probeHostInfo` after `sh -lc` /
 * `bash -lc` / `zsh -lc` round-trips a marker against the remote).
 */
async function ensurePosixRemote(target: SSHConnectionTarget): Promise<"sh" | "bash" | "zsh"> {
	await ensureConnection(target);
	const info = await ensureHostInfo(target);
	if (info.os === "windows") {
		throw new Error(
			`ssh://: ${target.name} is a Windows host; ssh:// supports POSIX remotes only (head/cat/mv) — use \`bash\` with a remote SSH command for Windows hosts`,
		);
	}
	if (!info.transferShell) {
		throw new Error(
			`ssh://: ${target.name} has no verified POSIX shell for ssh:// read/write — none of sh/bash/zsh round-tripped a capability probe (use \`bash\` with a remote SSH command for this host)`,
		);
	}
	return info.transferShell;
}

export interface RemoteFileReadOptions {
	/** Maximum bytes to materialize; the helper fetches one extra byte to detect truncation. */
	maxBytes: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface RemoteFileReadResult {
	/** Raw file bytes, capped at `maxBytes`. */
	bytes: Uint8Array;
	/** True when the remote file was larger than `maxBytes` (`bytes` is the prefix). */
	truncated: boolean;
}

export interface RemoteFileWriteOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Read a remote file's raw bytes. Fetches `maxBytes + 1` so the caller can
 * distinguish an exactly-`maxBytes` file from a larger (truncated) one.
 *
 * Throws `ptree.NonZeroExitError` (carrying the remote stderr tail) when the
 * file is missing/unreadable or the host is unreachable.
 */
export async function readRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: RemoteFileReadOptions,
): Promise<RemoteFileReadResult> {
	const shell = await ensurePosixRemote(target);
	const command = `head -c ${opts.maxBytes + 1} ${quotePosixPath(remotePath)}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	// Drain stdout before awaiting exit so a full pipe can't deadlock the child.
	const raw = await child.bytes();
	await child.exitedCleanly;
	const truncated = raw.length > opts.maxBytes;
	return { bytes: truncated ? raw.subarray(0, opts.maxBytes) : raw, truncated };
}

/**
 * Write `content` to a remote file byte-exact. Stdin is always staged first into
 * a uniquely named temp in the destination directory (so the remote never blocks
 * on an unread pipe and a dropped connection lands in the temp, never the
 * destination). The destination then dictates the commit:
 *  - a directory — or a symlink to one, since the `-d` test follows links — is
 *    refused (a plain `mv tmp dir` would move the temp INTO it).
 *  - an existing non-symlink regular file is rewritten IN PLACE from the staged
 *    temp, preserving its inode and therefore its ordinary permission bits (a
 *    `0600` secret stays `0600` on overwrite), ACLs, xattrs, and hardlinks. The
 *    setuid/setgid bits may be cleared by the write (per POSIX). This commit is
 *    not fully atomic — a remote-side failure during the local temp->dest copy
 *    (e.g. the disk filling) can truncate the destination — but the slow network
 *    transfer has already landed in the temp, and the temp is removed on failure.
 *    It also needs write permission on the file itself (a read-only file is
 *    refused, not silently replaced).
 *  - an existing special file (FIFO/socket/device) is refused, not replaced.
 *  - anything else (a new path, a symlink to a non-directory, a dangling symlink)
 *    is committed with an atomic rename, which REPLACES a symlink with a regular
 *    file rather than writing through it (resolving the link target is not
 *    portable across the macOS/Linux hosts this stack supports).
 * Throws `ptree.NonZeroExitError` when the remote path is unwritable or the host
 * is unreachable.
 */
export async function writeRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	content: Uint8Array,
	opts: RemoteFileWriteOptions,
): Promise<void> {
	const shell = await ensurePosixRemote(target);
	if (remotePath.endsWith("/")) {
		throw new Error("ssh://: destination is a directory path (trailing '/'); ssh:// write requires a file path");
	}
	const dest = quotePosixPath(remotePath);
	const tmp = quotePosixPath(`${remotePath}.omp-tmp.${crypto.randomUUID()}`);
	// Stage stdin into the temp first (so the remote never blocks on an unread
	// pipe and a dropped connection lands in the temp, never the destination).
	// An EXIT trap removes the staged temp on every exit path (staging failure,
	// in-place success, refuse branches, or a failed rename). Commit by
	// destination kind: a directory (or symlink to one; `-d` follows links) is
	// refused; an existing non-symlink regular file is rewritten IN PLACE
	// (preserving inode, permission bits, ACLs, xattrs, hardlinks; setuid/setgid
	// may clear); an existing special file (FIFO/socket/device) is refused;
	// anything else (a new path or a symlink to a non-directory) uses temp+rename,
	// replacing such a symlink rather than writing through it.
	const command =
		`t=${tmp}; trap 'rm -f -- "$t"' 0; ` +
		`mkdir -p -- "$(dirname "$t")" && ` +
		`cat > "$t" && { ` +
		`if [ -d ${dest} ]; then echo 'ssh://: destination is a directory' >&2; exit 1; ` +
		`elif [ -f ${dest} ] && [ ! -L ${dest} ]; then cat "$t" > ${dest} || exit 1; ` +
		`elif [ -e ${dest} ] && [ ! -L ${dest} ]; then echo 'ssh://: destination is a special file (not a regular file)' >&2; exit 1; ` +
		`else mv "$t" ${dest}; fi; ` +
		`}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command), { allowStdin: true });
	using child = ptree.spawn(["ssh", ...args], {
		stdin: content,
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	await child.exitedCleanly;
}

/** Classification of a remote path, used by the read handler's directory dispatch. */
export type RemotePathKind = "file" | "directory" | "other" | "missing";

/**
 * Classify a remote path with POSIX `test` (portable across Linux/BSD/macOS):
 * `directory`, regular `file`, `other` (special file), or `missing`.
 */
export async function statRemotePath(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemotePathKind> {
	const shell = await ensurePosixRemote(target);
	const p = quotePosixPath(remotePath);
	const command = `if [ -d ${p} ]; then echo directory; elif [ -f ${p} ]; then echo file; elif [ -e ${p} ]; then echo other; else echo missing; fi`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	const out = new TextDecoder().decode(await child.bytes()).trim();
	await child.exitedCleanly;
	return out === "directory" || out === "file" || out === "other" ? out : "missing";
}

/** A single entry in a remote directory listing. */
export interface RemoteDirEntry {
	/** Entry name (no path component), trailing `/` stripped. */
	name: string;
	/** True when the entry is a directory. */
	isDirectory: boolean;
}

/**
 * List a remote directory one level deep with `ls -1Ap` (one per line; all
 * entries incl. dotfiles but not `.`/`..`; trailing `/` marks directories).
 * Plain `ls` (no `| head`) so a permission/race failure surfaces as a non-zero
 * exit instead of being masked as an empty listing. Entries are returned in
 * full, sorted directories-first then by name to mirror the local
 * directory-resource contract, so the read tool can paginate the listing.
 */
export async function listRemoteDir(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemoteDirEntry[]> {
	const shell = await ensurePosixRemote(target);
	const command = `LC_ALL=C ls -1Ap -- ${quotePosixPath(remotePath)}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	const text = new TextDecoder().decode(await child.bytes());
	await child.exitedCleanly;
	const entries = text
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => {
			const isDirectory = line.endsWith("/");
			return { name: isDirectory ? line.slice(0, -1) : line, isDirectory };
		});
	// JS sort is the order contract (mirrors buildDirectoryResource): dirs first, then by name.
	entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
	return entries;
}
