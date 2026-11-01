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
import { hasFsCode, isEnoent } from "@oh-my-pi/pi-utils";

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
 * Set the mode of the directory at `dir` through a descriptor opened on the
 * name itself: `chmod` by name follows a link put at the name since the
 * directory was made and changes the mode of whatever the link leads to. A
 * link at the name, or anything else but a directory, is refused with
 * nothing changed. Windows has no such links to follow, and no descriptor on
 * a directory to set a mode through.
 */
export async function chmodDirectory(dir: string, mode: number): Promise<void> {
	if (process.platform === "win32") return await fs.chmod(dir, mode);
	const handle = await fs.open(
		dir,
		fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
	);
	try {
		await handle.chmod(mode);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * A file this run holds: the descriptor it was created or read through,
 * still open; the identity that descriptor reports; and, where this run
 * knows them, the bytes the file holds — what this run wrote into it, a
 * random value among them, or what it read from it. See
 * {@link removeOwnFile} for what each layer proves.
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
		const note = held ? await removeOwnFile(file, [held], "the file this run created") : undefined;
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

/** What {@link unlinkOwnFile} found at the name: its own file, gone; nothing; or something else, kept. */
export type OwnFileRemoval = "removed" | "absent" | "kept";

/**
 * Unlink `file` only while the name holds one of `own`, files this run
 * holds. Throws what a look or the `unlink` threw, for the caller to report;
 * {@link removeOwnFile} reports it for most.
 *
 * A name is not provenance, and neither is an inode number: the kernel hands
 * a freed number to the next file created, so a file someone put at the name
 * after this run's was removed can carry the very number this run captured —
 * a reviewer saw it, on the first create, once a copy across filesystems had
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
 * One gap is left, and it is named rather than narrowed further: the
 * `unlink` removes whatever has the name at that instant, so a file renamed
 * onto it between that last look and the `unlink` — one system call later —
 * is removed. POSIX has no unlink-if-this-inode, and no portable call closes
 * it. Only a writer that can change this directory can reach it, and no gc
 * writer renames onto a name: each creates with `O_EXCL` or `link`, which
 * refuse a name already taken.
 */
export async function unlinkOwnFile(file: string, own: readonly HeldFile[]): Promise<OwnFileRemoval> {
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
		if (error instanceof NotARegularFile || hasFsCode(error, "ELOOP")) return "kept";
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
 * Remove `file` only while the name holds one of `own` — see
 * {@link unlinkOwnFile} — and say why not, otherwise. Returns undefined once
 * nothing of this run's is left at the name, or a sentence for the command
 * to print, `what` naming this run's file ("the record this run wrote").
 */
export async function removeOwnFile(file: string, own: readonly HeldFile[], what: string): Promise<string | undefined> {
	try {
		return (await unlinkOwnFile(file, own)) === "kept"
			? `${file} is not ${what}, so it was left as it is`
			: undefined;
	} catch (error) {
		return `${file} could not be checked or removed, so it was left as it is: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/** The error a read by name gave when nothing was at `file`, for a reader that opened it through {@link openRegularFile}. */
export function absentFile(file: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT", path: file });
}
