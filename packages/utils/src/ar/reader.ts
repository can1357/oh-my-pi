import { ensureParentDirectories, resolveArchiveLinkPath, upsertArchiveEntry } from "./entries";
import { ArchiveError } from "./error";
import { type ArchiveLimits, assertArchiveMemberSize, DEFAULT_ARCHIVE_LIMITS } from "./limits";
import { formatArchivePathForError, normalizeArchiveLookupPath } from "./paths";
import type {
	ArchiveDirectoryEntry,
	ArchiveFormat,
	ArchiveIndexEntry,
	ArchiveNode,
	ExtractedArchiveFile,
} from "./types";

/** Raise the canonical error for a symlink whose target cannot be materialized. */
export function throwUnreadableArchiveLink(targetPath: string, memberPath: string): never {
	throw new ArchiveError(
		`Archive symlink '${formatArchivePathForError(memberPath)}' cannot be materialized from target '${formatArchivePathForError(targetPath)}'`,
	);
}

/**
 * An indexed, read-only view over a single archive. Member payloads stay
 * lazy behind their format's `MemberSource`; symlink aliases are traversed
 * lazily so N files behind M directory aliases never inflate the index to
 * N×M entries during listing.
 */
export class ArchiveReader {
	readonly format: ArchiveFormat;
	readonly limits: ArchiveLimits;
	#entries = new Map<string, ArchiveIndexEntry>();

	constructor(format: ArchiveFormat, entries: ArchiveIndexEntry[], limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS) {
		this.format = format;
		this.limits = limits;
		for (const entry of entries) {
			upsertArchiveEntry(this.#entries, entry);
		}
		ensureParentDirectories(this.#entries, limits);
	}

	/**
	 * Raw index entries, including link records and synthesized directories.
	 * For extraction/merge flows that need storage kinds; path lookups should
	 * use {@link getNode}/{@link readFile}, which resolve symlink aliases.
	 */
	indexEntries(): IterableIterator<ArchiveIndexEntry> {
		return this.#entries.values();
	}

	/** Resolve a path to its node, or `undefined` when absent or escaping the root. */
	getNode(subPath?: string): ArchiveNode | undefined {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) return undefined;
		if (normalizedPath === "") {
			return { path: "", isDirectory: true, size: 0 };
		}

		const resolvedPath = resolveArchiveLinkPath(this.#entries, normalizedPath, this.limits.maxLinkDepth);
		if (resolvedPath === "") {
			return { path: normalizedPath, isDirectory: true, size: 0 };
		}
		const entry = this.#entries.get(resolvedPath);
		if (!entry) return undefined;
		return {
			path: normalizedPath,
			isDirectory: entry.isDirectory,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			mode: entry.mode,
		};
	}

	/** List one directory's children, sorted case-insensitively by name. */
	listDirectory(subPath?: string): ArchiveDirectoryEntry[] {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (normalizedPath === undefined) {
			throw new ArchiveError("Archive path cannot contain '..'");
		}

		const resolvedPath = normalizedPath
			? resolveArchiveLinkPath(this.#entries, normalizedPath, this.limits.maxLinkDepth)
			: "";
		if (normalizedPath && resolvedPath !== "") {
			const entry = this.#entries.get(resolvedPath);
			if (!entry) {
				throw new ArchiveError(`Archive path '${normalizedPath}' not found`);
			}
			if (!entry.isDirectory) {
				throw new ArchiveError(`Archive path '${normalizedPath}' is not a directory`);
			}
		}

		const sourcePrefix = resolvedPath ? `${resolvedPath}/` : "";
		const children = new Map<string, ArchiveDirectoryEntry>();

		for (const entry of this.#entries.values()) {
			if (resolvedPath) {
				if (!entry.path.startsWith(sourcePrefix) || entry.path === resolvedPath) continue;
			}

			const relativePath = resolvedPath ? entry.path.slice(sourcePrefix.length) : entry.path;
			const nextSegment = relativePath.split("/")[0];
			if (!nextSegment) continue;

			const childPath = normalizedPath ? `${normalizedPath}/${nextSegment}` : nextSegment;
			if (children.has(childPath)) continue;

			const sourceChildPath = resolvedPath ? `${resolvedPath}/${nextSegment}` : nextSegment;
			const resolvedChildPath = resolveArchiveLinkPath(this.#entries, sourceChildPath, this.limits.maxLinkDepth);
			const childEntry = resolvedChildPath ? this.#entries.get(resolvedChildPath) : undefined;
			const isDirectory = resolvedChildPath === "" || childEntry?.isDirectory === true || relativePath.includes("/");
			children.set(childPath, {
				name: nextSegment,
				path: childPath,
				isDirectory,
				size: isDirectory ? 0 : (childEntry?.size ?? entry.size),
				mtimeMs: childEntry?.mtimeMs ?? entry.mtimeMs,
				mode: childEntry?.mode ?? entry.mode,
			});
		}

		return [...children.values()].sort((left, right) =>
			left.name.toLowerCase().localeCompare(right.name.toLowerCase()),
		);
	}

	/** Extract one file member's bytes, following symlink aliases. */
	async readFile(subPath: string): Promise<ExtractedArchiveFile> {
		const normalizedPath = normalizeArchiveLookupPath(subPath);
		if (!normalizedPath) {
			throw new ArchiveError("Archive file path is required");
		}

		const resolvedPath = resolveArchiveLinkPath(this.#entries, normalizedPath, this.limits.maxLinkDepth);
		if (resolvedPath === "") {
			throw new ArchiveError(`Archive path '${normalizedPath}' is a directory`);
		}
		const entry = this.#entries.get(resolvedPath);
		if (!entry) {
			throw new ArchiveError(`Archive file '${normalizedPath}' not found`);
		}
		if (entry.isDirectory) {
			throw new ArchiveError(`Archive path '${normalizedPath}' is a directory`);
		}
		if (!entry.storage) {
			throw new ArchiveError(`Archive file '${normalizedPath}' has no readable storage`);
		}
		assertArchiveMemberSize(entry.size, normalizedPath, this.limits);

		if (entry.storage.type === "link") {
			throwUnreadableArchiveLink(entry.storage.targetPath, normalizedPath);
		}
		const bytes = await entry.storage.source.read(entry.size, normalizedPath);
		return {
			path: normalizedPath,
			isDirectory: false,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			mode: entry.mode,
			bytes,
		};
	}
}
