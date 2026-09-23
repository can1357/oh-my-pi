import { describe, expect, test } from "bun:test";
import { ArchiveError } from "../../src/ar/error";
import { readIso, sniffIso } from "../../src/ar/iso";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/ar/limits";
import { type ByteSource, memoryByteSource } from "../../src/ar/source";
import type { ArchiveIndexEntry } from "../../src/ar/types";
import { arFixture } from "./fixtures";

const textDecoder = new TextDecoder();

function findEntry(entries: ArchiveIndexEntry[], memberPath: string): ArchiveIndexEntry {
	const entry = entries.find(candidate => candidate.path === memberPath);
	if (!entry) throw new Error(`Missing test entry ${memberPath}`);
	return entry;
}

async function readMember(entry: ArchiveIndexEntry): Promise<Uint8Array> {
	if (entry.storage?.type !== "member") throw new Error(`Test entry ${entry.path} is not a member`);
	return entry.storage.source.read(entry.size, entry.path);
}

function indexOfSequence(bytes: Uint8Array, sequence: Uint8Array): number {
	outer: for (let offset = 0; offset <= bytes.byteLength - sequence.byteLength; offset++) {
		for (let index = 0; index < sequence.byteLength; index++) {
			if (bytes[offset + index] !== sequence[index]) continue outer;
		}
		return offset;
	}
	return -1;
}

function ucs2be(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length * 2);
	for (let index = 0; index < value.length; index++) {
		bytes[index * 2] = value.charCodeAt(index) >>> 8;
		bytes[index * 2 + 1] = value.charCodeAt(index) & 0xff;
	}
	return bytes;
}

async function fixtureBytes(): Promise<Uint8Array> {
	return arFixture("rock-ridge-joliet.iso");
}

describe("ISO 9660 fixtures", () => {
	test("prefers Joliet names and lists deep directories and Rock Ridge links", async () => {
		const bytes = await fixtureBytes();
		expect(sniffIso(bytes.subarray(0, 128 * 1024))).toBe(true);
		const entries = await readIso(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(entries.map(entry => entry.path)).toEqual([
			"empty-dir",
			"hello.txt",
			"nested",
			"nested/deep",
			"nested/日本語-long-name.txt",
			"nested/deep/level",
			"nested/deep/level/three",
			"nested/deep/level/three/end.bin",
			"nested/hello-link",
		]);
		expect(findEntry(entries, "empty-dir")).toMatchObject({ isDirectory: true, size: 0 });
		expect(findEntry(entries, "nested/deep/level/three")).toMatchObject({ isDirectory: true, size: 0 });
		const link = findEntry(entries, "nested/hello-link");
		expect((findEntry(entries, "hello.txt").mode ?? 0) & 0o170000).toBe(0o100000);
		expect(link.storage).toEqual({ type: "link", targetPath: "hello.txt", resolveTarget: true });
		expect((link.mode ?? 0) & 0o170000).toBe(0o120000);
		expect(link.mtimeMs).toBeNumber();
	});

	test("extracts file extents lazily and verifies declared sizes", async () => {
		const bytes = await fixtureBytes();
		let bytesRead = 0;
		let reads = 0;
		const source: ByteSource = {
			size: bytes.byteLength,
			async read(start, end) {
				reads++;
				bytesRead += end - start;
				return bytes.subarray(start, end);
			},
		};
		const entries = await readIso(source, { limits: DEFAULT_ARCHIVE_LIMITS });
		const indexedBytes = bytesRead;
		const indexedReads = reads;
		expect(indexedBytes).toBeLessThan(bytes.byteLength);
		expect(textDecoder.decode(await readMember(findEntry(entries, "hello.txt")))).toBe("hello from iso\n");
		expect(textDecoder.decode(await readMember(findEntry(entries, "nested/日本語-long-name.txt")))).toBe(
			"unicode payload\n",
		);
		expect(textDecoder.decode(await readMember(findEntry(entries, "nested/deep/level/three/end.bin")))).toBe(
			"deep end\n",
		);
		expect(bytesRead).toBeGreaterThan(indexedBytes);
		expect(reads).toBeGreaterThan(indexedReads);
		const hello = findEntry(entries, "hello.txt");
		if (hello.storage?.type !== "member") throw new Error("hello.txt is not a member");
		await expect(hello.storage.source.read(hello.size + 1, hello.path)).rejects.toThrow(
			"produced 15 bytes, expected 16",
		);
	});
});

test("drops a Joliet path that escapes the archive root", async () => {
	const bytes = (await fixtureBytes()).slice();
	const identifier = ucs2be("hello.txt");
	const offset = indexOfSequence(bytes, identifier);
	expect(offset).toBeGreaterThanOrEqual(0);
	bytes.set(ucs2be("../bad.txt"), offset);
	const entries = await readIso(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
	expect(entries.some(entry => entry.path === "hello.txt" || entry.path === "bad.txt")).toBe(false);
});

test("rejects truncation, mismatched both-endian fields, and Rock Ridge relocation", async () => {
	const fixture = await fixtureBytes();
	await expect(
		readIso(memoryByteSource(fixture.subarray(0, 64 * 1024)), { limits: DEFAULT_ARCHIVE_LIMITS }),
	).rejects.toBeInstanceOf(ArchiveError);

	const endian = fixture.slice();
	let supplementary = -1;
	for (let sector = 16; sector * 2048 + 7 <= endian.byteLength; sector++) {
		const offset = sector * 2048;
		if (endian[offset] === 2 && textDecoder.decode(endian.subarray(offset + 1, offset + 6)) === "CD001") {
			supplementary = offset;
			break;
		}
	}
	expect(supplementary).toBeGreaterThanOrEqual(0);
	endian[supplementary + 130] ^= 1;
	await expect(readIso(memoryByteSource(endian), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
		"logical block size has mismatched byte orders",
	);

	const relocation = fixture.slice();
	const slOffset = indexOfSequence(relocation, new Uint8Array([0x53, 0x4c, 0x12, 0x01]));
	expect(slOffset).toBeGreaterThanOrEqual(0);
	relocation[slOffset] = 0x43;
	await expect(readIso(memoryByteSource(relocation), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
		"Rock Ridge relocated directory (CL)",
	);
});

test("detects High Sierra and UDF-only images with precise errors", async () => {
	for (const [signature, signatureOffset, message] of [
		["CDROM", 9, "High Sierra"],
		["NSR02", 1, "UDF-only"],
	] as const) {
		const bytes = new Uint8Array(17 * 2048);
		bytes[16 * 2048] = 0;
		bytes.set(new TextEncoder().encode(signature), 16 * 2048 + signatureOffset);
		bytes[16 * 2048 + signatureOffset + 5] = 1;
		await expect(readIso(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(message);
	}
});

test("enforces metadata, entry, member, and path limits", async () => {
	const bytes = await fixtureBytes();
	await expect(
		readIso(memoryByteSource(bytes), { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxIndexSize: 2047 } }),
	).rejects.toThrow("metadata limit");
	await expect(
		readIso(memoryByteSource(bytes), { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 2 } }),
	).rejects.toThrow("too many entries");
	await expect(
		readIso(memoryByteSource(bytes), { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 8 } }),
	).rejects.toThrow("too large to extract");
	await expect(
		readIso(memoryByteSource(bytes), { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxPathBytes: 5 } }),
	).rejects.toThrow("member name exceeds 5 bytes");
});

test("accepts zero-length records with junk extents (bsdtar symlink Joliet entries)", async () => {
	// bsdtar's Joliet record for a Rock Ridge symlink is a zero-length file
	// whose extent points at an unallocated block; 7-Zip and bsdtar accept
	// these, and the Rock Ridge merge must still surface the link.
	const entries = await readIso(memoryByteSource(await arFixture("minimal-symlink.iso")), {
		limits: DEFAULT_ARCHIVE_LIMITS,
	});
	const link = findEntry(entries, "link.txt");
	expect(link.storage?.type).toBe("link");
	if (link.storage?.type !== "link") throw new Error("unreachable");
	expect(link.storage.targetPath).toBe("real.txt");
	const real = findEntry(entries, "real.txt");
	expect(textDecoder.decode(await readMember(real))).toBe("target\n");
});
