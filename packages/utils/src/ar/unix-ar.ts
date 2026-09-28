import { bytesMatchAscii, UTF8_DECODER } from "./bytes";
import { ensureParentDirectories, upsertArchiveEntry } from "./entries";
import { ArchiveError } from "./error";
import { type ArchiveLimits, assertArchiveMemberSize, assertEntryCount, assertIndexSize } from "./limits";
import { assertArchivePathBytes, normalizeArchiveEntryPath } from "./paths";
import { type ByteSource, memoryByteSource, readMemoryRange } from "./source";
import type { ArchiveIndexEntry, FormatReader, FormatReadOptions, MemberSource } from "./types";

const SIGNATURE = "!<arch>\n";
const HEADER_SIZE = 60;
const NAME_SIZE = 16;
const HEADER_TRAILER_OFFSET = 58;
const FILE_TYPE_MASK = 0o170000;
const DIRECTORY_TYPE = 0o040000;

interface RawArMember {
	name: string;
	nameByteLength: number;
	dataOffset: number;
	size: number;
	mtimeSeconds?: number;
	mode?: number;
}

class ArMemberSource implements MemberSource {
	readonly #source: ByteSource;
	readonly #offset: number;

	constructor(source: ByteSource, offset: number) {
		this.#source = source;
		this.#offset = offset;
	}

	async read(size: number, memberPath: string): Promise<Uint8Array> {
		try {
			const bytes = await this.#source.read(this.#offset, this.#offset + size);
			if (bytes.byteLength !== size) {
				throw new ArchiveError(`Archive member '${memberPath}' is truncated`);
			}
			return bytes;
		} catch (error) {
			if (error instanceof ArchiveError) throw error;
			throw new ArchiveError(error instanceof Error ? error.message : String(error));
		}
	}
}

function decodeAsciiField(bytes: Uint8Array, offset: number, length: number): string {
	let end = offset + length;
	while (end > offset && bytes[end - 1] === 0x20) end--;
	let value = "";
	for (let index = offset; index < end; index++) {
		const byte = bytes[index]!;
		if (byte < 0x20 || byte > 0x7e) throw new ArchiveError("Invalid ar archive header field");
		value += String.fromCharCode(byte);
	}
	return value;
}

function parseOptionalNumber(value: string, radix: 8 | 10, field: string): number | undefined {
	if (value === "" || value === "-1") return undefined;
	const pattern = radix === 8 ? /^[0-7]+$/ : /^\d+$/;
	if (!pattern.test(value)) throw new ArchiveError(`Invalid ar archive ${field}`);
	const parsed = Number.parseInt(value, radix);
	if (!Number.isSafeInteger(parsed)) throw new ArchiveError(`Invalid ar archive ${field}`);
	return parsed;
}

function parseRequiredSize(value: string): number {
	const parsed = parseOptionalNumber(value, 10, "member size");
	if (parsed === undefined) throw new ArchiveError("Invalid ar archive member size");
	return parsed;
}

function parseHeader(header: Uint8Array): {
	rawName: string;
	physicalSize: number;
	mtimeSeconds?: number;
	mode?: number;
	bsdNameLength?: number;
} {
	if (
		header.byteLength !== HEADER_SIZE ||
		header[HEADER_TRAILER_OFFSET] !== 0x60 ||
		header[HEADER_TRAILER_OFFSET + 1] !== 0x0a
	) {
		throw new ArchiveError("Invalid ar archive member header");
	}
	const rawName = decodeAsciiField(header, 0, NAME_SIZE);
	const mtimeSeconds = parseOptionalNumber(decodeAsciiField(header, 16, 12), 10, "modification time");
	parseOptionalNumber(decodeAsciiField(header, 28, 6), 10, "user id");
	parseOptionalNumber(decodeAsciiField(header, 34, 6), 10, "group id");
	const mode = parseOptionalNumber(decodeAsciiField(header, 40, 8), 8, "mode");
	const physicalSize = parseRequiredSize(decodeAsciiField(header, 48, 10));
	let bsdNameLength: number | undefined;
	if (rawName.startsWith("#1/")) {
		const encodedLength = rawName.slice(3);
		if (!/^\d+$/.test(encodedLength)) throw new ArchiveError("Invalid ar archive BSD extended name length");
		bsdNameLength = Number.parseInt(encodedLength, 10);
		if (!Number.isSafeInteger(bsdNameLength) || bsdNameLength <= 0 || bsdNameLength > physicalSize) {
			throw new ArchiveError("Invalid ar archive BSD extended name length");
		}
	}
	return { rawName, physicalSize, mtimeSeconds, mode, bsdNameLength };
}

function decodeName(bytes: Uint8Array, limits: ArchiveLimits): string {
	assertArchivePathBytes(bytes.byteLength, "member path", limits.maxPathBytes);
	return UTF8_DECODER.decode(bytes);
}

function decodeBsdName(bytes: Uint8Array, limits: ArchiveLimits): { name: string; byteLength: number } {
	const nul = bytes.indexOf(0);
	const nameBytes = nul >= 0 ? bytes.subarray(0, nul) : bytes;
	if (nameBytes.byteLength === 0) throw new ArchiveError("Invalid ar archive empty BSD extended name");
	return { name: decodeName(nameBytes, limits), byteLength: nameBytes.byteLength };
}

function shortName(rawName: string): string {
	if (rawName === "/" || rawName === "//" || rawName === "/SYM64/") return rawName;
	return rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
}

function resolveLongName(
	reference: string,
	table: Uint8Array,
	limits: ArchiveLimits,
): { name: string; byteLength: number } {
	const offsetText = reference.slice(1);
	if (!/^\d+$/.test(offsetText)) throw new ArchiveError(`Invalid ar archive member name '${reference}'`);
	const offset = Number.parseInt(offsetText, 10);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset >= table.byteLength) {
		throw new ArchiveError(`Invalid ar archive long-name offset '${reference}'`);
	}
	let end = offset;
	while (end < table.byteLength && table[end] !== 0 && table[end] !== 0x0a) end++;
	if (end === table.byteLength) throw new ArchiveError(`Unterminated ar archive long name at offset ${offset}`);
	let nameEnd = end;
	if (table[end] === 0x0a && nameEnd > offset && table[nameEnd - 1] === 0x2f) nameEnd--;
	if (nameEnd === offset) throw new ArchiveError(`Empty ar archive long name at offset ${offset}`);
	const nameBytes = table.subarray(offset, nameEnd);
	return { name: decodeName(nameBytes, limits), byteLength: nameBytes.byteLength };
}

function isMetadataName(name: string): boolean {
	return name === "/" || name === "//" || name === "/SYM64/" || name === "__.SYMDEF" || name === "__.SYMDEF SORTED";
}

function materializeEntries(
	records: RawArMember[],
	longNames: Uint8Array | undefined,
	source: ByteSource,
	options: FormatReadOptions,
): ArchiveIndexEntry[] {
	const entries = new Map<string, ArchiveIndexEntry>();
	for (const record of records) {
		let name = record.name;
		let nameByteLength = record.nameByteLength;
		if (/^\/\d+$/.test(name)) {
			if (!longNames) throw new ArchiveError(`Ar archive member '${name}' references a missing long-name table`);
			const resolved = resolveLongName(name, longNames, options.limits);
			name = resolved.name;
			nameByteLength = resolved.byteLength;
		} else {
			name = shortName(name);
		}
		if (isMetadataName(name)) continue;
		assertArchivePathBytes(nameByteLength, "member path", options.limits.maxPathBytes);
		assertArchiveMemberSize(record.size, name, options.limits);
		const path = normalizeArchiveEntryPath(name);
		if (!path) continue;
		const isDirectory = record.mode !== undefined && (record.mode & FILE_TYPE_MASK) === DIRECTORY_TYPE;
		const entry: ArchiveIndexEntry = {
			path,
			isDirectory,
			size: isDirectory ? 0 : record.size,
			...(record.mtimeSeconds !== undefined ? { mtimeMs: record.mtimeSeconds * 1000 } : {}),
			...(record.mode !== undefined ? { mode: record.mode } : {}),
			...(!isDirectory
				? { storage: { type: "member" as const, source: new ArMemberSource(source, record.dataOffset) } }
				: {}),
		};
		upsertArchiveEntry(entries, entry);
		assertEntryCount(entries.size, options.limits);
	}
	ensureParentDirectories(entries, options.limits);
	return [...entries.values()];
}

function readSignatureFromBuffer(bytes: Uint8Array): void {
	if (!sniffUnixAr(bytes)) throw new ArchiveError("Invalid ar archive signature");
}

/** Parse a fully materialized Unix ar archive for composition by formats such as deb. */
export function readUnixArEntriesFromBuffer(bytes: Uint8Array, options: FormatReadOptions): ArchiveIndexEntry[] {
	readSignatureFromBuffer(bytes);
	const records: RawArMember[] = [];
	let longNames: Uint8Array | undefined;
	let metadataSize = 0;
	for (let position = SIGNATURE.length; position < bytes.byteLength;) {
		if (bytes.byteLength - position < HEADER_SIZE)
			throw new ArchiveError("Invalid ar archive: truncated member header");
		const header = parseHeader(readMemoryRange(bytes, position, position + HEADER_SIZE));
		metadataSize += HEADER_SIZE;
		assertIndexSize(metadataSize, options.limits, "index");
		const payloadOffset = position + HEADER_SIZE;
		const payloadEnd = payloadOffset + header.physicalSize;
		if (!Number.isSafeInteger(payloadEnd) || payloadEnd > bytes.byteLength) {
			throw new ArchiveError("Invalid ar archive: truncated member data");
		}
		let name = header.rawName;
		let nameByteLength = Buffer.byteLength(name, "utf-8");
		let dataOffset = payloadOffset;
		let size = header.physicalSize;
		if (header.bsdNameLength !== undefined) {
			metadataSize += header.bsdNameLength;
			assertIndexSize(metadataSize, options.limits, "index");
			const nameBytes = readMemoryRange(bytes, payloadOffset, payloadOffset + header.bsdNameLength);
			const decoded = decodeBsdName(nameBytes, options.limits);
			name = decoded.name;
			nameByteLength = decoded.byteLength;
			dataOffset += header.bsdNameLength;
			size -= header.bsdNameLength;
		} else if (header.rawName === "//") {
			metadataSize += header.physicalSize;
			assertIndexSize(metadataSize, options.limits, "index");
			longNames = readMemoryRange(bytes, payloadOffset, payloadEnd);
		}
		records.push({ name, nameByteLength, dataOffset, size, mtimeSeconds: header.mtimeSeconds, mode: header.mode });
		assertEntryCount(records.length, options.limits);
		position = payloadEnd + (header.physicalSize & 1);
		if (position > bytes.byteLength) throw new ArchiveError("Invalid ar archive: missing alignment byte");
	}
	return materializeEntries(records, longNames, memoryByteSource(bytes), options);
}

async function readExact(source: ByteSource, start: number, end: number, what: string): Promise<Uint8Array> {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.size) {
		throw new ArchiveError(`Invalid ar archive: truncated ${what}`);
	}
	try {
		const bytes = await source.read(start, end);
		if (bytes.byteLength !== end - start) throw new ArchiveError(`Invalid ar archive: truncated ${what}`);
		return bytes;
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(error instanceof Error ? error.message : String(error));
	}
}

async function readUnixArImpl(source: ByteSource, options: FormatReadOptions): Promise<ArchiveIndexEntry[]> {
	if (!Number.isSafeInteger(source.size) || source.size < SIGNATURE.length)
		throw new ArchiveError("Invalid ar archive signature");
	readSignatureFromBuffer(await readExact(source, 0, SIGNATURE.length, "signature"));
	const records: RawArMember[] = [];
	let longNames: Uint8Array | undefined;
	let metadataSize = 0;
	for (let position = SIGNATURE.length; position < source.size;) {
		const headerBytes = await readExact(source, position, position + HEADER_SIZE, "member header");
		const header = parseHeader(headerBytes);
		metadataSize += HEADER_SIZE;
		assertIndexSize(metadataSize, options.limits, "index");
		const payloadOffset = position + HEADER_SIZE;
		const payloadEnd = payloadOffset + header.physicalSize;
		if (!Number.isSafeInteger(payloadEnd) || payloadEnd > source.size) {
			throw new ArchiveError("Invalid ar archive: truncated member data");
		}
		let name = header.rawName;
		let nameByteLength = Buffer.byteLength(name, "utf-8");
		let dataOffset = payloadOffset;
		let size = header.physicalSize;
		if (header.bsdNameLength !== undefined) {
			metadataSize += header.bsdNameLength;
			assertIndexSize(metadataSize, options.limits, "index");
			const nameBytes = await readExact(
				source,
				payloadOffset,
				payloadOffset + header.bsdNameLength,
				"BSD member name",
			);
			const decoded = decodeBsdName(nameBytes, options.limits);
			name = decoded.name;
			nameByteLength = decoded.byteLength;
			dataOffset += header.bsdNameLength;
			size -= header.bsdNameLength;
		} else if (header.rawName === "//") {
			metadataSize += header.physicalSize;
			assertIndexSize(metadataSize, options.limits, "index");
			longNames = await readExact(source, payloadOffset, payloadEnd, "long-name table");
		}
		records.push({ name, nameByteLength, dataOffset, size, mtimeSeconds: header.mtimeSeconds, mode: header.mode });
		assertEntryCount(records.length, options.limits);
		position = payloadEnd + (header.physicalSize & 1);
		if (position > source.size) throw new ArchiveError("Invalid ar archive: missing alignment byte");
	}
	return materializeEntries(records, longNames, source, options);
}

/** Read a Unix ar, static-library, or COFF import-library container. */
export const readUnixAr: FormatReader = async (source, options) => {
	try {
		return await readUnixArImpl(source, options);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(error instanceof Error ? error.message : String(error));
	}
};

/** Detect the Unix ar global header. */
export function sniffUnixAr(bytes: Uint8Array): boolean {
	return bytesMatchAscii(bytes, 0, SIGNATURE);
}
