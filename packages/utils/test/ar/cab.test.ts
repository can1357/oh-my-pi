import { describe, expect, test } from "bun:test";
import { readUInt32LE } from "../../src/ar/bytes";
import { readCab, sniffCab } from "../../src/ar/cab";
import { ArchiveError } from "../../src/ar/error";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/ar/limits";
import { type ByteSource, memoryByteSource } from "../../src/ar/source";
import type { ArchiveIndexEntry } from "../../src/ar/types";
import { arFixture as fixtureBytes } from "./fixtures";

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

function indexOfAscii(bytes: Uint8Array, value: string): number {
	const needle = new TextEncoder().encode(value);
	outer: for (let offset = 0; offset <= bytes.byteLength - needle.byteLength; offset++) {
		for (let index = 0; index < needle.byteLength; index++) {
			if (bytes[offset + index] !== needle[index]) continue outer;
		}
		return offset;
	}
	return -1;
}

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

const expectedNestedPayload = `nested cabinet payload\n${"history-window-line\n".repeat(3000)}`;

describe("Microsoft Cabinet fixtures", () => {
	test("indexes nested paths and extracts uncompressed folder members", async () => {
		const bytes = await fixtureBytes("cab-none.cab");
		expect(sniffCab(bytes.subarray(0, 128 * 1024))).toBe(true);
		expect(sniffCab(new TextEncoder().encode("not a cabinet"))).toBe(false);
		const entries = await readCab(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(entries.map(entry => entry.path)).toEqual(["root.txt", "nested/hello.txt", "aa/evil.txt"]);
		expect(findEntry(entries, "root.txt")).toMatchObject({
			isDirectory: false,
			size: 17,
			mode: 0o100644,
		});
		expect(findEntry(entries, "root.txt").mtimeMs).toBeNumber();
		expect(textDecoder.decode(await readMember(findEntry(entries, "root.txt")))).toBe("CAB root payload\n");
		expect(textDecoder.decode(await readMember(findEntry(entries, "nested/hello.txt")))).toBe(expectedNestedPayload);
	});

	test("carries the MSZIP dictionary across CFDATA blocks and caches the decoded folder", async () => {
		const fixture = await fixtureBytes("cab-mszip.cab");
		let reads = 0;
		let bytesRead = 0;
		const source: ByteSource = {
			size: fixture.byteLength,
			async read(start, end) {
				reads++;
				bytesRead += end - start;
				return fixture.subarray(start, end);
			},
		};
		const entries = await readCab(source, { limits: DEFAULT_ARCHIVE_LIMITS });
		const indexedReads = reads;
		const indexedBytes = bytesRead;
		expect(indexedBytes).toBeLessThan(fixture.byteLength);
		expect(textDecoder.decode(await readMember(findEntry(entries, "root.txt")))).toBe("CAB root payload\n");
		expect(reads).toBe(indexedReads + 1);
		expect(textDecoder.decode(await readMember(findEntry(entries, "nested/hello.txt")))).toBe(expectedNestedPayload);
		expect(reads).toBe(indexedReads + 1);
	});

	test("extracts known-good libmspack MSZIP and LZX folders and detects Quantum", async () => {
		const bytes = await fixtureBytes("cab-mixed-reference.cab");
		const entries = await readCab(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(entries.map(entry => [entry.path, entry.size])).toEqual([
			["mszip.txt", 57],
			["lzx.txt", 187],
			["qtm.txt", 59],
		]);
		expect(sha256(await readMember(findEntry(entries, "mszip.txt")))).toBe(
			"6a2d9536b995c42a9b9daa2c2eaabf9a1e13e594669a420f8d3e66150af33cff",
		);
		expect(sha256(await readMember(findEntry(entries, "lzx.txt")))).toBe(
			"e978598104671296857e0543f4280f4d4e0506dd3cad5162e9f2a4f604fafc78",
		);
		await expect(readMember(findEntry(entries, "qtm.txt"))).rejects.toThrow("Quantum (level 18)");
	});

	test("decodes LZX uncompressed blocks and applies the intra-frame E8 transform", async () => {
		const bytes = await fixtureBytes("cab-lzx-e8.cab");
		const entries = await readCab(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		const extracted = await readMember(findEntry(entries, "e8.bin"));
		expect(sha256(extracted)).toBe("ea4ff46bad2ca4bea457b9a5cabbbc353f9446b7b40f83f15fd6fab262192d52");
		expect(Array.from(extracted.subarray(5, 10))).toEqual([0xe8, 15, 0, 0, 0]);
	});

	test("skips CFHEADER, CFFOLDER, and CFDATA reserve areas while verifying the block checksum", async () => {
		const bytes = await fixtureBytes("cab-reserved.cab");
		const entries = await readCab(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(entries.map(entry => entry.path)).toEqual(["reserved.txt"]);
		expect(sha256(await readMember(entries[0]!))).toBe(
			"356fccab233a844365ec431e6208ca69cf7a57884f32a5f5f831124102f4fb84",
		);
	});
});

test("drops a member path that escapes the archive root", async () => {
	const bytes = (await fixtureBytes("cab-none.cab")).slice();
	const offset = indexOfAscii(bytes, "aa\\evil.txt");
	expect(offset).toBeGreaterThanOrEqual(0);
	bytes.set(new TextEncoder().encode("..\\evil.txt"), offset);
	const entries = await readCab(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
	expect(entries.some(entry => entry.path === "aa/evil.txt" || entry.path === "evil.txt")).toBe(false);
});

test("honors UTF-8 names and maps CAB directory attributes to Unix mode bits", async () => {
	const utf8 = (await fixtureBytes("cab-reserved.cab")).slice();
	const fileOffset = readUInt32LE(utf8, 16);
	const encodedName = new TextEncoder().encode("résumé.txt");
	expect(encodedName.byteLength).toBe("reserved.txt".length);
	utf8.set(encodedName, fileOffset + 16);
	utf8[fileOffset + 14]! |= 0x80;
	const utf8Entries = await readCab(memoryByteSource(utf8), { limits: DEFAULT_ARCHIVE_LIMITS });
	expect(utf8Entries[0]?.path).toBe("résumé.txt");

	const directory = (await fixtureBytes("cab-reserved.cab")).slice();
	const directoryOffset = readUInt32LE(directory, 16);
	new DataView(directory.buffer, directory.byteOffset, directory.byteLength).setUint32(directoryOffset, 0, true);
	directory[directoryOffset + 14]! |= 0x10;
	const directoryEntries = await readCab(memoryByteSource(directory), { limits: DEFAULT_ARCHIVE_LIMITS });
	expect(directoryEntries[0]).toMatchObject({
		path: "reserved.txt",
		isDirectory: true,
		size: 0,
		mode: 0o040755,
		storage: undefined,
	});
});

test("rejects truncation, multi-volume links, checksum damage, and invalid MSZIP framing", async () => {
	const fixture = await fixtureBytes("cab-none.cab");
	await expect(
		readCab(memoryByteSource(fixture.subarray(0, fixture.byteLength - 1)), { limits: DEFAULT_ARCHIVE_LIMITS }),
	).rejects.toBeInstanceOf(ArchiveError);

	const multiVolume = fixture.slice();
	multiVolume[30]! |= 1;
	await expect(readCab(memoryByteSource(multiVolume), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
		"multi-volume CAB archive",
	);

	const corrupt = fixture.slice();
	corrupt[corrupt.byteLength - 1]! ^= 0xff;
	const corruptEntries = await readCab(memoryByteSource(corrupt), { limits: DEFAULT_ARCHIVE_LIMITS });
	await expect(readMember(findEntry(corruptEntries, "root.txt"))).rejects.toThrow("checksum mismatch");

	const mszip = (await fixtureBytes("cab-mszip.cab")).slice();
	const dataStart = readUInt32LE(mszip, 36);
	mszip.fill(0, dataStart, dataStart + 4);
	mszip[dataStart + 8] = 0;
	const mszipEntries = await readCab(memoryByteSource(mszip), { limits: DEFAULT_ARCHIVE_LIMITS });
	await expect(readMember(findEntry(mszipEntries, "root.txt"))).rejects.toThrow("CK signature");
});

test("detects unsupported compression parameters and verifies extraction size", async () => {
	const fixture = (await fixtureBytes("cab-none.cab")).slice();
	fixture[42] = 2;
	fixture[43] = 18;
	const quantumEntries = await readCab(memoryByteSource(fixture), { limits: DEFAULT_ARCHIVE_LIMITS });
	await expect(readMember(findEntry(quantumEntries, "root.txt"))).rejects.toThrow("Quantum (level 18)");

	const validEntries = await readCab(memoryByteSource(await fixtureBytes("cab-mszip.cab")), {
		limits: DEFAULT_ARCHIVE_LIMITS,
	});
	const root = findEntry(validEntries, "root.txt");
	if (root.storage?.type !== "member") throw new Error("root.txt is not a member");
	await expect(root.storage.source.read(root.size + 1, root.path)).rejects.toThrow("size changed");
});

test("enforces index, entry, member, path, and in-memory folder limits", async () => {
	const fixture = await fixtureBytes("cab-none.cab");
	await expect(
		readCab(memoryByteSource(fixture), { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxIndexSize: 64 } }),
	).rejects.toThrow("CAB index");
	await expect(
		readCab(memoryByteSource(fixture), { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 2 } }),
	).rejects.toThrow("too many entries");
	await expect(
		readCab(memoryByteSource(fixture), { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 16 } }),
	).rejects.toThrow("too large to extract");
	await expect(
		readCab(memoryByteSource(fixture), { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxPathBytes: 7 } }),
	).rejects.toThrow("member path exceeds 7 bytes");
	await expect(
		readCab(memoryByteSource(fixture), { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxInMemorySize: 32 * 1024 } }),
	).rejects.toThrow("too large to read in memory");
});
