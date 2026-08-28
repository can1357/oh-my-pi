import * as path from "node:path";
import { readUInt32LE, writeUInt32LE } from "./bytes";
import { ArchiveError } from "./error";
import { assertArchiveMemberSize, assertEntryCount, assertIndexSize } from "./limits";
import {
	assertArchivePathBytes,
	assertArchivePathString,
	formatArchivePathForError,
	normalizeArchiveEntryPath,
	normalizeArchiveLookupPath,
} from "./paths";
import type { ByteSource } from "./source";
import type { ArchiveIndexEntry, FormatReader, FormatReadOptions, MemberSource } from "./types";

const ASAR_HEADER_DECODER = new TextDecoder("utf-8", { fatal: true });
const ASAR_HEADER_ENCODER = new TextEncoder();
const ASAR_PICKLE_PREFIX_SIZE = 8;
const ASAR_INNER_PREFIX_SIZE = 8;
const ASAR_JSON_OFFSET = ASAR_PICKLE_PREFIX_SIZE + ASAR_INNER_PREFIX_SIZE;
const ASAR_FILE_MODE = 0o100000;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

interface AsarIntegrity {
	algorithm: "SHA256";
	hash: string;
}

interface AsarWorkItem {
	parentPath: string;
	parentPathBytes: number;
	name: string;
	node: unknown;
}

interface AsarFileNode {
	size: number;
	offset: string;
}

interface AsarDirectoryNode {
	files: Record<string, AsarNode>;
}

type AsarNode = AsarFileNode | AsarDirectoryNode;

function invalidAsar(message: string): ArchiveError {
	return new ArchiveError(`Invalid ASAR archive: ${message}`);
}

function describeError(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

function alignAsarPayload(size: number): number {
	return size + ((4 - (size % 4)) % 4);
}

function isArchiveRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIntegrity(value: unknown, entryPath: string, size: number): AsarIntegrity | undefined {
	if (value === undefined) return undefined;
	const label = formatArchivePathForError(entryPath);
	if (!isArchiveRecord(value)) {
		throw invalidAsar(`file '${label}' has an invalid integrity record`);
	}
	if (value.algorithm !== "SHA256") {
		throw invalidAsar(`file '${label}' uses unsupported integrity algorithm '${String(value.algorithm)}'`);
	}
	if (typeof value.hash !== "string" || !SHA256_HEX.test(value.hash)) {
		throw invalidAsar(`file '${label}' has an invalid integrity hash`);
	}
	if (typeof value.blockSize !== "number" || !Number.isSafeInteger(value.blockSize) || value.blockSize <= 0) {
		throw invalidAsar(`file '${label}' has an invalid integrity block size`);
	}
	if (!Array.isArray(value.blocks)) {
		throw invalidAsar(`file '${label}' has invalid integrity blocks`);
	}
	const expectedBlocks = Math.max(1, Math.ceil(size / value.blockSize));
	if (value.blocks.length !== expectedBlocks) {
		throw invalidAsar(`file '${label}' has an inconsistent integrity block count`);
	}
	for (const block of value.blocks) {
		if (typeof block !== "string" || !SHA256_HEX.test(block)) {
			throw invalidAsar(`file '${label}' has an invalid integrity block hash`);
		}
	}
	return { algorithm: "SHA256", hash: value.hash.toLowerCase() };
}

function verifyIntegrity(bytes: Uint8Array, integrity: AsarIntegrity | undefined, memberPath: string): void {
	if (!integrity) return;
	const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	if (actual !== integrity.hash) {
		throw new ArchiveError(
			`ASAR member '${formatArchivePathForError(memberPath)}' failed SHA256 integrity verification`,
		);
	}
}

class PackedAsarMemberSource implements MemberSource {
	readonly #source: ByteSource;
	readonly #offset: number;
	readonly #size: number;
	readonly #integrity?: AsarIntegrity;

	constructor(source: ByteSource, offset: number, size: number, integrity: AsarIntegrity | undefined) {
		this.#source = source;
		this.#offset = offset;
		this.#size = size;
		this.#integrity = integrity;
	}

	async read(size: number, memberPath: string): Promise<Uint8Array> {
		if (size !== this.#size) {
			throw new ArchiveError(`ASAR member '${formatArchivePathForError(memberPath)}' has an inconsistent size`);
		}
		let bytes: Uint8Array;
		try {
			bytes = await this.#source.read(this.#offset, this.#offset + this.#size);
		} catch (error) {
			if (error instanceof ArchiveError) throw error;
			throw new ArchiveError(
				`Failed to read ASAR member '${formatArchivePathForError(memberPath)}': ${describeError(error)}`,
			);
		}
		if (bytes.byteLength !== this.#size) {
			throw new ArchiveError(`ASAR member '${formatArchivePathForError(memberPath)}' is truncated`);
		}
		verifyIntegrity(bytes, this.#integrity, memberPath);
		return bytes;
	}
}

class UnpackedAsarMemberSource implements MemberSource {
	readonly #filePath?: string;
	readonly #size: number;
	readonly #integrity?: AsarIntegrity;

	constructor(filePath: string | undefined, size: number, integrity: AsarIntegrity | undefined) {
		this.#filePath = filePath;
		this.#size = size;
		this.#integrity = integrity;
	}

	async read(size: number, memberPath: string): Promise<Uint8Array> {
		const label = formatArchivePathForError(memberPath);
		if (size !== this.#size) {
			throw new ArchiveError(`ASAR member '${label}' has an inconsistent size`);
		}
		if (!this.#filePath) {
			throw new ArchiveError(`Archive file '${label}' is unpacked and requires a filesystem-backed ASAR archive`);
		}
		const file = Bun.file(this.#filePath);
		const stat = await file.stat().catch(() => {
			throw new ArchiveError(`Unpacked ASAR file '${label}' was not found`);
		});
		if (stat.isDirectory()) {
			throw new ArchiveError(`Unpacked ASAR file '${label}' is a directory`);
		}
		if (stat.size !== this.#size) {
			throw new ArchiveError(
				`Unpacked ASAR file '${label}' size differs from its archive header (${stat.size} != ${this.#size} bytes)`,
			);
		}
		let bytes: Uint8Array;
		try {
			bytes = await file.bytes();
		} catch (error) {
			throw new ArchiveError(`Failed to read unpacked ASAR file '${label}': ${describeError(error)}`);
		}
		if (bytes.byteLength !== this.#size) {
			throw new ArchiveError(`Unpacked ASAR file '${label}' changed while being read`);
		}
		verifyIntegrity(bytes, this.#integrity, memberPath);
		return bytes;
	}
}

async function readAsarIndex(source: ByteSource, options: FormatReadOptions): Promise<ArchiveIndexEntry[]> {
	if (!Number.isSafeInteger(source.size) || source.size < ASAR_JSON_OFFSET) {
		throw invalidAsar("truncated header");
	}

	const sizePickle = await source.read(0, ASAR_PICKLE_PREFIX_SIZE);
	if (sizePickle.byteLength !== ASAR_PICKLE_PREFIX_SIZE) {
		throw invalidAsar("truncated size pickle");
	}
	if (readUInt32LE(sizePickle, 0) !== 4) {
		throw invalidAsar("invalid size pickle");
	}
	const headerSize = readUInt32LE(sizePickle, 4);
	if (headerSize < ASAR_INNER_PREFIX_SIZE) {
		throw invalidAsar("header is too small");
	}
	assertIndexSize(headerSize, options.limits, "ASAR header");
	const dataOffset = ASAR_PICKLE_PREFIX_SIZE + headerSize;
	if (!Number.isSafeInteger(dataOffset) || dataOffset > source.size) {
		throw invalidAsar("header extends beyond archive boundary");
	}

	const headerPickle = await source.read(ASAR_PICKLE_PREFIX_SIZE, dataOffset);
	if (headerPickle.byteLength !== headerSize) {
		throw invalidAsar("truncated header pickle");
	}
	const payloadSize = readUInt32LE(headerPickle, 0);
	const jsonSize = readUInt32LE(headerPickle, 4);
	if (payloadSize + 4 !== headerSize || payloadSize !== 4 + alignAsarPayload(jsonSize)) {
		throw invalidAsar("inconsistent pickle lengths");
	}
	const jsonEnd = ASAR_INNER_PREFIX_SIZE + jsonSize;
	for (let index = jsonEnd; index < headerPickle.byteLength; index++) {
		if (headerPickle[index] !== 0) {
			throw invalidAsar("non-zero pickle string padding");
		}
	}

	let headerText: string;
	try {
		headerText = ASAR_HEADER_DECODER.decode(headerPickle.subarray(ASAR_INNER_PREFIX_SIZE, jsonEnd));
	} catch {
		throw invalidAsar("header is not valid UTF-8");
	}
	let header: unknown;
	try {
		header = JSON.parse(headerText);
	} catch {
		throw invalidAsar("header is not valid JSON");
	}
	if (!isArchiveRecord(header) || !isArchiveRecord(header.files)) {
		throw invalidAsar("root must contain a files object");
	}

	const entries: ArchiveIndexEntry[] = [];
	const work: AsarWorkItem[] = [];
	let scheduled = 0;
	const scheduleChildren = (files: Record<string, unknown>, parentPath: string, parentPathBytes: number): void => {
		for (const name in files) {
			assertEntryCount(++scheduled, options.limits);
			work.push({ parentPath, parentPathBytes, name, node: files[name] });
		}
	};
	scheduleChildren(header.files, "", 0);

	while (work.length > 0) {
		const current = work.pop()!;
		const nameBytes = Buffer.byteLength(current.name, "utf-8");
		assertArchivePathBytes(nameBytes, "entry name", options.limits.maxPathBytes);
		if (
			current.name.length === 0 ||
			current.name === "." ||
			current.name === ".." ||
			current.name.includes("/") ||
			current.name.includes("\\") ||
			current.name.includes("\0")
		) {
			throw invalidAsar(`invalid entry name '${formatArchivePathForError(current.name)}'`);
		}
		if (!isArchiveRecord(current.node)) {
			throw invalidAsar(`entry '${formatArchivePathForError(current.name)}' must be an object`);
		}
		const entryPathBytes = current.parentPathBytes + (current.parentPath ? 1 : 0) + nameBytes;
		assertArchivePathBytes(entryPathBytes, "member path", options.limits.maxPathBytes);
		const entryPath = current.parentPath ? `${current.parentPath}/${current.name}` : current.name;
		const normalizedPath = normalizeArchiveEntryPath(entryPath);
		if (normalizedPath !== entryPath) {
			throw invalidAsar(`invalid entry path '${formatArchivePathForError(entryPath)}'`);
		}
		const entryLabel = formatArchivePathForError(entryPath);
		if (current.node.unpacked !== undefined && typeof current.node.unpacked !== "boolean") {
			throw invalidAsar(`entry '${entryLabel}' has a non-boolean unpacked flag`);
		}

		if ("link" in current.node) {
			if (typeof current.node.link !== "string" || current.node.link.length === 0) {
				throw invalidAsar(`entry '${entryLabel}' has an invalid link target`);
			}
			assertArchivePathString(current.node.link, "link target", options.limits.maxPathBytes);
			const portableTarget = current.node.link.replace(/\\/g, "/");
			const targetPath =
				portableTarget.startsWith("/") || /^[A-Za-z]:\//.test(portableTarget)
					? undefined
					: normalizeArchiveLookupPath(portableTarget);
			if (targetPath === undefined) {
				throw invalidAsar(`entry '${entryLabel}' links outside the archive`);
			}
			entries.push({
				path: entryPath,
				isDirectory: false,
				size: 0,
				storage: { type: "link", targetPath, resolveTarget: true },
			});
			continue;
		}

		if ("files" in current.node) {
			if (!isArchiveRecord(current.node.files)) {
				throw invalidAsar(`directory '${entryLabel}' must contain a files object`);
			}
			entries.push({ path: entryPath, isDirectory: true, size: 0 });
			scheduleChildren(current.node.files, entryPath, entryPathBytes);
			continue;
		}

		const size = current.node.size;
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
			throw invalidAsar(`file '${entryLabel}' has an invalid size`);
		}
		assertArchiveMemberSize(size, entryPath, options.limits);
		if (current.node.executable !== undefined && typeof current.node.executable !== "boolean") {
			throw invalidAsar(`file '${entryLabel}' has a non-boolean executable flag`);
		}
		const mode =
			typeof current.node.executable === "boolean"
				? ASAR_FILE_MODE | (current.node.executable ? 0o755 : 0o644)
				: undefined;
		const integrity = parseIntegrity(current.node.integrity, entryPath, size);

		if (current.node.unpacked === true) {
			const filePath = options.archivePath
				? path.join(`${options.archivePath}.unpacked`, ...entryPath.split("/"))
				: undefined;
			entries.push({
				path: entryPath,
				isDirectory: false,
				size,
				mode,
				storage: { type: "member", source: new UnpackedAsarMemberSource(filePath, size, integrity) },
			});
			continue;
		}

		if (typeof current.node.offset !== "string" || !/^\d+$/.test(current.node.offset)) {
			throw invalidAsar(`file '${entryLabel}' has an invalid offset`);
		}
		const relativeOffset = Number(current.node.offset);
		const memberOffset = dataOffset + relativeOffset;
		const memberEnd = memberOffset + size;
		if (
			!Number.isSafeInteger(relativeOffset) ||
			!Number.isSafeInteger(memberOffset) ||
			!Number.isSafeInteger(memberEnd) ||
			memberEnd > source.size
		) {
			throw invalidAsar(`file '${entryLabel}' extends beyond archive boundary`);
		}
		entries.push({
			path: entryPath,
			isDirectory: false,
			size,
			mode,
			storage: {
				type: "member",
				source: new PackedAsarMemberSource(source, memberOffset, size, integrity),
			},
		});
	}
	return entries;
}

/** Read an Electron ASAR index while keeping packed and unpacked member payloads lazy. */
export const readAsar: FormatReader = async (source, options) => {
	try {
		return await readAsarIndex(source, options);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(`Failed to read ASAR archive: ${describeError(error)}`);
	}
};

/** Whether bytes begin with a structurally plausible Electron ASAR Pickle header. */
export function sniffAsar(bytes: Uint8Array): boolean {
	if (bytes.byteLength < ASAR_JSON_OFFSET + 1) return false;
	const outerPayload = readUInt32LE(bytes, 0);
	const headerSize = readUInt32LE(bytes, 4);
	const innerPayload = readUInt32LE(bytes, 8);
	const jsonSize = readUInt32LE(bytes, 12);
	return (
		outerPayload === 4 &&
		headerSize >= ASAR_INNER_PREFIX_SIZE &&
		headerSize === innerPayload + 4 &&
		innerPayload === 4 + alignAsarPayload(jsonSize) &&
		jsonSize > 0 &&
		bytes[ASAR_JSON_OFFSET] === 0x7b
	);
}

function writerPath(rawPath: string): string {
	const portable = rawPath.replace(/\\/g, "/");
	const normalized = normalizeArchiveEntryPath(portable);
	if (
		normalized === undefined ||
		portable.startsWith("/") ||
		/^[A-Za-z]:\//.test(portable) ||
		portable.includes("\0") ||
		portable.split("/").some(part => !part || part === "." || part === "..")
	) {
		throw new ArchiveError(`Invalid ASAR member path '${formatArchivePathForError(rawPath)}'`);
	}
	return normalized;
}

/** Encode file members in Electron's Pickle-framed ASAR layout. */
export async function encodeAsar(members: Iterable<readonly [string, Uint8Array]>): Promise<Uint8Array> {
	try {
		const root: AsarDirectoryNode = { files: Object.create(null) as Record<string, AsarNode> };
		const payloads: Uint8Array[] = [];
		let payloadSize = 0;
		for (const member of members) {
			if (
				!Array.isArray(member) ||
				member.length !== 2 ||
				typeof member[0] !== "string" ||
				!(member[1] instanceof Uint8Array)
			) {
				throw new ArchiveError("ASAR members must be [path, Uint8Array] pairs");
			}
			const memberPath = writerPath(member[0]);
			const parts = memberPath.split("/");
			let directory = root;
			for (let index = 0; index < parts.length - 1; index++) {
				const part = parts[index]!;
				const existing = directory.files[part];
				if (existing && !("files" in existing)) {
					throw new ArchiveError(
						`ASAR member path '${memberPath}' crosses file '${parts.slice(0, index + 1).join("/")}'`,
					);
				}
				if (!existing) {
					directory.files[part] = { files: Object.create(null) as Record<string, AsarNode> };
				}
				directory = directory.files[part] as AsarDirectoryNode;
			}
			const name = parts.at(-1)!;
			if (directory.files[name]) {
				throw new ArchiveError(`Duplicate or conflicting ASAR member path '${memberPath}'`);
			}
			if (!Number.isSafeInteger(member[1].byteLength) || !Number.isSafeInteger(payloadSize + member[1].byteLength)) {
				throw new ArchiveError("ASAR payload is too large to encode safely");
			}
			directory.files[name] = { size: member[1].byteLength, offset: String(payloadSize) };
			payloads.push(member[1]);
			payloadSize += member[1].byteLength;
		}

		const jsonBytes = ASAR_HEADER_ENCODER.encode(JSON.stringify(root));
		const paddedJsonSize = alignAsarPayload(jsonBytes.byteLength);
		const innerPayloadSize = 4 + paddedJsonSize;
		const headerSize = 4 + innerPayloadSize;
		if (jsonBytes.byteLength > 0xffffffff || headerSize > 0xffffffff) {
			throw new ArchiveError("ASAR header is too large to encode");
		}
		const dataOffset = ASAR_PICKLE_PREFIX_SIZE + headerSize;
		const archiveSize = dataOffset + payloadSize;
		if (!Number.isSafeInteger(archiveSize)) {
			throw new ArchiveError("ASAR archive is too large to encode safely");
		}
		let output: Uint8Array;
		try {
			output = new Uint8Array(archiveSize);
		} catch {
			throw new ArchiveError("ASAR archive is too large to encode in memory");
		}
		writeUInt32LE(output, 0, 4);
		writeUInt32LE(output, 4, headerSize);
		writeUInt32LE(output, 8, innerPayloadSize);
		writeUInt32LE(output, 12, jsonBytes.byteLength);
		output.set(jsonBytes, ASAR_JSON_OFFSET);
		let offset = dataOffset;
		for (const payload of payloads) {
			output.set(payload, offset);
			offset += payload.byteLength;
		}
		return output;
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(`Failed to encode ASAR archive: ${describeError(error)}`);
	}
}
