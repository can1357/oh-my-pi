import path from "node:path";
import type { ArchiveLimits } from "../../src/ar/limits";
import { ArchiveReader } from "../../src/ar/reader";
import type { ArchiveFormat, ArchiveIndexEntry } from "../../src/ar/types";

/**
 * Every `ar/` test fixture bundled as a single `tar.gz`, loaded once per test run.
 *
 * Keeping ~130 small binary blobs as loose files thrashes git status/diff on every
 * checkout; the archive is a single opaque blob instead. Names inside the archive
 * are the same relative paths the loose files used to have (e.g. `"codecs/bzip-level-1.txt.bz2"`).
 */
// `bun test --parallel` runs files sharing this module concurrently; a plain top-level-await
// export races across those callers (Bun TDZ bug), so the archive is memoized behind a lazy
// promise instead of read from a top-level-await binding.
let filesPromise: Promise<Map<string, File>> | null = null;

function loadFiles(): Promise<Map<string, File>> {
	filesPromise ??= (async () => {
		const archive = new Bun.Archive(await Bun.file(path.join(import.meta.dir, "../fixtures/ar.tar.gz")).bytes());
		return archive.files();
	})();
	return filesPromise;
}

/** Reads one fixture's bytes by its archive-relative name (e.g. `"zip-basic.zip"`, `"codecs/bzip-level-1.txt.bz2"`). */
export async function arFixture(name: string): Promise<Uint8Array> {
	const files = await loadFiles();
	const file = files.get(name);
	if (!file) throw new Error(`Missing ar fixture: ${name}`);
	return new Uint8Array(await file.arrayBuffer());
}

/**
 * Index `entries` under `limits`, then extract its largest file: `maxMemberSize` bounds extraction, so an
 * oversized member never blocks the listing. Rejects with the extraction error.
 */
export async function extractLargestMember(
	format: ArchiveFormat,
	entries: ArchiveIndexEntry[],
	limits: ArchiveLimits,
): Promise<unknown> {
	const files = entries.filter(entry => !entry.isDirectory && entry.storage?.type === "member");
	const largest = files.reduce((best, entry) => (entry.size > best.size ? entry : best));
	return new ArchiveReader(format, entries, limits).readFile(largest.path);
}
