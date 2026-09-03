import { bytesMatchAscii, UTF8_DECODER } from "./bytes";
import { bzip2Decompress } from "./codecs/bzip2";
import { gzipDecompress } from "./codecs/gzip";
import { lzmaAloneDecompress } from "./codecs/lzma";
import { xzDecompress } from "./codecs/xz";
import { zstdDecompress } from "./codecs/zstd";
import { ensureParentDirectories, upsertArchiveEntry } from "./entries";
import { ArchiveError } from "./error";
import { assertInMemorySize } from "./limits";
import { normalizeArchiveEntryPath } from "./paths";
import type { ByteSource } from "./source";
import { readTarEntriesFromBuffer } from "./tar";
import type { ArchiveIndexEntry, FormatReader, FormatReadOptions } from "./types";
import { readUnixAr } from "./unix-ar";

const AR_SIGNATURE = "!<arch>\n";
const AR_HEADER_SIZE = 60;
const AR_NAME_SIZE = 16;
const DEBIAN_BINARY = "debian-binary";

type DebTarKind = "control" | "data";
type DebCompression = "none" | "gz" | "xz" | "zst" | "bz2" | "lzma";

function firstArMemberName(bytes: Uint8Array): string | undefined {
	if (!bytesMatchAscii(bytes, 0, AR_SIGNATURE) || bytes.byteLength < AR_SIGNATURE.length + AR_HEADER_SIZE)
		return undefined;
	const headerOffset = AR_SIGNATURE.length;
	if (bytes[headerOffset + 58] !== 0x60 || bytes[headerOffset + 59] !== 0x0a) return undefined;
	let nameEnd = headerOffset + AR_NAME_SIZE;
	while (nameEnd > headerOffset && bytes[nameEnd - 1] === 0x20) nameEnd--;
	let rawName = "";
	for (let index = headerOffset; index < nameEnd; index++) {
		const byte = bytes[index]!;
		if (byte < 0x20 || byte > 0x7e) return undefined;
		rawName += String.fromCharCode(byte);
	}
	if (rawName.startsWith("#1/")) {
		const lengthText = rawName.slice(3);
		if (!/^\d+$/.test(lengthText)) return undefined;
		const length = Number.parseInt(lengthText, 10);
		const start = headerOffset + AR_HEADER_SIZE;
		if (!Number.isSafeInteger(length) || length <= 0 || start + length > bytes.byteLength) return undefined;
		const nameBytes = bytes.subarray(start, start + length);
		const nul = nameBytes.indexOf(0);
		return UTF8_DECODER.decode(nul >= 0 ? nameBytes.subarray(0, nul) : nameBytes);
	}
	return rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
}

function classifyTarMember(path: string): { kind: DebTarKind; compression: DebCompression } | undefined {
	const match = /^(control|data)\.tar(?:\.(gz|xz|zst|bz2|lzma))?$/.exec(path);
	if (!match) return undefined;
	return {
		kind: match[1] as DebTarKind,
		compression: (match[2] ?? "none") as DebCompression,
	};
}

async function decompressDebTar(
	bytes: Uint8Array,
	compression: DebCompression,
	options: FormatReadOptions,
): Promise<Uint8Array> {
	const maxOutput = options.limits.maxInMemorySize;
	let decompressed: Uint8Array;
	switch (compression) {
		case "none":
			decompressed = bytes;
			break;
		case "gz":
			decompressed = await gzipDecompress(bytes, maxOutput);
			break;
		case "xz":
			decompressed = await xzDecompress(bytes, maxOutput);
			break;
		case "zst":
			decompressed = await zstdDecompress(bytes, maxOutput);
			break;
		case "bz2":
			decompressed = await bzip2Decompress(bytes, maxOutput);
			break;
		case "lzma":
			decompressed = await lzmaAloneDecompress(bytes, maxOutput);
			break;
	}
	assertInMemorySize(decompressed.byteLength, options.limits);
	return decompressed;
}

function prefixControlEntry(entry: ArchiveIndexEntry): ArchiveIndexEntry {
	const path = `control/${entry.path}`;
	if (entry.storage?.type !== "link") return { ...entry, path };
	const targetPath = entry.storage.targetPath;
	if (targetPath !== "" && normalizeArchiveEntryPath(targetPath) !== targetPath) return { ...entry, path };
	return {
		...entry,
		path,
		storage: {
			...entry.storage,
			targetPath: targetPath ? `control/${targetPath}` : "control",
		},
	};
}

async function readOuterMember(entry: ArchiveIndexEntry): Promise<Uint8Array> {
	if (entry.isDirectory || entry.storage?.type !== "member") {
		throw new ArchiveError(`Invalid deb archive member '${entry.path}'`);
	}
	return entry.storage.source.read(entry.size, entry.path);
}

async function readDebImpl(source: ByteSource, options: FormatReadOptions): Promise<ArchiveIndexEntry[]> {
	const probeEnd = Math.min(source.size, AR_SIGNATURE.length + AR_HEADER_SIZE + options.limits.maxPathBytes);
	let probe: Uint8Array;
	try {
		probe = await source.read(0, probeEnd);
	} catch (error) {
		throw new ArchiveError(error instanceof Error ? error.message : String(error));
	}
	if (!sniffDeb(probe)) throw new ArchiveError("Invalid deb archive: first member is not debian-binary");

	const outerEntries = await readUnixAr(source, options);
	if (outerEntries[0]?.path !== DEBIAN_BINARY) {
		throw new ArchiveError("Invalid deb archive: first member is not debian-binary");
	}
	const result = new Map<string, ArchiveIndexEntry>();
	for (const outerEntry of outerEntries) {
		const tar = classifyTarMember(outerEntry.path);
		if (!tar) {
			if (outerEntry.path.startsWith("control.tar.") || outerEntry.path.startsWith("data.tar.")) {
				throw new ArchiveError(`Unsupported deb tar compression in '${outerEntry.path}'`);
			}
			upsertArchiveEntry(result, outerEntry);
			continue;
		}
		const compressed = await readOuterMember(outerEntry);
		const tarBytes = await decompressDebTar(compressed, tar.compression, options);
		const innerEntries = readTarEntriesFromBuffer(tarBytes, options);
		for (const innerEntry of innerEntries) {
			upsertArchiveEntry(result, tar.kind === "control" ? prefixControlEntry(innerEntry) : innerEntry);
		}
	}
	ensureParentDirectories(result, options.limits);
	return [...result.values()];
}

/** Read a Debian binary package and expose its control and data tar members. */
export const readDeb: FormatReader = async (source, options) => {
	try {
		return await readDebImpl(source, options);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(error instanceof Error ? error.message : String(error));
	}
};

/** Detect a Debian package by its ar header and first debian-binary member. */
export function sniffDeb(bytes: Uint8Array): boolean {
	return firstArMemberName(bytes) === DEBIAN_BINARY;
}
