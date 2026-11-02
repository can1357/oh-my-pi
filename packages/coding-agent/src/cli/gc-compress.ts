/**
 * In-place transparent filesystem compression for cold session files.
 *
 * Compressed files keep their path, bytes, and mtime; the filesystem inflates
 * them on read, so every session reader works unchanged. Supported volumes:
 *
 * - APFS (macOS): `ditto --hfsCompression` writes compressed copies that are
 *   verified and renamed over the originals. A later write stores the file
 *   uncompressed again.
 * - NTFS (Windows): `compact /c` sets LZNT1 compression on each file in place,
 *   keeping its inode and timestamps; later appends are stored compressed too.
 */
import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { COMPRESS_SCRATCH_PREFIX } from "@oh-my-pi/omp-stats/parser";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils";
import {
	type HeldFile,
	makeHeldDirectory,
	newNonce,
	openRegularFile,
	removeFileOthersMayWrite,
	removeHeldDirectory,
	writeExclusive,
} from "../session/regular-file";
import { soleOpenLeaseIntact, takeSoleOpenLease } from "../session/open-file-holders";
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
 * {@link clearScratch}), so a killed run's scratch stays until someone who
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
 * A file in a scratch directory this run takes for its own: what it proved
 * the file holds — its digest and length — and, for a copy it holds open,
 * the identity it was proved at.
 */
interface ScratchFile {
	path: string;
	proof: CopiedBytes;
	identity?: { dev: number; ino: number };
}

/**
 * Make a scratch directory of this run's own in `dir`, at a fresh random
 * name, and hold it — made and proved by {@link makeHeldDirectory}, mode
 * `0700`, its descriptor kept — so {@link clearScratch} removes it only while
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
 * Take away the scratch directory this run made, with the files in it this
 * run made, and nothing else. Each file goes by {@link removeFileOthersMayWrite}:
 * moved to a private name and judged there, through a descriptor opened on
 * it then, as still holding exactly what this run proved it held — so bytes
 * written to it after the proof, by its name or any other way, keep it, as
 * does another file at its name. The directory goes only while its name holds
 * the held directory and it is empty. Anything else inside is somebody's — it
 * and the directory are left, and said. Returns a sentence for each thing
 * left; never throws, since this runs on the way out of a failure as often as
 * a success. The caller has closed every descriptor it held on the files: a
 * lease still taken on one would hold up this run's own open of it.
 */
async function clearScratch(scratch: Scratch, files: readonly ScratchFile[]): Promise<string[]> {
	const notes: string[] = [];
	for (const file of files) {
		const sameFile = (stat: Stats): boolean =>
			stat.isFile() &&
			(file.identity === undefined || (stat.dev === file.identity.dev && stat.ino === file.identity.ino));
		const removal = await removeFileOthersMayWrite(file.path, {
			matches: sameFile,
			mismatch: `${file.path} is not what this run made there`,
			judge: async (moved, handle) =>
				handle && sameFile(moved) && (await holdsCopied(file.proof)(handle))
					? undefined
					: `${file.path} holds what this run did not make there`,
		});
		if (removal.outcome === "kept") notes.push(removal.note);
		else if (removal.outcome === "removed" && removal.note) notes.push(removal.note);
	}
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
 * Compress `candidates` in place. The caller must hold whatever lease keeps
 * writers off these files.
 *
 * APFS: each directory's files are copied with compression into a scratch
 * directory beside them, and a copy replaces its original only when its size
 * and SHA-256 match and the original is unchanged since it was selected.
 * Paths in `transcripts` (files with a session header) swap under the session
 * publish lock. NTFS: the filesystem compresses each file in place.
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
	const byDir = new Map<string, CompressCandidate[]>();
	for (const candidate of candidates) {
		const dir = path.dirname(candidate.path);
		const group = byDir.get(dir);
		if (group) group.push(candidate);
		else byDir.set(dir, [candidate]);
	}
	for (const [dir, group] of byDir) {
		for (let start = 0; start < group.length; start += DITTO_BATCH) {
			await compressBatch(dir, group.slice(start, start + DITTO_BATCH), transcripts, result);
		}
	}
	return result;
}

/**
 * Whether `method` actually stores a compressible file compressed under `dir`.
 * The volume type alone does not prove it: on macOS 27 `ditto --hfsCompression`
 * exits 0 but writes plain copies (#16244), and policy can disable NTFS
 * compression. Runs one throwaway file through {@link compressFilesInPlace}
 * inside a scratch directory of this run's own, then takes the directory away
 * with the probe and nothing else — see {@link clearScratch}. Throws when the
 * compression tool itself fails, so a broken run is not mistaken for a volume
 * that stores files uncompressed, and when anything was left behind.
 */
export async function compressionWorks(dir: string, method: CompressMethod): Promise<boolean> {
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
		// `compact` has to work on.
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
	const left = await clearScratch(scratch, [{ path: probe, proof }]);
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
 * The file at `candidate.path` is still the one selected: same inode, size,
 * and mtime, and still its only link (a hard link added since selection would
 * be split from it by the rename).
 */
function unchangedSinceSelection(candidate: CompressCandidate): boolean {
	const current = fsSync.lstatSync(candidate.path, { bigint: true });
	return (
		current.ino === candidate.ino &&
		current.nlink === 1n &&
		current.size === BigInt(candidate.bytes) &&
		current.mtimeNs === candidate.mtimeNs
	);
}

/**
 * Rename `copyPath` over `candidate.path` while the original is unchanged and
 * `copyPath` still names the copy this run checked and holds — and, where the
 * kernel leased it, no process has opened the copy since — all checked
 * immediately before the rename. Transcripts swap under the session publish
 * lock, which serializes them against appends from any omp binary.
 */
function swapIfUnchanged(
	storage: FileSessionStorage,
	candidate: CompressCandidate,
	copyPath: string,
	copy: HeldCopy,
	transcript: boolean,
): boolean {
	const unchanged = (): boolean => {
		const named = fsSync.lstatSync(copyPath, { throwIfNoEntry: false });
		return (
			named?.dev === copy.held.dev &&
			named.ino === copy.held.ino &&
			(!copy.leased || soleOpenLeaseIntact(copy.held.handle.fd)) &&
			unchangedSinceSelection(candidate)
		);
	};
	if (transcript) return storage.replaceSessionFileSync(candidate.path, copyPath, unchanged);
	if (!unchanged()) return false;
	fsSync.renameSync(copyPath, candidate.path);
	return true;
}

/** A copy `ditto` made, as this run proved and holds it: see {@link holdCopy}. */
interface HeldCopy {
	held: HeldFile;
	/** What the copy held when it was proved: checked again before it is swapped in or taken away. */
	proof: CopiedBytes;
	/** All of the original's bytes; otherwise how the original begins. */
	whole: boolean;
	/** Whether the kernel leased the copy to this run before it was read: then no process has opened it since while the lease stands. */
	leased: boolean;
}

/**
 * The copy `ditto` made of `original` at `copyPath`, held — opened as a
 * regular file without following a link — once its bytes are shown to be the
 * original's: all of them (`whole`), or how the original begins, which is as
 * far as a copy cut short gets. Taking such a file away loses no byte the
 * original does not still hold. Before a byte is read, the kernel is asked for
 * the lease #17488's reclaim takes — {@link takeSoleOpenLease} — so where one
 * is given, a process that opens the copy after the proof breaks it, and the
 * swap sees that. A copy another process already holds open is not this
 * run's to vouch for. Undefined when nothing is at the name; throws, leaving
 * the file as it is, when what is there holds anything else or is open
 * elsewhere.
 */
async function holdCopy(copyPath: string, original: CompressCandidate, digest: string): Promise<HeldCopy | undefined> {
	const handle = await openRegularFile(copyPath, { noFollow: true });
	if (!handle) return undefined;
	let found: HeldCopy | undefined;
	try {
		const lease = takeSoleOpenLease(handle.fd);
		if (lease.outcome === "open-elsewhere") {
			throw new Error(`${copyPath} is open in another process (${lease.evidence}), so it was left as it is`);
		}
		const { dev, ino } = await handle.stat();
		const proof = await digestOfHandle(handle);
		const held: HeldFile = { handle, dev, ino };
		const leased = lease.outcome === "held";
		if (proof.size === original.bytes && proof.hash === digest) found = { held, proof, whole: true, leased };
		else {
			const source = await openRegularFile(original.path);
			if (source) {
				try {
					if (await handleBeginsWith(source, handle)) found = { held, proof, whole: false, leased };
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
	// Copies this run proved and has not swapped in: taken away with the
	// scratch directory. Every descriptor held on a copy is closed first.
	const copies: ScratchFile[] = [];
	const held: HeldFile[] = [];
	try {
		const digests = await sha256Files(batch.map(candidate => candidate.path));
		const copy = await $`ditto --hfsCompression ${batch.map(candidate => candidate.path)} ${scratch.dir}`
			.quiet()
			.nothrow();
		// A copy tool that exits nonzero vouches for nothing it wrote, whatever
		// its bytes look like: what it did not finish can be the copy's mode,
		// and a review's copy, byte-identical, replaced a `0600` original with
		// a `0644` file. So no copy is swapped in; what the copy left is held
		// and taken away below like any other copy.
		const copiedAll = copy.exitCode === 0;
		if (!copiedAll) result.errors.push(`${dir}: ditto exited ${copy.exitCode}: ${copy.stderr.toString().trim()}`);
		const storage = new FileSessionStorage();
		for (const [index, candidate] of batch.entries()) {
			const copyPath = path.join(scratch.dir, path.basename(candidate.path));
			try {
				const found = await holdCopy(copyPath, candidate, digests[index]);
				if (!found) {
					if (copiedAll) result.errors.push(`${candidate.path}: ditto left no copy at ${copyPath}`);
					continue;
				}
				held.push(found.held);
				const entry: ScratchFile = {
					path: copyPath,
					proof: found.proof,
					identity: { dev: found.held.dev, ino: found.held.ino },
				};
				copies.push(entry);
				if (!copiedAll) continue;
				if (!found.whole) {
					result.errors.push(`${candidate.path}: compressed copy does not match the original`);
					continue;
				}
				const allocated = (await found.held.handle.stat()).blocks * 512;
				// Incompressible: APFS stored the copy uncompressed, so the original stays.
				if (allocated >= candidate.allocated) continue;
				// Proved again, through the descriptor it was proved through, just
				// before the swap: bytes written to the copy since — by its name or
				// through a descriptor opened before the proof — keep the original.
				if (!(await holdsCopied(found.proof)(found.held.handle))) {
					result.errors.push(`${copyPath} changed after this run checked it, so ${candidate.path} was kept`);
					continue;
				}
				// ditto copied the nanosecond mtime; the rename keeps it.
				if (!swapIfUnchanged(storage, candidate, copyPath, found, transcripts.has(candidate.path))) continue;
				// Swapped in, the copy is the session's file, no longer scratch, and
				// its lease goes at once: a reader of the session must not wait on it.
				copies.splice(copies.indexOf(entry), 1);
				held.splice(held.indexOf(found.held), 1);
				await found.held.handle.close().catch(() => undefined);
				result.compressed += 1;
				result.allocatedAfter += allocated - candidate.allocated;
			} catch (error) {
				result.errors.push(`${candidate.path}: ${errorMessage(error)}`);
			}
		}
	} catch (error) {
		result.errors.push(`${dir}: ${errorMessage(error)}`);
	} finally {
		for (const file of held) await file.handle.close().catch(() => undefined);
		result.errors.push(...(await clearScratch(scratch, copies)));
	}
}
