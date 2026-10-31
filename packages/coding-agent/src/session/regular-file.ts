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

/** Whether the file open at `handle` is one of `own`, by its identity and, where known, its bytes. */
async function isOneOf(handle: fs.FileHandle, own: readonly HeldFile[]): Promise<boolean> {
	const { dev, ino } = await handle.stat();
	const same = own.find(held => held.dev === dev && held.ino === ino);
	if (!same) return false;
	if (same.bytes === undefined) return true;
	return (await handle.readFile()).equals(same.bytes);
}

/**
 * Remove `file` only while the name holds one of `own`, files this run holds
 * — and say why not, otherwise. Returns undefined once nothing of this run's
 * is left at the name, or a sentence for the command to print, `what`
 * naming this run's file ("the record this run wrote").
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
 * - the bytes, compared through a descriptor on what is removed: for a file
 *   this run wrote, they carry a random value from {@link newNonce}, which a
 *   writer who did not read the file cannot repeat.
 *
 * And what is checked is what is removed: the name is first renamed to one
 * only this call knows, which moves exactly what has the name at that
 * moment, and the check and the `unlink` both act on that. Anything else is
 * put back under its name with `link`, which replaces nothing; if something
 * has taken the name meanwhile, it stays at the private name, which the
 * message gives. Anything that is not a regular file is not touched at all.
 *
 * A writer that can write in this directory and puts a file at the private
 * name between the rename and the `unlink` is outside this: the name has 64
 * random bits, and no system call removes a file by its descriptor.
 */
export async function removeOwnFile(file: string, own: readonly HeldFile[], what: string): Promise<string | undefined> {
	const kept = `${file} is not ${what}, so it was left as it is`;
	try {
		const standing = await fs.lstat(file).catch((error: unknown) => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		if (!standing) return undefined;
		if (!standing.isFile() || !own.some(held => held.dev === standing.dev && held.ino === standing.ino)) return kept;
		const aside = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(8).toString("hex")}.leaving`);
		try {
			await fs.rename(file, aside);
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
		const moved = await openRegularFile(aside, { noFollow: true }).catch(notRegularAsAbsent);
		let ours = false;
		try {
			ours = moved !== undefined && (await isOneOf(moved, own));
		} finally {
			await moved?.close().catch(() => undefined);
		}
		if (ours) {
			await fs.unlink(aside);
			return undefined;
		}
		try {
			await fs.link(aside, file);
		} catch (error) {
			if ((error as { code?: string }).code === "EEXIST") {
				return `${file} is not ${what}, and something else took its name meanwhile, so it was left at ${aside}`;
			}
			throw error;
		}
		await fs.unlink(aside);
		return kept;
	} catch (error) {
		return `${file} could not be checked or removed, so it was left as it is: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/** The error a read by name gave when nothing was at `file`, for a reader that opened it through {@link openRegularFile}. */
export function absentFile(file: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT", path: file });
}
