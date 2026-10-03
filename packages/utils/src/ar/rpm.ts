import { readUInt32BE } from "./bytes";
import { bzip2Decompress, isBzip2 } from "./codecs/bzip2";
import { gzipDecompress, isGzip } from "./codecs/gzip";
import { lzmaAloneDecompress } from "./codecs/lzma";
import { isXz, xzDecompress } from "./codecs/xz";
import { isZstd, zstdDecompress } from "./codecs/zstd";
import { readCpioEntriesFromBuffer, sniffCpio } from "./cpio";
import { ArchiveError } from "./error";
import { assertEntryCount, assertIndexSize, assertInMemorySize } from "./limits";
import type { ByteSource } from "./source";
import type { ArchiveIndexEntry, FormatReader, FormatReadOptions } from "./types";

const RPM_LEAD_SIZE = 96;
const RPM_HEADER_INTRO_SIZE = 16;
const RPM_INDEX_ENTRY_SIZE = 16;
const RPM_HEADER_MAGIC = 0x8eade801;
const RPM_SIGNATURE_TYPE_HEADER = 5;
const RPM_TAG_NAME = 1000;
const RPM_TAG_VERSION = 1001;
const RPM_TAG_PAYLOAD_FORMAT = 1124;
const RPM_TAG_PAYLOAD_COMPRESSOR = 1125;
const RPM_TAG_PAYLOAD_FLAGS = 1126;
const RPM_TYPE_STRING = 6;
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

interface HeaderIntro {
	indexCount: number;
	dataSize: number;
	bodySize: number;
	totalSize: number;
}

interface RpmMetadata {
	name?: string;
	version?: string;
	payloadFormat?: string;
	payloadCompressor?: string;
	payloadFlags?: string;
}

function align(value: number, alignment: number): number {
	const remainder = value % alignment;
	return remainder === 0 ? value : value + alignment - remainder;
}

async function readExact(source: ByteSource, start: number, end: number, what: string): Promise<Uint8Array> {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.size) {
		throw new ArchiveError(`Invalid RPM package: truncated ${what}`);
	}
	const bytes = await source.read(start, end);
	if (bytes.byteLength !== end - start) throw new ArchiveError(`Invalid RPM package: truncated ${what}`);
	return bytes;
}

function parseHeaderIntro(bytes: Uint8Array, options: FormatReadOptions, what: string): HeaderIntro {
	if (bytes.byteLength !== RPM_HEADER_INTRO_SIZE || readUInt32BE(bytes, 0) !== RPM_HEADER_MAGIC) {
		throw new ArchiveError(`Invalid RPM package: corrupt ${what} header magic`);
	}
	for (let offset = 4; offset < 8; offset++) {
		if (bytes[offset] !== 0) throw new ArchiveError(`Invalid RPM package: corrupt ${what} header reserved bytes`);
	}
	const indexCount = readUInt32BE(bytes, 8);
	const dataSize = readUInt32BE(bytes, 12);
	assertEntryCount(indexCount, options.limits);
	const indexSize = indexCount * RPM_INDEX_ENTRY_SIZE;
	const bodySize = indexSize + dataSize;
	if (!Number.isSafeInteger(bodySize)) throw new ArchiveError(`Invalid RPM package: ${what} header is too large`);
	assertIndexSize(RPM_HEADER_INTRO_SIZE + bodySize, options.limits, `RPM ${what} header`);
	return { indexCount, dataSize, bodySize, totalSize: RPM_HEADER_INTRO_SIZE + bodySize };
}

function validateHeaderBody(body: Uint8Array, intro: HeaderIntro, what: string): void {
	const indexSize = intro.indexCount * RPM_INDEX_ENTRY_SIZE;
	if (body.byteLength !== intro.bodySize) throw new ArchiveError(`Invalid RPM package: truncated ${what} header`);
	for (let index = 0; index < intro.indexCount; index++) {
		const recordOffset = index * RPM_INDEX_ENTRY_SIZE;
		const tag = readUInt32BE(body, recordOffset);
		const type = readUInt32BE(body, recordOffset + 4);
		const offset = readUInt32BE(body, recordOffset + 8);
		const count = readUInt32BE(body, recordOffset + 12);
		if (offset > intro.dataSize) throw new ArchiveError(`Invalid RPM package: tag ${tag} points outside header data`);
		const remaining = intro.dataSize - offset;
		let elementSize = 0;
		if (type === 1 || type === 2 || type === 7) elementSize = 1;
		else if (type === 3) elementSize = 2;
		else if (type === 4) elementSize = 4;
		else if (type === 5) elementSize = 8;
		else if (type === 0) {
			if (count !== 0) throw new ArchiveError(`Invalid RPM package: null tag ${tag} has values`);
			continue;
		} else if (type === RPM_TYPE_STRING || type === 8 || type === 9) {
			const stringCount = type === RPM_TYPE_STRING ? 1 : count;
			if (type === RPM_TYPE_STRING && count !== 1) {
				throw new ArchiveError(`Invalid RPM package: string tag ${tag} has an invalid count`);
			}
			if (stringCount > remaining) {
				throw new ArchiveError(`Invalid RPM package: string tag ${tag} exceeds header data`);
			}
			let cursor = indexSize + offset;
			const limit = indexSize + intro.dataSize;
			for (let stringIndex = 0; stringIndex < stringCount; stringIndex++) {
				while (cursor < limit && body[cursor] !== 0) cursor++;
				if (cursor === limit) {
					throw new ArchiveError(`Invalid RPM package: string tag ${tag} is not NUL-terminated`);
				}
				cursor++;
			}
			continue;
		} else {
			throw new ArchiveError(`Invalid RPM package: tag ${tag} uses unknown data type ${type}`);
		}
		if (offset % elementSize !== 0) throw new ArchiveError(`Invalid RPM package: tag ${tag} data is misaligned`);
		if (count * elementSize > remaining)
			throw new ArchiveError(`Invalid RPM package: tag ${tag} exceeds header data`);
	}
}

function readHeaderString(
	body: Uint8Array,
	indexSize: number,
	dataSize: number,
	offset: number,
	count: number,
	type: number,
	tag: number,
): string {
	if (type !== RPM_TYPE_STRING || count !== 1) {
		throw new ArchiveError(`Invalid RPM package: tag ${tag} must contain one string`);
	}
	const start = indexSize + offset;
	const limit = indexSize + dataSize;
	let end = start;
	while (end < limit && body[end] !== 0) end++;
	if (end === limit) throw new ArchiveError(`Invalid RPM package: tag ${tag} string is not NUL-terminated`);
	if (end - start > 4096) throw new ArchiveError(`Invalid RPM package: tag ${tag} string is too large`);
	try {
		return UTF8_FATAL_DECODER.decode(body.subarray(start, end));
	} catch {
		throw new ArchiveError(`Invalid RPM package: tag ${tag} is not valid UTF-8`);
	}
}

function parseMainHeader(body: Uint8Array, intro: HeaderIntro): RpmMetadata {
	validateHeaderBody(body, intro, "main");
	const indexSize = intro.indexCount * RPM_INDEX_ENTRY_SIZE;
	if (body.byteLength !== intro.bodySize) throw new ArchiveError("Invalid RPM package: truncated main header");
	const metadata: RpmMetadata = {};
	for (let index = 0; index < intro.indexCount; index++) {
		const recordOffset = index * RPM_INDEX_ENTRY_SIZE;
		const tag = readUInt32BE(body, recordOffset);
		const type = readUInt32BE(body, recordOffset + 4);
		const offset = readUInt32BE(body, recordOffset + 8);
		const count = readUInt32BE(body, recordOffset + 12);
		if (offset > intro.dataSize) throw new ArchiveError(`Invalid RPM package: tag ${tag} points outside header data`);
		if (
			tag !== RPM_TAG_NAME &&
			tag !== RPM_TAG_VERSION &&
			tag !== RPM_TAG_PAYLOAD_FORMAT &&
			tag !== RPM_TAG_PAYLOAD_COMPRESSOR &&
			tag !== RPM_TAG_PAYLOAD_FLAGS
		) {
			continue;
		}
		const value = readHeaderString(body, indexSize, intro.dataSize, offset, count, type, tag);
		switch (tag) {
			case RPM_TAG_NAME:
				metadata.name = value;
				break;
			case RPM_TAG_VERSION:
				metadata.version = value;
				break;
			case RPM_TAG_PAYLOAD_FORMAT:
				metadata.payloadFormat = value;
				break;
			case RPM_TAG_PAYLOAD_COMPRESSOR:
				metadata.payloadCompressor = value;
				break;
			case RPM_TAG_PAYLOAD_FLAGS:
				metadata.payloadFlags = value;
				break;
		}
	}
	return metadata;
}

function rpmIdentity(metadata: RpmMetadata, leadName: string): string {
	if (metadata.name && metadata.version) return `${metadata.name}-${metadata.version}`;
	return metadata.name ?? leadName;
}

function sniffLzmaAlone(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 13 || bytes[0]! > 224) return false;
	const dictionarySize = (bytes[1]! | (bytes[2]! << 8) | (bytes[3]! << 16) | (bytes[4]! << 24)) >>> 0;
	if (dictionarySize < 4096) return false;
	const rounded = 2 ** Math.ceil(Math.log2(dictionarySize));
	return dictionarySize === rounded || dictionarySize === rounded - rounded / 4;
}

async function decompressPayload(
	payload: Uint8Array,
	metadata: RpmMetadata,
	identity: string,
	maxOutput: number,
): Promise<Uint8Array> {
	const compressor = metadata.payloadCompressor?.trim().toLowerCase();
	let method = compressor;
	if (!method || !["gzip", "gz", "bzip2", "bzip", "xz", "lzma", "zstd", "zstdio", "none"].includes(method)) {
		if (isGzip(payload)) method = "gzip";
		else if (isBzip2(payload)) method = "bzip2";
		else if (isXz(payload)) method = "xz";
		else if (isZstd(payload)) method = "zstd";
		else if (sniffLzmaAlone(payload)) method = "lzma";
		else if (sniffCpio(payload)) method = "none";
		else {
			throw new ArchiveError(
				`RPM package '${identity}' uses unsupported payload compressor '${metadata.payloadCompressor ?? "unknown"}'`,
			);
		}
	}

	switch (method) {
		case "gzip":
		case "gz":
			return gzipDecompress(payload, maxOutput);
		case "bzip2":
		case "bzip":
			return bzip2Decompress(payload, maxOutput);
		case "xz":
			return xzDecompress(payload, maxOutput);
		case "zstd":
		case "zstdio":
			return zstdDecompress(payload, maxOutput);
		case "lzma":
			if (!sniffLzmaAlone(payload)) throw new ArchiveError(`RPM package '${identity}' has a malformed LZMA payload`);
			return lzmaAloneDecompress(payload, maxOutput);
		case "none":
			if (!sniffCpio(payload))
				throw new ArchiveError(`RPM package '${identity}' has an invalid uncompressed CPIO payload`);
			return payload;
		default:
			throw new ArchiveError(`RPM package '${identity}' uses unsupported payload compressor '${method}'`);
	}
}

async function readRpmArchive(source: ByteSource, options: FormatReadOptions): Promise<ArchiveIndexEntry[]> {
	const initial = await readExact(source, 0, RPM_LEAD_SIZE + RPM_HEADER_INTRO_SIZE, "lead and signature header");
	if (!sniffRpm(initial)) throw new ArchiveError("Invalid RPM package: bad lead magic");
	const major = initial[4]!;
	const packageType = (initial[6]! << 8) | initial[7]!;
	if (major < 3 || packageType > 1) throw new ArchiveError("Unsupported RPM package lead version or type");
	const signatureType = (initial[78]! << 8) | initial[79]!;
	if (signatureType !== RPM_SIGNATURE_TYPE_HEADER) {
		throw new ArchiveError(`Unsupported RPM signature type ${signatureType}; only header signatures are supported`);
	}
	const leadNameEnd = initial.subarray(10, 76).indexOf(0);
	const leadNameBytes = initial.subarray(10, leadNameEnd < 0 ? 76 : 10 + leadNameEnd);
	let leadName = "unknown package";
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(leadNameBytes);
		if (decoded) leadName = decoded;
	} catch {}

	const signatureIntro = parseHeaderIntro(initial.subarray(RPM_LEAD_SIZE), options, "signature");
	const signatureEnd = RPM_LEAD_SIZE + signatureIntro.totalSize;
	const mainHeaderOffset = align(signatureEnd, 8);
	const signatureBodyAndPadding = await readExact(
		source,
		RPM_LEAD_SIZE + RPM_HEADER_INTRO_SIZE,
		mainHeaderOffset,
		"signature header",
	);
	if (signatureBodyAndPadding.byteLength < signatureIntro.bodySize) {
		throw new ArchiveError("Invalid RPM package: truncated signature header");
	}
	validateHeaderBody(signatureBodyAndPadding.subarray(0, signatureIntro.bodySize), signatureIntro, "signature");
	for (let offset = signatureIntro.bodySize; offset < signatureBodyAndPadding.byteLength; offset++) {
		if (signatureBodyAndPadding[offset] !== 0) {
			throw new ArchiveError("Invalid RPM package: non-zero signature alignment padding");
		}
	}

	const mainIntroBytes = await readExact(
		source,
		mainHeaderOffset,
		mainHeaderOffset + RPM_HEADER_INTRO_SIZE,
		"main header intro",
	);
	const mainIntro = parseHeaderIntro(mainIntroBytes, options, "main");
	assertIndexSize(signatureIntro.totalSize + mainIntro.totalSize, options.limits, "RPM headers");
	const mainBodyOffset = mainHeaderOffset + RPM_HEADER_INTRO_SIZE;
	const mainBody = await readExact(source, mainBodyOffset, mainBodyOffset + mainIntro.bodySize, "main header");
	const metadata = parseMainHeader(mainBody, mainIntro);
	const identity = rpmIdentity(metadata, leadName);
	if (metadata.payloadFormat && metadata.payloadFormat.toLowerCase() !== "cpio") {
		throw new ArchiveError(`RPM package '${identity}' uses unsupported payload format '${metadata.payloadFormat}'`);
	}

	const payloadOffset = mainHeaderOffset + mainIntro.totalSize;
	const payloadSize = source.size - payloadOffset;
	assertInMemorySize(payloadSize, options.limits);
	const payload = await readExact(source, payloadOffset, source.size, "payload");
	const cpio = await decompressPayload(payload, metadata, identity, options.limits.maxInMemorySize);
	assertInMemorySize(cpio.byteLength, options.limits);
	return readCpioEntriesFromBuffer(cpio, options);
}

/** Read an RPM lead, headers, compressed payload, and its contained CPIO entries. */
export const readRpm: FormatReader = async (source, options) => {
	try {
		return await readRpmArchive(source, options);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(error instanceof Error ? error.message : String(error));
	}
};

/** Detect the four-byte RPM package lead magic. */
export function sniffRpm(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 4 && bytes[0] === 0xed && bytes[1] === 0xab && bytes[2] === 0xee && bytes[3] === 0xdb;
}
