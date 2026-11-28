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
	/** Max decompressed bytes in one pass over a compressed tar too large for `maxInMemorySize`. */
	maxStreamSize: number;
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
	maxStreamSize: 4 * 1024 * 1024 * 1024,
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
 * Reject a member size field that is not a byte count. Indexing checks only this: `maxMemberSize` bounds
 * extraction, so one oversized member never hides the rest of the archive.
 */
export function assertArchiveMemberSizeField(size: number, memberPath: string): void {
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new ArchiveError(`Archive member '${formatArchivePathForError(memberPath)}' has an invalid size`);
	}
}

/**
 * Reject a member whose declared (uncompressed) size exceeds `maxMemberSize`.
 * The declared size is metadata — a crafted entry can claim multi-GB sizes
 * that would be allocated up front before any data decompresses. `read` says
 * how the caller reads the member, so the refusal says what it would cost: a
 * `whole` read holds the member in memory; a `chunked` read need not, so its
 * refusal names only the member size limit.
 */
export function assertArchiveMemberSize(
	size: number,
	memberPath: string,
	limits: ArchiveLimits,
	read: "whole" | "chunked" = "whole",
): void {
	assertArchiveMemberSizeField(size, memberPath);
	if (size > limits.maxMemberSize) {
		const member = `Archive member '${formatArchivePathForError(memberPath)}'`;
		const sizes = `${formatBytes(size)} > ${formatBytes(limits.maxMemberSize)}`;
		throw new ArchiveError(
			read === "chunked"
				? `${member} exceeds the member size limit (${sizes})`
				: `${member} is too large to extract in memory (${sizes} limit)`,
		);
	}
}

/** Reject an index that grew beyond `maxEntries` while parsing. */
export function assertEntryCount(count: number, limits: ArchiveLimits): void {
	if (count > limits.maxEntries) {
		throw new ArchiveError(`Archive has too many entries (> ${limits.maxEntries} limit)`);
	}
}
