import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { getPrivateTempDir } from "@oh-my-pi/pi-utils/dirs";

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
 * A file {@link openPrivateTempFile} or {@link openPrivateTempFileSync}
 * opened, read and written through its descriptor until {@link close}. After
 * the close the process can give the number to another file, whose bytes a
 * read would take for this file's, so {@link fd} throws from then on and only
 * the first close closes it. Only those two make one, so the class is
 * exported as a type: no other module can wrap a descriptor of its own as a
 * private file.
 */
class PrivateTempFile {
	readonly #fd: number;
	#closed = false;

	constructor(fd: number) {
		this.#fd = fd;
	}

	/** The descriptor; throws once the file is closed. */
	get fd(): number {
		if (this.#closed) throw new Error("A private temporary file was used after it was closed");
		return this.#fd;
	}

	/** Whether {@link close} ran, so a holder can refuse a read in its own words before taking {@link fd}. */
	get closed(): boolean {
		return this.#closed;
	}

	/** Close the descriptor; a later call does nothing. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			fs.closeSync(this.#fd);
		} catch {
			// Already closed.
		}
	}
}

export type { PrivateTempFile };

/**
 * Open a new file, mode 0600, in account `uid`'s directory `prefix-<uid>`
 * under `os.tmpdir()` ({@link getPrivateTempDir}), made 0700 when missing and
 * used only when it is a directory (not a link to one) that the account owns
 * with mode 0700 ({@link assertOwnerPrivateDir}, which changes nothing here:
 * `mkdir` takes a directory that exists as it is, which another account
 * could have made first, or left open to others, and a caller that cannot
 * use it goes without it). The file is unlinked once open: its disk is freed
 * when the descriptor closes, and a killed process leaves nothing. Throws
 * when the directory or the file cannot be made or opened (`os.tmpdir()`
 * read-only, under a regular file, full, out of descriptors) or the
 * directory is refused; a file it opened and could not unlink is closed and
 * removed.
 *
 * @param label Human-readable directory role prefixed to a refusal's message.
 */
export function openPrivateTempFileSync(prefix: string, uid: number, label: string): PrivateTempFile {
	const dir = getPrivateTempDir(prefix, uid);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	assertOwnerPrivateDir(dir, label, { uid, repairMode: false });
	const file = path.join(dir, `${process.pid}-${crypto.randomUUID()}`);
	const fd = fs.openSync(file, "wx+", 0o600);
	try {
		fs.unlinkSync(file);
	} catch (error) {
		fs.closeSync(fd);
		fs.rmSync(file, { force: true });
		throw error;
	}
	return new PrivateTempFile(fd);
}

/**
 * {@link openPrivateTempFileSync} through asynchronous calls, which leave the
 * event loop free while they run. The directory check stays synchronous: an
 * open, a stat and a close of one directory's descriptor.
 */
export async function openPrivateTempFile(prefix: string, uid: number, label: string): Promise<PrivateTempFile> {
	const dir = getPrivateTempDir(prefix, uid);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	assertOwnerPrivateDir(dir, label, { uid, repairMode: false });
	const file = path.join(dir, `${process.pid}-${crypto.randomUUID()}`);
	const fd = await openDescriptor(file, "wx+", 0o600);
	try {
		await fs.promises.unlink(file);
	} catch (error) {
		fs.closeSync(fd);
		await fs.promises.rm(file, { force: true });
		throw error;
	}
	return new PrivateTempFile(fd);
}

/** `fs.open` of `file`, resolving with its descriptor: a number a {@link PrivateTempFile} can hold and close. */
function openDescriptor(file: string, flags: string, mode: number): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	fs.open(file, flags, mode, (err, fd) => {
		if (err) reject(err);
		else resolve(fd);
	});
	return promise;
}

/** How {@link assertOwnerPrivateDir} checks a directory. */
export interface OwnerPrivateDirOptions {
	/** The account that must own the directory; by default this process's, none where the platform has no account ids. */
	uid?: number;
	/**
	 * Whether a directory the account owns with group or other access is made
	 * 0700 (the default) rather than refused. A caller that can go without the
	 * directory refuses it, changing nothing.
	 */
	repairMode?: boolean;
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
 * foreign owner, or lingering group/other access via {@link ownerPrivateDirError};
 * with `repairMode: false` it changes nothing and refuses the last too.
 * POSIX only: Windows lacks `O_NOFOLLOW`/`O_DIRECTORY`.
 *
 * @param label Human-readable directory role prefixed to the thrown message.
 */
export function assertOwnerPrivateDir(dir: string, label: string, options: OwnerPrivateDirOptions = {}): void {
	const { uid = process.getuid?.(), repairMode = true } = options;
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
		if (repairMode && (uid === undefined || st.uid === uid) && (st.mode & 0o777) !== 0o700) {
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
