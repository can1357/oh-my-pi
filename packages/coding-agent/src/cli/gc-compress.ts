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
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { COMPRESS_SCRATCH_PREFIX } from "@oh-my-pi/omp-stats/parser";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { FileSessionStorage } from "../session/session-storage";
import { errorMessage } from "../slash-commands/helpers/parse";
import { sha256File } from "../utils/file-hash";

const SCRATCH_GLOB = new Bun.Glob(`**/${COMPRESS_SCRATCH_PREFIX}*`);
/**
 * Written into each scratch directory before anything else, so the sweep
 * recursively removes only directories gc created; a session artifact can
 * carry any name.
 */
const SCRATCH_OWNER_MARKER = ".omp-gc-compress-owner";

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
 * Count, and with `apply` remove, scratch directories under `roots` that a
 * killed run left behind; the caller's gc lock rules out a live one. Only a
 * directory holding the owner marker is removed recursively. An unmarked one
 * is gc's only while empty (a run killed before writing the marker).
 */
export async function sweepCompressScratch(roots: string[], apply: boolean, errors: string[]): Promise<number> {
	let found = 0;
	for (const root of roots) {
		const dirs: string[] = [];
		try {
			for await (const name of SCRATCH_GLOB.scan({ cwd: root, dot: true, onlyFiles: false })) {
				dirs.push(path.join(root, name));
			}
		} catch (error) {
			if (!isEnoent(error)) errors.push(`${root}: ${errorMessage(error)}`);
			continue;
		}
		for (const dir of dirs) {
			try {
				if (!(await fs.lstat(dir)).isDirectory()) continue;
				const owned = await fs.exists(path.join(dir, SCRATCH_OWNER_MARKER));
				if (!owned && (await fs.readdir(dir)).length > 0) continue;
				found += 1;
				if (!apply) continue;
				if (owned) await fs.rm(dir, { recursive: true, force: true });
				else await fs.rmdir(dir);
			} catch (error) {
				if (isEnoent(error)) continue;
				errors.push(`${dir}: ${errorMessage(error)}`);
			}
		}
	}
	return found;
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
 * Rename `copyPath` over `candidate.path` if the original is unchanged, checked
 * immediately before the rename. Transcripts swap under the session publish
 * lock, which serializes them against appends from any omp binary.
 */
function swapIfUnchanged(
	storage: FileSessionStorage,
	candidate: CompressCandidate,
	copyPath: string,
	transcript: boolean,
): boolean {
	if (transcript) {
		return storage.replaceSessionFileSync(candidate.path, copyPath, () => unchangedSinceSelection(candidate));
	}
	if (!unchangedSinceSelection(candidate)) return false;
	fsSync.renameSync(copyPath, candidate.path);
	return true;
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
	let scratch: string | undefined;
	try {
		// A fresh directory: a pre-existing one with this name is never gc's to remove.
		scratch = await fs.mkdtemp(path.join(dir, COMPRESS_SCRATCH_PREFIX));
		await Bun.write(path.join(scratch, SCRATCH_OWNER_MARKER), "");
		const digests = await sha256Files(batch.map(candidate => candidate.path));
		const copy = await $`ditto --hfsCompression ${batch.map(candidate => candidate.path)} ${scratch}`
			.quiet()
			.nothrow();
		if (copy.exitCode !== 0) {
			result.errors.push(`${dir}: ditto exited ${copy.exitCode}: ${copy.stderr.toString().trim()}`);
			return;
		}
		const storage = new FileSessionStorage();
		for (const [index, candidate] of batch.entries()) {
			const copyPath = path.join(scratch, path.basename(candidate.path));
			try {
				const copied = await fs.lstat(copyPath);
				if (copied.size !== candidate.bytes || (await sha256File(copyPath)) !== digests[index]) {
					result.errors.push(`${candidate.path}: compressed copy does not match the original`);
					continue;
				}
				// Incompressible: APFS stored the copy uncompressed, so the original stays.
				if (copied.blocks * 512 >= candidate.allocated) continue;
				// ditto copied the nanosecond mtime; the rename keeps it.
				if (!swapIfUnchanged(storage, candidate, copyPath, transcripts.has(candidate.path))) continue;
				result.compressed += 1;
				result.allocatedAfter += copied.blocks * 512 - candidate.allocated;
			} catch (error) {
				result.errors.push(`${candidate.path}: ${errorMessage(error)}`);
			}
		}
	} catch (error) {
		result.errors.push(`${dir}: ${errorMessage(error)}`);
	} finally {
		if (scratch !== undefined) await fs.rm(scratch, { recursive: true, force: true });
	}
}
