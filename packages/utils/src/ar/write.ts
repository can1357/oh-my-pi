import { encodeAsar } from "./asar";
import { gzipCompress } from "./codecs/gzip";
import { zstdCompress } from "./codecs/zstd";
import { memberContentToBytes } from "./open";
import { encodeTar, type TarMemberPayload, writeTarFile } from "./tar";
import type { ArchiveFormat, ArchiveMemberContent, WritableArchiveFormat } from "./types";
import { encodeZip } from "./zip";

const WRITABLE_FORMATS: Record<WritableArchiveFormat, true> = {
	zip: true,
	tar: true,
	"tar.gz": true,
	"tar.zst": true,
	asar: true,
};

/** Whether `format` can be serialized by {@link writeArchive} (rest are read-only). */
export function isWritableArchiveFormat(format: ArchiveFormat): format is WritableArchiveFormat {
	return format in WRITABLE_FORMATS;
}

/** One archive entry: its member name and content. */
type ArchiveEntry = readonly [string, ArchiveMemberContent];

/**
 * `entries` as both writers pack them, one at a time: member names normalized
 * to forward slashes, string members encoded as UTF-8, and binary members
 * (`Uint8Array` or `Blob`) passed on unread, so a `Blob` from another realm,
 * which is not `instanceof Blob`, still streams.
 */
async function* packedMembers(
	entries: Iterable<ArchiveEntry> | AsyncIterable<ArchiveEntry>,
): AsyncGenerator<readonly [string, TarMemberPayload]> {
	for await (const [name, content] of entries) {
		yield [name.replace(/\\/g, "/"), typeof content === "string" ? await memberContentToBytes(content) : content];
	}
}

/**
 * Serialize `entries` into an archive of `format` in memory. String members
 * are encoded as UTF-8; member names are normalized to forward slashes.
 */
export async function encodeArchive(
	format: WritableArchiveFormat,
	entries: Iterable<readonly [string, ArchiveMemberContent]>,
): Promise<Uint8Array> {
	const members: (readonly [string, Uint8Array])[] = [];
	for await (const [name, payload] of packedMembers(entries)) {
		members.push([name, await memberContentToBytes(payload)] as const);
	}
	switch (format) {
		case "zip":
			return encodeZip(members);
		case "asar":
			return encodeAsar(members);
		case "tar":
			return encodeTar(members);
		case "tar.gz":
			return gzipCompress(await encodeTar(members));
		case "tar.zst":
			return zstdCompress(await encodeTar(members));
	}
}

/** {@link encodeArchive}, written to `destPath` (parent directories auto-created). */
export async function writeArchive(
	destPath: string,
	format: WritableArchiveFormat,
	entries: Iterable<readonly [string, ArchiveMemberContent]>,
): Promise<void> {
	await Bun.write(destPath, await encodeArchive(format, entries));
}

/**
 * {@link writeArchive} for a plain tar, written member by member: the same
 * tar encoding, but each entry is read as it is written, and a `Blob` member
 * (e.g. `Bun.file`) streams from its source, so the archive is never built in
 * memory. `entries` may be an async iterable: the writer takes each entry
 * only once the one before it is written. The bytes equal `writeArchive`'s
 * when no entry changes while `entries` is read. Parent directories are
 * auto-created. Unlike `writeArchive`, this empties `destPath` before reading
 * any member. A failure after that can leave an empty or partial archive. To
 * preserve the destination on failure, write to a staging file beside it.
 * Rename the staging file over the destination after a successful write.
 */
export async function writeTarArchive(
	destPath: string,
	entries: Iterable<ArchiveEntry> | AsyncIterable<ArchiveEntry>,
): Promise<void> {
	await writeTarFile(destPath, packedMembers(entries));
}
