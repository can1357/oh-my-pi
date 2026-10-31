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
import * as fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
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

/** A file's identity: what a run captures from the descriptor that created it. */
export interface FileIdentity {
	dev: number;
	ino: number;
}

/**
 * Write `text` to `file`, which must not exist yet: created with `O_EXCL`,
 * so nothing already at the name — a FIFO, a link to somebody's file — is
 * written through, and EEXIST leaves whatever is there as it is. Returns the
 * identity of the file it created, from its own descriptor: the only proof,
 * later, that a file at that name is the one this call wrote. A write that
 * fails after the create takes away what it created, and only that.
 */
export async function writeExclusive(file: string, text: string, mode: number): Promise<FileIdentity> {
	const handle = await createExclusive(file, mode);
	let created: FileIdentity | undefined;
	try {
		const { dev, ino } = await handle.stat();
		created = { dev, ino };
		await handle.writeFile(text);
		return created;
	} catch (error) {
		const note = created ? await removeOwnFile(file, [created], "the file this run created") : undefined;
		throw note
			? new Error(`${error instanceof Error ? error.message : String(error)}; ${note}`, { cause: error })
			: error;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Remove `file` only while the name holds a regular file with one of the
 * identities in `own` — what the caller captured when it created it. A name
 * is not provenance: anything else standing there, whatever it is called,
 * is left as it is, and so is anything that cannot be looked at. Returns
 * undefined once nothing of the caller's is left at the name, or a sentence
 * saying what was left and why, `what` naming the caller's file ("the
 * record this run wrote").
 *
 * The look and the `unlink` both name a path, and no system call removes a
 * file by its inode: a writer who puts a file at the name between the two
 * has it removed. Such a concurrent writer is outside what this guards.
 */
export async function removeOwnFile(
	file: string,
	own: readonly FileIdentity[],
	what: string,
): Promise<string | undefined> {
	try {
		const standing = await fs.lstat(file).catch((error: unknown) => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		if (!standing) return undefined;
		if (!standing.isFile() || !own.some(id => id.dev === standing.dev && id.ino === standing.ino)) {
			return `${file} is not ${what}, so it was left as it is`;
		}
		await fs.unlink(file);
		return undefined;
	} catch (error) {
		return `${file} could not be checked or removed, so it was left as it is: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/** The error a read by name gave when nothing was at `file`, for a reader that opened it through {@link openRegularFile}. */
export function absentFile(file: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT", path: file });
}
