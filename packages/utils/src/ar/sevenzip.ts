import { crc32 } from "./checksums";
import { ArchiveError } from "./error";
import { assertArchiveMemberSize, assertEntryCount, assertIndexSize, assertInMemorySize } from "./limits";
import { assertArchivePathBytes, assertArchivePathString, normalizeArchiveEntryPath } from "./paths";
import {
	type SevenZipBindPair,
	type SevenZipCoder,
	type SevenZipFolderRecord,
	SevenZipFolderSource,
} from "./sevenzip/decode";
import type { ByteSource } from "./source";
import type { ArchiveIndexEntry, FormatReader, FormatReadOptions, MemberSource } from "./types";

const SIGNATURE = Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c);
// WHATWG maps the "utf-16" label to the UTF-16LE decoder 7z names use.
const UTF16_LE = new TextDecoder("utf-16", { fatal: true });
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const FILETIME_EPOCH_MS = 11_644_473_600_000;

class HeaderReader {
	readonly bytes: Uint8Array;
	pos = 0;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}

	get remaining(): number {
		return this.bytes.byteLength - this.pos;
	}

	readByte(): number {
		if (this.pos >= this.bytes.byteLength) throw new ArchiveError("Invalid 7z header: truncated data");
		return this.bytes[this.pos++]!;
	}

	readBytes(size: number): Uint8Array {
		if (!Number.isSafeInteger(size) || size < 0 || size > this.remaining)
			throw new ArchiveError("Invalid 7z header: truncated or invalid-sized data");
		const result = this.bytes.subarray(this.pos, this.pos + size);
		this.pos += size;
		return result;
	}

	readUInt32(): number {
		const bytes = this.readBytes(4);
		return (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0;
	}

	readUInt64BigInt(): bigint {
		const bytes = this.readBytes(8);
		let value = 0n;
		for (let index = 0; index < 8; index++) value |= BigInt(bytes[index]!) << BigInt(index * 8);
		return value;
	}

	readNumberBigInt(): bigint {
		const first = this.readByte();
		let value = 0n;
		let mask = 0x80;
		for (let index = 0; index < 8; index++) {
			if ((first & mask) === 0) return value | (BigInt(first & (mask - 1)) << BigInt(index * 8));
			value |= BigInt(this.readByte()) << BigInt(index * 8);
			mask >>>= 1;
		}
		return value;
	}

	readNumber(what = "number"): number {
		const value = this.readNumberBigInt();
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArchiveError(`7z ${what} is too large to read safely`);
		return Number(value);
	}

	skipSizedProperty(): void {
		this.readBytes(this.readNumber("property size"));
	}
}

interface Digests {
	defined: boolean[];
	values: Array<number | undefined>;
}

interface SevenZipSubstream {
	folderIndex: number;
	offset: number;
	size: number;
	crc?: number;
}

interface SevenZipStreams {
	packPosition: number;
	packSizes: number[];
	packCrcs: Array<number | undefined>;
	folders: SevenZipFolderRecord[];
	substreams: SevenZipSubstream[];
}

interface FileMetadata {
	names: string[];
	emptyStreams: boolean[];
	emptyFiles: boolean[];
	antiFiles: boolean[];
	mtimes: Array<number | undefined>;
	attributes: Array<number | undefined>;
}

function readBoolVector(reader: HeaderReader, count: number): boolean[] {
	const result = new Array<boolean>(count);
	let byte = 0;
	let mask = 0;
	for (let index = 0; index < count; index++) {
		if (mask === 0) {
			byte = reader.readByte();
			mask = 0x80;
		}
		result[index] = (byte & mask) !== 0;
		mask >>>= 1;
	}
	return result;
}

function readDefinedVector(reader: HeaderReader, count: number): boolean[] {
	if (reader.readByte() !== 0) return new Array<boolean>(count).fill(true);
	return readBoolVector(reader, count);
}

function readDigests(reader: HeaderReader, count: number): Digests {
	const defined = readDefinedVector(reader, count);
	const values = new Array<number | undefined>(count);
	for (let index = 0; index < count; index++) if (defined[index]) values[index] = reader.readUInt32();
	return { defined, values };
}

function expectId(reader: HeaderReader, expected: number, context: string): void {
	const actual = reader.readNumber("property ID");
	if (actual !== expected)
		throw new ArchiveError(
			`Invalid 7z header: expected ${context} ID 0x${expected.toString(16)}, got 0x${actual.toString(16)}`,
		);
}

function parseFolder(reader: HeaderReader, options: FormatReadOptions): SevenZipFolderRecord {
	const coderCount = reader.readNumber("folder coder count");
	if (coderCount === 0 || coderCount > options.limits.maxEntries)
		throw new ArchiveError("Invalid 7z folder coder count");
	const coders: SevenZipCoder[] = [];
	let totalInputs = 0;
	let totalOutputs = 0;
	for (let index = 0; index < coderCount; index++) {
		const flags = reader.readByte();
		if ((flags & 0xc0) !== 0) throw new ArchiveError("Unsupported 7z coder alternatives or reserved flags");
		const idSize = flags & 0x0f;
		if (idSize === 0 || idSize > 8) throw new ArchiveError("Invalid 7z coder method ID size");
		let id = 0n;
		for (const byte of reader.readBytes(idSize)) id = (id << 8n) | BigInt(byte);
		const complex = (flags & 0x10) !== 0;
		const numInputs = complex ? reader.readNumber("coder input count") : 1;
		const numOutputs = complex ? reader.readNumber("coder output count") : 1;
		if (
			numInputs === 0 ||
			numOutputs === 0 ||
			totalInputs + numInputs > options.limits.maxEntries ||
			totalOutputs + numOutputs > options.limits.maxEntries
		) {
			throw new ArchiveError("Invalid or excessive 7z coder stream count");
		}
		const propertySize = (flags & 0x20) !== 0 ? reader.readNumber("coder properties size") : 0;
		assertIndexSize(propertySize, options.limits, "coder properties");
		const properties = reader.readBytes(propertySize).slice();
		coders.push({ id, properties, inputStart: totalInputs, outputStart: totalOutputs, numInputs, numOutputs });
		totalInputs += numInputs;
		totalOutputs += numOutputs;
	}
	const bindCount = totalOutputs - 1;
	if (bindCount < 0 || bindCount > totalInputs) throw new ArchiveError("Invalid 7z folder bind-pair count");
	const bindPairs: SevenZipBindPair[] = [];
	const usedInputs = new Set<number>();
	const usedOutputs = new Set<number>();
	for (let index = 0; index < bindCount; index++) {
		const input = reader.readNumber("bind input index");
		const output = reader.readNumber("bind output index");
		if (input >= totalInputs || output >= totalOutputs || usedInputs.has(input) || usedOutputs.has(output))
			throw new ArchiveError("Invalid 7z folder bind pair");
		usedInputs.add(input);
		usedOutputs.add(output);
		bindPairs.push({ input, output });
	}
	const packedCount = totalInputs - bindCount;
	const packedIndices: number[] = [];
	if (packedCount === 1) {
		for (let index = 0; index < totalInputs; index++) if (!usedInputs.has(index)) packedIndices.push(index);
	} else {
		for (let index = 0; index < packedCount; index++) {
			const packed = reader.readNumber("packed stream index");
			if (packed >= totalInputs || usedInputs.has(packed)) throw new ArchiveError("Invalid 7z packed stream index");
			usedInputs.add(packed);
			packedIndices.push(packed);
		}
	}
	if (packedIndices.length !== packedCount) throw new ArchiveError("Invalid 7z folder packed-stream map");
	return { coders, bindPairs, packedIndices, unpackSizes: [], packOffsets: [], packSizes: [], packCrcs: [] };
}

function finalFolderOutput(folder: SevenZipFolderRecord): number {
	const bound = new Set(folder.bindPairs.map(pair => pair.output));
	const outputs = folder.coders.flatMap(coder =>
		Array.from({ length: coder.numOutputs }, (_, index) => coder.outputStart + index),
	);
	const final = outputs.filter(index => !bound.has(index));
	if (final.length !== 1) throw new ArchiveError("Unsupported 7z folder with multiple final output streams");
	return final[0]!;
}

function parsePackInfo(reader: HeaderReader, streams: SevenZipStreams, options: FormatReadOptions): void {
	streams.packPosition = reader.readNumber("pack position");
	const count = reader.readNumber("pack stream count");
	if (count > options.limits.maxEntries) throw new ArchiveError("7z has too many packed streams");
	for (;;) {
		const id = reader.readNumber("PackInfo property ID");
		if (id === 0) break;
		if (id === 9) {
			if (streams.packSizes.length !== 0) throw new ArchiveError("Invalid duplicate 7z pack sizes");
			for (let index = 0; index < count; index++) streams.packSizes.push(reader.readNumber("packed stream size"));
		} else if (id === 10) {
			if (streams.packCrcs.length !== 0) throw new ArchiveError("Invalid duplicate 7z pack CRCs");
			streams.packCrcs = readDigests(reader, count).values;
		} else reader.skipSizedProperty();
	}
	if (streams.packSizes.length !== count) throw new ArchiveError("Invalid 7z PackInfo without complete sizes");
	if (streams.packCrcs.length === 0) streams.packCrcs = new Array(count).fill(undefined);
}

function parseUnpackInfo(reader: HeaderReader, streams: SevenZipStreams, options: FormatReadOptions): void {
	expectId(reader, 11, "Folder");
	const count = reader.readNumber("folder count");
	if (count > options.limits.maxEntries) throw new ArchiveError("7z has too many folders");
	if (reader.readByte() !== 0) throw new ArchiveError("Unsupported 7z external folder definitions");
	for (let index = 0; index < count; index++) streams.folders.push(parseFolder(reader, options));
	expectId(reader, 12, "CodersUnpackSize");
	for (const folder of streams.folders) {
		const outputCount = folder.coders.reduce((sum, coder) => sum + coder.numOutputs, 0);
		for (let index = 0; index < outputCount; index++) folder.unpackSizes.push(reader.readNumber("coder unpack size"));
	}
	for (;;) {
		const id = reader.readNumber("UnpackInfo property ID");
		if (id === 0) break;
		if (id === 10) {
			const digests = readDigests(reader, count);
			for (let index = 0; index < count; index++) streams.folders[index]!.crc = digests.values[index];
		} else reader.skipSizedProperty();
	}
}

function parseSubStreamsInfo(reader: HeaderReader, streams: SevenZipStreams): void {
	const counts = new Array<number>(streams.folders.length).fill(1);
	let sizes: number[] | undefined;
	let rawDigests: Digests | undefined;
	for (;;) {
		const id = reader.readNumber("SubStreamsInfo property ID");
		if (id === 0) break;
		if (id === 13) {
			for (let index = 0; index < counts.length; index++)
				counts[index] = reader.readNumber("folder substream count");
		} else if (id === 9) {
			sizes = [];
			for (let folderIndex = 0; folderIndex < streams.folders.length; folderIndex++) {
				for (let index = 1; index < counts[folderIndex]!; index++) sizes.push(reader.readNumber("substream size"));
			}
		} else if (id === 10) {
			let digestCount = 0;
			for (let index = 0; index < counts.length; index++)
				if (counts[index] !== 1 || streams.folders[index]!.crc === undefined) digestCount += counts[index]!;
			rawDigests = readDigests(reader, digestCount);
		} else reader.skipSizedProperty();
	}
	let sizeIndex = 0;
	let digestIndex = 0;
	for (let folderIndex = 0; folderIndex < streams.folders.length; folderIndex++) {
		const folder = streams.folders[folderIndex]!;
		const count = counts[folderIndex]!;
		let offset = 0;
		const folderSize = folder.unpackSizes[finalFolderOutput(folder)]!;
		for (let index = 0; index < count; index++) {
			const size =
				index + 1 === count
					? folderSize - offset
					: (sizes?.[sizeIndex++] ??
						(() => {
							throw new ArchiveError("Invalid 7z SubStreamsInfo without sizes");
						})());
			if (size < 0 || offset + size > folderSize) throw new ArchiveError("Invalid 7z substream size total");
			let checksum: number | undefined;
			if (count === 1 && folder.crc !== undefined) checksum = folder.crc;
			else checksum = rawDigests?.values[digestIndex++];
			streams.substreams.push({ folderIndex, offset, size, crc: checksum });
			offset += size;
		}
		if (offset !== folderSize) throw new ArchiveError("Invalid 7z substream sizes");
	}
}

function assignPackStreams(streams: SevenZipStreams, sourceSize: number): void {
	let absolute = 32 + streams.packPosition;
	const offsets: number[] = [];
	for (const size of streams.packSizes) {
		if (!Number.isSafeInteger(absolute) || absolute < 0 || size < 0 || absolute + size > sourceSize)
			throw new ArchiveError("Invalid 7z packed-stream range");
		offsets.push(absolute);
		absolute += size;
	}
	let packIndex = 0;
	for (const folder of streams.folders) {
		for (let index = 0; index < folder.packedIndices.length; index++) {
			if (packIndex >= streams.packSizes.length) throw new ArchiveError("Invalid 7z folder-to-pack-stream mapping");
			folder.packOffsets.push(offsets[packIndex]!);
			folder.packSizes.push(streams.packSizes[packIndex]!);
			folder.packCrcs.push(streams.packCrcs[packIndex]);
			packIndex++;
		}
	}
	if (packIndex !== streams.packSizes.length) throw new ArchiveError("Invalid unused 7z packed streams");
}

function parseStreamsInfo(reader: HeaderReader, sourceSize: number, options: FormatReadOptions): SevenZipStreams {
	const streams: SevenZipStreams = { packPosition: 0, packSizes: [], packCrcs: [], folders: [], substreams: [] };
	for (;;) {
		const id = reader.readNumber("StreamsInfo property ID");
		if (id === 0) break;
		if (id === 6) parsePackInfo(reader, streams, options);
		else if (id === 7) parseUnpackInfo(reader, streams, options);
		else if (id === 8) parseSubStreamsInfo(reader, streams);
		else throw new ArchiveError(`Unsupported 7z StreamsInfo property ID 0x${id.toString(16)}`);
	}
	if (streams.folders.length > 0 && streams.substreams.length === 0) {
		for (let index = 0; index < streams.folders.length; index++) {
			const folder = streams.folders[index]!;
			streams.substreams.push({
				folderIndex: index,
				offset: 0,
				size: folder.unpackSizes[finalFolderOutput(folder)]!,
				crc: folder.crc,
			});
		}
	}
	assignPackStreams(streams, sourceSize);
	return streams;
}

async function decodeMetadataStreams(
	source: ByteSource,
	streams: SevenZipStreams,
	options: FormatReadOptions,
): Promise<Uint8Array[]> {
	const buffers: Uint8Array[] = [];
	for (const folder of streams.folders) {
		const size = folder.unpackSizes[finalFolderOutput(folder)]!;
		assertIndexSize(size, options.limits, "decoded header");
		assertInMemorySize(size, options.limits);
		buffers.push(await new SevenZipFolderSource(source, folder, options.limits).read());
	}
	return buffers;
}

function selectPropertyStream(reader: HeaderReader, external: Uint8Array[]): HeaderReader {
	const isExternal = reader.readByte();
	if (isExternal === 0) return reader;
	if (isExternal !== 1) throw new ArchiveError("Invalid 7z external-property flag");
	const index = reader.readNumber("external property stream index");
	const bytes = external[index];
	if (!bytes) throw new ArchiveError("Invalid 7z external property stream index");
	return new HeaderReader(bytes);
}

function parseNames(reader: HeaderReader, count: number, external: Uint8Array[], maxPathBytes: number): string[] {
	const values = selectPropertyStream(reader, external);
	const names: string[] = [];
	for (let index = 0; index < count; index++) {
		const start = values.pos;
		while (values.remaining >= 2 && (values.bytes[values.pos] !== 0 || values.bytes[values.pos + 1] !== 0))
			values.pos += 2;
		assertArchivePathBytes(values.pos - start, "encoded member path", maxPathBytes * 2);
		if (values.remaining < 2) throw new ArchiveError("Invalid 7z UTF-16 file-name table");
		let name: string;
		try {
			name = UTF16_LE.decode(values.bytes.subarray(start, values.pos));
		} catch {
			throw new ArchiveError("Invalid 7z UTF-16 file name");
		}
		values.pos += 2;
		assertArchivePathString(name, "member path", maxPathBytes);
		names.push(name);
	}
	return names;
}

function parseTimes(reader: HeaderReader, count: number, external: Uint8Array[]): Array<number | undefined> {
	const defined = readDefinedVector(reader, count);
	const values = selectPropertyStream(reader, external);
	const result = new Array<number | undefined>(count);
	for (let index = 0; index < count; index++)
		if (defined[index]) {
			const ticks = values.readUInt64BigInt();
			const milliseconds = Number(ticks / 10_000n) - FILETIME_EPOCH_MS;
			if (Number.isFinite(milliseconds)) result[index] = milliseconds;
		}
	return result;
}

function parseAttributes(reader: HeaderReader, count: number, external: Uint8Array[]): Array<number | undefined> {
	const defined = readDefinedVector(reader, count);
	const values = selectPropertyStream(reader, external);
	const result = new Array<number | undefined>(count);
	for (let index = 0; index < count; index++) if (defined[index]) result[index] = values.readUInt32();
	return result;
}

function parseFilesInfo(reader: HeaderReader, external: Uint8Array[], options: FormatReadOptions): FileMetadata {
	const count = reader.readNumber("file count");
	assertEntryCount(count, options.limits);
	const metadata: FileMetadata = {
		names: new Array<string>(count).fill(""),
		emptyStreams: new Array<boolean>(count).fill(false),
		emptyFiles: [],
		antiFiles: [],
		mtimes: new Array<number | undefined>(count),
		attributes: new Array<number | undefined>(count),
	};
	for (;;) {
		const id = reader.readNumber("FilesInfo property ID");
		if (id === 0) break;
		const size = reader.readNumber("FilesInfo property size");
		assertIndexSize(size, options.limits, "file property");
		const property = new HeaderReader(reader.readBytes(size));
		if (id === 14) metadata.emptyStreams = readBoolVector(property, count);
		else if (id === 15) metadata.emptyFiles = readBoolVector(property, metadata.emptyStreams.filter(Boolean).length);
		else if (id === 16) metadata.antiFiles = readBoolVector(property, metadata.emptyStreams.filter(Boolean).length);
		else if (id === 17) metadata.names = parseNames(property, count, external, options.limits.maxPathBytes);
		else if (id === 20) metadata.mtimes = parseTimes(property, count, external);
		else if (id === 21) metadata.attributes = parseAttributes(property, count, external);
		else if (id === 25)
			while (property.remaining > 0)
				if (property.readByte() !== 0) throw new ArchiveError("Invalid non-zero 7z dummy property");
				else property.pos = property.bytes.byteLength;
		if (property.remaining !== 0) throw new ArchiveError(`Invalid 7z file property 0x${id.toString(16)} length`);
	}
	return metadata;
}

async function parseHeader(
	source: ByteSource,
	bytes: Uint8Array,
	options: FormatReadOptions,
): Promise<{ streams: SevenZipStreams; files: FileMetadata }> {
	const reader = new HeaderReader(bytes);
	expectId(reader, 1, "Header");
	let additional: Uint8Array[] = [];
	let streams: SevenZipStreams | undefined;
	let files: FileMetadata | undefined;
	for (;;) {
		const id = reader.readNumber("Header property ID");
		if (id === 0) break;
		if (id === 2) {
			for (;;) {
				const propertyId = reader.readNumber("archive property ID");
				if (propertyId === 0) break;
				reader.skipSizedProperty();
			}
		} else if (id === 3)
			additional = await decodeMetadataStreams(source, parseStreamsInfo(reader, source.size, options), options);
		else if (id === 4) streams = parseStreamsInfo(reader, source.size, options);
		else if (id === 5) files = parseFilesInfo(reader, additional, options);
		else throw new ArchiveError(`Unsupported 7z header property ID 0x${id.toString(16)}`);
	}
	if (reader.remaining !== 0) throw new ArchiveError("Invalid 7z trailing header data");
	if (!streams) streams = { packPosition: 0, packSizes: [], packCrcs: [], folders: [], substreams: [] };
	if (!files) files = { names: [], emptyStreams: [], emptyFiles: [], antiFiles: [], mtimes: [], attributes: [] };
	return { streams, files };
}

class SevenZipMemberSource implements MemberSource {
	readonly #folder: SevenZipFolderSource;
	readonly #offset: number;
	readonly #size: number;
	readonly #crc?: number;

	constructor(folder: SevenZipFolderSource, stream: SevenZipSubstream) {
		this.#folder = folder;
		this.#offset = stream.offset;
		this.#size = stream.size;
		this.#crc = stream.crc;
	}

	async read(size: number, memberPath: string): Promise<Uint8Array> {
		if (size !== this.#size)
			throw new ArchiveError(`7z member '${memberPath}' declared size changed during extraction`);
		const folder = await this.#folder.read();
		if (this.#offset < 0 || this.#offset + size > folder.byteLength)
			throw new ArchiveError(`Invalid 7z member '${memberPath}' folder range`);
		const bytes = folder.subarray(this.#offset, this.#offset + size);
		if (this.#crc !== undefined && crc32(bytes) !== this.#crc)
			throw new ArchiveError(`Invalid 7z member '${memberPath}' CRC32 mismatch`);
		return bytes.slice();
	}
}

class EmptyMemberSource implements MemberSource {
	async read(size: number, memberPath: string): Promise<Uint8Array> {
		if (size !== 0) throw new ArchiveError(`Invalid empty 7z member '${memberPath}' size`);
		return new Uint8Array(0);
	}
}

const EMPTY_MEMBER_SOURCE = new EmptyMemberSource();

function canonicalLinkTarget(recordPath: string, rawTarget: string): { targetPath: string; resolveTarget: boolean } {
	const portable = rawTarget.replace(/\\/g, "/");
	if (portable.startsWith("/")) return { targetPath: portable, resolveTarget: false };
	const parts = recordPath.split("/");
	parts.pop();
	for (const part of portable.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return { targetPath: portable, resolveTarget: false };
			parts.pop();
		} else parts.push(part);
	}
	return { targetPath: parts.join("/"), resolveTarget: true };
}

async function buildEntries(
	source: ByteSource,
	streams: SevenZipStreams,
	files: FileMetadata,
	options: FormatReadOptions,
): Promise<ArchiveIndexEntry[]> {
	const folderSources = streams.folders.map(folder => new SevenZipFolderSource(source, folder, options.limits));
	const entries: ArchiveIndexEntry[] = [];
	let emptyIndex = 0;
	let streamIndex = 0;
	for (let fileIndex = 0; fileIndex < files.names.length; fileIndex++) {
		const rawPath = files.names[fileIndex]!;
		const path = normalizeArchiveEntryPath(rawPath);
		const emptyStream = files.emptyStreams[fileIndex] ?? false;
		const emptyFile = emptyStream ? (files.emptyFiles[emptyIndex] ?? false) : false;
		const anti = emptyStream ? (files.antiFiles[emptyIndex] ?? false) : false;
		if (emptyStream) emptyIndex++;
		const stream = emptyStream ? undefined : streams.substreams[streamIndex++];
		if (!emptyStream && !stream) throw new ArchiveError("Invalid 7z file-to-substream mapping");
		if (!path || anti) continue;
		const attribute = files.attributes[fileIndex];
		const mode = attribute !== undefined && attribute >>> 16 !== 0 ? attribute >>> 16 : undefined;
		const isSymlink = mode !== undefined && (mode & 0o170000) === 0o120000;
		const isDirectory =
			(emptyStream && !emptyFile) ||
			(attribute !== undefined && (attribute & 0x10) !== 0) ||
			(mode !== undefined && (mode & 0o170000) === 0o040000);
		const size = stream?.size ?? 0;
		assertArchiveMemberSize(size, path, options.limits);
		const entry: ArchiveIndexEntry = { path, isDirectory, size, mtimeMs: files.mtimes[fileIndex], mode };
		if (isSymlink && stream) {
			assertArchivePathBytes(size, "link target", options.limits.maxPathBytes);
			const member = new SevenZipMemberSource(folderSources[stream.folderIndex]!, stream);
			let target: string;
			try {
				target = UTF8.decode(await member.read(size, path));
			} catch (error) {
				if (error instanceof ArchiveError) throw error;
				throw new ArchiveError(`Invalid UTF-8 symlink target in 7z member '${path}'`);
			}
			assertArchivePathString(target, "link target", options.limits.maxPathBytes);
			const canonical = canonicalLinkTarget(path, target);
			entry.storage = { type: "link", targetPath: canonical.targetPath, resolveTarget: canonical.resolveTarget };
		} else if (!isDirectory) {
			entry.storage = stream
				? { type: "member", source: new SevenZipMemberSource(folderSources[stream.folderIndex]!, stream) }
				: { type: "member", source: EMPTY_MEMBER_SOURCE };
		}
		entries.push(entry);
		assertEntryCount(entries.length, options.limits);
	}
	if (streamIndex !== streams.substreams.length) throw new ArchiveError("Invalid unused 7z substreams");
	return entries;
}

/** Whether bytes begin with the canonical 7z signature. */
export function sniffSevenZip(bytes: Uint8Array): boolean {
	if (bytes.byteLength < SIGNATURE.byteLength) return false;
	for (let index = 0; index < SIGNATURE.byteLength; index++) if (bytes[index] !== SIGNATURE[index]) return false;
	return true;
}

/** Index a 7z archive and lazily decode member folders on extraction. */
export const readSevenZip: FormatReader = async (source, options) => {
	try {
		if (source.size < 32) throw new ArchiveError("Invalid 7z archive: truncated signature header");
		const signatureHeader = await source.read(0, 32);
		if (!sniffSevenZip(signatureHeader)) throw new ArchiveError("Invalid 7z archive signature");
		if (signatureHeader[6] !== 0) throw new ArchiveError(`Unsupported 7z major version ${signatureHeader[6]}`);
		if (crc32(signatureHeader.subarray(12, 32)) !== new HeaderReader(signatureHeader.subarray(8, 12)).readUInt32())
			throw new ArchiveError("Invalid 7z start-header CRC32 mismatch");
		const start = new HeaderReader(signatureHeader.subarray(12));
		const nextOffset = start.readUInt64BigInt();
		const nextSize = start.readUInt64BigInt();
		const nextCrc = start.readUInt32();
		if (nextOffset > BigInt(Number.MAX_SAFE_INTEGER) || nextSize > BigInt(Number.MAX_SAFE_INTEGER))
			throw new ArchiveError("7z header offsets or sizes are too large to read safely");
		const headerStart = 32 + Number(nextOffset);
		const headerSize = Number(nextSize);
		assertIndexSize(headerSize, options.limits, "next header");
		if (!Number.isSafeInteger(headerStart) || headerStart < 32 || headerStart + headerSize > source.size)
			throw new ArchiveError("Invalid 7z next-header range");
		let header = await source.read(headerStart, headerStart + headerSize);
		if (crc32(header) !== nextCrc) throw new ArchiveError("Invalid 7z next-header CRC32 mismatch");
		const first = new HeaderReader(header).readNumber("next-header ID");
		if (first === 23) {
			const encodedReader = new HeaderReader(header);
			encodedReader.readNumber();
			const encodedStreams = parseStreamsInfo(encodedReader, source.size, options);
			if (encodedReader.remaining !== 0) throw new ArchiveError("Invalid 7z encoded-header trailing data");
			const decoded = await decodeMetadataStreams(source, encodedStreams, options);
			if (decoded.length !== 1) throw new ArchiveError("Invalid 7z encoded header folder count");
			header = decoded[0]!;
			if (new HeaderReader(header).readNumber("decoded-header ID") !== 1)
				throw new ArchiveError("Invalid decoded 7z header marker");
		} else if (first !== 1) throw new ArchiveError(`Unsupported 7z next-header ID 0x${first.toString(16)}`);
		const parsed = await parseHeader(source, header, options);
		return await buildEntries(source, parsed.streams, parsed.files, options);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(`Invalid 7z archive: ${error instanceof Error ? error.message : String(error)}`);
	}
};
