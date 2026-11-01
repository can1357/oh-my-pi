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
 * Make `dir`, new, with `mode` given to the `mkdir` itself, and hold it.
 *
 * The mode is set by the one call that makes the directory, as `mkdtemp`
 * sets `0700`: the kernel applies it, less the umask, as the directory comes
 * into being, so there is no moment at which the directory exists with a
 * mode it is later changed from, and nothing here changes a mode afterwards
 * — not through the name, not through a descriptor. A mode set after the
 * `mkdir` went to whatever the name held by then: through the name it
 * followed a link put there, and through a descriptor opened after the
 * `mkdir` it reached a directory a writer of this user's own swapped in
 * between the two calls — a review won that race with an inotify watcher
 * about a third of the time, the restore gave somebody's private directory
 * the archived `0777`, and another user removed its only file. With no
 * change of mode left, a directory swapped in keeps its own.
 *
 * The directory is then opened with `O_DIRECTORY` and `O_NOFOLLOW`, so a
 * link put at the name is refused, and what the descriptor holds must be a
 * directory of this user's with nothing in it, read through the descriptor:
 * a directory just made is empty, and one swapped in before the `open`
 * that holds anything is somebody's, so nothing is put into it. The caller
 * adds entries by name, each created afresh — never written over — and
 * keeps the descriptor, and the identity it reports, to say afterwards
 * whether the name still holds the directory and, while it is open, to know
 * the directory by an inode number no other entry can be given.
 */
export async function makeHeldDirectory(dir: string, mode: number): Promise<HeldFile> {
	await fs.mkdir(dir, { mode });
	const handle = await fs.open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		const notMine = (): Error =>
			new Error(`${dir} is not the directory this run just made, so nothing was put into it`);
		if (!stat.isDirectory() || (process.getuid !== undefined && stat.uid !== process.getuid())) throw notMine();
		// `/dev/fd/<n>` opens the directory the descriptor holds, wherever its
		// name has gone since; Windows has neither the path nor the swap.
		if (process.platform !== "win32" && (await fs.readdir(`/dev/fd/${handle.fd}`)).length > 0) throw notMine();
		return { handle, dev: stat.dev, ino: stat.ino };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
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
 * part names, the restore record, a stage — written once, by gc, through its
 * own descriptor, and appended to by nobody. A file anybody else may write
 * goes through {@link removeFileOthersMayWrite} instead, which catches a
 * write by its name that a look before an `unlink` cannot.
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
	/** What the name held was kept; `note` says why and where it is, for the command to print. */
	| { outcome: "kept"; note: string };

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
 * is first given a second name — `.<name>.<16 hex digits>.leaving`, in the
 * same directory, made with `link`, which never replaces a name already
 * taken — and then its own name is unlinked. From then on a write by the
 * name creates a new file of the writer's own, which is never touched, and
 * a write before it is in what is judged, through a descriptor opened on
 * the private name now. What passes is unlinked there; anything else is put
 * back under its name with `link`, which replaces nothing; if something has
 * taken the name meanwhile, it stays at the private name, which the note
 * gives. Anything the rule's first look does not match is not touched.
 *
 * Two writers stay outside this, neither of them one that loses its own
 * work to an ordinary write: one that renames a file onto the name in the
 * one system call between the `link` and the `unlink` of the name — POSIX
 * has no unlink-if-this-inode — and one that held the file open from before
 * and writes through that descriptor after the judgment, which no removal
 * by any program can see.
 */
export async function removeFileOthersMayWrite(file: string, rule: OthersMayWriteRule): Promise<OthersMayWriteRemoval> {
	const kept = (why: string): OthersMayWriteRemoval => ({ outcome: "kept", note: `${why}, so it was left as it is` });
	let standing: Stats;
	try {
		standing = await fs.lstat(file);
	} catch (error) {
		if (isEnoent(error)) return { outcome: "absent" };
		return kept(`${file} could not be looked at (${errorText(error)})`);
	}
	if (!rule.matches(standing)) return kept(rule.mismatch);
	let aside: string | undefined;
	for (let attempt = 0; attempt < ASIDE_ATTEMPTS && aside === undefined; attempt++) {
		const candidate = path.join(
			path.dirname(file),
			`.${path.basename(file)}.${randomBytes(8).toString("hex")}.leaving`,
		);
		try {
			await fs.link(file, candidate);
			aside = candidate;
		} catch (error) {
			if (isEnoent(error)) return { outcome: "absent" };
			if (!isEexist(error)) return kept(`${file} could not be moved aside to be checked (${errorText(error)})`);
		}
	}
	if (aside === undefined) {
		return kept(
			`${file} could not be moved aside to be checked: ${ASIDE_ATTEMPTS} private names in a row were taken`,
		);
	}
	try {
		await fs.unlink(file);
	} catch (error) {
		// Gone from its name since the `link`: the private name is now the only
		// one, and what it holds is judged like anything moved.
		if (!isEnoent(error)) {
			// The name stays, so the second one goes again: nothing was moved.
			const left = await fs
				.unlink(aside)
				.then(() => "")
				.catch(
					(unlinkError: unknown) =>
						`, and its second name ${aside} could not be removed (${errorText(unlinkError)})`,
				);
			return kept(`${file} could not be moved aside to be checked (${errorText(error)})${left}`);
		}
	}
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
