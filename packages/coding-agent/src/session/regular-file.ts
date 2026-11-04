/**
 * The one way `omp gc` opens a file in a session tree: the live sessions, an
 * archive, a staging ledger or a quarantine.
 *
 * Anything can stand at a name in those trees, directly or through a link:
 * a FIFO, a socket, a device. Reading one is never safe. A FIFO with no
 * writer, or a device nobody drives, waits for ever; one that is being
 * written to hands over bytes that were meant for someone else, and once
 * read they are gone from it, with no copy anywhere. So no name is read
 * through: every open is non-blocking, and the descriptor's own `fstat` —
 * not a look at the name, which can change after it — decides whether what
 * was opened is a regular file. Anything else is refused by throwing
 * {@link NotARegularFile}, which the caller reports or deliberately turns
 * into an answer; nothing is skipped without a decision at the call.
 *
 * `gc-cli.ts` and `session-archive.ts` are kept from reading any other way —
 * `Bun.file`, `fs.open`, `fs.readFile`, a session reader that opens by name —
 * by `.oxlintrc.json`, so a new read cannot reach a file but through here.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { errnoName, isErrno, type Libc, libc, type NoReplaceRename, renameNoReplace } from "./libc";

/** What a name stands for when it is not a regular file, in a reader's words: "a FIFO", "a socket", "a device". */
export function kindOf(stat: Stats): string {
	if (stat.isDirectory()) return "a directory";
	if (stat.isSymbolicLink()) return "a symbolic link";
	if (stat.isFIFO()) return "a FIFO";
	if (stat.isSocket()) return "a socket";
	if (stat.isCharacterDevice() || stat.isBlockDevice()) return "a device";
	return "a special file";
}

/**
 * A name in a session tree that stands, itself or through a link, for
 * something other than a regular file — and so was not read.
 */
export class NotARegularFile extends Error {
	constructor(
		readonly file: string,
		readonly kind: string,
	) {
		super(
			kind === "a directory" || kind === "a symbolic link"
				? `${file} is ${kind}, not a regular file, so it was not read`
				: `${file} is ${kind}, not a regular file, so it was not read: reading ${kind} takes what is written to it ` +
						`away from whoever it was written for, and no copy of it would be kept`,
		);
		this.name = "NotARegularFile";
	}
}

/** For a caller that answers "no regular file here" for anything else: {@link NotARegularFile} becomes undefined. */
export function notRegularAsAbsent(error: unknown): undefined {
	if (error instanceof NotARegularFile) return undefined;
	throw error;
}

/**
 * A descriptor on `file` only when what it opens is a regular file: undefined
 * when nothing is at the name, {@link NotARegularFile} when anything else is,
 * and any other error as it came. Opened non-blocking, so neither a FIFO
 * nor a device is waited on before the check; `write` opens it write-only
 * instead, and `noFollow` refuses a link at the name itself.
 */
export async function openRegularFile(
	file: string,
	options: { write?: boolean; noFollow?: boolean } = {},
): Promise<fs.FileHandle | undefined> {
	if (options.noFollow) {
		try {
			const named = await fs.lstat(file);
			if (named.isSymbolicLink()) throw new NotARegularFile(file, kindOf(named));
		} catch (error) {
			if (isEnoent(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
			throw error;
		}
	}
	const flags =
		(options.write ? fsConstants.O_WRONLY : fsConstants.O_RDONLY) |
		fsConstants.O_NONBLOCK |
		(options.noFollow ? fsConstants.O_NOFOLLOW : 0);
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, flags);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		if (options.noFollow && (error as NodeJS.ErrnoException).code === "ELOOP") {
			throw new NotARegularFile(file, "a symbolic link");
		}
		// A FIFO with no reader, opened to write, or a socket or a device
		// nobody drives: something is there, and it is no regular file.
		if (error instanceof Error && "code" in error && error.code === "ENXIO") {
			throw new NotARegularFile(file, "a FIFO, a socket or a device");
		}
		throw error;
	}
	let stat: Stats;
	try {
		stat = await handle.stat();
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
	if (stat.isFile()) return handle;
	await handle.close().catch(() => undefined);
	throw new NotARegularFile(file, kindOf(stat));
}

/**
 * Create `file`, which must not exist yet: `O_EXCL` never opens what is
 * already there, so no FIFO or link at the name is ever written through.
 */
export async function createExclusive(file: string, mode: number, readable = false): Promise<fs.FileHandle> {
	return await fs.open(file, readable ? "wx+" : "wx", mode);
}

/**
 * Make `dir`, new, with `mode` given to the `mkdir` itself, and hold it —
 * but only once what the descriptor holds is shown to be the directory that
 * `mkdir` made, not merely a directory: being a directory, being this
 * user's and being empty are each true of a directory somebody else of this
 * user put at the name, and a review filled such a directory, at `0777`,
 * with a restore's artifacts, and deleted an empty one, carrying its own
 * extended attribute, while undoing an archive.
 *
 * The mode is set by the one call that makes the directory, as `mkdtemp`
 * sets `0700`: the kernel applies it, less the umask, as the directory comes
 * into being, and nothing here changes a mode afterwards — not through the
 * name, not through a descriptor. A mode set after the `mkdir` went to
 * whatever the name held by then, and gave somebody's private directory the
 * archived `0777`.
 *
 * `mkdir` returns no identity and no descriptor, so provenance is built from
 * three looks, each refusing what the one before cannot:
 *
 * 1. The name is looked at with `lstat` straight after the `mkdir`, and must
 *    be a directory, not a link. Its device and inode are what this run takes
 *    the `mkdir` to have made.
 * 2. The name is opened with `O_DIRECTORY` and `O_NOFOLLOW`, and the
 *    descriptor's own `fstat` must report that very device and inode. This
 *    comparison, not the open's flags, is what refuses a link put at the name
 *    between the look and the `open`: an ordinary Linux kernel refuses a link
 *    to a directory under those flags with `ENOTDIR`, but gVisor was measured
 *    following one with no error. That measurement used a plain `openat` with
 *    `O_NOFOLLOW`; `openat2` with `RESOLVE_NO_SYMLINKS` was not tested.
 * 3. The descriptor's mode must be exactly `mode` less the umask, which is
 *    what `mkdir` gives every directory it makes. A directory swapped in
 *    before the look in step 1 passes steps 1 and 2 — it is what the name
 *    held — and is refused here unless it already carries exactly the mode
 *    this run's own would have had: the review's `0777` directory is refused,
 *    and nothing is put into it.
 * 4. The descriptor must carry no extended attribute but those every new
 *    directory there gets: the ACLs a default ACL on its directory passes
 *    on, and a security module's label — see {@link GIVEN_AT_CREATION}. A
 *    review swapped in an empty `0700` directory carrying an attribute of its
 *    own; the run took it for its own and, undoing a failed archive, removed
 *    it with the attribute. It is refused here, and nothing is put into it.
 *
 * It must also be this user's and empty, read through the descriptor.
 *
 * What is left: an empty directory of this user's, swapped in before the
 * look in step 1, already carrying exactly that mode and no attribute a new
 * directory there would not get, is taken for this run's. It is filled, and
 * if the run then fails, removed; nothing it carried is lost but its times
 * and its inode number. What is put in it is open to nobody this run's own
 * directory would not have opened it to. No system call makes a directory
 * and hands back a descriptor on it, so no look taken after the `mkdir` can
 * tell such a directory from the one the `mkdir` made. And a parent
 * directory carrying a default ACL gives a new directory the ACL's mode
 * instead of `mode` less the umask, so there every directory this makes can
 * be refused: nothing is filled, and the refusal names it.
 *
 * The caller adds entries by name, each created afresh — never written
 * over — and keeps the descriptor, and the identity it reports, to say
 * afterwards whether the name still holds the directory and, while it is
 * open, to know the directory by an inode number no other entry can be
 * given. Removal goes through {@link removeHeldDirectory}.
 */
export async function makeHeldDirectory(dir: string, mode: number): Promise<HeldFile> {
	await fs.mkdir(dir, { mode });
	const notMine = (): Error => new Error(`${dir} is not the directory this run just made, so nothing was put into it`);
	const made = await fs.lstat(dir).catch((error: unknown) => {
		if (isEnoent(error)) throw notMine();
		throw error;
	});
	if (!made.isDirectory()) throw notMine();
	const held = await holdSeenDirectory(dir, made);
	if (!held) throw notMine();
	try {
		const stat = await held.handle.stat();
		if (process.getuid !== undefined && stat.uid !== process.getuid()) throw notMine();
		// Windows keeps no mode bits a `mkdir` could be told by, and has
		// neither `/dev/fd` nor the swap.
		if (process.platform !== "win32") {
			if ((stat.mode & 0o777) !== (mode & ~process.umask() & 0o777)) throw notMine();
			// `/dev/fd/<n>` opens the directory the descriptor holds, wherever
			// its name has gone since.
			if ((await fs.readdir(`/dev/fd/${held.handle.fd}`)).length > 0) throw notMine();
			if (!(await carriesOnlyWhatANewDirectoryGets(dir, held.handle.fd))) throw notMine();
		}
		return held;
	} catch (error) {
		await held.handle.close().catch(() => undefined);
		throw error;
	}
}

/**
 * The extended attributes a directory can be given just by being made: the
 * ACLs a default ACL on its directory passes on, and the label a Linux
 * security module gives every new directory. Proving a directory is the one
 * a `mkdir` made has to allow them.
 */
const GIVEN_AT_CREATION: Record<string, true> = {
	"system.posix_acl_access": true,
	"system.posix_acl_default": true,
	"security.selinux": true,
	"security.SMACK64": true,
	"security.SMACK64TRANSMUTE": true,
};

/**
 * Whether the directory `dir`, open at `fd`, carries no extended attribute
 * but those a directory made there gets — step 4 of {@link makeHeldDirectory}.
 * An ACL counts only when its directory has a default ACL to pass on.
 */
async function carriesOnlyWhatANewDirectoryGets(dir: string, fd: number): Promise<boolean> {
	const names = extendedAttributeNames(fd);
	if (!names.every(name => GIVEN_AT_CREATION[name] === true)) return false;
	if (!names.some(name => name.startsWith("system.posix_acl_"))) return true;
	const parent = await fs.open(path.dirname(dir), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
	try {
		return extendedAttributeNames(parent.fd).includes("system.posix_acl_default");
	} finally {
		await parent.close().catch(() => undefined);
	}
}

/**
 * The names of the extended attributes on the file or directory open at
 * `fd`: every one this process can list — `trusted.*` only with
 * `CAP_SYS_ADMIN`. Throws when they cannot be read: "could not look" is not
 * "none". Windows has no extended attributes in this sense; an NTFS
 * alternate data stream is not asked about.
 */
export function extendedAttributeNames(fd: number): string[] {
	if (process.platform === "win32") return [];
	const lib = libc();
	for (let attempt = 0; attempt < 8; attempt++) {
		const size = lib.flistxattr(fd, null, 0);
		if (size < 0) {
			const code = lib.errno();
			throw new Error(`its extended attributes could not be listed (${errnoName(code)})`);
		}
		if (size === 0) return [];
		const names = Buffer.alloc(size);
		const got = lib.flistxattr(fd, names, size);
		if (got < 0) {
			const code = lib.errno();
			// The list grew between sizing the buffer and reading it.
			if (isErrno(code, "ERANGE")) continue;
			throw new Error(`its extended attributes could not be listed (${errnoName(code)})`);
		}
		return names
			.subarray(0, got)
			.toString("utf8")
			.split("\0")
			.filter(name => name.length > 0);
	}
	throw new Error("its extended attributes kept changing while they were listed");
}

/**
 * Open the directory `dir` names and hold it — but only when it is `seen`,
 * the directory an earlier `lstat` of the name found, by the device and
 * inode the descriptor's own `fstat` reports. Undefined when the name no
 * longer holds that directory: nothing there, something that is no
 * directory, a link the open refused, or a different directory.
 *
 * The open is `O_DIRECTORY | O_NOFOLLOW`, but those flags are not what keeps
 * a link out: an ordinary Linux kernel refuses a link to a directory under
 * them with `ENOTDIR`, and gVisor was measured following one with no error
 * (a plain `openat` with `O_NOFOLLOW`; `openat2` with `RESOLVE_NO_SYMLINKS`
 * was not tested). The identity comparison refuses it everywhere.
 */
export async function holdSeenDirectory(dir: string, seen: Stats): Promise<HeldFile | undefined> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (stat.isDirectory() && stat.dev === seen.dev && stat.ino === seen.ino) {
			return { handle, dev: stat.dev, ino: stat.ino };
		}
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
	await handle.close().catch(() => undefined);
	return undefined;
}

/**
 * What a directory removal found: the held directory, gone; nothing; something
 * else, kept; or the held directory with something in it, kept.
 */
export type HeldDirectoryRemoval = "removed" | "absent" | "kept" | "not-empty";

/**
 * Remove `dir` only while its name holds `held`, a directory this run holds
 * open — for a directory gc made: a staging directory it minted at a random
 * name, or an archived copy directory whose original a reclaim moved beside
 * it. Throws what the look or the `rmdir` threw, for the caller to report.
 *
 * `rmdir` removes nothing but an empty directory, and an empty directory is
 * not nothing: one somebody put at the name has its own owner, mode and
 * extended attributes. So the name is looked at the instant before the
 * `rmdir` and must hold the held directory, whose inode number no other
 * directory can be given while this run holds its descriptor. One gap is
 * left, as for a file — see {@link unlinkFileNoOneElseWrites}: an empty
 * directory renamed onto the name between that look and the `rmdir` is
 * removed, because POSIX has no rmdir-if-this-inode.
 */
export async function removeHeldDirectory(dir: string, held: HeldFile): Promise<HeldDirectoryRemoval> {
	const standing = await fs.lstat(dir).catch((error: unknown) => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!standing) return "absent";
	if (!standing.isDirectory() || standing.dev !== held.dev || standing.ino !== held.ino) return "kept";
	try {
		await fs.rmdir(dir);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ENOENT") return "absent";
		if (code === "ENOTEMPTY" || code === "EEXIST") return "not-empty";
		throw error;
	}
	return "removed";
}

/**
 * A file this run holds: the descriptor it was created or read through,
 * still open; the identity that descriptor reports; and, where this run
 * knows them, the bytes the file holds — what this run wrote into it, a
 * random value among them, or what it read from it. See
 * {@link removeFileNoOneElseWrites} for what each layer proves.
 */
export interface HeldFile {
	handle: fs.FileHandle;
	dev: number;
	ino: number;
	bytes?: Buffer;
}

/** 32 random bytes, as hex, to write into a file this run creates: a statement a writer who did not read the file cannot repeat. */
export function newNonce(): string {
	return randomBytes(32).toString("hex");
}

/**
 * Write `text` to `file`, which must not exist yet: created with `O_EXCL`,
 * so nothing already at the name — a FIFO, a link to somebody's file — is
 * written through, and EEXIST leaves whatever is there as it is. Returns the
 * file held: its descriptor stays open, so its inode cannot be handed to
 * another file until the caller closes it, and the caller closes it only
 * after it has removed the file or given it up. A write that fails after the
 * create takes away what it created, and only that.
 */
export async function writeExclusive(file: string, text: string, mode: number): Promise<HeldFile> {
	const handle = await createExclusive(file, mode);
	let held: HeldFile | undefined;
	try {
		const { dev, ino } = await handle.stat();
		held = { handle, dev, ino };
		const bytes = Buffer.from(text);
		await writeAllAt(handle, bytes, 0);
		return { ...held, bytes };
	} catch (error) {
		// What it holds after a failed write is not known, so this one is
		// recognised by the held descriptor alone.
		const note = held ? await removeFileNoOneElseWrites(file, [held], "the file this run created") : undefined;
		await handle.close().catch(() => undefined);
		throw note
			? new Error(`${error instanceof Error ? error.message : String(error)}; ${note}`, { cause: error })
			: error;
	}
}

/** The one of `own` the file open at `handle` is, by its identity and, where known, its bytes. */
async function heldAs(handle: fs.FileHandle, own: readonly HeldFile[]): Promise<HeldFile | undefined> {
	const { dev, ino } = await handle.stat();
	const same = own.find(held => held.dev === dev && held.ino === ino);
	if (!same) return undefined;
	if (same.bytes !== undefined && !(await handle.readFile()).equals(same.bytes)) return undefined;
	return same;
}

/** What {@link unlinkFileNoOneElseWrites} found at the name: its own file, gone; nothing; or something else, kept. */
export type OwnFileRemoval = "removed" | "absent" | "kept";

/**
 * Unlink `file`, a file only gc names and writes, only while the name holds
 * one of `own`, files this run holds. Throws what a look or the `unlink`
 * threw, for the caller to report; {@link removeFileNoOneElseWrites} reports it
 * for most.
 *
 * For gc's own files: the lock, its breaker, the staging records and their
 * part names, a stage — written once, by gc, through its own descriptor,
 * and appended to by nobody. A file anybody else may write by its name goes
 * through {@link removeFileOthersMayWrite} instead, which catches a write by
 * its name that a look before an `unlink` cannot. The restore record is such
 * a file: it sits in an archive bucket, where any process of this user can
 * name it, and a review renamed a file of its own onto it in the one call
 * between the last look and the `unlink`, which removed that file.
 *
 * A name is not provenance, and neither is an inode number: the kernel hands
 * a freed number to the next file created, so a file someone put at the name
 * after this run's was removed can carry the very number this run captured —
 * a review saw it, on the first create, once a copy across filesystems had
 * left the original free. So identity comes in layers, each one something
 * this run holds or wrote:
 *
 * - the descriptor, held open by the caller from the create or the read
 *   until after this returns: an inode is freed only once its last link and
 *   its last open descriptor are gone, so while this run holds one, no other
 *   file can be given its number;
 * - the device and inode that descriptor reports;
 * - the bytes, read through a descriptor opened on the name now: for a file
 *   this run wrote, they carry a random value from {@link newNonce}, which a
 *   writer who did not read the file cannot repeat.
 *
 * The name is looked at once more, the instant before the `unlink`, and has
 * to name the file just checked. Nothing is moved or linked on the way:
 * there is no second name for anything to stand at, and a run killed at any
 * point leaves its file at its own name or nothing. Anything at the name
 * that is not a regular file is left as it is, and nothing is read from it.
 *
 * One gap is left: the `unlink` removes whatever has the name at that
 * instant, so a file renamed onto it between that last look and the
 * `unlink` — one system call later — is removed. POSIX has no
 * unlink-if-this-inode. Only a writer that can change this directory can
 * reach it, and no gc writer renames onto a name: each creates with
 * `O_EXCL` or `link`, which refuse a name already taken.
 */
export async function unlinkFileNoOneElseWrites(file: string, own: readonly HeldFile[]): Promise<OwnFileRemoval> {
	const lookAgain = async (): Promise<Stats | undefined> =>
		await fs.lstat(file).catch((error: unknown) => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
	const first = await lookAgain();
	if (!first) return "absent";
	if (!first.isFile() || !own.some(held => held.dev === first.dev && held.ino === first.ino)) return "kept";
	const handle = await openRegularFile(file, { noFollow: true });
	if (!handle) return "absent";
	let ours: HeldFile | undefined;
	try {
		ours = await heldAs(handle, own);
	} finally {
		await handle.close().catch(() => undefined);
	}
	if (!ours) return "kept";
	const last = await lookAgain();
	if (!last) return "absent";
	if (last.dev !== ours.dev || last.ino !== ours.ino) return "kept";
	try {
		await fs.unlink(file);
	} catch (error) {
		if (isEnoent(error)) return "absent";
		throw error;
	}
	return "removed";
}

/**
 * Remove `file`, a file only gc names and writes, only while the name holds
 * one of `own` — see {@link unlinkFileNoOneElseWrites} — and say why not,
 * otherwise. Returns undefined once nothing of this run's is left at the
 * name, or a sentence for the command to print, `what` naming this run's
 * file ("the record this run wrote").
 */
export async function removeFileNoOneElseWrites(
	file: string,
	own: readonly HeldFile[],
	what: string,
): Promise<string | undefined> {
	try {
		return (await unlinkFileNoOneElseWrites(file, own)) === "kept"
			? `${file} is not ${what}, so it was left as it is`
			: undefined;
	} catch (error) {
		return `${file} could not be checked or removed, so it was left as it is: ${errorText(error)}`;
	}
}

/**
 * How {@link removeFileOthersMayWrite} decides whether what a name holds may
 * go. Every reason is a clause naming the file — "`x` holds what `y` does
 * not" — which it finishes with what became of the file.
 */
export interface OthersMayWriteRule {
	/** On an `lstat` of the name, before anything moves: false leaves the name untouched. */
	matches(standing: Stats): boolean;
	/** Why a name the rule does not match is kept. */
	mismatch: string;
	/**
	 * On what was moved aside: its `lstat` and, when it is a regular file, a
	 * descriptor opened on it now — never through a link. Undefined when it may
	 * go, or why it may not. Anything that is not a regular file has no
	 * descriptor, so a judgment that reads bytes keeps it.
	 */
	judge(moved: Stats, handle: fs.FileHandle | undefined): Promise<string | undefined>;
	/**
	 * Put a replacement at the name once what was there is judged, and before
	 * it goes: it goes only after this returns, and goes back if this throws.
	 */
	replaceWith?(): Promise<void>;
	/**
	 * Judge once more after the `unlink`, through the descriptor still held on
	 * what went, whose bytes can still be read. A reason here means it should
	 * not have gone: its bytes are written back, to a new file at the name, or
	 * at the private name when the name is taken, and the removal reports it
	 * kept. So nothing that changes before the `unlink` is decided past — the
	 * one system call between the last look and the `unlink` included.
	 */
	confirm?(handle: fs.FileHandle): Promise<string | undefined>;
}

/** What {@link removeFileOthersMayWrite} did with a name. */
export type OthersMayWriteRemoval =
	/**
	 * The name no longer holds what it held — removed, or replaced by
	 * {@link OthersMayWriteRule.replaceWith}. A replaced file whose private
	 * name could not be removed is still there, which `note` says.
	 */
	| { outcome: "removed"; note?: string }
	/** Nothing was at the name, so nothing was done. */
	| { outcome: "absent" }
	/**
	 * What the name held was kept; `note` says why and where it is, for the
	 * command to print, and `cause` is the error that stopped the move aside,
	 * when one did. `lost` marks the one way it was not kept whole: it was
	 * unlinked, the check after that failed — see
	 * {@link OthersMayWriteRule.confirm} — and its bytes could not all be
	 * written back; `note` then says how many the written-back file holds.
	 */
	| { outcome: "kept"; note: string; cause?: unknown; lost?: true };

/** Private names tried before moving a file aside gives up. */
const ASIDE_ATTEMPTS = 8;

/**
 * Remove `file`, which a process other than gc may name and write — a copy
 * gc made in the archive, which a superseding copy replaces or a reclaim
 * frees beside its moved original, or a restore's own record — only once it
 * has been moved to a name nobody else knows and judged there, through a
 * descriptor on what was moved.
 *
 * A look taken before an `unlink` of the name does not hold across the two:
 * a writer that appends by the name after the last look and before the
 * `unlink` loses what it wrote. So the file
 * is moved to a private name — `.<name>.<16 random hex digits>.leaving`, in
 * the same directory — by {@link moveAside}, with a rename that refuses to
 * replace anything: it moves exactly what had the name at that instant, or,
 * finding the private name taken, moves nothing, and another name is tried.
 * From then on a write by the name — an append, or a save that renames a new
 * file onto it — makes a file of the writer's own there, which is never
 * touched, and a write before it is in what is judged, through a descriptor
 * opened on the private name now and held until the file is gone. What passes
 * is unlinked there, only while the private name still holds that very file —
 * see {@link unlinkStillMoved}; anything else is put back under its name by
 * {@link putBack}, which replaces nothing either. Anything the rule's first
 * look does not match is not touched.
 *
 * Not an empty placeholder at the private name first and a `rename` onto it:
 * a `rename` replaces whatever has the new name, and a review's `inotify`
 * watcher learned the private name from the placeholder's creation and
 * renamed a file of its own onto it just before gc's `rename`; that file was
 * gone, and the reclaim reported success. Not `link` to the private name and
 * then `unlink` of the name either: a save that renames a new file onto the
 * name between those two calls is what the `unlink` would then remove.
 *
 * What is left is one system call wide: a process that watches the
 * directory, learns the private name when the file arrives there, and
 * renames a file of its own onto it exactly between the last look at that
 * name and the `unlink` has that file removed — POSIX has no
 * unlink-if-this-inode. Renamed there at any other moment, it is never
 * removed: it is put back under the file's name, as anything at the private
 * name is, or left at the private name if that is taken, and named. Eight
 * private names taken in a row refuse the removal, naming the file, and
 * nothing moves; so does a filesystem that refuses a rename that does not
 * replace.
 *
 * A run killed part-way leaves a `.leaving` name, and nothing removes it
 * automatically: no later run can show that a run made it, and a file whose
 * maker cannot be shown is not gc's to remove. Killed after the move and
 * before the file is unlinked or put back, it leaves the whole file under the
 * `.leaving` name, and nothing at its own name. It holds what the file held
 * when it moved. An archived artifact's — a superseded, withdrawn or
 * rolled-back copy, or one a reclaim was freeing — is in the archived tree,
 * and a restore brings it home as an artifact. A restore takes its record
 * down only once the session is whole, so a kill there leaves a whole
 * session and the record's text under the `.leaving` name. Either way the
 * file is the user's to look at, compare with what stands at the name it
 * came from, and remove.
 *
 * And one writer is outside what this judges: one that held the file open
 * from before and writes through that descriptor after the judgment. Its
 * write lands in the inode this unlinks. No caller removes a file such a
 * writer may need: a live session file leaves its name only by rename — see
 * `reclaimedTranscriptPath` (`session-archive.ts`) — and what goes here is a
 * copy, whose bytes another file holds.
 */
export async function removeFileOthersMayWrite(file: string, rule: OthersMayWriteRule): Promise<OthersMayWriteRemoval> {
	const moved = await moveAside(file, rule);
	if (moved.outcome !== "moved") return moved;
	const { aside } = moved;
	let why: string | undefined;
	let standing: Stats | undefined;
	let handle: fs.FileHandle | undefined;
	try {
		try {
			standing = await fs.lstat(aside);
			handle = standing.isFile() ? await openRegularFile(aside, { noFollow: true }) : undefined;
			why = await rule.judge(standing, handle);
		} catch (error) {
			why = `${file} could not be checked (${errorText(error)})`;
		}
		if (why === undefined && rule.replaceWith) {
			try {
				await rule.replaceWith();
			} catch (error) {
				why = `${file} could not be replaced (${errorText(error)})`;
			}
		}
		if (why === undefined && standing) {
			// Judged through the descriptor, which stays open until the file is
			// gone, so no other file can be given its inode number meanwhile.
			let removal: StillMovedRemoval;
			try {
				removal = await unlinkStillMoved(aside, standing);
			} catch (error) {
				removal = "failed";
				why = `${file} could not be removed (${errorText(error)})`;
			}
			if (removal === "removed") {
				const late =
					handle && rule.confirm ? await rule.confirm(handle).catch(error => errorText(error)) : undefined;
				if (late === undefined || !handle) return { outcome: "removed" };
				return { outcome: "kept", ...(await writeBack(file, aside, handle, standing, late)) };
			}
			if (removal !== "failed") {
				// What was seen, not who did it: a name changed, by whom is not known.
				why =
					removal === "replaced"
						? `${aside}, where ${file} was moved to be removed, held another file before it could be removed`
						: `${file} was no longer at ${aside}, where it was moved to be removed, before it could be removed`;
			}
			// Replaced, the name already holds its replacement, and what is at
			// the private name stays there; otherwise it goes back.
			if (rule.replaceWith) return { outcome: "removed", note: `${why}, so ${aside} was left as it is` };
		}
		why ??= `${file} could not be checked`;
		return {
			outcome: "kept",
			note: (await putBack(file, aside, why)) ?? `${why}, so it was put back`,
		};
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * Write all of `bytes` through `handle` at `position`, however many calls
 * the kernel takes: `write(2)` may write less than it was given — a file size
 * limit, a full disk, a signal — and says how much in `bytesWritten`. A write
 * that cannot go on throws (`EFBIG`, `ENOSPC`, …); a call that writes nothing
 * and reports no error throws too, rather than loop.
 */
export async function writeAllAt(handle: fs.FileHandle, bytes: Uint8Array, position: number): Promise<void> {
	for (let done = 0; done < bytes.byteLength;) {
		const { bytesWritten } = await handle.write(bytes, done, bytes.byteLength - done, position + done);
		if (bytesWritten === 0) throw new Error(`a write at offset ${position + done} wrote nothing`);
		done += bytesWritten;
	}
}

/**
 * Write the bytes of a file {@link removeFileOthersMayWrite} unlinked and then
 * judged should have stayed, read through `handle`, the descriptor it still
 * holds on it, into a new file with its mode: at `file`, or at `aside` when
 * `file` is taken, each made with `O_EXCL` so nothing is written over. Says
 * where they are, or where they could not be put, after `why`. Only a file
 * that holds every byte is reported written back: a write the kernel cuts
 * short is carried on, and one that cannot finish leaves what it wrote at
 * the name — counted from the written file itself, which a write cut short
 * part-way through a window has grown past the last whole window — and
 * says the rest was lost, marking it `lost`, since the kernel lets no
 * process give an unlinked file a name again.
 */
async function writeBack(
	file: string,
	aside: string,
	handle: fs.FileHandle,
	was: Stats,
	why: string,
): Promise<{ note: string; lost?: true }> {
	// Its size, for the report and for telling a short copy from a whole one;
	// a failure to read it must not stop the write-back, which copies until a
	// read finds the end.
	let size: number | undefined;
	let its: string;
	try {
		size = (await handle.stat()).size;
		its = `its ${size} bytes`;
	} catch (error) {
		its = `its bytes (its size could not be read: ${errorText(error)})`;
	}
	// Lost only where a loss is shown: fewer bytes put back than it held. A
	// failed look is said as a failed look — a review failed the read that
	// would have found the end, after every byte was written back, and saw
	// the whole copy reported lost.
	const shortOf = (holds: number | undefined): boolean => holds !== undefined && size !== undefined && holds < size;
	const nothingPutBack = (target: string, cause: string): { note: string; lost?: true } =>
		size === 0
			? { note: `${why}; it was empty, so nothing was lost, though ${target} could not be made (${cause})` }
			: size === undefined
				? {
						note: `${why}; nothing could be written back to ${target} (${cause}), and whether it held any bytes is not known`,
					}
				: {
						note: `${why}; none of ${its} could be written back to ${target} (${cause}), and they were lost with the unlinked file`,
						lost: true,
					};
	for (const target of [file, aside]) {
		let written: fs.FileHandle;
		try {
			written = await createExclusive(target, was.mode & 0o7777);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			return nothingPutBack(target, errorText(error));
		}
		let at = 0;
		let whole = false;
		try {
			const window = Buffer.allocUnsafe(64 * 1024);
			for (;;) {
				const { bytesRead } = await handle.read(window, 0, window.length, at);
				if (bytesRead === 0) break;
				await writeAllAt(written, window.subarray(0, bytesRead), at);
				at += bytesRead;
			}
			whole = true;
			await written.chmod(was.mode & 0o7777);
			await written.sync();
		} catch (error) {
			if (whole) {
				return { note: `${why}, so its bytes were written back to ${target}, though ${errorText(error)}` };
			}
			let sizeFailure: string | undefined;
			const holds = await written
				.stat()
				.then(stat => stat.size)
				.catch((failure: unknown) => {
					sizeFailure = errorText(failure);
					return undefined;
				});
			const counted =
				holds === undefined ? `an unknown number (size could not be checked: ${sizeFailure})` : `${holds}`;
			if (shortOf(holds)) {
				return {
					note:
						`${why}; writing its bytes back to ${target} stopped (${errorText(error)}): ${target} holds ` +
						`${counted} of ${its}, and the rest was lost with the unlinked file`,
					lost: true,
				};
			}
			return {
				note:
					`${why}; ${target} holds ${counted} of ${its}, written back, but writing back stopped ` +
					`(${errorText(error)}) before it could be confirmed that nothing followed them`,
			};
		} finally {
			await written.close().catch(() => undefined);
		}
		return { note: `${why}, so its bytes were written back to ${target}` };
	}
	if (size === 0)
		return { note: `${why}; it was empty, so nothing was lost, though ${file} and ${aside} are both taken` };
	return {
		note: `${why}; ${file} and ${aside} are both taken, so ${its} could not be written back${size === undefined ? "" : " and were lost with the unlinked file"}`,
		...(size === undefined ? {} : { lost: true as const }),
	};
}

/** What {@link unlinkStillMoved} did: removed it; found nothing; found another file there and kept it; or the `unlink` failed. */
export type StillMovedRemoval = "removed" | "absent" | "replaced" | "failed";

/**
 * Unlink `aside`, the private name {@link moveAside} moved a file to, only
 * while it still names `moved` — that file, by device and inode, which the
 * caller holds a descriptor on so the number cannot be given to another
 * file. A process that learns the private name from the directory's events
 * and renames a file of its own onto it has that file kept, not removed: a
 * review's watcher did exactly that to the name gc had moved a file to, and
 * the reclaim removed the watcher's file. The look is the call before the
 * `unlink`; between the two is the one gap POSIX leaves, which has no
 * unlink-if-this-inode. Throws what the `unlink` threw.
 */
export async function unlinkStillMoved(aside: string, moved: { dev: number; ino: number }): Promise<StillMovedRemoval> {
	const named = await fs.lstat(aside).catch((error: unknown) => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!named) return "absent";
	if (named.dev !== moved.dev || named.ino !== moved.ino) return "replaced";
	try {
		await fs.unlink(aside);
	} catch (error) {
		if (isEnoent(error)) return "absent";
		throw error;
	}
	return "removed";
}

/** What {@link moveAside} did with a name: moved what it held to `aside`, found nothing, or kept it. */
export type MoveAside = { outcome: "moved"; aside: string } | Exclude<OthersMayWriteRemoval, { outcome: "removed" }>;

/**
 * The first half of {@link removeFileOthersMayWrite}: move what `file` holds,
 * once `rule.matches` it, to a private name beside it with a rename that
 * refuses to replace anything — see `renameNoReplace` (`libc.ts`) — and say
 * where. The caller judges what moved there and either unlinks it, by
 * {@link unlinkStillMoved}, or gives it to {@link putBack}. Taken apart so a
 * caller can move a whole set of files aside before it asks anything about
 * any of them.
 */
export async function moveAside(
	file: string,
	rule: Pick<OthersMayWriteRule, "matches" | "mismatch">,
): Promise<MoveAside> {
	const kept = (why: string, cause?: unknown): MoveAside => ({
		outcome: "kept",
		note: `${why}, so it was left as it is`,
		cause,
	});
	let standing: Stats;
	try {
		standing = await fs.lstat(file);
	} catch (error) {
		if (isEnoent(error)) return { outcome: "absent" };
		return kept(`${file} could not be looked at (${errorText(error)})`);
	}
	if (!rule.matches(standing)) return kept(rule.mismatch);
	for (let attempt = 0; attempt < ASIDE_ATTEMPTS; attempt++) {
		const candidate = asideName(file);
		let moved: NoReplaceRename;
		try {
			moved = await renameNoReplace(file, candidate);
		} catch (error) {
			return kept(`${file} could not be moved aside to be checked (${errorText(error)})`, error);
		}
		if (moved.outcome === "renamed") return { outcome: "moved", aside: candidate };
		if (moved.outcome === "absent") return { outcome: "absent" };
		if (moved.outcome === "unsupported") {
			return kept(
				`${file} could not be moved aside to be checked: ${moved.why}, and a rename that may replace what has ` +
					`the private name could remove another process's file there`,
			);
		}
	}
	return kept(`${file} could not be moved aside to be checked: ${ASIDE_ATTEMPTS} private names in a row were taken`);
}

/**
 * Put what {@link moveAside} moved to `aside` back under `file`, with a
 * rename that replaces nothing: if something has taken the name meanwhile,
 * what moved stays at the private name. Whatever stands at the private name
 * goes back — the file moved, or one another process renamed onto it since,
 * which was then the move's to undo — and nothing is removed. Undefined once
 * it is back under its name; otherwise the sentence saying where it is, `why`
 * first.
 */
export async function putBack(file: string, aside: string, why: string): Promise<string | undefined> {
	try {
		const back = await renameNoReplace(aside, file);
		if (back.outcome === "renamed") return undefined;
		if (back.outcome === "taken")
			return `${why}, and something else took its name meanwhile, so it was left at ${aside}`;
		if (back.outcome === "absent") {
			return `${why}, and nothing was left at ${aside} to put back: it had been moved or removed meanwhile`;
		}
		return `${why}, and it could not be put back (${back.why}), so it was left at ${aside}`;
	} catch (error) {
		return `${why}, and it could not be put back (${errorText(error)}), so it was left at ${aside}`;
	}
}

/** A private name beside `entry`: `.<name>.<16 random hex digits>.leaving`. */
function asideName(entry: string): string {
	return path.join(path.dirname(entry), `.${path.basename(entry)}.${randomBytes(8).toString("hex")}.leaving`);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The error a read by name gave when nothing was at `file`, for a reader that opened it through {@link openRegularFile}. */
export function absentFile(file: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT", path: file });
}

/** `FS_IOC_GETFLAGS`, `_IOR('f', 1, long)` on the 64-bit systems omp runs on; the kernel writes an `int`. */
const FS_IOC_GETFLAGS = 0x80086601;

/**
 * The inode flags (`chattr`'s) of the entry open at `fd`, or undefined where
 * the filesystem keeps none or the call cannot be made here. Throws when they
 * exist and could not be read.
 */
export function inodeFlags(fd: number): number | undefined {
	let lib: Libc;
	try {
		lib = libc();
	} catch {
		return undefined;
	}
	if (!lib.ioctl) return undefined;
	const into = Buffer.alloc(8);
	if (lib.ioctl(fd, FS_IOC_GETFLAGS, into) === 0) return into.readUInt32LE(0);
	const code = lib.errno();
	if (isErrno(code, "ENOTTY", "ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS")) return undefined;
	throw new Error(`its inode flags could not be read (${errnoName(code)})`);
}

/** `FS_IMMUTABLE_FL` and `FS_APPEND_FL`: the kernel refuses to rename an entry carrying either, or out of a directory carrying either. */
const RENAME_LOCKING_FLAGS = 0x10 | 0x20;

/** Whether `entry` carries an immutable or append-only flag; a failed probe throws. */
async function renameLocked(entry: string, directory: boolean): Promise<boolean> {
	const lib = libc();
	if (lib.statx) {
		// Linux's fixed 256-byte statx ABI: attributes at 0x08 and their
		// supported-bit mask at 0x38. Unlike open/ioctl this needs no read
		// permission on the entry rename(2) would move.
		const stat = Buffer.alloc(256);
		if (lib.statx(entry, stat) === 0) {
			const supported = stat.readUInt32LE(0x38);
			if ((stat.readUInt32LE(0x08) & supported & RENAME_LOCKING_FLAGS) !== 0) return true;
			if ((supported & RENAME_LOCKING_FLAGS) === RENAME_LOCKING_FLAGS) return false;
		} else {
			const errno = lib.errno();
			if (!isErrno(errno, "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EINVAL")) {
				throw new Error(`inode flags of ${entry} could not be checked (statx: ${errnoName(errno)})`);
			}
		}
	}
	const ioctl = lib.ioctl;
	if (!ioctl) throw new Error(`inode flags of ${entry} could not be checked (no ioctl binding here)`);
	const flags =
		fsConstants.O_RDONLY |
		fsConstants.O_NOFOLLOW |
		fsConstants.O_NONBLOCK |
		(directory ? fsConstants.O_DIRECTORY : 0);
	const handle = await fs.open(entry, flags).catch((error: unknown) => {
		throw new Error(`inode flags of ${entry} could not be checked (${errorText(error)})`, { cause: error });
	});
	try {
		const into = Buffer.alloc(8);
		if (ioctl(handle.fd, FS_IOC_GETFLAGS, into) !== 0) {
			throw new Error(`inode flags of ${entry} could not be checked (${errnoName(lib.errno())})`);
		}
		return (into.readUInt32LE(0) & RENAME_LOCKING_FLAGS) !== 0;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Why the kernel would refuse to rename `from` into the directory `toParent`,
 * told by the conditions `rename(2)` names, without renaming anything — so a
 * preview refuses where applying would: write and search permission on the
 * directory `from` leaves and on the one it goes into (or, where that one does
 * not exist yet, on the nearest directory above it, which must let it be
 * made), which also answers for a read-only filesystem and an immutable
 * directory; write permission on `from` itself when it is a directory moving
 * to another parent, whose `..` changes; the sticky bit on the directory it
 * leaves, which lets only the owner of the entry or of that directory move
 * it; and the immutable or append-only flag on `from` or on the directory it
 * leaves. A review set the archive's bucket, and in turn the live bucket, to
 * `0500`: the preview promised the reclaim and applying failed with
 * `EACCES`. Different filesystems are the caller's to tell, in its own words.
 * Undefined when none of these refuses it.
 */
export async function renameRefusal(from: string, toParent: string): Promise<string | undefined> {
	const entry = await fs.lstat(from);
	const leaves = path.dirname(from);
	const leavesStat = await fs.stat(leaves);
	// Each probe says what it was told: a refusal (`EACCES`, `EPERM`, `EROFS`)
	// is a refusal; any other failure is a probe that could not tell, said
	// as one, since the preview refuses on either rather than promise.
	const probe = async (target: string, mode: number, refused: string, what: string): Promise<string | undefined> => {
		try {
			await fs.access(target, mode);
			return undefined;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EACCES" || code === "EPERM" || code === "EROFS") return `${refused} (${errorText(error)})`;
			return `whether this process can ${what} could not be checked (${errorText(error)})`;
		}
	};
	const writable = async (dir: string, why: string): Promise<string | undefined> =>
		await probe(
			dir,
			fsConstants.W_OK | fsConstants.X_OK,
			`${dir} does not let this process ${why}`,
			`${why}: ${dir}`,
		);
	const out = await writable(leaves, `move ${from} out of it`);
	if (out) return out;
	let into = toParent;
	for (;;) {
		try {
			await fs.stat(into);
			break;
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			if (path.dirname(into) === into) throw error;
			into = path.dirname(into);
		}
	}
	const made = into === toParent ? "move" : `make ${toParent} to move`;
	const inside = await writable(into, `${made} ${from} into it`);
	if (inside) return inside;
	const uid = process.geteuid?.();
	if (uid !== undefined && leavesStat.mode & 0o1000 && entry.uid !== uid && leavesStat.uid !== uid) {
		return `${leaves} has the sticky bit, so only the owner of ${from} (user ${entry.uid}) or of ${leaves} can move it`;
	}
	if (entry.isDirectory() && path.resolve(toParent) !== path.resolve(leaves)) {
		const own = await probe(
			from,
			fsConstants.W_OK,
			`${from} is a directory this process cannot write, and moving it into another directory changes its \`..\``,
			`write ${from}, which moving it into another directory needs`,
		);
		if (own) return own;
	}
	for (const [name, directory] of [
		[from, entry.isDirectory()],
		[leaves, true],
	] as const) {
		// Symlinks have no rename-locking inode flags of their own to read.
		if (name === from && entry.isSymbolicLink()) continue;
		if (await renameLocked(name, directory)) {
			return `${name} is immutable or append-only (\`chattr\` flag \`i\` or \`a\`), so ${from} cannot be moved`;
		}
	}
	return undefined;
}
