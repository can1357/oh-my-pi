import { readUInt16LE, readUInt32LE } from "./bytes";
import { crc32 } from "./checksums";
import { ArchiveError } from "./error";
import { assertArchiveMemberSize, assertEntryCount, assertIndexSize, assertInMemorySize } from "./limits";
import { assertArchivePathBytes, normalizeArchiveEntryPath } from "./paths";
import { Rar4Decoder } from "./rar/rar4-decoder";
import { Rar5Decoder } from "./rar/rar5-decoder";
import type { ByteSource } from "./source";
import type { ArchiveIndexEntry, FormatReader, FormatReadOptions, MemberSource } from "./types";

const RAR4_MARKER = Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00);
const RAR5_MARKER = Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00);
const UTF8 = new TextDecoder("utf-8", { fatal: true });
// WHATWG maps the "latin1" label to windows-1252; bun-types only names the latter.
const LATIN1 = new TextDecoder("windows-1252");

interface RarRecord {
	format: 4 | 5;
	path: string;
	dataStart: number;
	packedSize: number;
	unpackedSize: number;
	method: number;
	version: number;
	dictionarySize: number;
	solid: boolean;
	crc?: number;
	isDirectory: boolean;
	mtimeMs?: number;
	mode?: number;
	linkTarget?: string;
	linkResolveTarget?: boolean;
}

class RarMemberSource implements MemberSource {
	readonly #archive: RarArchive;
	readonly #index: number;

	constructor(archive: RarArchive, index: number) {
		this.#archive = archive;
		this.#index = index;
	}

	async read(size: number, memberPath: string): Promise<Uint8Array> {
		return this.#archive.read(this.#index, size, memberPath);
	}
}

class RarArchive {
	readonly #source: ByteSource;
	readonly #records: RarRecord[];
	readonly #limits: FormatReadOptions["limits"];
	readonly #cache = new Map<number, Uint8Array>();
	#queue: Promise<void> = Promise.resolve();

	constructor(source: ByteSource, records: RarRecord[], options: FormatReadOptions) {
		this.#source = source;
		this.#records = records;
		this.#limits = options.limits;
	}

	member(index: number): MemberSource {
		return new RarMemberSource(this, index);
	}

	async read(index: number, size: number, memberPath: string): Promise<Uint8Array> {
		const pending = this.#queue.then(async () => {
			if (!this.#cache.has(index)) await this.#decode(index);
		});
		this.#queue = pending.catch(() => undefined);
		await pending;
		const bytes = this.#cache.get(index);
		if (!bytes) throw new ArchiveError(`Failed to extract RAR member '${memberPath}'`);
		if (bytes.byteLength !== size) {
			throw new ArchiveError(`RAR member '${memberPath}' size mismatch (${bytes.byteLength} != ${size})`);
		}
		return bytes.slice();
	}

	async #decode(index: number): Promise<void> {
		const target = this.#records[index];
		if (!target) throw new ArchiveError("Invalid RAR member index");
		let start = index;
		if (target.solid) {
			while (start > 0 && this.#records[start]!.solid && this.#records[start - 1]!.format === target.format) start--;
		}
		const rar4Decoder = new Rar4Decoder();
		const rar5Decoder = new Rar5Decoder();
		for (let current = start; current <= index; current++) {
			const record = this.#records[current]!;
			if (record.isDirectory) continue;
			assertArchiveMemberSize(record.unpackedSize, record.path, this.#limits);
			if (record.method === 0 && record.packedSize !== record.unpackedSize) {
				corrupt("stored member size mismatch");
			}
			if (record.method > 5) {
				throw new ArchiveError(
					record.format === 4
						? `Unsupported RAR4 compression method 0x${(record.method + 0x30).toString(16)} for '${record.path}'`
						: `Unsupported RAR5 compression method ${record.method} for '${record.path}'`,
				);
			}
			if (record.method !== 0) {
				assertInMemorySize(
					record.packedSize + 2 * record.unpackedSize + 2 * record.dictionarySize + 8192,
					this.#limits,
				);
			}
			const end = checkedEnd(record.dataStart, record.packedSize, this.#source.size, "member data");
			const packed = await this.#source.read(record.dataStart, end);
			let output: Uint8Array;
			if (record.method === 0) {
				output = packed;
				if (record.solid) {
					if (record.format === 4) rar4Decoder.reset();
					else rar5Decoder.reset();
				}
			} else if (record.format === 5) {
				output = rar5Decoder.decode(
					packed,
					record.unpackedSize,
					record.dictionarySize,
					record.solid,
					record.version,
				);
			} else {
				output = rar4Decoder.decode(
					packed,
					record.unpackedSize,
					record.dictionarySize,
					record.solid,
					record.version,
				);
			}
			if (output.byteLength !== record.unpackedSize) corrupt(`member '${record.path}' size mismatch`);
			if (record.crc !== undefined && crc32(output) !== record.crc) {
				throw new ArchiveError(`RAR member '${record.path}' CRC32 mismatch`);
			}
			this.#cache.set(current, output.slice());
		}
	}
}

/** Probe the RAR 1.5-4.x or RAR5 signature. */
export function sniffRar(bytes: Uint8Array): boolean {
	return findMarker(bytes) !== undefined;
}

/** Index a RAR4 or RAR5 archive and defer member decompression until extraction. */
export const readRar: FormatReader = async (source, options) => {
	if (!Number.isSafeInteger(source.size) || source.size < 0) {
		throw new ArchiveError("Archive is too large to read safely");
	}
	const indexed = await indexRarMetadata(source, options);
	const bytes = sparseBytes(source.size, indexed.segments);
	const marker = indexed.marker;
	const records =
		marker.version === 5 ? parseRar5(bytes, marker.offset, options) : parseRar4(bytes, marker.offset, options);
	const archive = new RarArchive(source, records, options);
	const entries: ArchiveIndexEntry[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index]!;
		const entry: ArchiveIndexEntry = {
			path: record.path,
			isDirectory: record.isDirectory,
			size: record.unpackedSize,
		};
		if (record.mtimeMs !== undefined) entry.mtimeMs = record.mtimeMs;
		if (record.mode !== undefined) entry.mode = record.mode;
		if (record.linkTarget !== undefined) {
			entry.storage = {
				type: "link",
				targetPath: record.linkTarget,
				resolveTarget: record.linkResolveTarget ?? false,
			};
		} else if (!record.isDirectory) {
			entry.storage = { type: "member", source: archive.member(index) };
		}
		entries.push(entry);
	}
	return entries;
};

interface SparseSegment {
	start: number;
	bytes: Uint8Array;
}

async function indexRarMetadata(
	source: ByteSource,
	options: FormatReadOptions,
): Promise<{ marker: { version: 4 | 5; offset: number }; segments: SparseSegment[] }> {
	let probeEnd = Math.min(source.size, RAR5_MARKER.byteLength);
	let probe = await source.read(0, probeEnd);
	let marker = findMarker(probe);
	while (!marker && probeEnd < Math.min(source.size, 1024 * 1024 + RAR5_MARKER.byteLength)) {
		const nextEnd = Math.min(source.size, 1024 * 1024 + RAR5_MARKER.byteLength, Math.max(64 * 1024, probeEnd * 2));
		assertIndexSize(nextEnd, options.limits, "RAR signature scan");
		const next = await source.read(probeEnd, nextEnd);
		const combined = new Uint8Array(nextEnd);
		combined.set(probe);
		combined.set(next, probeEnd);
		probe = combined;
		probeEnd = nextEnd;
		marker = findMarker(probe);
	}
	if (!marker) throw new ArchiveError("Invalid RAR archive: signature not found");
	const segments: SparseSegment[] = [{ start: 0, bytes: probe }];
	let metadataSize = probe.byteLength;
	assertIndexSize(metadataSize, options.limits, "RAR metadata");
	let offset = marker.offset + (marker.version === 5 ? RAR5_MARKER.byteLength : RAR4_MARKER.byteLength);
	while (offset < source.size) {
		if (marker.version === 5) {
			if (offset + 5 > source.size) corrupt("truncated RAR5 header");
			const prefix = await source.read(offset, Math.min(source.size, offset + 16));
			const sizeCursor = { offset: 4 };
			const headerSize = readVint(prefix, sizeCursor, prefix.byteLength, "header size");
			if (headerSize > 2 * 1024 * 1024) corrupt("RAR5 header exceeds format limit");
			const headerEnd = checkedEnd(offset, sizeCursor.offset + headerSize, source.size, "RAR5 header");
			assertIndexSize(metadataSize + headerEnd - offset, options.limits, "RAR metadata");
			const header = await source.read(offset, headerEnd);
			segments.push({ start: offset, bytes: header });
			metadataSize += header.byteLength;
			assertIndexSize(metadataSize, options.limits, "RAR metadata");
			const cursor = { offset: sizeCursor.offset };
			const type = readVint(header, cursor, header.byteLength, "header type");
			const flags = readVint(header, cursor, header.byteLength, "header flags");
			if ((flags & 1) !== 0) readVint(header, cursor, header.byteLength, "extra area size");
			const dataSize = (flags & 2) !== 0 ? readVint(header, cursor, header.byteLength, "data size") : 0;
			offset = checkedEnd(headerEnd, dataSize, source.size, "RAR5 data area");
			if (type === 4 || type === 5) break;
		} else {
			if (offset + 7 > source.size) corrupt("truncated RAR4 base header");
			const prefix = await source.read(offset, Math.min(source.size, offset + 11));
			const type = prefix[2]!;
			const flags = readUInt16LE(prefix, 3);
			const headerSize = readUInt16LE(prefix, 5);
			if (headerSize < 7) corrupt("invalid RAR4 header size");
			const headerEnd = checkedEnd(offset, headerSize, source.size, "RAR4 header");
			assertIndexSize(metadataSize + headerEnd - offset, options.limits, "RAR metadata");
			const header = await source.read(offset, headerEnd);
			segments.push({ start: offset, bytes: header });
			metadataSize += header.byteLength;
			assertIndexSize(metadataSize, options.limits, "RAR metadata");
			const dataSize = (flags & 0x8000) !== 0 ? readUInt32LE(header, 7) : 0;
			const dataEnd = checkedEnd(headerEnd, dataSize, source.size, "RAR4 data area");
			if (type === 0x74 && dataSize <= options.limits.maxPathBytes) {
				const fileFields = (flags & 0x8000) !== 0 ? 11 : 7;
				if (fileFields + 21 <= header.byteLength) {
					const hostOs = header[fileFields + 4]!;
					const attributes = readUInt32LE(header, fileFields + 17);
					if (hostOs === 3 && (attributes & 0xf000) === 0xa000) {
						assertIndexSize(metadataSize + dataSize, options.limits, "RAR metadata");
						segments.push({ start: headerEnd, bytes: await source.read(headerEnd, dataEnd) });
						metadataSize += dataSize;
						assertIndexSize(metadataSize, options.limits, "RAR metadata");
					}
				}
			}
			offset = dataEnd;
			if (type === 0x7b || (type === 0x73 && (flags & 0x80) !== 0)) break;
		}
	}
	segments.sort((left, right) => left.start - right.start || right.bytes.byteLength - left.bytes.byteLength);
	return { marker, segments };
}

function sparseBytes(size: number, segments: SparseSegment[]): Uint8Array {
	const findSegment = (start: number, end: number): SparseSegment => {
		let low = 0;
		let high = segments.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (segments[middle]!.start <= start) low = middle + 1;
			else high = middle;
		}
		for (let index = low - 1; index >= 0; index--) {
			const segment = segments[index]!;
			if (start >= segment.start && end <= segment.start + segment.bytes.byteLength) return segment;
		}
		corrupt("RAR parser accessed member payload while indexing");
	};
	const target = Object.create(null) as Record<PropertyKey, unknown>;
	const proxy = new Proxy(target, {
		get(_object, property) {
			if (property === "byteLength" || property === "length") return size;
			if (property === "subarray") {
				return (start: number, end = size): Uint8Array => {
					const segment = findSegment(start, end);
					return segment.bytes.subarray(start - segment.start, end - segment.start);
				};
			}
			if (typeof property === "string") {
				const offset = Number(property);
				if (Number.isSafeInteger(offset) && offset >= 0) {
					const segment = findSegment(offset, offset + 1);
					return segment.bytes[offset - segment.start];
				}
			}
			return undefined;
		},
	});
	return proxy as unknown as Uint8Array;
}

function parseRar5(bytes: Uint8Array, marker: number, options: FormatReadOptions): RarRecord[] {
	const records: RarRecord[] = [];
	let offset = marker + RAR5_MARKER.byteLength;
	let sawMain = false;
	while (offset < bytes.byteLength) {
		if (offset + 5 > bytes.byteLength) corrupt("truncated RAR5 header");
		const expectedHeaderCrc = readUInt32LE(bytes, offset);
		const sizeAt = offset + 4;
		const sizeCursor = { offset: sizeAt };
		const headerSize = readVint(bytes, sizeCursor, bytes.byteLength, "header size");
		if (headerSize > 2 * 1024 * 1024) corrupt("RAR5 header exceeds format limit");
		assertIndexSize(headerSize, options.limits, "RAR5 header");
		const headerStart = sizeCursor.offset;
		const headerEnd = checkedEnd(headerStart, headerSize, bytes.byteLength, "RAR5 header");
		if (crc32(bytes.subarray(sizeAt, headerEnd)) !== expectedHeaderCrc) corrupt("RAR5 header CRC32 mismatch");
		const cursor = { offset: headerStart };
		const type = readVint(bytes, cursor, headerEnd, "header type");
		const flags = readVint(bytes, cursor, headerEnd, "header flags");
		const extraSize = (flags & 1) !== 0 ? readVint(bytes, cursor, headerEnd, "extra area size") : 0;
		const dataSize = (flags & 2) !== 0 ? readVint(bytes, cursor, headerEnd, "data size") : 0;
		if ((flags & 0x18) !== 0) throw new ArchiveError("Unsupported multi-volume RAR5 archive");
		const dataStart = headerEnd;
		const dataEnd = checkedEnd(dataStart, dataSize, bytes.byteLength, "RAR5 data area");
		if (extraSize > headerEnd - cursor.offset) corrupt("invalid RAR5 extra area size");
		const extraStart = headerEnd - extraSize;

		if (type === 4) throw new ArchiveError("Encrypted RAR5 headers are not supported");
		if (type === 1) {
			const archiveFlags = readVint(bytes, cursor, extraStart, "archive flags");
			if ((archiveFlags & 1) !== 0) throw new ArchiveError("Unsupported multi-volume RAR5 archive");
			if ((archiveFlags & 8) !== 0) throw new ArchiveError("Unsupported RAR5 recovery record");
			if ((archiveFlags & 2) !== 0) readVint(bytes, cursor, extraStart, "volume number");
			sawMain = true;
		} else if (type === 2 || type === 3) {
			const fileFlags = readVint(bytes, cursor, extraStart, "file flags");
			const unpackedSize = readVint(bytes, cursor, extraStart, "unpacked size");
			if ((fileFlags & 8) !== 0) throw new ArchiveError("RAR5 member with unknown unpacked size is not supported");
			const attributes = readVint(bytes, cursor, extraStart, "file attributes");
			let mtimeMs: number | undefined;
			if ((fileFlags & 2) !== 0) {
				need(cursor.offset, 4, extraStart, "RAR5 modification time");
				mtimeMs = readUInt32LE(bytes, cursor.offset) * 1000;
				cursor.offset += 4;
			}
			let dataCrc: number | undefined;
			if ((fileFlags & 4) !== 0) {
				need(cursor.offset, 4, extraStart, "RAR5 data CRC32");
				dataCrc = readUInt32LE(bytes, cursor.offset);
				cursor.offset += 4;
			}
			const compression = readVint(bytes, cursor, extraStart, "compression information");
			let version = compression & 0x3f;
			if (version === 1 && (compression & 0x100000) !== 0) version = 0;
			const solid = (compression & 0x40) !== 0;
			const method = (compression >>> 7) & 7;
			const dictionaryPower = (compression >>> 10) & 0x1f;
			let dictionarySize = 128 * 1024 * 2 ** dictionaryPower;
			if ((compression & 0x3f) === 1) dictionarySize += (dictionarySize * ((compression >>> 15) & 0x1f)) / 32;
			if (!Number.isSafeInteger(dictionarySize) || dictionarySize > options.limits.maxInMemorySize) {
				throw new ArchiveError(`RAR5 dictionary is too large (${dictionarySize} bytes)`);
			}
			const hostOs = readVint(bytes, cursor, extraStart, "host OS");
			const nameSize = readVint(bytes, cursor, extraStart, "file name size");
			assertArchivePathBytes(nameSize, "member path", options.limits.maxPathBytes);
			need(cursor.offset, nameSize, extraStart, "RAR5 file name");
			let rawPath: string;
			try {
				rawPath = UTF8.decode(bytes.subarray(cursor.offset, cursor.offset + nameSize));
			} catch {
				throw new ArchiveError("Invalid RAR5 UTF-8 member name");
			}
			cursor.offset += nameSize;
			let linkTarget: string | undefined;
			for (const extra of readExtraRecords(bytes, extraStart, headerEnd)) {
				const extraCursor = { offset: extra.start };
				if (extra.type === 1) throw new ArchiveError(`Encrypted RAR5 member '${rawPath}' is not supported`);
				if (extra.type === 3) {
					const timeFlags = readVint(bytes, extraCursor, extra.end, "time flags");
					if ((timeFlags & 2) !== 0) {
						if ((timeFlags & 1) !== 0) {
							need(extraCursor.offset, 4, extra.end, "Unix modification time");
							mtimeMs = readUInt32LE(bytes, extraCursor.offset) * 1000;
						} else {
							need(extraCursor.offset, 8, extra.end, "Windows modification time");
							mtimeMs = filetimeMs(bytes, extraCursor.offset);
						}
					}
				} else if (extra.type === 5) {
					const redirectionType = readVint(bytes, extraCursor, extra.end, "redirection type");
					readVint(bytes, extraCursor, extra.end, "redirection flags");
					const targetSize = readVint(bytes, extraCursor, extra.end, "link target size");
					assertArchivePathBytes(targetSize, "link target", options.limits.maxPathBytes);
					need(extraCursor.offset, targetSize, extra.end, "link target");
					if (redirectionType < 1 || redirectionType > 5)
						throw new ArchiveError(`Unsupported RAR5 redirection type ${redirectionType}`);
					try {
						linkTarget = UTF8.decode(bytes.subarray(extraCursor.offset, extraCursor.offset + targetSize));
					} catch {
						throw new ArchiveError("Invalid RAR5 UTF-8 link target");
					}
				}
			}
			if (type === 2) {
				assertArchiveMemberSize(unpackedSize, rawPath, options.limits);
				const path = normalizeArchiveEntryPath(rawPath);
				if (path) {
					let linkResolveTarget: boolean | undefined;
					if (linkTarget !== undefined) {
						const canonical = canonicalLinkTarget(path, linkTarget);
						linkTarget = canonical.target;
						linkResolveTarget = canonical.resolveTarget;
					}
					const isDirectory = (fileFlags & 1) !== 0;
					records.push({
						format: 5,
						path,
						dataStart,
						packedSize: dataSize,
						unpackedSize,
						method,
						version,
						dictionarySize,
						solid,
						crc: dataCrc,
						isDirectory,
						mtimeMs,
						mode: hostOs === 1 ? attributes : undefined,
						linkTarget,
						linkResolveTarget,
					});
					assertEntryCount(records.length, options.limits);
				}
			} else if (rawPath === "RR") {
				throw new ArchiveError("Unsupported RAR5 recovery record");
			}
		} else if (type === 5) {
			const endFlags = readVint(bytes, cursor, extraStart, "end flags");
			if ((endFlags & 1) !== 0) throw new ArchiveError("Unsupported multi-volume RAR5 archive");
			break;
		} else if ((flags & 4) === 0) {
			throw new ArchiveError(`Unsupported RAR5 header type ${type}`);
		}
		offset = dataEnd;
	}
	if (!sawMain) corrupt("RAR5 main header is missing");
	return records;
}

function parseRar4(bytes: Uint8Array, marker: number, options: FormatReadOptions): RarRecord[] {
	const records: RarRecord[] = [];
	let offset = marker + RAR4_MARKER.byteLength;
	let sawMain = false;
	while (offset < bytes.byteLength) {
		need(offset, 7, bytes.byteLength, "RAR4 base header");
		const headerCrc = readUInt16LE(bytes, offset);
		const type = bytes[offset + 2]!;
		const flags = readUInt16LE(bytes, offset + 3);
		const headerSize = readUInt16LE(bytes, offset + 5);
		if (headerSize < 7) corrupt("invalid RAR4 header size");
		assertIndexSize(headerSize, options.limits, "RAR4 header");
		const headerEnd = checkedEnd(offset, headerSize, bytes.byteLength, "RAR4 header");
		if ((crc32(bytes.subarray(offset + 2, headerEnd)) & 0xffff) !== headerCrc) corrupt("RAR4 header CRC mismatch");
		let dataSize = 0;
		let cursor = offset + 7;
		if ((flags & 0x8000) !== 0) {
			need(cursor, 4, headerEnd, "RAR4 additional size");
			dataSize = readUInt32LE(bytes, cursor);
			cursor += 4;
		}
		const dataStart = headerEnd;
		let dataEnd = checkedEnd(dataStart, dataSize, bytes.byteLength, "RAR4 data area");
		if (type === 0x73) {
			if ((flags & 1) !== 0) throw new ArchiveError("Unsupported multi-volume RAR4 archive");
			if ((flags & 0x40) !== 0) throw new ArchiveError("Unsupported RAR4 recovery record");
			if ((flags & 0x80) !== 0) throw new ArchiveError("Encrypted RAR4 headers are not supported");
			sawMain = true;
		} else if (type === 0x74) {
			need(cursor, 21, headerEnd, "RAR4 file header");
			const unpackedLow = readUInt32LE(bytes, cursor);
			cursor += 4;
			const hostOs = bytes[cursor++]!;
			const dataCrc = readUInt32LE(bytes, cursor);
			cursor += 4;
			const dosTime = readUInt32LE(bytes, cursor);
			cursor += 4;
			const version = bytes[cursor++]!;
			const methodByte = bytes[cursor++]!;
			const nameSize = readUInt16LE(bytes, cursor);
			cursor += 2;
			const attributes = readUInt32LE(bytes, cursor);
			cursor += 4;
			let packedSize = dataSize;
			let unpackedSize = unpackedLow;
			if ((flags & 0x100) !== 0) {
				need(cursor, 8, headerEnd, "RAR4 high sizes");
				packedSize += readUInt32LE(bytes, cursor) * 0x100000000;
				cursor += 4;
				unpackedSize += readUInt32LE(bytes, cursor) * 0x100000000;
				cursor += 4;
				dataEnd = checkedEnd(dataStart, packedSize, bytes.byteLength, "RAR4 file data");
			}
			if ((flags & 3) !== 0) throw new ArchiveError("Unsupported multi-volume RAR4 member");
			if ((flags & 4) !== 0) throw new ArchiveError("Encrypted RAR4 file data is not supported");
			if (methodByte < 0x30 || methodByte > 0x35)
				throw new ArchiveError(`Unsupported RAR4 compression method 0x${methodByte.toString(16)}`);
			assertArchivePathBytes(nameSize, "member path", options.limits.maxPathBytes);
			need(cursor, nameSize, headerEnd, "RAR4 file name");
			const nameBytes = bytes.subarray(cursor, cursor + nameSize);
			const rawPath = (flags & 0x200) !== 0 ? decodeRar4UnicodeName(nameBytes) : LATIN1.decode(nameBytes);
			cursor += nameSize;
			if ((flags & 0x400) !== 0) {
				need(cursor, 8, headerEnd, "RAR4 salt");
				cursor += 8;
			}
			let mtimeMs = dosTimeMs(dosTime);
			if ((flags & 0x1000) !== 0) {
				need(cursor, 2, headerEnd, "RAR4 extended time flags");
				const timeFlags = readUInt16LE(bytes, cursor);
				cursor += 2;
				for (let timeIndex = 0; timeIndex < 4; timeIndex++) {
					const mode = (timeFlags >>> ((3 - timeIndex) * 4)) & 15;
					if ((mode & 8) === 0) continue;
					let timeValue = dosTime;
					if (timeIndex !== 0) {
						need(cursor, 4, headerEnd, "RAR4 extended time");
						timeValue = readUInt32LE(bytes, cursor);
						cursor += 4;
					}
					let preciseMs = dosTimeMs(timeValue) + ((mode & 4) !== 0 ? 1000 : 0);
					let remainder = 0;
					const count = mode & 3;
					need(cursor, count, headerEnd, "RAR4 extended time precision");
					for (let index = 0; index < count; index++) {
						remainder |= bytes[cursor++]! << ((index + 3 - count) * 8);
					}
					preciseMs += remainder / 10000;
					if (timeIndex === 0) mtimeMs = preciseMs;
				}
			}
			assertArchiveMemberSize(unpackedSize, rawPath, options.limits);
			const path = normalizeArchiveEntryPath(rawPath);
			if (path) {
				const directory = ((flags >>> 5) & 7) === 7;
				const mode = hostOs === 3 ? attributes : undefined;
				let linkTarget: string | undefined;
				let linkResolveTarget: boolean | undefined;
				if (mode !== undefined && (mode & 0xf000) === 0xa000) {
					if (methodByte !== 0x30 || packedSize !== unpackedSize)
						throw new ArchiveError(`Unsupported compressed RAR4 symlink '${path}'`);
					assertArchivePathBytes(packedSize, "link target", options.limits.maxPathBytes);
					const canonical = canonicalLinkTarget(path, LATIN1.decode(bytes.subarray(dataStart, dataEnd)));
					linkTarget = canonical.target;
					linkResolveTarget = canonical.resolveTarget;
				}
				records.push({
					format: 4,
					path,
					dataStart,
					packedSize,
					unpackedSize,
					method: methodByte - 0x30,
					version,
					dictionarySize: rar4Dictionary(flags),
					solid: (flags & 0x10) !== 0,
					crc: dataCrc,
					isDirectory: directory,
					mtimeMs,
					mode,
					linkTarget,
					linkResolveTarget,
				});
				assertEntryCount(records.length, options.limits);
			}
		} else if (type === 0x78) {
			throw new ArchiveError("Unsupported RAR4 recovery record");
		} else if (type === 0x7b) {
			if ((flags & 1) !== 0) throw new ArchiveError("Unsupported multi-volume RAR4 archive");
			break;
		}
		offset = dataEnd;
	}
	if (!sawMain) corrupt("RAR4 main header is missing");
	return records;
}

function readExtraRecords(
	bytes: Uint8Array,
	start: number,
	end: number,
): Array<{ type: number; start: number; end: number }> {
	const records: Array<{ type: number; start: number; end: number }> = [];
	const cursor = { offset: start };
	while (cursor.offset < end) {
		const recordSize = readVint(bytes, cursor, end, "extra record size");
		const recordStart = cursor.offset;
		const recordEnd = checkedEnd(recordStart, recordSize, end, "extra record");
		const type = readVint(bytes, cursor, recordEnd, "extra record type");
		records.push({ type, start: cursor.offset, end: recordEnd });
		cursor.offset = recordEnd;
	}
	return records;
}

function readVint(bytes: Uint8Array, cursor: { offset: number }, end: number, what: string): number {
	let value = 0;
	let factor = 1;
	for (let count = 0; count < 10; count++) {
		if (cursor.offset >= end) corrupt(`truncated ${what}`);
		const byte = bytes[cursor.offset++]!;
		value += (byte & 0x7f) * factor;
		if (!Number.isSafeInteger(value)) corrupt(`${what} is too large`);
		if ((byte & 0x80) === 0) return value;
		factor *= 128;
	}
	corrupt(`${what} vint is too long`);
}

function findMarker(bytes: Uint8Array): { version: 4 | 5; offset: number } | undefined {
	const limit = Math.min(bytes.byteLength, 1024 * 1024 + RAR5_MARKER.byteLength);
	for (let offset = 0; offset < limit; offset++) {
		if (matches(bytes, offset, RAR5_MARKER)) return { version: 5, offset };
		if (matches(bytes, offset, RAR4_MARKER)) return { version: 4, offset };
	}
	return undefined;
}

function matches(bytes: Uint8Array, offset: number, marker: Uint8Array): boolean {
	if (offset + marker.byteLength > bytes.byteLength) return false;
	for (let index = 0; index < marker.byteLength; index++) if (bytes[offset + index] !== marker[index]) return false;
	return true;
}

function decodeRar4UnicodeName(bytes: Uint8Array): string {
	let separator = bytes.indexOf(0);
	if (separator < 0) return LATIN1.decode(bytes);
	if (++separator >= bytes.byteLength) return LATIN1.decode(bytes.subarray(0, separator - 1));
	const highByte = bytes[separator++]!;
	let decodedPosition = 0;
	let flags = 0;
	let flagBits = 0;
	let output = "";
	while (separator < bytes.byteLength) {
		if (flagBits === 0) {
			flags = bytes[separator++]!;
			flagBits = 8;
			if (separator >= bytes.byteLength) break;
		}
		const operation = flags >>> 6;
		if (operation === 0) {
			output += String.fromCharCode(bytes[separator++]!);
			decodedPosition++;
		} else if (operation === 1) {
			output += String.fromCharCode(bytes[separator++]! + (highByte << 8));
			decodedPosition++;
		} else if (operation === 2) {
			if (separator + 1 >= bytes.byteLength) corrupt("truncated RAR4 Unicode name");
			output += String.fromCharCode(bytes[separator]! | (bytes[separator + 1]! << 8));
			separator += 2;
			decodedPosition++;
		} else {
			let count = bytes[separator++]!;
			if ((count & 0x80) !== 0) {
				if (separator >= bytes.byteLength) corrupt("truncated RAR4 Unicode name correction");
				const correction = bytes[separator++]!;
				count = (count & 0x7f) + 2;
				for (; count > 0 && decodedPosition < bytes.byteLength; count--, decodedPosition++) {
					output += String.fromCharCode((highByte << 8) | ((bytes[decodedPosition]! + correction) & 0xff));
				}
			} else {
				count += 2;
				for (; count > 0 && decodedPosition < bytes.byteLength; count--, decodedPosition++)
					output += String.fromCharCode(bytes[decodedPosition]!);
			}
		}
		flags = (flags << 2) & 0xff;
		flagBits -= 2;
	}
	return output;
}
function canonicalLinkTarget(recordPath: string, rawTarget: string): { target: string; resolveTarget: boolean } {
	const portable = rawTarget.replace(/\\/g, "/");
	if (portable.startsWith("/")) return { target: portable, resolveTarget: false };
	const parts = recordPath.split("/");
	parts.pop();
	for (const part of portable.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return { target: portable, resolveTarget: false };
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return { target: parts.join("/"), resolveTarget: true };
}

function rar4Dictionary(flags: number): number {
	const index = (flags >>> 5) & 7;
	return index === 7 ? 4 * 1024 * 1024 : 64 * 1024 * 2 ** index;
}

function dosTimeMs(value: number): number {
	const second = (value & 0x1f) * 2;
	const minute = (value >>> 5) & 0x3f;
	const hour = (value >>> 11) & 0x1f;
	const day = (value >>> 16) & 0x1f;
	const month = (value >>> 21) & 0xf;
	const year = ((value >>> 25) & 0x7f) + 1980;
	return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function filetimeMs(bytes: Uint8Array, offset: number): number {
	const ticks = readUInt32LE(bytes, offset) + readUInt32LE(bytes, offset + 4) * 0x100000000;
	return ticks / 10000 - 11644473600000;
}

function checkedEnd(start: number, size: number, limit: number, what: string): number {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || size < 0) corrupt(`invalid ${what} range`);
	const end = start + size;
	if (!Number.isSafeInteger(end) || end < start || end > limit) corrupt(`truncated ${what}`);
	return end;
}

function need(start: number, size: number, end: number, what: string): void {
	checkedEnd(start, size, end, what);
}

function corrupt(reason: string): never {
	throw new ArchiveError(`Invalid RAR archive: ${reason}`);
}
