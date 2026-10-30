import { UTF8_DECODER } from "./bytes";
import { type ArchiveLimits, assertInMemorySize, DEFAULT_ARCHIVE_LIMITS } from "./limits";
import { openArchive } from "./open";
import type { ArchiveReader } from "./reader";

/**
 * A ZIP-based document package (OOXML, EPUB) whose members are inflated only
 * when read. Lookups use exact member paths, so a converter sees the same
 * members a fully materialized `path → bytes` map would expose. Each member's
 * size counts once toward a cap on total inflated bytes, like a fully
 * materialized archive, so a crafted package cannot amplify past the in-memory
 * limit one member at a time.
 */
export class ZipPackage {
	#archive: ArchiveReader;
	#members = new Set<string>();
	#limits: ArchiveLimits;
	/** Members already counted toward {@link #inflated}; re-reading one is free against the cap. */
	#counted = new Set<string>();
	#inflated = 0;

	constructor(archive: ArchiveReader, maxTotalBytes = DEFAULT_ARCHIVE_LIMITS.maxInMemorySize) {
		this.#archive = archive;
		this.#limits = { ...DEFAULT_ARCHIVE_LIMITS, maxInMemorySize: maxTotalBytes };
		for (const entry of archive.indexEntries()) {
			if (!entry.isDirectory) this.#members.add(entry.path);
		}
	}

	/** Index a ZIP buffer without inflating any member. */
	static async open(bytes: Uint8Array, maxTotalBytes?: number): Promise<ZipPackage> {
		return new ZipPackage(await openArchive({ bytes, format: "zip" }), maxTotalBytes);
	}

	/** Exact paths of every file member. */
	get members(): ReadonlySet<string> {
		return this.#members;
	}

	/** Inflate one member, or `undefined` when absent. Throws once distinct inflated bytes exceed the cap. */
	async readBytes(memberPath: string): Promise<Uint8Array | undefined> {
		if (!this.#members.has(memberPath)) return undefined;
		const { bytes } = await this.#archive.readFile(memberPath);
		if (!this.#counted.has(memberPath)) {
			this.#counted.add(memberPath);
			this.#inflated += bytes.length;
			assertInMemorySize(this.#inflated, this.#limits);
		}
		return bytes;
	}

	/** Inflate one member as UTF-8 text, or `undefined` when absent. */
	async readText(memberPath: string): Promise<string | undefined> {
		const bytes = await this.readBytes(memberPath);
		return bytes ? UTF8_DECODER.decode(bytes) : undefined;
	}
}
