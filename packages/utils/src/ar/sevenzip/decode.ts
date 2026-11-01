import { crc32 } from "../checksums";
import { lzma2Decompress, lzmaDecompress } from "../codecs/lzma";
import { deltaDecode, x86Decode } from "../codecs/xz";
import { ArchiveError } from "../error";
import type { ArchiveLimits } from "../limits";
import { assertInMemorySize } from "../limits";
import type { ByteSource } from "../source";

/** One 7z coder and its global folder-stream coordinates. */
export interface SevenZipCoder {
	id: bigint;
	properties: Uint8Array;
	inputStart: number;
	outputStart: number;
	numInputs: number;
	numOutputs: number;
}

/** One binding from a coder output stream to another coder input stream. */
export interface SevenZipBindPair {
	input: number;
	output: number;
}

/** Parsed folder graph and its lazy packed-data coordinates. */
export interface SevenZipFolderRecord {
	coders: SevenZipCoder[];
	bindPairs: SevenZipBindPair[];
	packedIndices: number[];
	unpackSizes: number[];
	packOffsets: number[];
	packSizes: number[];
	packCrcs: Array<number | undefined>;
	crc?: number;
}

function methodName(id: bigint): string {
	switch (id) {
		case 0n:
			return "Copy";
		case 3n:
			return "Delta";
		case 0x21n:
			return "LZMA2";
		case 0x30101n:
			return "LZMA";
		case 0x30401n:
			return "PPMd";
		case 0x3030103n:
			return "BCJ x86";
		case 0x303011bn:
			return "BCJ2";
		case 0x6f10701n:
			return "7zAES";
		case 0x40108n:
			return "Deflate";
		case 0x40109n:
			return "Deflate64";
		case 0x40202n:
			return "BZip2";
		case 0x3030205n:
			return "BCJ PowerPC";
		case 0x3030401n:
			return "BCJ IA64";
		case 0x3030501n:
			return "BCJ ARM";
		case 0x3030701n:
			return "BCJ ARM Thumb";
		case 0x3030805n:
			return "BCJ SPARC";
		case 0xan:
			return "BCJ ARM64";
		case 0xbn:
			return "BCJ RISC-V";
		default:
			return `method 0x${id.toString(16)}`;
	}
}

function read32LE(bytes: Uint8Array, offset: number): number {
	if (offset + 4 > bytes.byteLength) throw new ArchiveError("Invalid 7z BCJ properties");
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

/** Shared lazy decoder/cache for a single 7z folder (solid block). */
export class SevenZipFolderSource {
	readonly #source: ByteSource;
	readonly #folder: SevenZipFolderRecord;
	readonly #limits: ArchiveLimits;
	#cached?: Promise<Uint8Array>;

	constructor(source: ByteSource, folder: SevenZipFolderRecord, limits: ArchiveLimits) {
		this.#source = source;
		this.#folder = folder;
		this.#limits = limits;
	}

	read(): Promise<Uint8Array> {
		this.#cached ??= this.#decode();
		return this.#cached;
	}

	async #decode(): Promise<Uint8Array> {
		const folder = this.#folder;
		if (folder.packedIndices.length !== 1 || folder.packOffsets.length !== 1 || folder.packSizes.length !== 1) {
			const bcj2 = folder.coders.find(coder => coder.id === 0x303011bn);
			if (bcj2) throw new ArchiveError("Unsupported 7z coder BCJ2 (multi-input folder)");
			throw new ArchiveError("Unsupported 7z folder graph with multiple packed input streams");
		}
		const packOffset = folder.packOffsets[0]!;
		const packSize = folder.packSizes[0]!;
		if (
			!Number.isSafeInteger(packOffset) ||
			!Number.isSafeInteger(packSize) ||
			packOffset < 0 ||
			packSize < 0 ||
			packOffset + packSize > this.#source.size
		) {
			throw new ArchiveError("Invalid 7z packed-stream range");
		}
		let bytes = await this.#source.read(packOffset, packOffset + packSize);
		if (folder.packCrcs[0] !== undefined && crc32(bytes) !== folder.packCrcs[0]) {
			throw new ArchiveError("Invalid 7z packed-stream CRC32 mismatch");
		}
		let inputIndex = folder.packedIndices[0]!;
		const visited = new Set<number>();
		for (;;) {
			const coderIndex = folder.coders.findIndex(
				coder => inputIndex >= coder.inputStart && inputIndex < coder.inputStart + coder.numInputs,
			);
			if (coderIndex < 0 || visited.has(coderIndex)) throw new ArchiveError("Invalid 7z folder binding graph");
			visited.add(coderIndex);
			const coder = folder.coders[coderIndex]!;
			if (coder.numInputs !== 1 || coder.numOutputs !== 1)
				throw new ArchiveError(`Unsupported 7z coder ${methodName(coder.id)} stream topology`);
			const outputSize = folder.unpackSizes[coder.outputStart];
			if (outputSize === undefined) throw new ArchiveError("Invalid 7z coder unpack size");
			assertInMemorySize(outputSize, this.#limits);
			switch (coder.id) {
				case 0n:
					if (coder.properties.byteLength !== 0 || bytes.byteLength !== outputSize)
						throw new ArchiveError("Invalid 7z Copy coder size or properties");
					break;
				case 0x30101n:
					bytes = await lzmaDecompress(coder.properties, bytes, outputSize);
					break;
				case 0x21n:
					if (coder.properties.byteLength !== 1) throw new ArchiveError("Invalid 7z LZMA2 coder properties");
					bytes = await lzma2Decompress(coder.properties[0]!, bytes, outputSize);
					if (bytes.byteLength !== outputSize) throw new ArchiveError("7z LZMA2 coder output size mismatch");
					break;
				case 3n:
					if (coder.properties.byteLength !== 1 || bytes.byteLength !== outputSize)
						throw new ArchiveError("Invalid 7z Delta coder properties or size");
					bytes = bytes.slice();
					deltaDecode(bytes, coder.properties[0]! + 1);
					break;
				case 0x3030103n: {
					if (coder.properties.byteLength !== 0 && coder.properties.byteLength !== 4)
						throw new ArchiveError("Invalid 7z BCJ x86 coder properties");
					if (bytes.byteLength !== outputSize) throw new ArchiveError("7z BCJ x86 coder output size mismatch");
					const startOffset = coder.properties.byteLength === 4 ? read32LE(coder.properties, 0) : 0;
					bytes = bytes.slice();
					x86Decode(bytes, startOffset);
					break;
				}
				case 0x30401n:
					throw new ArchiveError("Unsupported 7z coder PPMd");
				case 0x6f10701n:
					throw new ArchiveError("Encrypted 7z archives use unsupported coder 7zAES");
				default:
					throw new ArchiveError(`Unsupported 7z coder ${methodName(coder.id)}`);
			}
			const binding = folder.bindPairs.find(pair => pair.output === coder.outputStart);
			if (!binding) break;
			inputIndex = binding.input;
		}
		if (visited.size !== folder.coders.length)
			throw new ArchiveError("Unsupported 7z folder graph with disconnected coders");
		if (folder.crc !== undefined && crc32(bytes) !== folder.crc)
			throw new ArchiveError("Invalid 7z folder CRC32 mismatch");
		return bytes;
	}
}
