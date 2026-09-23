import { encodeAsar } from "./asar";
import { gzipCompress } from "./codecs/gzip";
import { zstdCompress } from "./codecs/zstd";
import { memberContentToBytes } from "./open";
import { encodeTar } from "./tar";
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

/**
 * Serialize `entries` into an archive of `format` in memory. String members
 * are encoded as UTF-8; member names are normalized to forward slashes.
 */
export async function encodeArchive(
	format: WritableArchiveFormat,
	entries: Iterable<readonly [string, ArchiveMemberContent]>,
): Promise<Uint8Array> {
	const members: (readonly [string, Uint8Array])[] = [];
	for (const [name, content] of entries) {
		members.push([name.replace(/\\/g, "/"), await memberContentToBytes(content)] as const);
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
