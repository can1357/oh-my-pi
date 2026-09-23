import type { ArchiveLimits } from "./limits";
import type { ByteSource } from "./source";

/** Archive container formats readable by the unified archive API. */
export type ArchiveFormat =
	// Containers with their own member framing.
	| "zip"
	| "tar"
	| "tar.gz"
	| "tar.bz2"
	| "tar.xz"
	| "tar.zst"
	| "tar.Z"
	| "asar"
	| "rar"
	| "7z"
	| "iso"
	| "cab"
	| "cpio"
	| "rpm"
	| "ar"
	| "deb"
	| "lzh"
	| "arj"
	// Single-stream compressors exposed as one-member pseudo-archives.
	| "gz"
	| "bz2"
	| "xz"
	| "zst"
	| "Z"
	| "lzma";

/** Archive formats the unified API can serialize. Everything else is read-only. */
export type WritableArchiveFormat = "zip" | "tar" | "tar.gz" | "tar.zst" | "asar";

/**
 * Where to read an archive from: an extension-inferred filesystem path, a
 * format-tagged filesystem path, in-memory bytes, or any caller-provided
 * {@link ByteSource} (e.g. `httpByteSource` for ranged remote reads).
 * File- and source-backed ZIP/ASAR/RAR/7z/ISO are read lazily.
 */
export type ArchiveSource =
	| string
	| { bytes: Uint8Array; format: ArchiveFormat }
	| { path: string; format: ArchiveFormat }
	| { source: ByteSource; format: ArchiveFormat; path?: string };

/** Content for a member when packing or extracting an archive. */
export type ArchiveMemberContent = string | Uint8Array | Blob;

/** One `archive.ext:inner/path` split candidate (see `parseArchivePathCandidates`). */
export interface ArchivePathCandidate {
	archivePath: string;
	subPath: string;
}

/** A file or directory node visible through an `ArchiveReader`. */
export interface ArchiveNode {
	path: string;
	isDirectory: boolean;
	size: number;
	mtimeMs?: number;
	/** Unix permission/type bits when the container records them. */
	mode?: number;
}

/** An {@link ArchiveNode} with its name relative to the listed directory. */
export interface ArchiveDirectoryEntry extends ArchiveNode {
	name: string;
}

/** An {@link ArchiveNode} with its extracted payload. */
export interface ExtractedArchiveFile extends ArchiveNode {
	bytes: Uint8Array;
}

/**
 * Format-owned handle that extracts one member's bytes on demand. Instances
 * may share per-archive state (solid-block decoders, 7z folder caches).
 * Prefer classes with prototype methods over closures: archives can index
 * hundreds of thousands of members.
 */
export interface MemberSource {
	/**
	 * Read this member's bytes. `size` is the entry's declared uncompressed
	 * size (already bounds-checked); `memberPath` is for error messages.
	 * Implementations must verify the produced byte count (and checksums when
	 * the container records them) and throw {@link ArchiveError} on mismatch.
	 */
	read(size: number, memberPath: string): Promise<Uint8Array>;
}

/**
 * How an indexed entry's bytes are stored. `link` entries alias another
 * archive path and are resolved lazily by the reader core; `member` entries
 * defer to their format module.
 */
export type EntryStorage =
	| {
			type: "link";
			targetPath: string;
			/** Follow before target kind is known (ASAR link records do not encode it). */
			resolveTarget: boolean;
	  }
	| { type: "member"; source: MemberSource };

/** One indexed entry as produced by a format reader, before core resolution. */
export interface ArchiveIndexEntry extends ArchiveNode {
	storage?: EntryStorage;
}

/** Context passed to every format reader. */
export interface FormatReadOptions {
	limits: ArchiveLimits;
	/**
	 * Filesystem path of the archive when file-backed. Formats that reference
	 * sibling files use it (ASAR `.unpacked` payloads, multi-volume RAR).
	 */
	archivePath?: string;
}

/**
 * Contract implemented by every format module: index `source` into normalized
 * entries without materializing member payloads unless the container forces
 * it (tar streams, solid archives). Implementations must:
 * - normalize paths via `normalizeArchiveEntryPath` and drop unrepresentable ones,
 * - enforce `options.limits` before metadata-driven allocations,
 * - throw {@link ArchiveError} for malformed, truncated, encrypted, or
 *   unsupported input — never a bare `Error`, and never process-fatal paths.
 */
export type FormatReader = (source: ByteSource, options: FormatReadOptions) => Promise<ArchiveIndexEntry[]>;
