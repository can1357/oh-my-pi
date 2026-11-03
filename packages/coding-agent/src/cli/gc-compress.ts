/**
 * In-place transparent filesystem compression for cold session files.
 *
 * Compressed files keep their path, bytes, and mtime; the filesystem inflates
 * them on read, so every session reader works unchanged. Supported volumes:
 *
 * - APFS (macOS): `ditto --hfsCompression` writes a compressed copy of each
 *   file, and a copy takes its original's name only once the kernel has
 *   shown, with a file lease, that no other process holds either of them
 *   open — see {@link swapIn}. omp cannot ask macOS's kernel for such a
 *   lease, so on macOS nothing is compressed, and gc says why (see
 *   {@link compressUnavailable}). A later write stores the file
 *   uncompressed again.
 * - NTFS (Windows): `compact /c` sets LZNT1 compression on each file in place,
 *   keeping its inode and timestamps; later appends are stored compressed too.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { COMPRESS_SCRATCH_PREFIX } from "@oh-my-pi/omp-stats/parser";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils";
import { errnoName, isErrno, type Libc, libc, renameExchange } from "../session/libc";
import { leaseCallUnavailable, soleOpenLeaseStands, takeSoleOpenLease } from "../session/open-file-holders";
import {
	extendedAttributeNames,
	type HeldFile,
	inodeFlags,
	makeHeldDirectory,
	moveAside,
	newNonce,
	openRegularFile,
	putBack,
	removeFileOthersMayWrite,
	removeHeldDirectory,
	type StillMovedRemoval,
	unlinkStillMoved,
	writeExclusive,
} from "../session/regular-file";
import { type CopiedBytes, digestOfHandle, handleBeginsWith, holdsCopied } from "../session/session-archive";
import { FileSessionStorage } from "../session/session-storage";
import { errorMessage } from "../slash-commands/helpers/parse";
import { sha256File } from "../utils/file-hash";

const SCRATCH_GLOB = new Bun.Glob(`**/${COMPRESS_SCRATCH_PREFIX}*`);
/** Names tried before making a scratch directory gives up: a name taken this often in a row is no collision. */
const SCRATCH_ATTEMPTS = 16;

/** Formats whose bytes are already compressed; the filesystem would store them as-is. */
const INCOMPRESSIBLE_EXTENSIONS: Record<string, true> = {
	".gz": true,
	".zst": true,
	".png": true,
	".jpg": true,
	".jpeg": true,
	".webp": true,
	".gif": true,
};

/** Bounded argv per tool spawn; Windows caps a command line at 32K characters. */
const DITTO_BATCH = 256;
const COMPACT_BATCH = 64;
/** Files hashed at once, well below common open-file limits. */
const HASH_CONCURRENCY = 8;

/** `GetVolumeInformationW` flag: the volume supports per-file compression. */
const FILE_FILE_COMPRESSION = 0x10;

/** The `chattr` letter of each flag a person or a program sets. */
const FLAG_LETTERS: ReadonlyArray<readonly [number, string]> = [
	[0x1, "s"],
	[0x2, "u"],
	[0x4, "c"],
	[0x8, "S"],
	[0x10, "i"],
	[0x20, "a"],
	[0x40, "d"],
	[0x80, "A"],
	[0x400, "m"],
	[0x800, "E"],
	[0x4000, "j"],
	[0x8000, "t"],
	[0x10000, "D"],
	[0x20000, "T"],
	[0x100000, "V"],
	[0x800000, "C"],
	[0x2000000, "x"],
	[0x20000000, "P"],
	[0x40000000, "F"],
];

/**
 * The flags a person or a program sets. The rest — extents, an indexed
 * directory, inline data and their like — the filesystem sets on its own,
 * on a restored entry as on any other.
 */
const SET_BY_HAND = FLAG_LETTERS.reduce((mask, [bit]) => mask | bit, 0);

/** How this machine compresses files in place: the filesystem the sessions live on. */
export type CompressMethod = "apfs" | "ntfs";

export interface CompressCandidate {
	path: string;
	bytes: number;
	/** Bytes allocated on disk before compression. */
	allocated: number;
	mtimeMs: number;
	/** Identity at selection; a file that no longer matches is left alone. */
	mtimeNs: bigint;
	ino: bigint;
}

export interface CompressBatchResult {
	compressed: number;
	/** Bytes allocated on disk by the processed candidates afterwards. */
	allocatedAfter: number;
	errors: string[];
}

/**
 * The compression method for files under `dir`, or undefined when the volume
 * holding it has no transparent compression this phase drives (exFAT, SMB,
 * NFS, ReFS, FAT, Linux filesystems, or a missing `dir`).
 */
export async function compressMethod(
	dir: string,
	platform: NodeJS.Platform = process.platform,
): Promise<CompressMethod | undefined> {
	try {
		if (platform === "darwin") return (await isApfsVolume(dir)) ? "apfs" : undefined;
		if (platform === "win32") return isCompressingNtfsVolume(dir) ? "ntfs" : undefined;
	} catch {
		// An unreadable dir or mount table means no supported volume.
	}
	return undefined;
}

/**
 * Why this system cannot compress with `method` without risking a write, or
 * undefined where it can. NTFS compresses each file in place, under every
 * writer. APFS puts a compressed copy in place of each file, and that is safe
 * only once the kernel has shown that no other process holds the file open —
 * a process that wrote through a descriptor it held would otherwise write to
 * a file no name reaches any more. Only a kernel file lease shows that, and
 * where omp cannot ask for one at all — macOS, whose C library it cannot pass
 * `fcntl`'s argument to — no file is copied and nothing is swapped.
 */
export function compressUnavailable(method: CompressMethod): string | undefined {
	if (method !== "apfs") return undefined;
	const refusal = leaseCallUnavailable();
	if (!refusal) return undefined;
	return (
		"APFS compression puts a compressed copy in place of each file, which is safe only once the kernel shows that " +
		`no other process holds the file open, and ${refusal.meaning} (${refusal.evidence}), so no file is compressed`
	);
}

/**
 * Whether `dir` sits on an APFS volume. `statfs` reports a load-order type
 * number on macOS, so the mount table entry with the same device decides.
 */
async function isApfsVolume(dir: string): Promise<boolean> {
	const { dev } = await fs.stat(dir);
	const mounts = await $`/sbin/mount`.quiet().nothrow();
	for (const line of mounts.stdout.toString().split("\n")) {
		// "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)"
		const match = /^.+? on (.+) \(([^,)]+)/.exec(line);
		if (match?.[2] !== "apfs") continue;
		try {
			if ((await fs.stat(match[1])).dev === dev) return true;
		} catch {
			// A mount point this user cannot stat holds no sessions dir of theirs.
		}
	}
	return false;
}

/** Whether `dir` sits on an NTFS volume that supports per-file compression. */
function isCompressingNtfsVolume(dir: string): boolean {
	const kernel32 = dlopen("kernel32.dll", {
		GetVolumePathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		GetVolumeInformationW: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
			returns: FFIType.i32,
		},
	});
	try {
		const chars = 261;
		const root = Buffer.alloc(chars * 2);
		const target = Buffer.from(`${path.resolve(dir)}\0`, "utf16le");
		if (!kernel32.symbols.GetVolumePathNameW(ptr(target), ptr(root), chars)) return false;
		const flags = new Uint32Array(1);
		const name = Buffer.alloc(chars * 2);
		if (!kernel32.symbols.GetVolumeInformationW(ptr(root), null, 0, null, null, ptr(flags), ptr(name), chars)) {
			return false;
		}
		const fsName = name.toString("utf16le").split("\0")[0];
		return fsName === "NTFS" && (flags[0] & FILE_FILE_COMPRESSION) !== 0;
	} finally {
		kernel32.close();
	}
}

/**
 * Whether `file` should be compressed: a regular file larger than one
 * filesystem block, in a compressible format, with a single link, and not
 * already stored compressed. A single-block file cannot shrink, and replacing
 * a hard-linked file would split it from its other names. A compressed file
 * allocates fewer blocks than its logical size; session files are never
 * sparse, so that comparison identifies them.
 */
export async function compressCandidate(file: string): Promise<CompressCandidate | undefined> {
	if (INCOMPRESSIBLE_EXTENSIONS[path.extname(file).toLowerCase()]) return undefined;
	const stat = await fs.lstat(file, { bigint: true });
	if (!stat.isFile() || stat.nlink > 1n || stat.size <= stat.blksize) return undefined;
	const allocated = Number(stat.blocks) * 512;
	if (allocated < stat.size) return undefined;
	return {
		path: file,
		bytes: Number(stat.size),
		allocated,
		mtimeMs: Number(stat.mtimeMs),
		mtimeNs: stat.mtimeNs,
		ino: stat.ino,
	};
}

/**
 * Directories under `roots` named like a compression scratch directory —
 * what a killed run leaves — found and reported, never removed. A name, a
 * file inside it or its being empty is no proof gc made a directory: a
 * review lost a user's only copy of a file to a sweep that trusted a name
 * and a marker, and an empty directory of somebody's to one that trusted
 * emptiness. A run removes only the scratch it made itself and holds (see
 * {@link removeScratch}), so a killed run's scratch stays until someone who
 * has looked at it removes it.
 */
export async function findCompressScratch(roots: string[], errors: string[]): Promise<string[]> {
	const found: string[] = [];
	for (const root of roots) {
		const names: string[] = [];
		try {
			for await (const name of SCRATCH_GLOB.scan({ cwd: root, dot: true, onlyFiles: false })) names.push(name);
		} catch (error) {
			if (!isEnoent(error)) errors.push(`${root}: ${errorMessage(error)}`);
			continue;
		}
		for (const name of names.sort()) {
			const dir = path.join(root, name);
			try {
				if ((await fs.lstat(dir)).isDirectory()) found.push(dir);
			} catch (error) {
				if (!isEnoent(error)) errors.push(`${dir}: ${errorMessage(error)}`);
			}
		}
	}
	return found;
}

/** A scratch directory this run made, held: see {@link makeScratch}. */
interface Scratch {
	dir: string;
	held: HeldFile;
}

/**
 * Make a scratch directory of this run's own in `dir`, at a fresh random
 * name, and hold it — made and proved by {@link makeHeldDirectory}, mode
 * `0700`, its descriptor kept — so {@link removeScratch} removes it only while
 * its name holds that very directory.
 */
async function makeScratch(dir: string): Promise<Scratch> {
	for (let attempt = 0; attempt < SCRATCH_ATTEMPTS; attempt++) {
		const scratch = path.join(dir, `${COMPRESS_SCRATCH_PREFIX}${randomBytes(8).toString("hex")}`);
		try {
			return { dir: scratch, held: await makeHeldDirectory(scratch, 0o700) };
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
	}
	throw new Error(
		`no scratch directory could be made in ${dir}: ${SCRATCH_ATTEMPTS} names in a row were already taken`,
	);
}

/**
 * Take away the scratch directory this run made, once the files in it this
 * run made are gone, and only while its name holds the held directory and it
 * is empty. Anything else inside is somebody's: it and the directory are
 * left, and said. Returns a sentence for each thing left; never throws, since
 * this runs on the way out of a failure as often as a success.
 */
async function removeScratch(scratch: Scratch): Promise<string[]> {
	const notes: string[] = [];
	try {
		const removal = await removeHeldDirectory(scratch.dir, scratch.held);
		if (removal === "kept") notes.push(`${scratch.dir} is not the directory this run made, so it was left as it is`);
		if (removal === "not-empty") {
			// What this run left there is in the notes before this one; the rest is not its.
			notes.push(`${scratch.dir} is not empty, so it was left as it is`);
		}
	} catch (error) {
		notes.push(`${scratch.dir} could not be removed, so it was left as it is: ${errorMessage(error)}`);
	} finally {
		await scratch.held.handle.close().catch(() => undefined);
	}
	return notes;
}

/**
 * What a file carries besides its bytes, which the copy put in its place must
 * carry exactly: its permission bits, owner, group, modification time to the
 * nanosecond, every extended attribute this process can list with what each
 * holds — access control lists and file capabilities among them — and the
 * inode flags a person or a program sets. The change time, the birth time
 * and the inode number are the filesystem's own, and no copy carries them:
 * the copy is a new file.
 */
interface CarriedMetadata {
	mode: number;
	uid: number;
	gid: number;
	mtimeNs: bigint;
	xattrs: ReadonlyMap<string, Buffer>;
	flags: number;
}

/** What the file open at `handle` carries; see {@link CarriedMetadata}. Throws when any of it cannot be read. */
async function carriedMetadata(handle: fs.FileHandle): Promise<CarriedMetadata> {
	const stat = await handle.stat({ bigint: true });
	return {
		mode: Number(stat.mode & 0o7777n),
		uid: Number(stat.uid),
		gid: Number(stat.gid),
		mtimeNs: stat.mtimeNs,
		xattrs: extendedAttributes(handle.fd),
		flags: (inodeFlags(handle.fd) ?? 0) & SET_BY_HAND,
	};
}

/** Every extended attribute this process can list on the file open at `fd`, with what each holds. */
function extendedAttributes(fd: number): Map<string, Buffer> {
	const values = new Map<string, Buffer>();
	const names = extendedAttributeNames(fd);
	if (names.length === 0) return values;
	const lib = libc();
	for (const name of names.sort()) values.set(name, extendedAttribute(lib, fd, name));
	return values;
}

/** What the extended attribute `name` holds on the file open at `fd`. Throws when it cannot be read: "could not look" is not "the same". */
function extendedAttribute(lib: Libc, fd: number, name: string): Buffer {
	for (let attempt = 0; attempt < 8; attempt++) {
		const size = lib.fgetxattr(fd, name, null, 0);
		if (size < 0) throw new Error(`its extended attribute ${name} could not be read (${errnoName(lib.errno())})`);
		const value = Buffer.alloc(size);
		if (size === 0) return value;
		const got = lib.fgetxattr(fd, name, value, size);
		if (got >= 0) return value.subarray(0, got);
		const code = lib.errno();
		// It grew between sizing the buffer and reading it.
		if (!isErrno(code, "ERANGE"))
			throw new Error(`its extended attribute ${name} could not be read (${errnoName(code)})`);
	}
	throw new Error(`its extended attribute ${name} kept changing while it was read`);
}

/** How `copy` differs from `original` in what a file carries, as a phrase; undefined when it carries the same. */
function metadataDifference(original: CarriedMetadata, copy: CarriedMetadata): string | undefined {
	const differences: string[] = [];
	if (copy.mode !== original.mode) differences.push(`mode ${copy.mode.toString(8)}, not ${original.mode.toString(8)}`);
	if (copy.uid !== original.uid || copy.gid !== original.gid) {
		differences.push(`owner ${copy.uid}:${copy.gid}, not ${original.uid}:${original.gid}`);
	}
	if (copy.mtimeNs !== original.mtimeNs) differences.push("another modification time");
	if (copy.flags !== original.flags) {
		differences.push(`inode flags ${copy.flags.toString(16)}, not ${original.flags.toString(16)}`);
	}
	const changed = [...new Set([...original.xattrs.keys(), ...copy.xattrs.keys()])].filter(name => {
		const before = original.xattrs.get(name);
		const after = copy.xattrs.get(name);
		return before === undefined || after === undefined || !before.equals(after);
	});
	if (changed.length > 0) differences.push(`other extended attributes (${changed.sort().join(", ")})`);
	return differences.length > 0 ? differences.join(", ") : undefined;
}

/**
 * A file this run holds open, read-only, under the kernel's lease — see
 * `takeSoleOpenLease` (`open-file-holders.ts`) — which is granted only while
 * no other process holds the file open, however it came by its descriptor,
 * and is broken by any later open or truncation, which
 * {@link soleOpenLeaseStands} sees. While it stands nothing but this run
 * reaches the file's bytes, so `proof`, what they were once the lease was
 * taken, is what they are. Its metadata is another matter: a `chmod`,
 * `chown`, `setxattr` or `utimes` by name opens nothing and leaves a lease
 * standing (measured on Linux 7.0, ext4), so `metadata` is read again
 * wherever it is relied on.
 */
interface LeasedFile {
	handle: fs.FileHandle;
	dev: number;
	ino: number;
	proof: CopiedBytes;
	metadata: CarriedMetadata;
}

/**
 * Lease the file open at `handle`, which `file` names, and read under the
 * lease what it holds and carries: the {@link LeasedFile}, or the clause
 * saying why it is not this run's to vouch for — the file is open or mapped
 * elsewhere, or the kernel gives no lease here. A refused lease says only
 * that some other open or mapping of the file exists; it can be this
 * process's own, so the clause names no process. The caller closes `handle`.
 */
async function leaseFile(file: string, handle: fs.FileHandle): Promise<LeasedFile | string> {
	const lease = takeSoleOpenLease(handle.fd);
	if (lease.outcome === "open-elsewhere") {
		return `${file} is open or mapped elsewhere (${lease.evidence}), by a process the kernel does not name, this one not excluded`;
	}
	if (lease.outcome === "unproved") {
		return `whether anything else holds ${file} open could not be told: ${lease.meaning} (${lease.evidence})`;
	}
	const { dev, ino } = await handle.stat();
	return { handle, dev, ino, proof: await digestOfHandle(handle), metadata: await carriedMetadata(handle) };
}

/**
 * Unlink `aside`, the private name a file this run holds as `held` was moved
 * to, only while that file's lease still stands — so no other process has
 * opened it since its bytes were proved; one that has keeps it — only while
 * what it carries is what was proved — a `chmod`, `chown`, `setxattr` or
 * `utimes` leaves a lease standing, and a file somebody changed is theirs —
 * and only while `aside` still names it. The unlink is the call after that
 * last look: a process that learns the private name and opens it in
 * between, or renames a file of its own onto it, is the one thing left, one
 * system call wide; POSIX has no unlink-if-unopened, and no
 * unlink-if-this-inode. Undefined once it is gone; otherwise the clause
 * saying why not.
 */
async function unlinkLeased(file: string, aside: string, held: LeasedFile): Promise<string | undefined> {
	try {
		if (!soleOpenLeaseStands(held.handle.fd)) return `${file} ${OPENED} after this run proved it`;
		const changed = await changedSince(held);
		if (changed) return `${file} ${changed} after this run proved it`;
	} catch (error) {
		return `${file} could not be checked again (${errorMessage(error)})`;
	}
	let removal: StillMovedRemoval;
	try {
		removal = await unlinkStillMoved(aside, held);
	} catch (error) {
		return `${file} could not be removed (${errorMessage(error)})`;
	}
	if (removal === "removed") return undefined;
	if (removal === "absent")
		return `${file} was moved away from ${aside} by another process before it could be removed`;
	return `${aside}, where ${file} was moved to be removed, was taken by another process's file`;
}

/**
 * Remove `file`, which this run holds as `held` under its lease: moved to a
 * private name with a rename that replaces nothing (`moveAside`), then
 * {@link unlinkLeased}. What may not go is put back under its name, or left
 * at the private name where something has taken that, and said. Undefined
 * once it is gone; otherwise the sentence saying where it is and why.
 */
async function removeLeased(file: string, held: LeasedFile, what: string): Promise<string | undefined> {
	const moved = await moveAside(file, {
		matches: stat => stat.isFile() && stat.dev === held.dev && stat.ino === held.ino,
		mismatch: `${file} is not ${what}`,
	});
	if (moved.outcome === "absent")
		return `${file}, ${what}, was moved away by another process before it could be removed`;
	if (moved.outcome === "kept") return moved.note;
	const why = await unlinkLeased(file, moved.aside, held);
	if (why === undefined) return undefined;
	return (await putBack(file, moved.aside, why)) ?? `${why}, so it was kept`;
}

/**
 * Remove `file`, which this run wrote as `expected` and holds no descriptor
 * on: opened and leased now, and removed by {@link removeLeased} only when
 * it holds exactly those bytes. Where the kernel gives no lease for it, or
 * another process holds it open, it is kept and said. The one exception is a
 * system that has no lease to ask for at all — Windows, where the compression
 * probe is the only file gc writes — which judges it by its bytes alone, as
 * `removeFileOthersMayWrite` does: a process that opened that probe and
 * writes to it after the judgment writes to a file that is gone.
 */
async function removeWritten(file: string, expected: CopiedBytes, what: string): Promise<string | undefined> {
	if (leaseCallUnavailable()) {
		const removal = await removeFileOthersMayWrite(file, {
			matches: stat => stat.isFile(),
			mismatch: `${file} is not ${what}`,
			judge: async (_moved, handle) =>
				handle && (await holdsCopied(expected)(handle))
					? undefined
					: `${file} holds what this run did not write there`,
		});
		return removal.outcome === "absent" ? undefined : removal.note;
	}
	let handle: fs.FileHandle | undefined;
	try {
		handle = await openRegularFile(file, { noFollow: true });
	} catch (error) {
		return `${file} could not be checked (${errorMessage(error)}), so it was left as it is`;
	}
	if (!handle) return undefined;
	try {
		const leased = await leaseFile(file, handle);
		if (typeof leased === "string") return `${leased}, so it was left as it is`;
		if (leased.proof.hash !== expected.hash || leased.proof.size !== expected.size) {
			return `${file} holds what this run did not write there, so it was left as it is`;
		}
		return await removeLeased(file, leased, what);
	} catch (error) {
		return `${file} could not be checked (${errorMessage(error)}), so it was left as it is`;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Compress `candidates` in place. The caller must hold whatever lease keeps
 * writers off these files.
 *
 * APFS: each directory's files are copied with compression into a scratch
 * directory beside them, and a copy takes its original's place only as
 * {@link swapIn} proves it may; transcripts (the paths in `transcripts`)
 * swap under the session publish lock. Nothing is copied where the system
 * gives no file lease — see {@link compressUnavailable}. NTFS: the
 * filesystem compresses each file in place.
 */
export async function compressFilesInPlace(
	candidates: CompressCandidate[],
	method: CompressMethod,
	transcripts: ReadonlySet<string>,
): Promise<CompressBatchResult> {
	const result: CompressBatchResult = { compressed: 0, allocatedAfter: 0, errors: [] };
	if (method === "ntfs") {
		for (let start = 0; start < candidates.length; start += COMPACT_BATCH) {
			await compactBatch(candidates.slice(start, start + COMPACT_BATCH), result);
		}
		return result;
	}
	const unavailable = compressUnavailable(method);
	if (unavailable) {
		for (const candidate of candidates) result.allocatedAfter += candidate.allocated;
		if (candidates.length > 0) result.errors.push(unavailable);
		return result;
	}
	const byDir = new Map<string, CompressCandidate[]>();
	for (const candidate of candidates) {
		const dir = path.dirname(candidate.path);
		const group = byDir.get(dir);
		if (group) group.push(candidate);
		else byDir.set(dir, [candidate]);
	}
	const storage = new FileSessionStorage();
	for (const [dir, group] of byDir) {
		for (let start = 0; start < group.length; start += DITTO_BATCH) {
			await compressBatch(storage, dir, group.slice(start, start + DITTO_BATCH), transcripts, result);
		}
	}
	return result;
}

/**
 * Whether `method` actually stores a compressible file compressed under `dir`.
 * The volume type alone does not prove it: on macOS 27 `ditto --hfsCompression`
 * exits 0 but writes plain copies (#16244), and policy can disable NTFS
 * compression. Runs one throwaway file through {@link compressFilesInPlace}
 * inside a scratch directory of this run's own, then takes away the probe —
 * leased and judged by its bytes, see {@link removeWritten} — and the
 * directory, with nothing else. Throws, creating nothing, where the system
 * cannot compress with `method` safely ({@link compressUnavailable}); throws
 * when the compression tool itself fails, so a broken run is not mistaken
 * for a volume that stores files uncompressed, and when anything was left
 * behind.
 */
export async function compressionWorks(dir: string, method: CompressMethod): Promise<boolean> {
	const unavailable = compressUnavailable(method);
	if (unavailable) throw new Error(unavailable);
	const scratch = await makeScratch(dir);
	const probe = path.join(scratch.dir, "probe.txt");
	// A random value first: what holds these bytes at the probe's name is the
	// probe this run wrote, or the compressed copy APFS swapped in for it.
	const text = `${newNonce()}\n${"omp gc compression probe\n".repeat(10_000)}`;
	const proof: CopiedBytes = {
		hash: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
		size: Buffer.byteLength(text),
	};
	let works = false;
	let failed = false;
	let failure: unknown;
	try {
		// Closed before the tool runs, so this run holds nothing open that
		// `compact` has to work on, and nothing that refuses the probe's lease.
		await (await writeExclusive(probe, text, 0o600)).handle.close();
		const candidate = await compressCandidate(probe);
		if (candidate) {
			const batch = await compressFilesInPlace([candidate], method, new Set());
			if (batch.errors.length > 0) throw new Error(batch.errors.join("; "));
			works = batch.compressed === 1;
		}
	} catch (error) {
		failed = true;
		failure = error;
	}
	const probeLeft = await removeWritten(probe, proof, "the probe this run wrote");
	const left = [...(probeLeft === undefined ? [] : [probeLeft]), ...(await removeScratch(scratch))];
	if (failed) {
		if (left.length === 0) throw failure;
		throw new Error(`${errorMessage(failure)}; ${left.join("; ")}`, { cause: failure });
	}
	if (left.length > 0) throw new Error(left.join("; "));
	return works;
}

async function compactBatch(batch: CompressCandidate[], result: CompressBatchResult): Promise<void> {
	for (const candidate of batch) result.allocatedAfter += candidate.allocated;
	// LZNT1 rather than `/exe` (WOF) compression: WOF inflates the whole file on
	// its next write, so a resumed session would lose all its savings. LZNT1
	// compresses in place, so a concurrent appender cannot lose data. `/i` keeps
	// going past a file that fails (one held open) instead of stopping the batch;
	// `/a` because compact documents Hidden and System files as excluded by default.
	const run = await $`compact /c /i /a /q ${batch.map(candidate => candidate.path)}`.quiet().nothrow();
	if (run.exitCode !== 0) {
		const output = `${run.stdout.toString()}${run.stderr.toString()}`.trim().split("\n").slice(-3).join(" ");
		result.errors.push(`compact exited ${run.exitCode}: ${output}`);
	}
	for (const candidate of batch) {
		try {
			const allocated = (await fs.lstat(candidate.path)).blocks * 512;
			if (allocated >= candidate.allocated) continue;
			result.compressed += 1;
			result.allocatedAfter += allocated - candidate.allocated;
		} catch (error) {
			result.errors.push(`${candidate.path}: ${errorMessage(error)}`);
		}
	}
}

/**
 * What became of {@link swapIn}: whether the copy has the original's name
 * now, whether the original is gone, whether the copy is still at its
 * scratch name for cleanup to take away, and what is left to say.
 */
interface SwapOutcome {
	swapped: boolean;
	originalFreed: boolean;
	copyAtScratch: boolean;
	notes: string[];
}

/**
 * Put `copy` — the compressed copy of `candidate` this run made at
 * `copyPath` and holds under its lease — in place of the original, so that
 * what ends up under the original's name is exactly what was proved, bytes
 * and metadata, nothing done to the file by its name or through a
 * descriptor opened before is lost, and the name never stands without a
 * whole file:
 *
 * 1. The original is opened at its name and leased. The kernel grants the
 *    lease only while no other process holds the file open, so a writer
 *    holding a descriptor from before refuses the swap; and any process that
 *    opens it from then on, by its name or any other, breaks the lease.
 * 2. Under the lease, the original's bytes and metadata are read, and must
 *    be the copy's; both leases must still stand, both files have one name,
 *    and the copy's metadata is what it was when the copy was proved.
 * 3. The two names are exchanged in one call ({@link renameExchange}): the
 *    original's name holds the copy and the copy's scratch name holds the
 *    original, each whole, with nothing replaced. A process that reaches the
 *    name before the exchange reaches the original, and one after reaches
 *    the copy.
 * 4. {@link settleExchange} looks at both names and both files again and
 *    decides which file the name keeps; see there.
 *
 * Transcripts do all of it under the session publish lock, which every omp
 * binary's appends take, so none lands mid-swap.
 */
async function swapIn(
	storage: FileSessionStorage,
	candidate: CompressCandidate,
	copyPath: string,
	copy: LeasedFile,
	transcript: boolean,
): Promise<SwapOutcome> {
	if (!transcript) return await swapUnlocked(candidate, copyPath, copy);
	return await storage.withPublishLock(candidate.path, () => swapUnlocked(candidate, copyPath, copy));
}

async function swapUnlocked(candidate: CompressCandidate, copyPath: string, copy: LeasedFile): Promise<SwapOutcome> {
	const file = candidate.path;
	const kept = (note: string): SwapOutcome => ({
		swapped: false,
		originalFreed: false,
		copyAtScratch: true,
		notes: [note],
	});
	let exchanged = false;
	let handle: fs.FileHandle | undefined;
	try {
		handle = await openRegularFile(file, { noFollow: true });
		if (!handle) return kept(`${file} was gone before its compressed copy could take its place`);
		const original = await leaseFile(file, handle);
		if (typeof original === "string") return kept(`${original}, so it was left as it is`);
		const refusal = await swapRefusal(file, candidate, original, copyPath, copy);
		if (refusal) return kept(`${refusal}, so it was left as it is`);
		const swap = await renameExchange(copyPath, file);
		if (swap.outcome === "absent") {
			// A removal of the session file is that process's deletion of it, which
			// stands: the copy not put in place goes, as any such copy does.
			const which = isHeld(await identityAt(copyPath), copy)
				? `another process removed ${file} just before its compressed copy took its place`
				: `the compressed copy of ${file} lost its name ${copyPath} just before it took ${file}'s place`;
			return kept(`${which}, so nothing moved`);
		}
		if (swap.outcome === "unsupported") {
			return kept(`the compressed copy of ${file} could not be put in its place (${swap.why}), so nothing moved`);
		}
		exchanged = true;
		return await settleExchange(file, copyPath, original, copy);
	} catch (error) {
		const why = `${file} could not be checked (${errorMessage(error)})`;
		if (!exchanged) return kept(`${why}, so it was left as it is`);
		// What the two names hold is unknown, so neither is touched again.
		return {
			swapped: false,
			originalFreed: false,
			copyAtScratch: false,
			notes: [
				`${why} after it was exchanged with its compressed copy, so ${file} and ${copyPath} were left as they are`,
			],
		};
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * Why the original, open at its name and held as `original`, may not give
 * way to `copy` — steps 1 and 2 of {@link swapIn} — or undefined when it may.
 */
async function swapRefusal(
	file: string,
	candidate: CompressCandidate,
	original: LeasedFile,
	copyPath: string,
	copy: LeasedFile,
): Promise<string | undefined> {
	const stat = await original.handle.stat();
	if (stat.ino !== Number(candidate.ino)) return `${file} is no longer the file selected to be compressed`;
	// A copy in place of one name would split the file from its other names.
	if (stat.nlink !== 1) return `${file} has another name now`;
	if (original.proof.hash !== copy.proof.hash || original.proof.size !== copy.proof.size) {
		return `${file} changed after it was copied`;
	}
	const carried = metadataDifference(original.metadata, copy.metadata);
	if (carried) return `the compressed copy of ${file} carries ${carried}`;
	if (!soleOpenLeaseStands(original.handle.fd)) return `${file} ${OPENED} while it was checked`;
	if (!soleOpenLeaseStands(copy.handle.fd)) {
		return `the compressed copy of ${file}, ${copyPath}, ${OPENED} after this run proved it`;
	}
	const links = (await copy.handle.stat()).nlink;
	if (links === 0)
		return `the compressed copy of ${file} no longer has its name ${copyPath}: another process took it away`;
	if (links !== 1) return `the compressed copy of ${file}, ${copyPath}, has another name`;
	const changed = await changedSince(copy);
	if (changed) return `the compressed copy of ${file}, ${copyPath}, ${changed} after this run proved it`;
	return undefined;
}

/** What a name holds, by identity: the file's device and inode, and whether it is a regular file. */
interface NameIdentity {
	dev: number;
	ino: number;
	isFile: boolean;
}

/** The identity of what `name` holds now, or undefined when it holds nothing. Throws when it cannot be looked at. */
async function identityAt(name: string): Promise<NameIdentity | undefined> {
	try {
		const stat = await fs.lstat(name);
		return { dev: stat.dev, ino: stat.ino, isFile: stat.isFile() };
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

const isHeld = (at: NameIdentity | undefined, held: LeasedFile): boolean =>
	at?.isFile === true && at.dev === held.dev && at.ino === held.ino;

/**
 * Decide, once the names are exchanged, which file the session file's name
 * keeps — step 4 of {@link swapIn}. After the exchange the name is the
 * users': whatever reached it since — a `chmod`, `setxattr`, `utimes` or
 * `chown` by name, a `link` of it, an open (which breaks the copy's lease
 * and waits on it) and what it then writes, a file renamed onto it, its
 * removal — reached the copy, or the name, and is kept by leaving the copy,
 * or what the name holds, there. The original must have its name back only
 * when something reached it at that name just before the exchange: an open
 * (its lease no longer stands; the opener then holds the original), a
 * change to what it carries, another name for it, or a file renamed onto
 * the name, which the exchange sent to the scratch name instead.
 *
 * The name goes back by a second exchange ({@link exchangeBack}), and only
 * while nothing has reached the copy at the name since the first; when
 * something has, both have a claim to the name, so the copy keeps it, and
 * the original stays at the scratch name, with whatever reached it, and is
 * said. A file another process renamed onto the name after the exchange
 * keeps it. Otherwise the original, unchanged and unopened, is unlinked at
 * the scratch name while its lease still stands ({@link unlinkLeased}), and
 * the copy in place keeps its one name: gc removes no name of it.
 *
 * The boundary: gc holds each session's ownership lease while it
 * compresses, so no omp process works on these files meanwhile; only a
 * process that ignores that lease can reach a name during a swap. One such
 * reach, before or after the exchange, is kept as above. A second one, in
 * the few system calls between the look here and the exchange back, goes to
 * the scratch name with the file it reached: the exchange back is the
 * swap's last move, so it is seen after, reported, and the file is kept,
 * never removed, but the session file's name does not have it.
 *
 * A removal of the session file's name, or a file renamed onto it, is the
 * other process's deletion or replacement of the session, at whatever point
 * of the swap it lands: gc does not keep what the name held for it, and
 * removes its own copies as it would have — the original at the scratch
 * name, once nothing reached it, and a copy not put in place.
 */
async function settleExchange(
	file: string,
	copyPath: string,
	original: LeasedFile,
	copy: LeasedFile,
): Promise<SwapOutcome> {
	const atName = await identityAt(file);
	const atScratch = await identityAt(copyPath);
	if (!isHeld(atName, copy)) {
		// Removed, or replaced by a rename onto it, after the exchange: the other
		// process's deletion or replacement of the session, which stands.
		const happened = atName
			? `another process put a file at ${file} as it was compressed, and it was left there`
			: `another process removed ${file} as it was compressed`;
		if (!isHeld(atScratch, original)) {
			return {
				swapped: false,
				originalFreed: false,
				copyAtScratch: false,
				notes: [`${happened}; ${copyPath} holds another file too, and was left as it is`],
			};
		}
		const why = (await originalChanged(file, original)) ?? (await unlinkLeased(file, copyPath, original));
		const notes = [why ? `${happened}; ${why}, so what ${file} held before was left at ${copyPath}` : happened];
		return { swapped: false, originalFreed: why === undefined, copyAtScratch: false, notes };
	}
	const giveBack = !isHeld(atScratch, original)
		? `another process put a file at ${file} as it was exchanged with its compressed copy`
		: await originalChanged(file, original);
	// A write to the copy is a reach too: after a long enough stall its lease
	// lapses, and a process that opened the name has written through it.
	const reached = (await copyWritten(copy)) ?? (await copyReached(file, copy));
	if (!giveBack) {
		const why = await unlinkLeased(file, copyPath, original);
		const notes = why ? [`${why}, so what ${file} held before it was compressed was left at ${copyPath}`] : [];
		// The compressed copy counts only while the name still holds it.
		let atNameNow: NameIdentity | undefined;
		try {
			atNameNow = await identityAt(file);
		} catch (error) {
			const removed = why === undefined ? "what it held before was removed at the scratch name, and " : "";
			notes.push(
				`${removed}whether ${file} still holds its compressed copy could not be checked (${errorMessage(error)}), so it was not counted`,
			);
			return { swapped: false, originalFreed: why === undefined, copyAtScratch: false, notes };
		}
		if (!isHeld(atNameNow, copy)) {
			notes.push(
				atNameNow
					? `another process put a file at ${file} as it was compressed, and it was left there`
					: `another process removed ${file} as it was compressed`,
			);
			return { swapped: false, originalFreed: why === undefined, copyAtScratch: false, notes };
		}
		return { swapped: true, originalFreed: why === undefined, copyAtScratch: false, notes };
	}
	if (reached) {
		return {
			swapped: true,
			originalFreed: false,
			copyAtScratch: false,
			notes: [
				`${giveBack}, and the compressed copy in its place ${reached} since, so the copy keeps the name and what ${file} held before was left at ${copyPath}`,
			],
		};
	}
	return await exchangeBack(file, copyPath, copy, giveBack);
}

/**
 * How something reached a leased file, as a phrase. A broken lease shows
 * that an open was made or tried, or the file was truncated, not which, and
 * not by whom: it can be this very process.
 */
const OPENED =
	"was opened, or an open of it was tried, or it was truncated, by a process the kernel does not name, this one not excluded,";

/**
 * Why `original`, exchanged to the scratch name, is no longer what was
 * proved, or undefined: another process has opened it since or tried to, it
 * has another name, or what it carries has changed — a `chmod`, `chown`,
 * `setxattr` or `utimes` by name opens nothing and leaves its lease standing.
 */
async function originalChanged(file: string, original: LeasedFile): Promise<string | undefined> {
	if (!soleOpenLeaseStands(original.handle.fd)) return `${file} ${OPENED} as it was compressed`;
	if ((await original.handle.stat()).nlink !== 1) return `${file} was given another name as it was compressed`;
	const changed = await changedSince(original);
	return changed && `${file} ${changed} as it was compressed`;
}

/**
 * Whether `copy`'s bytes are no longer the proof's, as a phrase, or
 * undefined. While its lease stands nobody else has it open, so they are;
 * once it does not, they are read again.
 */
async function copyWritten(copy: LeasedFile): Promise<string | undefined> {
	if (soleOpenLeaseStands(copy.handle.fd)) return undefined;
	const now = await digestOfHandle(copy.handle);
	if (now.hash === copy.proof.hash && now.size === copy.proof.size) return undefined;
	return "was written to by another process";
}

/**
 * What reached `copy`, in place at `file`, since the exchange, as a phrase
 * ("was given another name besides …"), or undefined: an open or an attempt
 * at one (its lease no longer stands), another name, the loss of its name,
 * or a change to what it carries.
 */
async function copyReached(file: string, copy: LeasedFile): Promise<string | undefined> {
	if (!soleOpenLeaseStands(copy.handle.fd)) return OPENED;
	const links = (await copy.handle.stat()).nlink;
	if (links === 0) return "lost its name to another process";
	if (links !== 1) return `was given another name besides ${file}`;
	return await changedSince(copy);
}

/**
 * How the metadata of `held` has changed since it was proved, as a phrase
 * ("now has mode 644, not 600"); undefined when it has not. Throws when it
 * cannot be read: a failure to look is no sign that another process changed
 * it, and no step may be taken on it as one.
 */
async function changedSince(held: LeasedFile): Promise<string | undefined> {
	const difference = metadataDifference(held.metadata, await carriedMetadata(held.handle));
	return difference && `now has ${difference}`;
}

/**
 * Exchange `file` and `copyPath` back, so the name has again what it held
 * before the first exchange — the original, with whatever reached it, or the
 * file another process renamed onto the name just before — and the copy is
 * at its scratch name, where cleanup takes it away only under its lease and
 * only while what it carries is unchanged. This is the swap's last move:
 * what reached the name in the few system calls between the last look and
 * this exchange went to the scratch name with it, and is seen here,
 * reported and kept, never moved again (the boundary in
 * {@link settleExchange}). Never throws.
 */
async function exchangeBack(file: string, copyPath: string, copy: LeasedFile, why: string): Promise<SwapOutcome> {
	const left = (note: string, copyAtScratch: boolean): SwapOutcome => ({
		swapped: false,
		originalFreed: false,
		copyAtScratch,
		notes: [note],
	});
	const back = await renameExchange(copyPath, file).catch(
		(error: unknown) => ({ outcome: "unsupported", why: errorMessage(error) }) as const,
	);
	if (back.outcome !== "exchanged") {
		const how = back.outcome === "absent" ? "a name was gone" : back.why;
		return left(
			`${why}, and the exchange could not be undone (${how}): ${file} and ${copyPath} were left as they are`,
			false,
		);
	}
	try {
		if (!isHeld(await identityAt(copyPath), copy)) {
			return left(
				`${why}, so ${file} was given back what it held; another process put a file at ${file} as it was given back, and that file is at ${copyPath}, where it was left`,
				false,
			);
		}
		const late = await copyReached(copyPath, copy);
		if (late) {
			// Reached through the name: somebody's now, so cleanup leaves it.
			return left(
				`${why}, so ${file} was given back what it held; the compressed copy ${late} as it was given back, and was left at ${copyPath}`,
				false,
			);
		}
		return left(`${why}, so ${file} was given back what it held`, true);
	} catch (error) {
		return left(
			`${why}; after it was given back, ${file} could not be checked (${errorMessage(error)}), so ${file} and ${copyPath} were left as they are`,
			false,
		);
	}
}

/**
 * The copy `ditto` made of `original` at `copyPath`, held under its lease
 * once its bytes are shown to be the original's: all of them (`whole`), or
 * how the original begins, which is as far as a copy cut short gets. Taking
 * such a file away loses no byte the original does not still hold. The lease
 * is taken before a byte is read, so a copy another process holds open — one
 * that could write to it afterwards — is not this run's to vouch for, and
 * neither is one on a filesystem that gives no lease; and it is held until
 * the copy is in place or removed, so a process that opens the copy after
 * the proof breaks it, which both see. Undefined when nothing is at the name;
 * throws, leaving the file as it is, when what is there is not this run's.
 */
async function holdCopy(
	copyPath: string,
	original: CompressCandidate,
	digest: string,
): Promise<{ copy: LeasedFile; whole: boolean } | undefined> {
	const handle = await openRegularFile(copyPath, { noFollow: true });
	if (!handle) return undefined;
	let found: { copy: LeasedFile; whole: boolean } | undefined;
	try {
		const copy = await leaseFile(copyPath, handle);
		if (typeof copy === "string") throw new Error(`${copy}, so it was left as it is`);
		if (copy.proof.size === original.bytes && copy.proof.hash === digest) found = { copy, whole: true };
		else {
			const source = await openRegularFile(original.path);
			if (source) {
				try {
					if (await handleBeginsWith(source, handle)) found = { copy, whole: false };
				} finally {
					await source.close().catch(() => undefined);
				}
			}
		}
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
	if (found) return found;
	await handle.close().catch(() => undefined);
	throw new Error(`${copyPath} holds what ${original.path} does not, so it was left as it is`);
}

async function sha256Files(files: string[]): Promise<string[]> {
	const digests: string[] = [];
	for (let start = 0; start < files.length; start += HASH_CONCURRENCY) {
		digests.push(...(await Promise.all(files.slice(start, start + HASH_CONCURRENCY).map(sha256File))));
	}
	return digests;
}

async function compressBatch(
	storage: FileSessionStorage,
	dir: string,
	batch: CompressCandidate[],
	transcripts: ReadonlySet<string>,
	result: CompressBatchResult,
): Promise<void> {
	// Every candidate counts at its current allocation until its compressed copy replaces it,
	// so failed and skipped files are still reported as occupying disk.
	for (const candidate of batch) result.allocatedAfter += candidate.allocated;
	let scratch: Scratch;
	try {
		scratch = await makeScratch(dir);
	} catch (error) {
		result.errors.push(`${dir}: ${errorMessage(error)}`);
		return;
	}
	// Copies this run proved and holds, still in the scratch directory: each
	// removed under its lease before the directory goes.
	const owned: Array<{ path: string; copy: LeasedFile }> = [];
	try {
		const digests = await sha256Files(batch.map(candidate => candidate.path));
		const run = await $`ditto --hfsCompression ${batch.map(candidate => candidate.path)} ${scratch.dir}`
			.quiet()
			.nothrow();
		// A copy tool that exits nonzero vouches for nothing it wrote, whatever
		// its bytes look like: what it did not finish can be the copy's mode,
		// and a review's copy, byte-identical, replaced a `0600` original with
		// a `0644` file. So no copy is swapped in; what the copy left is held
		// and taken away below like any other copy.
		const copiedAll = run.exitCode === 0;
		if (!copiedAll) result.errors.push(`${dir}: ditto exited ${run.exitCode}: ${run.stderr.toString().trim()}`);
		for (const [index, candidate] of batch.entries()) {
			const copyPath = path.join(scratch.dir, path.basename(candidate.path));
			try {
				const found = await holdCopy(copyPath, candidate, digests[index]);
				if (!found) {
					if (copiedAll) result.errors.push(`${candidate.path}: ditto left no copy at ${copyPath}`);
					continue;
				}
				const entry = { path: copyPath, copy: found.copy };
				owned.push(entry);
				if (!copiedAll) continue;
				if (!found.whole) {
					result.errors.push(`${candidate.path}: compressed copy does not match the original`);
					continue;
				}
				const allocated = (await found.copy.handle.stat()).blocks * 512;
				// Incompressible: APFS stored the copy uncompressed, so the original stays.
				if (allocated >= candidate.allocated) continue;
				const swap = await swapIn(storage, candidate, copyPath, found.copy, transcripts.has(candidate.path));
				result.errors.push(...swap.notes);
				if (!swap.copyAtScratch) {
					// In place, or gone from its scratch name: not cleanup's any more. In
					// place, its lease goes at once, so a reader of the session does not
					// wait on it.
					owned.splice(owned.indexOf(entry), 1);
					await found.copy.handle.close().catch(() => undefined);
				}
				if (!swap.swapped) continue;
				result.compressed += 1;
				// An original left at its private name still occupies its blocks.
				result.allocatedAfter += swap.originalFreed ? allocated - candidate.allocated : allocated;
			} catch (error) {
				result.errors.push(`${candidate.path}: ${errorMessage(error)}`);
			}
		}
	} catch (error) {
		result.errors.push(`${dir}: ${errorMessage(error)}`);
	} finally {
		for (const { path: copyPath, copy } of owned) {
			const left = await removeLeased(copyPath, copy, "the copy this run made").catch(
				(error: unknown) => `${copyPath} could not be removed (${errorMessage(error)}), so it was left as it is`,
			);
			if (left) result.errors.push(left);
			await copy.handle.close().catch(() => undefined);
		}
		result.errors.push(...(await removeScratch(scratch)));
	}
}
