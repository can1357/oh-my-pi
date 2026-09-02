import * as path from "node:path";
import { bytesMatchAscii, readUInt16BE, readUInt16LE, readUInt32BE, readUInt32LE } from "./bytes";
import { upsertArchiveEntry } from "./entries";
import { ArchiveError } from "./error";
import { type ArchiveLimits, assertArchiveMemberSize, assertEntryCount, assertIndexSize } from "./limits";
import { assertArchivePathBytes, normalizeArchiveEntryPath, normalizeArchiveLookupPath } from "./paths";
import type { ByteSource } from "./source";
import type { ArchiveIndexEntry, FormatReader, MemberSource } from "./types";

const ISO_SECTOR_SIZE = 2048;
const VOLUME_DESCRIPTOR_START = 16 * ISO_SECTOR_SIZE;
const MAX_DIRECTORY_DEPTH = 256;
const MAX_SUSP_CONTINUATIONS = 32;
const UTF8_DECODER = new TextDecoder();

interface IsoVolume {
	blockSize: number;
	root: IsoRecord;
	joliet: boolean;
	rockRidgeRoot?: IsoRecord;
}

interface IsoRecord {
	extent: number;
	size: number;
	extendedAttributeBlocks: number;
	mtimeMs?: number;
	flags: number;
	fileUnitSize: number;
	interleaveGapSize: number;
	identifier: Uint8Array;
	systemUse: Uint8Array;
}

interface IsoExtent {
	start: number;
	size: number;
	fileUnitSize: number;
	interleaveGapSize: number;
}

interface DirectoryWork {
	record: IsoRecord;
	parentPath: string;
	depth: number;
	ancestor: DirectoryAncestor;
}

interface DirectoryAncestor {
	key: string;
	parent?: DirectoryAncestor;
}

interface SuspData {
	name?: string;
	mode?: number;
	symlink?: string;
	relocation?: "RE" | "CL" | "PL";
}

class MetadataBudget {
	#readBytes = 0;
	readonly #limits: ArchiveLimits;

	constructor(limits: ArchiveLimits) {
		this.#limits = limits;
	}

	async read(source: ByteSource, start: number, end: number, what: string): Promise<Uint8Array> {
		assertSourceRange(source, start, end, what);
		this.#readBytes += end - start;
		assertIndexSize(this.#readBytes, this.#limits, "ISO metadata");
		const bytes = await source.read(start, end);
		if (bytes.byteLength !== end - start) throw invalidIso(`truncated ${what}`);
		return bytes;
	}
}

class IsoMemberSource implements MemberSource {
	readonly #source: ByteSource;
	readonly #blockSize: number;
	readonly #extents: readonly IsoExtent[];

	constructor(source: ByteSource, blockSize: number, extents: readonly IsoExtent[]) {
		this.#source = source;
		this.#blockSize = blockSize;
		this.#extents = extents;
	}

	async read(size: number, memberPath: string): Promise<Uint8Array> {
		try {
			const output = new Uint8Array(size);
			let outputOffset = 0;
			for (const extent of this.#extents) {
				if (outputOffset + extent.size > size) throw invalidIso(`invalid multi-extent size for '${memberPath}'`);
				const unitBytes = extent.fileUnitSize * this.#blockSize;
				const gapBytes = extent.interleaveGapSize * this.#blockSize;
				if (unitBytes === 0) {
					const bytes = await readPayload(this.#source, extent.start, extent.size, memberPath);
					output.set(bytes, outputOffset);
					outputOffset += bytes.byteLength;
					continue;
				}
				let remaining = extent.size;
				let position = extent.start;
				while (remaining > 0) {
					const length = Math.min(unitBytes, remaining);
					const bytes = await readPayload(this.#source, position, length, memberPath);
					output.set(bytes, outputOffset);
					outputOffset += length;
					remaining -= length;
					position = safeAdd(position, unitBytes + gapBytes, "interleaved file offset");
				}
			}
			if (outputOffset !== size) {
				throw invalidIso(`member '${memberPath}' produced ${outputOffset} bytes, expected ${size}`);
			}
			return output;
		} catch (error) {
			if (error instanceof ArchiveError) throw error;
			throw invalidIso(`could not extract member '${memberPath}'`);
		}
	}
}

function invalidIso(detail: string): ArchiveError {
	return new ArchiveError(`Invalid ISO 9660 archive: ${detail}`);
}

function safeMultiply(left: number, right: number, what: string): number {
	const value = left * right;
	if (!Number.isSafeInteger(value) || value < 0) throw invalidIso(`${what} is too large`);
	return value;
}

function safeAdd(left: number, right: number, what: string): number {
	const value = left + right;
	if (!Number.isSafeInteger(value) || value < 0) throw invalidIso(`${what} is too large`);
	return value;
}

function assertSourceRange(source: ByteSource, start: number, end: number, what: string): void {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.size) {
		throw invalidIso(`truncated or invalid ${what}`);
	}
}

async function readPayload(source: ByteSource, start: number, size: number, memberPath: string): Promise<Uint8Array> {
	const end = safeAdd(start, size, "member extent");
	assertSourceRange(source, start, end, `extent for '${memberPath}'`);
	const bytes = await source.read(start, end);
	if (bytes.byteLength !== size) throw invalidIso(`truncated extent for '${memberPath}'`);
	return bytes;
}

function bothEndian16(bytes: Uint8Array, offset: number, what: string): number {
	const little = readUInt16LE(bytes, offset);
	if (little !== readUInt16BE(bytes, offset + 2)) throw invalidIso(`${what} has mismatched byte orders`);
	return little;
}

function bothEndian32(bytes: Uint8Array, offset: number, what: string): number {
	const little = readUInt32LE(bytes, offset);
	if (little !== readUInt32BE(bytes, offset + 4)) throw invalidIso(`${what} has mismatched byte orders`);
	return little;
}

function recordingTime(bytes: Uint8Array, offset: number): number | undefined {
	const year = bytes[offset]! + 1900;
	const month = bytes[offset + 1]!;
	const day = bytes[offset + 2]!;
	const hour = bytes[offset + 3]!;
	const minute = bytes[offset + 4]!;
	const second = bytes[offset + 5]!;
	const zoneByte = bytes[offset + 6]!;
	const zone = zoneByte >= 128 ? zoneByte - 256 : zoneByte;
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > 31 ||
		hour > 23 ||
		minute > 59 ||
		second > 60 ||
		zone < -48 ||
		zone > 52
	) {
		return undefined;
	}
	const utc = Date.UTC(year, month - 1, day, hour, minute, Math.min(second, 59));
	if (!Number.isFinite(utc)) return undefined;
	return utc - zone * 15 * 60_000;
}

function parseRecord(bytes: Uint8Array, offset: number, available: number, label: string): IsoRecord {
	if (available < 34) throw invalidIso(`${label} directory record is too short`);
	const length = bytes[offset]!;
	if (length < 34 || length > available) throw invalidIso(`${label} directory record has an invalid length`);
	const identifierLength = bytes[offset + 32]!;
	const padding = identifierLength % 2 === 0 ? 1 : 0;
	const systemUseOffset = 33 + identifierLength + padding;
	if (identifierLength === 0 || systemUseOffset > length)
		throw invalidIso(`${label} directory record has an invalid identifier`);
	const extent = bothEndian32(bytes, offset + 2, `${label} extent location`);
	const size = bothEndian32(bytes, offset + 10, `${label} data length`);
	bothEndian16(bytes, offset + 28, `${label} volume sequence number`);
	const fileUnitSize = bytes[offset + 26]!;
	const interleaveGapSize = bytes[offset + 27]!;
	if ((fileUnitSize === 0) !== (interleaveGapSize === 0)) {
		throw invalidIso(`${label} has an invalid interleave configuration`);
	}
	return {
		extent,
		size,
		extendedAttributeBlocks: bytes[offset + 1]!,
		mtimeMs: recordingTime(bytes, offset + 18),
		flags: bytes[offset + 25]!,
		fileUnitSize,
		interleaveGapSize,
		identifier: bytes.subarray(offset + 33, offset + 33 + identifierLength),
		systemUse: bytes.subarray(offset + systemUseOffset, offset + length),
	};
}

function parseVolumeDescriptor(descriptor: Uint8Array, joliet: boolean): IsoVolume {
	bothEndian32(descriptor, 80, "volume space size");
	bothEndian16(descriptor, 120, "volume set size");
	bothEndian16(descriptor, 124, "volume sequence number");
	const blockSize = bothEndian16(descriptor, 128, "logical block size");
	bothEndian32(descriptor, 132, "path table size");
	if (blockSize !== ISO_SECTOR_SIZE) {
		throw new ArchiveError(`Unsupported ISO 9660 logical block size ${blockSize} (expected 2048)`);
	}
	const root = parseRecord(descriptor, 156, descriptor.byteLength - 156, "root");
	if ((root.flags & 0x02) === 0 || root.size === 0 || root.identifier.byteLength !== 1 || root.identifier[0] !== 0) {
		throw invalidIso("invalid root directory record");
	}
	return { blockSize, root, joliet };
}

async function readVolume(source: ByteSource, budget: MetadataBudget, limits: ArchiveLimits): Promise<IsoVolume> {
	if (source.size < VOLUME_DESCRIPTOR_START + ISO_SECTOR_SIZE) throw invalidIso("truncated volume descriptor set");
	let position = VOLUME_DESCRIPTOR_START;
	let chunkSectors = 16;
	let pending: Uint8Array = new Uint8Array(0);
	let pendingOffset = 0;
	let primary: IsoVolume | undefined;
	let joliet: IsoVolume | undefined;
	let sawUdf = false;
	let sawHighSierra = false;
	let terminated = false;
	let scanned = 0;

	while (!terminated && position < source.size) {
		const wanted = safeMultiply(chunkSectors, ISO_SECTOR_SIZE, "volume descriptor scan");
		const remainingBudget = limits.maxIndexSize - scanned;
		if (remainingBudget < ISO_SECTOR_SIZE) throw invalidIso("volume descriptor set exceeds metadata limit");
		const availableSectors = Math.floor(Math.min(wanted, remainingBudget, source.size - position) / ISO_SECTOR_SIZE);
		if (availableSectors < 1) throw invalidIso("truncated volume descriptor");
		const length = availableSectors * ISO_SECTOR_SIZE;
		pending = await budget.read(source, position, position + length, "volume descriptor set");
		pendingOffset = 0;
		while (pendingOffset + ISO_SECTOR_SIZE <= pending.byteLength) {
			const descriptor = pending.subarray(pendingOffset, pendingOffset + ISO_SECTOR_SIZE);
			const type = descriptor[0]!;
			if (bytesMatchAscii(descriptor, 1, "CDROM") || bytesMatchAscii(descriptor, 9, "CDROM")) {
				sawHighSierra = true;
			}
			if (
				bytesMatchAscii(descriptor, 1, "BEA01") ||
				bytesMatchAscii(descriptor, 1, "NSR02") ||
				bytesMatchAscii(descriptor, 1, "NSR03") ||
				bytesMatchAscii(descriptor, 1, "TEA01")
			)
				sawUdf = true;
			if (bytesMatchAscii(descriptor, 1, "CD001")) {
				if (descriptor[6] !== 1 && descriptor[6] !== 2) throw invalidIso("unsupported volume descriptor version");
				if (type === 1) primary = parseVolumeDescriptor(descriptor, false);
				if (
					type === 2 &&
					descriptor[88] === 0x25 &&
					descriptor[89] === 0x2f &&
					[0x40, 0x43, 0x45].includes(descriptor[90]!)
				) {
					joliet = parseVolumeDescriptor(descriptor, true);
				}
				if (type === 255) {
					terminated = true;
					break;
				}
			}
			pendingOffset += ISO_SECTOR_SIZE;
			scanned += ISO_SECTOR_SIZE;
		}
		position += pending.byteLength;
		chunkSectors = Math.min(chunkSectors * 2, Math.ceil(limits.maxIndexSize / ISO_SECTOR_SIZE));
	}
	if (!primary && !joliet) {
		if (sawHighSierra) throw new ArchiveError("Unsupported High Sierra CD-ROM filesystem (not ISO 9660)");
		if (sawUdf) throw new ArchiveError("Unsupported UDF-only image (no ISO 9660 volume descriptor)");
		throw invalidIso("primary volume descriptor not found");
	}
	if (!terminated) throw invalidIso("volume descriptor terminator not found");
	if (joliet) return { ...joliet, rockRidgeRoot: primary?.root };
	return primary!;
}

function decodeIdentifier(identifier: Uint8Array, joliet: boolean): string {
	let name: string;
	if (joliet) {
		if (identifier.byteLength % 2 !== 0) throw invalidIso("Joliet identifier has an odd byte length");
		const codeUnits = new Uint16Array(identifier.byteLength / 2);
		for (let index = 0; index < codeUnits.length; index++) codeUnits[index] = readUInt16BE(identifier, index * 2);
		const chunks: string[] = [];
		for (let index = 0; index < codeUnits.length; index += 4096) {
			chunks.push(String.fromCharCode(...codeUnits.subarray(index, index + 4096)));
		}
		name = chunks.join("");
	} else {
		name = UTF8_DECODER.decode(identifier);
	}
	return name.endsWith(";1") ? name.slice(0, -2) : name;
}

function findSuspSkip(record: IsoRecord): number | undefined {
	const bytes = record.systemUse;
	for (let offset = 0; offset + 7 <= bytes.byteLength;) {
		const length = bytes[offset + 2]!;
		if (length < 4 || offset + length > bytes.byteLength) return undefined;
		if (
			bytes[offset] === 0x53 &&
			bytes[offset + 1] === 0x50 &&
			length === 7 &&
			bytes[offset + 4] === 0xbe &&
			bytes[offset + 5] === 0xef
		) {
			return bytes[offset + 6]!;
		}
		offset += length;
	}
	return undefined;
}

async function parseSusp(
	record: IsoRecord,
	skip: number | undefined,
	source: ByteSource,
	blockSize: number,
	budget: MetadataBudget,
	limits: ArchiveLimits,
): Promise<SuspData> {
	if (skip === undefined || skip > record.systemUse.byteLength) return {};
	const queue: Uint8Array[] = [record.systemUse.subarray(skip)];
	const continuationRanges = new Set<string>();
	const nameParts: string[] = [];
	const linkParts: string[] = [];
	let linkComponentContinues = false;
	let mode: number | undefined;
	let relocation: SuspData["relocation"];
	for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
		const area = queue[queueIndex]!;
		for (let offset = 0; offset + 4 <= area.byteLength;) {
			const signature = String.fromCharCode(area[offset]!, area[offset + 1]!);
			const length = area[offset + 2]!;
			const version = area[offset + 3]!;
			if (length < 4 || offset + length > area.byteLength) throw invalidIso("malformed SUSP record");
			if (
				version !== 1 &&
				(signature === "CE" ||
					signature === "NM" ||
					signature === "PX" ||
					signature === "RE" ||
					signature === "CL" ||
					signature === "PL" ||
					signature === "SL" ||
					signature === "ST")
			) {
				throw invalidIso(`unsupported SUSP ${signature} version ${version}`);
			}
			const data = area.subarray(offset + 4, offset + length);
			if (signature === "ST") break;
			if (signature === "CE") {
				if (data.byteLength < 24) throw invalidIso("short SUSP CE record");
				const block = bothEndian32(data, 0, "SUSP continuation block");
				const blockOffset = bothEndian32(data, 8, "SUSP continuation offset");
				const continuationLength = bothEndian32(data, 16, "SUSP continuation length");
				assertIndexSize(continuationLength, limits, "ISO SUSP continuation");
				const start = safeAdd(
					safeMultiply(block, blockSize, "SUSP continuation location"),
					blockOffset,
					"SUSP continuation location",
				);
				const end = safeAdd(start, continuationLength, "SUSP continuation range");
				const key = `${start}:${end}`;
				if (continuationRanges.has(key)) throw invalidIso("cyclic SUSP continuation");
				if (continuationRanges.size >= MAX_SUSP_CONTINUATIONS) throw invalidIso("too many SUSP continuations");
				continuationRanges.add(key);
				queue.push(await budget.read(source, start, end, "SUSP continuation"));
			}
			if (signature === "NM" && data.byteLength >= 1) {
				const flags = data[0]!;
				if ((flags & 0x06) === 0) nameParts.push(UTF8_DECODER.decode(data.subarray(1)));
				else if (flags & 0x02) nameParts.push(".");
				else if (flags & 0x04) nameParts.push("..");
			}
			if (signature === "PX" && data.byteLength >= 8) mode = bothEndian32(data, 0, "Rock Ridge PX mode");
			if (signature === "RE" || signature === "CL" || signature === "PL") relocation = signature;
			if (signature === "SL" && data.byteLength >= 1) {
				let componentOffset = 1;
				while (componentOffset < data.byteLength) {
					if (componentOffset + 2 > data.byteLength) throw invalidIso("malformed Rock Ridge SL component");
					const flags = data[componentOffset]!;
					const componentLength = data[componentOffset + 1]!;
					componentOffset += 2;
					if (componentOffset + componentLength > data.byteLength)
						throw invalidIso("malformed Rock Ridge SL component");
					let component: string;
					if (flags & 0x08) component = "";
					else if (flags & 0x04) component = "..";
					else if (flags & 0x02) component = ".";
					else component = UTF8_DECODER.decode(data.subarray(componentOffset, componentOffset + componentLength));
					if (linkComponentContinues && linkParts.length > 0) linkParts[linkParts.length - 1] += component;
					else linkParts.push(component);
					linkComponentContinues = (flags & 0x01) !== 0;
					componentOffset += componentLength;
				}
			}
			offset += length;
		}
	}
	const name = nameParts.length > 0 ? nameParts.join("") : undefined;
	let symlink: string | undefined;
	if (linkParts.length > 0) symlink = linkParts[0] === "" ? `/${linkParts.slice(1).join("/")}` : linkParts.join("/");
	return { name, mode, symlink, relocation };
}

function directoryContainsAncestor(ancestor: DirectoryAncestor, key: string): boolean {
	for (let current: DirectoryAncestor | undefined = ancestor; current; current = current.parent) {
		if (current.key === key) return true;
	}
	return false;
}

function extentForRecord(record: IsoRecord, blockSize: number): IsoExtent {
	const dataBlock = safeAdd(record.extent, record.extendedAttributeBlocks, "file extent block");
	return {
		start: safeMultiply(dataBlock, blockSize, "file extent offset"),
		size: record.size,
		fileUnitSize: record.fileUnitSize,
		interleaveGapSize: record.interleaveGapSize,
	};
}

async function readDirectoryRecords(
	source: ByteSource,
	record: IsoRecord,
	blockSize: number,
	budget: MetadataBudget,
	limits: ArchiveLimits,
): Promise<IsoRecord[]> {
	const start = safeMultiply(
		safeAdd(record.extent, record.extendedAttributeBlocks, "directory extent block"),
		blockSize,
		"directory extent offset",
	);
	const end = safeAdd(start, record.size, "directory extent range");
	const bytes = await budget.read(source, start, end, "directory extent");
	const records: IsoRecord[] = [];
	for (let offset = 0; offset < bytes.byteLength;) {
		const sectorRemaining = blockSize - (offset % blockSize);
		const length = bytes[offset]!;
		if (length === 0) {
			offset += sectorRemaining;
			continue;
		}
		if (length > sectorRemaining || length > bytes.byteLength - offset)
			throw invalidIso("directory record crosses a logical block");
		records.push(parseRecord(bytes, offset, length, "member"));
		assertEntryCount(records.length, limits);
		offset += length;
	}
	return records;
}

async function mergeRockRidgeMetadata(
	source: ByteSource,
	root: IsoRecord,
	blockSize: number,
	budget: MetadataBudget,
	limits: ArchiveLimits,
	entries: Map<string, ArchiveIndexEntry>,
): Promise<void> {
	const rootKey = `${root.extent}:${root.size}`;
	const work: DirectoryWork[] = [
		{
			record: root,
			parentPath: "",
			depth: 0,
			ancestor: { key: rootKey },
		},
	];
	let suspSkip: number | undefined;
	while (work.length > 0) {
		const directory = work.pop()!;
		if (directory.depth > MAX_DIRECTORY_DEPTH) {
			throw invalidIso(`directory hierarchy exceeds ${MAX_DIRECTORY_DEPTH} levels`);
		}
		const records = await readDirectoryRecords(source, directory.record, blockSize, budget, limits);
		if (
			directory.depth === 0 &&
			records.length > 0 &&
			records[0]!.identifier.byteLength === 1 &&
			records[0]!.identifier[0] === 0
		) {
			suspSkip = findSuspSkip(records[0]!);
		}
		for (const record of records) {
			if (record.identifier.byteLength === 1 && (record.identifier[0] === 0 || record.identifier[0] === 1)) continue;
			const susp = await parseSusp(record, suspSkip, source, blockSize, budget, limits);
			if (susp.relocation) {
				throw new ArchiveError(`Unsupported Rock Ridge relocated directory (${susp.relocation})`);
			}
			const rawName = susp.name ?? decodeIdentifier(record.identifier, false);
			assertArchivePathBytes(Buffer.byteLength(rawName, "utf-8"), "member name", limits.maxPathBytes);
			const rawPath = directory.parentPath ? `${directory.parentPath}/${rawName}` : rawName;
			const normalizedPath = normalizeArchiveEntryPath(rawPath);
			if (!normalizedPath) continue;
			assertArchivePathBytes(Buffer.byteLength(normalizedPath, "utf-8"), "member path", limits.maxPathBytes);
			if (susp.symlink !== undefined) {
				assertArchivePathBytes(Buffer.byteLength(susp.symlink, "utf-8"), "link target", limits.maxPathBytes);
				const targetPath = path.posix.isAbsolute(susp.symlink)
					? undefined
					: normalizeArchiveLookupPath(path.posix.join(path.posix.dirname(normalizedPath), susp.symlink));
				upsertArchiveEntry(entries, {
					path: normalizedPath,
					isDirectory: false,
					size: 0,
					mtimeMs: record.mtimeMs,
					mode: susp.mode,
					storage: {
						type: "link",
						targetPath: targetPath ?? susp.symlink,
						resolveTarget: targetPath !== undefined,
					},
				});
				assertEntryCount(entries.size, limits);
				continue;
			}
			const existing = entries.get(normalizedPath);
			if (existing && susp.mode !== undefined) entries.set(normalizedPath, { ...existing, mode: susp.mode });
			if ((record.flags & 0x02) === 0) continue;
			const childKey = `${record.extent}:${record.size}`;
			if (directoryContainsAncestor(directory.ancestor, childKey)) {
				throw invalidIso(`cyclic directory at '${normalizedPath}'`);
			}
			work.push({
				record,
				parentPath: normalizedPath,
				depth: directory.depth + 1,
				ancestor: { key: childKey, parent: directory.ancestor },
			});
		}
	}
}

async function readIsoImpl(source: ByteSource, options: Parameters<FormatReader>[1]): Promise<ArchiveIndexEntry[]> {
	if (!Number.isSafeInteger(source.size) || source.size < 0) throw invalidIso("invalid source size");
	const budget = new MetadataBudget(options.limits);
	const volume = await readVolume(source, budget, options.limits);
	const rootKey = `${volume.root.extent}:${volume.root.size}`;
	const rootAncestor: DirectoryAncestor = { key: rootKey };
	const work: DirectoryWork[] = [{ record: volume.root, parentPath: "", depth: 0, ancestor: rootAncestor }];
	const entries = new Map<string, ArchiveIndexEntry>();
	let suspSkip: number | undefined;

	while (work.length > 0) {
		const directory = work.pop()!;
		if (directory.depth > MAX_DIRECTORY_DEPTH)
			throw invalidIso(`directory hierarchy exceeds ${MAX_DIRECTORY_DEPTH} levels`);
		const records = await readDirectoryRecords(source, directory.record, volume.blockSize, budget, options.limits);
		if (
			directory.depth === 0 &&
			records.length > 0 &&
			records[0]!.identifier.byteLength === 1 &&
			records[0]!.identifier[0] === 0
		) {
			suspSkip = findSuspSkip(records[0]!);
		}
		for (let index = 0; index < records.length;) {
			const record = records[index]!;
			if (record.identifier.byteLength === 1 && (record.identifier[0] === 0 || record.identifier[0] === 1)) {
				index++;
				continue;
			}
			const parts = [record];
			if ((record.flags & 0x80) !== 0) {
				if ((record.flags & 0x02) !== 0) throw invalidIso("multi-extent directory is unsupported");
				while ((parts[parts.length - 1]!.flags & 0x80) !== 0) {
					const next = records[++index];
					if (!next || next.identifier.byteLength !== record.identifier.byteLength)
						throw invalidIso("unterminated multi-extent file");
					for (let byteIndex = 0; byteIndex < record.identifier.byteLength; byteIndex++) {
						if (next.identifier[byteIndex] !== record.identifier[byteIndex])
							throw invalidIso("non-contiguous multi-extent file");
					}
					if ((next.flags & ~0x80) !== (record.flags & ~0x80))
						throw invalidIso("inconsistent multi-extent file flags");
					parts.push(next);
				}
			}
			index++;
			const susp = await parseSusp(record, suspSkip, source, volume.blockSize, budget, options.limits);
			if (susp.relocation) {
				throw new ArchiveError(`Unsupported Rock Ridge relocated directory (${susp.relocation})`);
			}
			const rawName = susp.name ?? decodeIdentifier(record.identifier, volume.joliet);
			assertArchivePathBytes(Buffer.byteLength(rawName, "utf-8"), "member name", options.limits.maxPathBytes);
			const rawPath = directory.parentPath ? `${directory.parentPath}/${rawName}` : rawName;
			const normalizedPath = normalizeArchiveEntryPath(rawPath);
			if (!normalizedPath) continue;
			assertArchivePathBytes(Buffer.byteLength(normalizedPath, "utf-8"), "member path", options.limits.maxPathBytes);
			const isDirectory = (record.flags & 0x02) !== 0;
			if (susp.symlink !== undefined) {
				assertArchivePathBytes(
					Buffer.byteLength(susp.symlink, "utf-8"),
					"link target",
					options.limits.maxPathBytes,
				);
				const targetPath = path.posix.isAbsolute(susp.symlink)
					? undefined
					: normalizeArchiveLookupPath(path.posix.join(path.posix.dirname(normalizedPath), susp.symlink));
				upsertArchiveEntry(entries, {
					path: normalizedPath,
					isDirectory: false,
					size: 0,
					mtimeMs: record.mtimeMs,
					mode: susp.mode,
					storage: {
						type: "link",
						targetPath: targetPath ?? susp.symlink,
						resolveTarget: targetPath !== undefined,
					},
				});
				assertEntryCount(entries.size, options.limits);
				continue;
			}
			if (isDirectory) {
				upsertArchiveEntry(entries, {
					path: normalizedPath,
					isDirectory: true,
					size: 0,
					mtimeMs: record.mtimeMs,
					mode: susp.mode,
				});
				assertEntryCount(entries.size, options.limits);
				const childKey = `${record.extent}:${record.size}`;
				if (directoryContainsAncestor(directory.ancestor, childKey))
					throw invalidIso(`cyclic directory at '${normalizedPath}'`);
				work.push({
					record,
					parentPath: normalizedPath,
					depth: directory.depth + 1,
					ancestor: { key: childKey, parent: directory.ancestor },
				});
				continue;
			}
			let totalSize = 0;
			for (const part of parts) totalSize = safeAdd(totalSize, part.size, "multi-extent member size");
			assertArchiveMemberSize(totalSize, normalizedPath, options.limits);
			// Zero-length members never read their extents, and writers record
			// junk locations for them (bsdtar's Joliet records for Rock Ridge
			// symlinks, empty files at unallocated blocks) — 7-Zip and bsdtar
			// both accept these, so validate extents only when bytes exist.
			const extents = totalSize === 0 ? [] : parts.map(part => extentForRecord(part, volume.blockSize));
			for (const extent of extents)
				assertSourceRange(
					source,
					extent.start,
					safeAdd(extent.start, extent.size, "file extent range"),
					`extent for '${normalizedPath}'`,
				);
			upsertArchiveEntry(entries, {
				path: normalizedPath,
				isDirectory: false,
				size: totalSize,
				mtimeMs: record.mtimeMs,
				mode: susp.mode,
				storage: { type: "member", source: new IsoMemberSource(source, volume.blockSize, extents) },
			});
			assertEntryCount(entries.size, options.limits);
		}
	}
	if (volume.rockRidgeRoot) {
		await mergeRockRidgeMetadata(source, volume.rockRidgeRoot, volume.blockSize, budget, options.limits, entries);
	}
	return [...entries.values()];
}

/** Probe an ISO 9660 primary-volume signature at sector 16. */
export function sniffIso(bytes: Uint8Array): boolean {
	return bytesMatchAscii(bytes, VOLUME_DESCRIPTOR_START + 1, "CD001");
}

/** Index an ISO 9660 image lazily, preferring a valid Joliet supplementary tree. */
export const readIso: FormatReader = async (source, options) => {
	try {
		return await readIsoImpl(source, options);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw invalidIso("could not parse image");
	}
};
