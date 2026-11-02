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
import { errnoName, isErrno, type Libc, libc, linkOpenFileNoReplace } from "../session/libc";
import { leaseCallUnavailable, soleOpenLeaseIntact, takeSoleOpenLease } from "../session/open-file-holders";
import {
	type HeldFile,
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
import { extendedAttributeNames, inodeFlags, SET_BY_HAND } from "../session/uncarried-metadata";
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
			notes.push(`${scratch.dir} holds something this run did not make there, so it was left as it is`);
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
 * {@link soleOpenLeaseIntact} sees. While it stands nothing but this run
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
 * saying why it is not this run's to vouch for — another process holds it
 * open, or the kernel gives no lease here. The caller closes `handle`.
 */
async function leaseFile(file: string, handle: fs.FileHandle): Promise<LeasedFile | string> {
	const lease = takeSoleOpenLease(handle.fd);
	if (lease.outcome === "open-elsewhere") return `${file} is open in another process (${lease.evidence})`;
	if (lease.outcome === "unproved") {
		return `${file} cannot be shown to be open in no other process: ${lease.meaning} (${lease.evidence})`;
	}
	const { dev, ino } = await handle.stat();
	return { handle, dev, ino, proof: await digestOfHandle(handle), metadata: await carriedMetadata(handle) };
}

/**
 * Unlink `aside`, the private name a file this run holds as `held` was moved
 * to, only while that file's lease still stands — so no other process has
 * opened it since its bytes were proved; one that has keeps it — and only
 * while `aside` still names it. The unlink is the call after that last look:
 * a process that learns the private name and opens it in between, or renames
 * a file of its own onto it, is the one thing left, one system call wide;
 * POSIX has no unlink-if-unopened, and no unlink-if-this-inode. Undefined
 * once it is gone; otherwise the clause saying why not.
 */
async function unlinkLeased(file: string, aside: string, held: LeasedFile): Promise<string | undefined> {
	if (!soleOpenLeaseIntact(held.handle.fd)) return `${file} was opened by another process after this run proved it`;
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

/** What became of {@link swapIn}: whether the copy has the original's name now, whether the original is gone, and what is left to say. */
interface SwapOutcome {
	swapped: boolean;
	originalFreed: boolean;
	notes: string[];
}

/**
 * Put `copy` — the compressed copy of `candidate` this run made at
 * `copyPath` and holds under its lease — in place of the original, so that
 * what ends up under the original's name is exactly what was proved, bytes
 * and metadata, and no write to the original, by its name or through a
 * descriptor opened before, is lost:
 *
 * 1. The original is moved to a private name beside it, by a rename that
 *    replaces nothing (`moveAside`). From then on a write by its name makes
 *    a new file there, which is the writer's and is kept.
 * 2. What moved is opened and leased. The kernel grants the lease only while
 *    no other process holds the file open, so a writer holding a descriptor
 *    from before refuses the swap, and the original goes back.
 * 3. Under the lease, the original's bytes and metadata are read, and must
 *    be the copy's; both leases must still stand, and the copy's metadata be
 *    what it was when the copy was proved.
 * 4. The copy is linked at the original's name through its own descriptor
 *    ({@link linkOpenFileNoReplace}): the very file proved, whatever its
 *    scratch name holds by now, and only while nothing has the name — a
 *    file a writer made there since step 1 refuses it, and is kept.
 * 5. Both are proved again ({@link publishedRefusal}): the copy's metadata,
 *    and its bytes once more where its lease no longer stands — the kernel
 *    takes a lease away once an opener has waited its break time out, and
 *    the opener may have written — and the original's lease and metadata,
 *    which a `chmod` or `setxattr` of its private name changes without
 *    breaking the lease. A difference takes the copy back off the name and
 *    puts the original back ({@link takeBack}).
 * 6. The original is looked at once more and unlinked at its private name
 *    while its lease still stands ({@link unlinkLeased}); then the copy's
 *    scratch name goes, a second name of the file now in place.
 *
 * Short of that, the original is back at its name, or — when a writer made a
 * new file there meanwhile — at its private name, which the note gives; a
 * failure to read anything along the way gives the same, never a name left
 * without its file. Transcripts do all of it under the session publish lock,
 * which every omp binary's appends take, so none lands mid-swap. The name is
 * without a file only from step 1 to step 4.
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
	const kept = (note: string): SwapOutcome => ({ swapped: false, originalFreed: false, notes: [note] });
	const moved = await moveAside(file, {
		// A cheap first look; the proof is step 3's, through the descriptor.
		matches: stat =>
			stat.isFile() && stat.nlink === 1 && stat.ino === Number(candidate.ino) && stat.size === candidate.bytes,
		mismatch: `${file} changed since it was selected`,
	});
	if (moved.outcome === "absent") return kept(`${file} was gone before its compressed copy could take its place`);
	if (moved.outcome === "kept") return kept(moved.note);
	const { aside } = moved;
	const giveBack = async (why: string): Promise<SwapOutcome> =>
		kept((await putBack(file, aside, why)) ?? `${why}, so it was put back`);
	// Where the swap is: what a failure has to undo.
	let step: "moved" | "linked" | "freed" = "moved";
	let handle: fs.FileHandle | undefined;
	try {
		handle = await openRegularFile(aside, { noFollow: true });
		if (!handle) return kept(`${file} was moved away from ${aside} by another process before it could be checked`);
		const original = await leaseFile(file, handle);
		if (typeof original === "string") return await giveBack(original);
		const refusal = await swapRefusal(file, candidate, original, copyPath, copy);
		if (refusal) return await giveBack(refusal);
		const linked = await linkOpenFileNoReplace(copy.handle.fd, file);
		if (linked.outcome === "taken") return await giveBack(`a new file was made at ${file} while it was compressed`);
		if (linked.outcome === "unsupported") {
			return await giveBack(`the compressed copy of ${file} could not be put at its name: ${linked.why}`);
		}
		step = "linked";
		const changed = (await publishedRefusal(file, copy)) ?? (await originalChanged(file, original));
		if (changed) return await takeBack(file, aside, copy, changed);
		const notes: string[] = [];
		const why = await unlinkLeased(file, aside, original);
		if (why) notes.push(`${why}, so what ${file} held before it was compressed was left at ${aside}`);
		else step = "freed";
		const scratchName = await removeSecondName(copyPath, copy);
		if (scratchName) notes.push(scratchName);
		// In place, the copy is the session's file: its lease goes at once, so
		// a reader of the session does not wait on it.
		await copy.handle.close().catch(() => undefined);
		return { swapped: true, originalFreed: step === "freed", notes };
	} catch (error) {
		const why = `${file} could not be checked (${errorMessage(error)})`;
		if (step === "moved") return await giveBack(why);
		if (step === "linked") return await takeBack(file, aside, copy, why);
		return { swapped: true, originalFreed: true, notes: [`${why} after it was compressed`] };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * Why the original, moved aside and held as `original`, may not give way to
 * `copy` — steps 2 and 3 of {@link swapIn} — or undefined when it may.
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
	if (!soleOpenLeaseIntact(original.handle.fd)) return `${file} was opened by another process while it was checked`;
	if (!soleOpenLeaseIntact(copy.handle.fd)) {
		return `the compressed copy of ${file}, ${copyPath}, was opened by another process after this run proved it`;
	}
	const links = (await copy.handle.stat()).nlink;
	if (links === 0)
		return `the compressed copy of ${file} no longer has its name ${copyPath}: another process took it away`;
	if (links !== 1) return `the compressed copy of ${file}, ${copyPath}, has another name`;
	const changed = await changedSince(copy);
	if (changed) return `the compressed copy of ${file}, ${copyPath}, ${changed} after this run proved it`;
	return undefined;
}

/**
 * Why `copy`, just linked at `file`, is not what was proved — step 5 of
 * {@link swapIn} — or undefined when it is: its metadata changed since its
 * proof, or its lease no longer stands and its bytes are not the proof's.
 * A lease gone with the bytes unchanged is a process that opened the copy
 * and has written nothing yet; what it writes from now on is written to the
 * file in place.
 */
async function publishedRefusal(file: string, copy: LeasedFile): Promise<string | undefined> {
	const changed = await changedSince(copy);
	if (changed) return `the compressed copy of ${file} ${changed} as it was put in place`;
	if (soleOpenLeaseIntact(copy.handle.fd)) return undefined;
	const now = await digestOfHandle(copy.handle);
	if (now.hash === copy.proof.hash && now.size === copy.proof.size) return undefined;
	return `the compressed copy of ${file} was written to by another process as it was put in place`;
}

/**
 * Why `original`, at its private name, is no longer what was proved, or
 * undefined: another process has opened it since, or what it carries has
 * changed — a `chmod`, `chown`, `setxattr` or `utimes` of its private name
 * opens nothing and leaves its lease standing.
 */
async function originalChanged(file: string, original: LeasedFile): Promise<string | undefined> {
	if (!soleOpenLeaseIntact(original.handle.fd)) return `${file} was opened by another process as it was compressed`;
	const changed = await changedSince(original);
	return changed && `${file} ${changed} as it was compressed`;
}

/** How the metadata of `held` has changed since it was proved, as a phrase ("now has mode 644, not 600"); undefined when it has not. */
async function changedSince(held: LeasedFile): Promise<string | undefined> {
	let now: CarriedMetadata;
	try {
		now = await carriedMetadata(held.handle);
	} catch (error) {
		return `could not be read again (${errorMessage(error)})`;
	}
	const difference = metadataDifference(held.metadata, now);
	return difference && `now has ${difference}`;
}

/**
 * Take the copy, linked at `file`, off that name again and put the original
 * back from `aside` — step 5 of {@link swapIn}. The copy is moved off by a
 * rename that replaces nothing, and its name there is dropped only by
 * {@link unlinkLeased}: while no other process holds it, so its bytes are the
 * proved ones, which the original holds too. One another process opened is
 * kept, with what that process writes, and said. Something else at `file` by
 * then — another process's file — is left there, and the original at
 * `aside`. Never throws.
 */
async function takeBack(file: string, aside: string, copy: LeasedFile, why: string): Promise<SwapOutcome> {
	const notes: string[] = [];
	const off = await moveAside(file, {
		matches: stat => stat.isFile() && stat.dev === copy.dev && stat.ino === copy.ino,
		mismatch: `${why}, and ${file} holds another process's file by now, so what it held before was left at ${aside}`,
	});
	if (off.outcome === "kept") return { swapped: false, originalFreed: false, notes: [off.note] };
	if (off.outcome === "moved") {
		const left = await unlinkLeased(`the compressed copy of ${file}`, off.aside, copy);
		if (left) notes.push(`${left}, so it was left at ${off.aside}`);
	}
	notes.unshift((await putBack(file, aside, why)) ?? `${why}, so ${file} was put back`);
	return { swapped: false, originalFreed: false, notes };
}

/**
 * Remove `copyPath`, the scratch name of `copy` once the copy also has the
 * session file's name: dropping it loses nothing while the file has another
 * name, and it goes only then, and only while it names that very file —
 * moved to a private name first, by a rename that replaces nothing.
 * Undefined once it is gone; otherwise the sentence saying what is left.
 */
async function removeSecondName(copyPath: string, copy: LeasedFile): Promise<string | undefined> {
	const moved = await moveAside(copyPath, {
		matches: stat => stat.isFile() && stat.dev === copy.dev && stat.ino === copy.ino,
		mismatch: `${copyPath} is not the copy this run put in place`,
	});
	if (moved.outcome !== "moved") return moved.outcome === "kept" ? moved.note : undefined;
	const only = await copy.handle
		.stat()
		.then(stat => stat.nlink < 2)
		.catch(() => true);
	if (only) {
		const why = `the copy put in place lost its other name, so ${copyPath}, its last, was kept`;
		return (await putBack(copyPath, moved.aside, why)) ?? why;
	}
	const removal = await unlinkStillMoved(moved.aside, copy).catch((error: unknown) => errorMessage(error));
	if (removal === "removed" || removal === "absent") return undefined;
	const why =
		removal === "replaced"
			? `${moved.aside}, where ${copyPath} was moved to be removed, was taken by another process's file`
			: `${copyPath} could not be removed (${removal})`;
	return (await putBack(copyPath, moved.aside, why)) ?? `${why}, so it was put back`;
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
				if (!swap.swapped) continue;
				owned.splice(owned.indexOf(entry), 1);
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
