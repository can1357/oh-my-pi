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
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils";

/** What a name stands for when it is not a regular file, in a reader's words: "a FIFO", "a socket", "a device". */
export function kindOf(stat: Stats): string {
	if (stat.isDirectory()) return "a directory";
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
			kind === "a directory"
				? `${file} is a directory, not a regular file, so it was not read`
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
	const flags =
		(options.write ? fsConstants.O_WRONLY : fsConstants.O_RDONLY) |
		fsConstants.O_NONBLOCK |
		(options.noFollow ? fsConstants.O_NOFOLLOW : 0);
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, flags);
	} catch (error) {
		if (isEnoent(error)) return undefined;
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
 *
 * It must also be this user's and empty, read through the descriptor.
 *
 * What is left: an empty directory of this user's, swapped in before the
 * look in step 1 and already carrying exactly that mode, is taken for this
 * run's. It is filled, and if the run then fails, removed — `rmdir` takes
 * its extended attributes with it. What is put in it is open to nobody this
 * run's own directory would not have opened it to. No system call makes a
 * directory and hands back a descriptor on it, so no look taken after the
 * `mkdir` can tell such a directory from the one the `mkdir` made. And a
 * parent directory carrying a default ACL gives a new directory the ACL's
 * mode instead of `mode` less the umask, so there every directory this makes
 * can be refused: nothing is filled, and the refusal names it.
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
		}
		return held;
	} catch (error) {
		await held.handle.close().catch(() => undefined);
		throw error;
	}
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
		if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return undefined;
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

/** What {@link removeHeldDirectory} found at the name: the held directory, gone; nothing; something else, kept; or the held directory with something in it, kept. */
export type HeldDirectoryRemoval = "removed" | "absent" | "kept" | "not-empty";

/**
 * Remove `dir` only while its name holds `held`, a directory this run holds
 * open: one it made through {@link makeHeldDirectory}, or one a reclaim
 * proved and opened. Throws what the look or the `rmdir` threw, for the
 * caller to report.
 *
 * `rmdir` removes nothing but an empty directory, and an empty directory is
 * not nothing: one somebody put at the name has its own owner, mode and
 * extended attributes, and a review lost one to an `rmdir` by name that
 * reported success. So the name is looked at the instant before the `rmdir`
 * and must hold the held directory, whose inode number no other directory
 * can be given while this run holds its descriptor. One gap is left, as for
 * a file — see {@link unlinkFileNoOneElseWrites}: an empty directory renamed
 * onto the name between that look and the `rmdir` is removed, because POSIX
 * has no rmdir-if-this-inode.
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
		await handle.writeFile(text);
		return { ...held, bytes: Buffer.from(text) };
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
	let handle: fs.FileHandle | undefined;
	try {
		handle = await openRegularFile(file, { noFollow: true });
	} catch (error) {
		// Something else took the name since the look: a link, which `noFollow`
		// refuses, or a FIFO, a socket or a device.
		if (error instanceof NotARegularFile || (error instanceof Error && "code" in error && error.code === "ELOOP")) {
			return "kept";
		}
		throw error;
	}
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
	 * when one did.
	 */
	| { outcome: "kept"; note: string; cause?: unknown };

/** Private names tried before moving a file aside gives up. */
const ASIDE_ATTEMPTS = 8;

/**
 * Remove `file`, which a process other than gc may name and write — a live
 * transcript or artifact, or an archived copy a superseding copy replaces —
 * only once it has been moved to a name nobody else knows and judged there,
 * through a descriptor on what was moved.
 *
 * A look taken before an `unlink` of the name does not hold across the two:
 * a writer that appends by the name after the last look and before the
 * `unlink` loses what it wrote, and a review did exactly that to a reclaim,
 * which, like the restore after it, exited 0 without the turn. So the file
 * is moved to a private name — `.<name>.<16 random hex digits>.leaving`, in
 * the same directory — in two steps. The private name is first taken with an
 * empty placeholder created with `O_EXCL`, so nothing already standing at it
 * — planted, left over, or a collision — is ever replaced: a name that is
 * taken is given up for a fresh one. Then the file is renamed onto the
 * placeholder, in one atomic step that moves exactly what had the name at
 * that instant and leaves no moment at which the name can be changed under
 * it. From then on a write by the name — an append, or a save that renames
 * a new file onto it — makes a file of the writer's own there, which is
 * never touched, and a write before it is in what is judged, through a
 * descriptor opened on the private name now. What passes is unlinked there;
 * anything else is put back under its name with `link`, which replaces
 * nothing; if something has taken the name meanwhile, it stays at the
 * private name, which the note gives. Anything the rule's first look does
 * not match is not touched.
 *
 * Not `link` to the private name and then `unlink` of the name: a save that
 * renames a new file onto the name between those two calls — one an
 * `inotify` watcher sees coming, from the private name's appearance — is
 * what the `unlink` would then remove. What is left is at the private name
 * only, which no writer has any reason to write to: a process that watches
 * for it and renames a file of its own onto it — the placeholder before the
 * rename, or what moved before the `unlink` there — has that file removed.
 *
 * The placeholder is created by this run with `O_EXCL` and held, its
 * descriptor kept until the rename is done, and a rename that fails takes it
 * away by {@link removeFileNoOneElseWrites}, as this run's own file. Eight
 * private names taken in a row refuse the removal, naming the file, and
 * nothing moves.
 *
 * A run killed part-way leaves a `.leaving` name, and nothing removes it
 * automatically: no later run can show that a run made it, and a file whose
 * maker cannot be shown is not gc's to remove.
 *
 * - Killed between the placeholder and the rename: an empty file. Each killed
 *   run leaves its own name — a review's twenty kills left twenty — and a
 *   later reclaim that succeeds removes none of them.
 * - Killed after the rename and before the file is unlinked or linked back:
 *   the whole file, under the `.leaving` name, and nothing at its own name.
 *   It holds what the file held when it moved, which can be more than any
 *   copy holds if something was written to it just before the move. In a
 *   live artifact tree, which is where a reclaim moves an artifact, a restore
 *   brings the archived copy home at the file's name and leaves the
 *   `.leaving` file beside it; the next `gc --archive --apply` takes it for an
 *   artifact and copies it into the archive with no error, and from then on
 *   the archive holds it and a restore brings it home like any other
 *   artifact. A transcript's `.leaving` name is in its session bucket. A
 *   restore brings the archived transcript home at its ordinary name and
 *   leaves the whole copy under `.leaving`; the next `gc --archive --apply`
 *   takes that copy as an artifact, reports success, and puts it in the
 *   archive, from where a restore brings it home as an artifact. An archived
 *   artifact's — a superseded, withdrawn or rolled-back copy — is in the
 *   archived tree, and a restore brings it home as an artifact. A restore
 *   takes its record down only once the session is whole, so a kill there
 *   leaves a whole session and the record's text under the `.leaving` name.
 *
 * Either way the file is the user's to look at, compare with what stands at
 * the name it came from, and remove.
 *
 * And one writer stays outside any removal: one that held the file open
 * from before and writes through that descriptor after the judgment, which
 * no removal by any program can see.
 */
export async function removeFileOthersMayWrite(file: string, rule: OthersMayWriteRule): Promise<OthersMayWriteRemoval> {
	const kept = (why: string, cause?: unknown): OthersMayWriteRemoval => ({
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
	let aside: string | undefined;
	let placeholder: HeldFile | undefined;
	for (let attempt = 0; attempt < ASIDE_ATTEMPTS && aside === undefined; attempt++) {
		const candidate = path.join(
			path.dirname(file),
			`.${path.basename(file)}.${randomBytes(8).toString("hex")}.leaving`,
		);
		try {
			const handle = await createExclusive(candidate, 0o600);
			const { dev, ino } = await handle.stat().catch(async (error: unknown) => {
				await handle.close().catch(() => undefined);
				throw error;
			});
			placeholder = { handle, dev, ino };
			aside = candidate;
		} catch (error) {
			if (!isEexist(error))
				return kept(`${file} could not be moved aside to be checked (${errorText(error)})`, error);
		}
	}
	if (aside === undefined || placeholder === undefined) {
		return kept(
			`${file} could not be moved aside to be checked: ${ASIDE_ATTEMPTS} private names in a row were taken`,
		);
	}
	try {
		await fs.rename(file, aside);
	} catch (error) {
		// Nothing moved: the placeholder, still this run's, goes again.
		const left = await removeFileNoOneElseWrites(aside, [placeholder], "the placeholder this run made");
		await placeholder.handle.close().catch(() => undefined);
		if (isEnoent(error) && !left) return { outcome: "absent" };
		return kept(
			`${file} could not be moved aside to be checked (${errorText(error)})${left ? `; ${left}` : ""}`,
			error,
		);
	}
	await placeholder.handle.close().catch(() => undefined);
	let why: string | undefined;
	try {
		const moved = await fs.lstat(aside);
		const handle = moved.isFile()
			? await openRegularFile(aside, { noFollow: true }).catch(notRegularAsAbsent)
			: undefined;
		try {
			why = await rule.judge(moved, handle);
		} finally {
			await handle?.close().catch(() => undefined);
		}
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
	if (why === undefined) {
		try {
			await fs.unlink(aside);
			return { outcome: "removed" };
		} catch (error) {
			// Replaced, the name already holds its replacement, and only the old
			// file's private name is left over; otherwise the file goes back.
			if (rule.replaceWith) {
				return {
					outcome: "removed",
					note: `${file} was replaced, and what it held could not be removed from ${aside} (${errorText(error)})`,
				};
			}
			why = `${file} could not be removed (${errorText(error)})`;
		}
	}
	try {
		await fs.link(aside, file);
	} catch (error) {
		return {
			outcome: "kept",
			note: isEexist(error)
				? `${why}, and something else took its name meanwhile, so it was left at ${aside}`
				: `${why}, and it could not be put back (${errorText(error)}), so it was left at ${aside}`,
		};
	}
	try {
		await fs.unlink(aside);
	} catch (error) {
		return {
			outcome: "kept",
			note: `${why}, so it was put back, and its second name ${aside} could not be removed (${errorText(error)})`,
		};
	}
	return kept(why);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The error a read by name gave when nothing was at `file`, for a reader that opened it through {@link openRegularFile}. */
export function absentFile(file: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT", path: file });
}
