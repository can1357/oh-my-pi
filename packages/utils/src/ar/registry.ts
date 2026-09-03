import * as path from "node:path";
import { readArj, sniffArj } from "./arj";
import { readAsar, sniffAsar } from "./asar";
import { readUInt32LE } from "./bytes";
import { readCab, sniffCab } from "./cab";
import { bzip2Decompress, isBzip2 } from "./codecs/bzip2";
import { gzipDecompress, isGzip } from "./codecs/gzip";
import { lzmaAloneDecompress } from "./codecs/lzma";
import { isCompressZ, lzwDecompress } from "./codecs/lzw";
import { isXz, xzDecompress } from "./codecs/xz";
import { isZstd, zstdDecompress } from "./codecs/zstd";
import { readCpio, sniffCpio } from "./cpio";
import { readDeb, sniffDeb } from "./deb";
import { readIso, sniffIso } from "./iso";
import { assertInMemorySize } from "./limits";
import { readLzh, sniffLzh } from "./lzh";
import { readRar, sniffRar } from "./rar";
import { readRpm, sniffRpm } from "./rpm";
import { readSevenZip, sniffSevenZip } from "./sevenzip";
import { readAllBytes } from "./source";
import { readTar, readTarEntriesFromBuffer, sniffTar } from "./tar";
import type { ArchiveFormat, ArchiveIndexEntry, FormatReader, MemberSource } from "./types";
import { readUnixAr, sniffUnixAr } from "./unix-ar";
import { readZip, sniffZip } from "./zip";

/**
 * Extensions recognized per format, lowercase, without the leading dot.
 * ZIP aliases cover the ZIP-container package families (JVM, Android, Python
 * wheels, browser/IDE extensions, NuGet, comics); `cbr` is RAR-under-alias.
 */
const FORMAT_EXTENSIONS: Record<ArchiveFormat, readonly string[]> = {
	zip: ["zip", "jar", "war", "ear", "apk", "whl", "ipa", "xpi", "vsix", "nupkg", "cbz"],
	tar: ["tar"],
	"tar.gz": ["tar.gz", "tgz"],
	"tar.bz2": ["tar.bz2", "tbz2", "tbz"],
	"tar.xz": ["tar.xz", "txz"],
	"tar.zst": ["tar.zst", "tzst"],
	"tar.Z": ["tar.z"],
	asar: ["asar"],
	rar: ["rar", "cbr"],
	"7z": ["7z"],
	iso: ["iso"],
	cab: ["cab"],
	cpio: ["cpio"],
	rpm: ["rpm"],
	ar: ["ar", "a", "lib"],
	deb: ["deb"],
	lzh: ["lzh", "lha"],
	arj: ["arj"],
	gz: ["gz"],
	bz2: ["bz2"],
	xz: ["xz"],
	zst: ["zst"],
	Z: ["z"],
	lzma: ["lzma"],
};

/** Every recognized extension paired with its format, longest first. */
const EXTENSION_TABLE: readonly (readonly [string, ArchiveFormat])[] = Object.entries(FORMAT_EXTENSIONS)
	.flatMap(([format, extensions]) => extensions.map(ext => [ext, format as ArchiveFormat] as const))
	.sort((left, right) => right[0].length - left[0].length);

/**
 * Regex alternation of every recognized archive extension, longest first so
 * `.tar.gz` wins over `.gz`. Shared with `parseArchivePathCandidates` as its
 * split pattern so extension recognition and path splitting never drift.
 */
export const ARCHIVE_EXTENSION_ALTERNATION = EXTENSION_TABLE.map(([ext]) => ext.replace(/\./g, "\\.")).join("|");

/** Infer an archive format from a filesystem path's extension. */
export function archiveFormatFromPath(filePath: string): ArchiveFormat | undefined {
	const normalized = filePath.toLowerCase();
	for (const [ext, format] of EXTENSION_TABLE) {
		if (normalized.endsWith(`.${ext}`)) return format;
	}
	return undefined;
}

/** Strip the recognized archive extension for single-member pseudo-archives. */
function stemMemberName(archivePath: string | undefined): string {
	if (!archivePath) return "data";
	const base = path.basename(archivePath.replace(/\\/g, "/"));
	const lower = base.toLowerCase();
	for (const [ext] of EXTENSION_TABLE) {
		if (lower.length > ext.length + 1 && lower.endsWith(`.${ext}`)) {
			return base.slice(0, base.length - ext.length - 1);
		}
	}
	return base || "data";
}

/** In-memory bytes as a `MemberSource` (single-member pseudo-archives). */
class BufferMember implements MemberSource {
	#bytes: Uint8Array;
	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}
	async read(): Promise<Uint8Array> {
		return this.#bytes;
	}
}

/**
 * Reader for one compressed stream: decompress bounded, then index the inner
 * bytes as tar when they are one, else surface a single stem-named member.
 * Serves both `tar.<codec>` and bare `.<codec>` formats, so `foo.tgz` holding
 * a tar lists as a tree while `notes.txt.gz` lists as `notes.txt`.
 */
function compressedReader(decompress: (bytes: Uint8Array, maxOutput: number) => Promise<Uint8Array>): FormatReader {
	return async (source, options) => {
		assertInMemorySize(source.size, options.limits);
		const inner = await decompress(await readAllBytes(source), options.limits.maxInMemorySize);
		assertInMemorySize(inner.byteLength, options.limits);
		if (sniffTar(inner)) {
			return readTarEntriesFromBuffer(inner, options);
		}
		const entry: ArchiveIndexEntry = {
			path: stemMemberName(options.archivePath),
			isDirectory: false,
			size: inner.byteLength,
			storage: { type: "member", source: new BufferMember(inner) },
		};
		return [entry];
	};
}

const READERS: Record<ArchiveFormat, FormatReader> = {
	zip: readZip,
	tar: readTar,
	"tar.gz": compressedReader(gzipDecompress),
	"tar.bz2": compressedReader(bzip2Decompress),
	"tar.xz": compressedReader(xzDecompress),
	"tar.zst": compressedReader(zstdDecompress),
	"tar.Z": compressedReader(lzwDecompress),
	asar: readAsar,
	rar: readRar,
	"7z": readSevenZip,
	iso: readIso,
	cab: readCab,
	cpio: readCpio,
	rpm: readRpm,
	ar: readUnixAr,
	deb: readDeb,
	lzh: readLzh,
	arj: readArj,
	gz: compressedReader(gzipDecompress),
	bz2: compressedReader(bzip2Decompress),
	xz: compressedReader(xzDecompress),
	zst: compressedReader(zstdDecompress),
	Z: compressedReader(lzwDecompress),
	lzma: compressedReader(lzmaAloneDecompress),
};

/** The format reader responsible for `format`. */
export function formatReaderFor(format: ArchiveFormat): FormatReader {
	return READERS[format];
}

/**
 * Content-sniff order. Magic-at-zero formats first, then structural probes,
 * then compression wrappers (reported as their `tar.*` variant — the reader
 * falls back to a single member when the inner stream is not tar), then
 * offset magics (tar at 257, ISO at 32769), and last the bounded ZIP-EOCD
 * tail scan for zips with prepended data.
 */
const SNIFFERS: readonly (readonly [ArchiveFormat, (bytes: Uint8Array) => boolean])[] = [
	["zip", sniffZip],
	["rar", sniffRar],
	["7z", sniffSevenZip],
	["cab", sniffCab],
	["rpm", sniffRpm],
	["arj", sniffArj],
	["lzh", sniffLzh],
	["cpio", sniffCpio],
	["deb", sniffDeb],
	["ar", sniffUnixAr],
	["asar", sniffAsar],
	["tar.gz", isGzip],
	["tar.bz2", isBzip2],
	["tar.xz", isXz],
	["tar.zst", isZstd],
	["tar.Z", isCompressZ],
	["iso", sniffIso],
	["tar", sniffTar],
];

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_EOCD_MIN_LENGTH = 22;
const ZIP_EOCD_MAX_COMMENT_LENGTH = 0xffff;

/**
 * Sniff an archive format from its bytes. Pass the full buffer when
 * available: most probes read the head, but tar needs offset 257, ISO offset
 * 32769, and the trailing ZIP central-directory scan needs the tail.
 */
export function sniffArchiveFormat(bytes: Uint8Array): ArchiveFormat | undefined {
	for (const [format, sniff] of SNIFFERS) {
		if (sniff(bytes)) return format;
	}
	// ZIP with prepended data (self-extractors, some installers): bounded
	// backward scan for the end-of-central-directory record.
	const scanStart = bytes.byteLength - ZIP_EOCD_MIN_LENGTH;
	const scanLimit = Math.max(0, bytes.byteLength - ZIP_EOCD_MIN_LENGTH - ZIP_EOCD_MAX_COMMENT_LENGTH);
	for (let offset = scanStart; offset >= scanLimit; offset--) {
		if (readUInt32LE(bytes, offset) === ZIP_EOCD_SIGNATURE) return "zip";
	}
	return undefined;
}
