import { describe, expect, test } from "bun:test";
import { ArchiveError } from "../../src/ar/error";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/ar/limits";
import { ArchiveReader } from "../../src/ar/reader";
import { type ByteSource, memoryByteSource } from "../../src/ar/source";
import type { ArchiveIndexEntry } from "../../src/ar/types";
import { encodeZip, readZip, readZipEager, sniffZip } from "../../src/ar/zip";
import { arFixture as fixture } from "./fixtures";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function findEntry(entries: ArchiveIndexEntry[], memberPath: string): ArchiveIndexEntry {
	const entry = entries.find(candidate => candidate.path === memberPath);
	if (!entry) throw new Error(`Missing test ZIP entry ${memberPath}`);
	return entry;
}

async function readMember(entry: ArchiveIndexEntry): Promise<Uint8Array> {
	if (entry.storage?.type !== "member") throw new Error(`Test ZIP entry ${entry.path} is not a member`);
	return entry.storage.source.read(entry.size, entry.path);
}

function countingSource(bytes: Uint8Array): ByteSource & { reads: Array<readonly [number, number]> } {
	const reads: Array<readonly [number, number]> = [];
	return {
		size: bytes.byteLength,
		reads,
		async read(start, end) {
			reads.push([start, end]);
			if (start < 0 || end < start || end > bytes.byteLength) throw new ArchiveError("test range out of bounds");
			return bytes.subarray(start, end);
		},
	};
}

function readUInt16(bytes: Uint8Array, offset: number): number {
	return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt32(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function findSignature(bytes: Uint8Array, signature: number): number {
	for (let offset = 0; offset + 4 <= bytes.byteLength; offset++) {
		if (readUInt32(bytes, offset) === signature) return offset;
	}
	throw new Error(`Missing test signature ${signature.toString(16)}`);
}

function* zip64CountMembers(): Generator<readonly [string, Uint8Array]> {
	for (let index = 0; index < 0xffff; index++) yield [`empty-${index}`, new Uint8Array()] as const;
}

describe("ZIP fixtures", () => {
	test("indexes the central directory with bounded ranged reads and extracts stored and deflated members", async () => {
		const bytes = await fixture("zip-basic.zip");
		expect(sniffZip(bytes)).toBe(true);
		const source = countingSource(bytes);
		const entries = await readZip(source, { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(source.reads.length).toBeLessThanOrEqual(3);
		expect(entries.map(entry => entry.path).sort()).toEqual(["nested/repeated.txt", "plain.txt"]);
		const reader = new ArchiveReader("zip", entries);
		expect(reader.listDirectory().map(entry => [entry.name, entry.isDirectory])).toEqual([
			["nested", true],
			["plain.txt", false],
		]);
		expect(DECODER.decode(await readMember(findEntry(entries, "plain.txt")))).toBe("stored payload\n");
		expect(DECODER.decode(await readMember(findEntry(entries, "nested/repeated.txt")))).toContain("compress me");
		expect(findEntry(entries, "plain.txt").mtimeMs).toBeNumber();
	});

	test.each([
		["zip-bzip2.zip", "BZIP2 (12)"],
		["zip-lzma.zip", "LZMA (14)"],
		["zip-zstd.zip", "deprecated Zstandard (20)"],
		["zip-zstd93.zip", "Zstandard (93)"],
		["zip-xz.zip", "XZ (95)"],
	] as const)("extracts %s using %s", async fixtureName => {
		const entries = await readZip(memoryByteSource(await fixture(fixtureName)), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(DECODER.decode(await readMember(findEntry(entries, "nested/repeated.txt")))).toBe(
			"compress me compress me compress me compress me compress me compress me compress me compress me\n",
		);
	});

	test("reads ZIP64 entry metadata, data descriptors, and windows-1252 names", async () => {
		const zip64 = await readZip(memoryByteSource(await fixture("zip-zip64.zip")), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(DECODER.decode(await readMember(findEntry(zip64, "zip64.txt")))).toBe("zip64 payload\n");
		const descriptor = await readZip(memoryByteSource(await fixture("zip-descriptor.zip")), {
			limits: DEFAULT_ARCHIVE_LIMITS,
		});
		expect(DECODER.decode(await readMember(findEntry(descriptor, "descriptor.txt")))).toBe(
			"descriptor payload\n".repeat(8),
		);
		const legacy = await readZip(memoryByteSource(await fixture("zip-legacy-name.zip")), {
			limits: DEFAULT_ARCHIVE_LIMITS,
		});
		expect(DECODER.decode(await readMember(findEntry(legacy, "café.txt")))).toBe("legacy name\n");
	});

	test("surfaces Unix modes and resolves a symlink whose payload is read while indexing", async () => {
		const entries = await readZip(memoryByteSource(await fixture("zip-symlink-mode.zip")), {
			limits: DEFAULT_ARCHIVE_LIMITS,
		});
		const executable = findEntry(entries, "bin/run.sh");
		expect(executable.mode! & 0o170000).toBe(0o100000);
		expect(executable.mode! & 0o111).toBe(0o111);
		expect(executable.mtimeMs).toBeNumber();
		const link = findEntry(entries, "current");
		expect(link.mode! & 0o170000).toBe(0o120000);
		expect(link.storage).toEqual({ type: "link", targetPath: "bin/run.sh", resolveTarget: true });
		const reader = new ArchiveReader("zip", entries);
		expect(DECODER.decode((await reader.readFile("current")).bytes)).toContain("zip mode");
	});
});

test("encodeZip round-trips lazily and through the eager document-converter API", async () => {
	const encoded = await encodeZip([
		["small.bin", new Uint8Array([0, 1, 2, 255])],
		["nested/repeated.txt", ENCODER.encode("highly compressible ".repeat(30))],
	] as const);
	expect(sniffZip(encoded)).toBe(true);
	const entries = await readZip(memoryByteSource(encoded), { limits: DEFAULT_ARCHIVE_LIMITS });
	expect(await readMember(findEntry(entries, "small.bin"))).toEqual(new Uint8Array([0, 1, 2, 255]));
	const eager = await readZipEager(encoded);
	expect(DECODER.decode(eager.get("nested/repeated.txt"))).toBe("highly compressible ".repeat(30));
	await expect(encodeZip([["../escape", new Uint8Array()]] as const)).rejects.toBeInstanceOf(ArchiveError);
});

test("encodeZip emits interoperable ZIP64 end records at the 16-bit entry-count boundary", async () => {
	const bytes = await encodeZip(zip64CountMembers());
	const entries = await readZip(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
	expect(entries).toHaveLength(0xffff);
	expect(findEntry(entries, "empty-65534").size).toBe(0);
});

test("drops traversal names and rejects encryption, truncation, unsupported methods, and corrupt payloads", async () => {
	const traversal = await readZip(memoryByteSource(await fixture("zip-traversal.zip")), {
		limits: DEFAULT_ARCHIVE_LIMITS,
	});
	expect(traversal).toEqual([]);

	await expect(
		readZip(memoryByteSource(await fixture("zip-encrypted.zip")), { limits: DEFAULT_ARCHIVE_LIMITS }),
	).rejects.toThrow("Encrypted ZIP member");
	await expect(
		readZip(memoryByteSource((await fixture("zip-basic.zip")).subarray(0, 40)), { limits: DEFAULT_ARCHIVE_LIMITS }),
	).rejects.toBeInstanceOf(ArchiveError);

	const unsupported = (await fixture("zip-descriptor.zip")).slice();
	const centralOffset = findSignature(unsupported, 0x02014b50);
	unsupported[8] = 9;
	unsupported[9] = 0;
	unsupported[centralOffset + 10] = 9;
	unsupported[centralOffset + 11] = 0;
	const unsupportedEntries = await readZip(memoryByteSource(unsupported), { limits: DEFAULT_ARCHIVE_LIMITS });
	await expect(readMember(findEntry(unsupportedEntries, "descriptor.txt"))).rejects.toThrow(
		"Unsupported ZIP compression method 9",
	);

	const corrupt = (await fixture("zip-basic.zip")).slice();
	const localNameLength = readUInt16(corrupt, 26);
	const localExtraLength = readUInt16(corrupt, 28);
	corrupt[30 + localNameLength + localExtraLength] ^= 1;
	const corruptEntries = await readZip(memoryByteSource(corrupt), { limits: DEFAULT_ARCHIVE_LIMITS });
	await expect(readMember(findEntry(corruptEntries, "plain.txt"))).rejects.toThrow("CRC mismatch");
});

test("enforces entry, index, member, and path limits before metadata-driven work", async () => {
	const bytes = await fixture("zip-basic.zip");
	for (const limits of [
		{ ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 },
		{ ...DEFAULT_ARCHIVE_LIMITS, maxIndexSize: 8 },
		{ ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 8 },
		{ ...DEFAULT_ARCHIVE_LIMITS, maxPathBytes: 4 },
	]) {
		await expect(readZip(memoryByteSource(bytes), { limits })).rejects.toBeInstanceOf(ArchiveError);
	}
});
