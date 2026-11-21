import * as fs from "node:fs";
import { logger } from "@oh-my-pi/pi-utils";

export interface OwnerPrivateDirStat {
	isSymlink: boolean;
	isDir: boolean;
	uid: number;
	mode: number;
}

/**
 * Reject reasons for an owner-private directory reused from a shared temp base:
 * it must be a real directory (not a symlink an attacker planted), owned by us,
 * with no group/other access. Returns `null` when the directory is safe to use.
 * Pure so the rejection matrix is testable without root.
 */
export function ownerPrivateDirError(stat: OwnerPrivateDirStat, expectedUid: number | undefined): string | null {
	if (stat.isSymlink) return "is a symlink";
	if (!stat.isDir) return "is not a directory";
	if (expectedUid !== undefined && stat.uid !== expectedUid) {
		return `is owned by uid ${stat.uid}, not ${expectedUid}`;
	}
	if ((stat.mode & 0o777) !== 0o700) return `must be mode 0700, got ${(stat.mode & 0o777).toString(8)}`;
	return null;
}

/**
 * Harden a directory pulled from a shared temp base, where another local user
 * may have created the path first.
 *
 * Opens the final path component with `O_NOFOLLOW | O_DIRECTORY` so a symlink or
 * non-directory is refused atomically at open time, then inspects and normalizes
 * that one pinned inode through the fd (`fstat`/`fchmod`) — never a second
 * pathname lookup. This closes the swap window where another local user could
 * replace the entry with a symlink between two `stat`s and slip a victim-owned
 * 0700 target past the checks (#9070). Rejects a symlink, a non-directory, a
 * foreign owner, or lingering group/other access via {@link ownerPrivateDirError}.
 * POSIX only: Windows lacks `O_NOFOLLOW`/`O_DIRECTORY`.
 *
 * @param label Human-readable directory role prefixed to the thrown message.
 */
export function assertOwnerPrivateDir(dir: string, label: string): void {
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
			throw new Error(`${label} ${dir} ${isSymlink ? "is a symlink" : "is not a directory"}`);
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
				logger.debug("Owner-private dir chmod failed", { path: dir, error: String(err) });
			}
		}
		const reason = ownerPrivateDirError(
			{ isSymlink: false, isDir: st.isDirectory(), uid: st.uid, mode: st.mode },
			uid,
		);
		if (reason) {
			throw new Error(`${label} ${dir} ${reason}`);
		}
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Verify a per-user runtime directory under the config root before reading or
 * pruning it: it must be a real directory, and on POSIX owned by the current
 * user. Callers that prune malformed entries depend on this — following a
 * planted symlink into an unrelated directory would turn listing into a
 * deletion tool. Returns the stat on POSIX, `null` on Windows.
 *
 * @param label Human-readable directory role prefixed to the thrown message.
 */
export async function assertPrivateRuntimeDir(dir: string, label: string): Promise<fs.Stats | null> {
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink: ${dir}`);
	if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`);
	if (process.platform === "win32") return null;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`${label} is not owned by the current user: ${dir}`);
	}
	return stat;
}

/**
 * Create a per-user runtime directory with owner-only POSIX permissions.
 * Windows retains the config root's ACL. `mkdir` with a mode leaves an
 * existing directory's permissions alone, so an already-present directory is
 * tightened explicitly; a symlink or a directory owned by another user is
 * refused rather than published into ({@link assertPrivateRuntimeDir}).
 */
export async function ensurePrivateRuntimeDir(dir: string, label: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await assertPrivateRuntimeDir(dir, label);
	if (stat && (stat.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}
