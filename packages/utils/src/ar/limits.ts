import { formatBytes } from "../format";
import { ArchiveError } from "./error";
import { formatArchivePathForError } from "./paths";

/**
 * Resource ceilings enforced before archive metadata can drive expensive
 * work. All sizes are attacker-controlled inputs until proven otherwise, so
 * every allocation-driving field is checked against these before use.
 * Mirrors `Limits` in the Rust `omp-ar` crate.
 */
export interface ArchiveLimits {
	/** Max indexed entries per archive. */
	maxEntries: number;
	/** Max bytes for any archive fully materialized in memory (tar buffers, solid/decompressed streams). */
	maxInMemorySize: number;
	/** Max bytes for archive metadata (ZIP central directory, ASAR JSON header, RAR/7z header areas). */
	maxIndexSize: number;
	/** Max declared bytes for a single extracted member. */
	maxMemberSize: number;
	/** Max byte length of a member path or link target. */
	maxPathBytes: number;
	/** Max symlink rewrites while resolving one path. */
	maxLinkDepth: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
	maxEntries: 1_000_000,
	maxInMemorySize: 256 * 1024 * 1024,
	maxIndexSize: 64 * 1024 * 1024,
	maxMemberSize: 64 * 1024 * 1024,
	maxPathBytes: 4096,
	maxLinkDepth: 40,
};

/** Reject an archive that would be fully materialized beyond `maxInMemorySize`. */
export function assertInMemorySize(size: number, limits: ArchiveLimits): void {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new ArchiveError("Archive is too large to read safely");
	}
	if (size > limits.maxInMemorySize) {
		throw new ArchiveError(
			`Archive is too large to read in memory (${formatBytes(size)} > ${formatBytes(limits.maxInMemorySize)} limit)`,
		);
	}
}

/** Reject archive metadata (index/header) beyond `maxIndexSize`. */
export function assertIndexSize(size: number, limits: ArchiveLimits, what: string): void {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new ArchiveError(`Invalid archive: ${what} has an invalid size`);
	}
	if (size > limits.maxIndexSize) {
		throw new ArchiveError(
			`Archive ${what} is too large (${formatBytes(size)} > ${formatBytes(limits.maxIndexSize)} limit)`,
		);
	}
}

/**
 * Reject a member whose declared (uncompressed) size exceeds `maxMemberSize`.
 * The declared size is metadata — a crafted entry can claim multi-GB sizes
 * that would be allocated up front before any data decompresses.
 */
export function assertArchiveMemberSize(size: number, memberPath: string, limits: ArchiveLimits): void {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new ArchiveError(`Archive member '${formatArchivePathForError(memberPath)}' has an invalid size`);
	}
	if (size > limits.maxMemberSize) {
		throw new ArchiveError(
			`Archive member '${formatArchivePathForError(memberPath)}' is too large to extract in memory (${formatBytes(size)} > ${formatBytes(limits.maxMemberSize)} limit)`,
		);
	}
}

/** Reject an index that grew beyond `maxEntries` while parsing. */
export function assertEntryCount(count: number, limits: ArchiveLimits): void {
	if (count > limits.maxEntries) {
		throw new ArchiveError(`Archive has too many entries (> ${limits.maxEntries} limit)`);
	}
}
