import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { ArchiveError } from "../../src/ar/error";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/ar/limits";
import { readRar, sniffRar } from "../../src/ar/rar";
import { memoryByteSource } from "../../src/ar/source";
import type { ArchiveIndexEntry } from "../../src/ar/types";
import { arFixture as fixture } from "./fixtures";

const EXPECTED_HASHES: Record<string, string> = {
	"input/hello.txt": "7f1620bec2523375e14494eade9ebdc362926b11904813809c503f2eb691aeff",
	"input/nested/data.bin": "10fc3c51a152e90e5b90319b601d92ccf37290ef53c35ff92507687d8a911a08",
	"input/naive-☃.txt": "1dcc4cea49428fe3a0d2df11ba03ed049e3860511144de489f2e5a0cc53c989d",
	"input/x86.bin": "2aad26e4b16a8535154aa7948ed00398f04104a65b1dfe34e89bd64235b6999d",
};

async function entries(name: string): Promise<ArchiveIndexEntry[]> {
	const bytes = await fixture(name);
	return readRar(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
}

function findEntry(index: ArchiveIndexEntry[], memberPath: string): ArchiveIndexEntry {
	const entry = index.find(candidate => candidate.path === memberPath);
	if (!entry) throw new Error(`Missing fixture entry ${memberPath}`);
	return entry;
}

async function extract(entry: ArchiveIndexEntry): Promise<Uint8Array> {
	if (entry.storage?.type !== "member") throw new Error(`${entry.path} is not a regular member`);
	return entry.storage.source.read(entry.size, entry.path);
}

function sha256(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

describe("RAR5", () => {
	test("sniffs, indexes Unicode and nested paths, and extracts stored members", async () => {
		const bytes = await fixture("rar5-store.rar");
		expect(sniffRar(bytes)).toBe(true);
		const index = await readRar(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(index.map(entry => entry.path)).toEqual(["input/hello.txt", "input/nested/data.bin", "input/naive-☃.txt"]);
		for (const entry of index) {
			expect(sha256(await extract(entry))).toBe(EXPECTED_HASHES[entry.path]);
			expect(entry.mtimeMs).toBeGreaterThan(1_700_000_000_000);
			expect(entry.mode! & 0o170000).toBe(0o100000);
		}
	});

	test("indexes range sources without reading member payloads", async () => {
		const bytes = await fixture("rar5-store.rar");
		const reads: Array<readonly [number, number]> = [];
		const source = {
			size: bytes.byteLength,
			async read(start: number, end: number) {
				reads.push([start, end]);
				return bytes.subarray(start, end);
			},
		};
		const index = await readRar(source, { limits: DEFAULT_ARCHIVE_LIMITS });
		const payloadOffset = Buffer.from(bytes).indexOf("hello from rar\n");
		expect(payloadOffset).toBeGreaterThan(0);
		expect(reads.some(([start, end]) => start <= payloadOffset && end > payloadOffset)).toBe(false);
		await extract(findEntry(index, "input/hello.txt"));
		expect(reads.some(([start, end]) => start <= payloadOffset && end > payloadOffset)).toBe(true);
	});

	test("finds an archive after an SFX prefix", async () => {
		const archive = await fixture("rar5-store.rar");
		const bytes = new Uint8Array(37 + archive.byteLength);
		bytes.fill(0xcc, 0, 37);
		bytes.set(archive, 37);
		expect(sniffRar(bytes)).toBe(true);
		const index = await readRar(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(sha256(await extract(findEntry(index, "input/hello.txt")))).toBe(EXPECTED_HASHES["input/hello.txt"]);
	});

	test("extracts compressed members including x86-filtered data", async () => {
		const index = await entries("rar5-default.rar");
		for (const entry of index) expect(sha256(await extract(entry))).toBe(EXPECTED_HASHES[entry.path]);
	});

	test("reverses a forced RAR5 x86 filter", async () => {
		const index = await entries("rar5-x86-filter.rar");
		const x86 = findEntry(index, "input/x86.bin");
		expect(sha256(await extract(x86))).toBe(EXPECTED_HASHES[x86.path]);
	});

	test("decodes solid predecessors when a later member is requested first", async () => {
		const index = await entries("rar5-solid.rar");
		const x86 = findEntry(index, "input/x86.bin");
		expect(sha256(await extract(x86))).toBe(EXPECTED_HASHES[x86.path]);
		const hello = findEntry(index, "input/hello.txt");
		expect(sha256(await extract(hello))).toBe(EXPECTED_HASHES[hello.path]);
	});

	test("indexes Unix symlinks", async () => {
		const index = await entries("rar5-symlink.rar");
		const link = findEntry(index, "input/links/hello-link");
		expect(link.mode! & 0o170000).toBe(0o120000);
		expect(link.storage).toEqual({ type: "link", targetPath: "input/hello.txt", resolveTarget: true });
	});

	test("rejects file/header encryption and volumes precisely", async () => {
		await expect(entries("rar5-password.rar")).rejects.toThrow("Encrypted RAR5 member");
		await expect(entries("rar5-header-password.rar")).rejects.toThrow("Encrypted RAR5 headers");
		await expect(entries("rar5-volume.rar")).rejects.toThrow("multi-volume RAR5");
		await expect(entries("rar5-recovery.rar")).rejects.toThrow("RAR5 recovery record");
		const unsupported = await entries("rar5-unsupported.rar");
		await expect(extract(findEntry(unsupported, "input/hello.txt"))).rejects.toThrow(
			"Unsupported RAR5 compression method 6",
		);
	});
});

describe("RAR4", () => {
	test("indexes Unicode paths and extracts stored members with Unix metadata", async () => {
		const index = await entries("rar4-store.rar");
		expect(index.map(entry => entry.path)).toEqual(["input/hello.txt", "input/nested/data.bin", "input/naive-☃.txt"]);
		for (const entry of index) {
			expect(sha256(await extract(entry))).toBe(EXPECTED_HASHES[entry.path]);
			expect(entry.mtimeMs).toBeGreaterThan(1_700_000_000_000);
			expect(entry.mode! & 0o170000).toBe(0o100000);
		}
	});

	test("decodes RAR 2.9 LZ/Huffman members", async () => {
		const index = await entries("rar4-default.rar");
		for (const entry of index) expect(sha256(await extract(entry))).toBe(EXPECTED_HASHES[entry.path]);
	});

	test("indexes RAR4 Unix symlinks", async () => {
		const index = await entries("rar4-symlink.rar");
		const link = findEntry(index, "input/links/hello-link");
		expect(link.mode! & 0o170000).toBe(0o120000);
		expect(link.storage).toEqual({ type: "link", targetPath: "input/hello.txt", resolveTarget: true });
	});

	test("detects unsupported RAR4 PPMd blocks", async () => {
		const index = await entries("rar4-ppm.rar");
		await expect(extract(findEntry(index, "input/ppm.txt"))).rejects.toThrow("PPMd compressed block");
	});

	test("rejects encrypted RAR4 data and headers", async () => {
		await expect(entries("rar4-password.rar")).rejects.toThrow("Encrypted RAR4 file data");
		await expect(entries("rar4-header-password.rar")).rejects.toThrow("Encrypted RAR4 headers");
		await expect(entries("rar4-recovery.rar")).rejects.toThrow("RAR4 recovery record");
		await expect(entries("rar4-unsupported.rar")).rejects.toThrow("Unsupported RAR4 compression method 0x36");
	});
});

test("RAR corruption, traversal, and limits fail safely", async () => {
	const original = await fixture("rar5-store.rar");
	const traversal = await entries("rar5-traversal.rar");
	expect(traversal.map(entry => entry.path)).not.toContain("../escape.txtxx");
	expect(sha256(await extract(findEntry(traversal, "input/nested/data.bin")))).toBe(
		EXPECTED_HASHES["input/nested/data.bin"],
	);
	await expect(
		readRar(memoryByteSource(original.subarray(0, original.byteLength - 3)), { limits: DEFAULT_ARCHIVE_LIMITS }),
	).rejects.toBeInstanceOf(ArchiveError);
	const corrupt = original.slice();
	corrupt[20] ^= 1;
	await expect(readRar(memoryByteSource(corrupt), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
		"header CRC32 mismatch",
	);
	const damagedPayload = original.slice();
	const payloadOffset = Buffer.from(damagedPayload).indexOf("hello from rar\n");
	if (payloadOffset < 0) throw new Error("Stored RAR fixture payload is missing");
	damagedPayload[payloadOffset] ^= 1;
	const damagedEntries = await readRar(memoryByteSource(damagedPayload), { limits: DEFAULT_ARCHIVE_LIMITS });
	await expect(extract(findEntry(damagedEntries, "input/hello.txt"))).rejects.toThrow("CRC32 mismatch");
	await expect(
		readRar(memoryByteSource(original), { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 5 } }),
	).rejects.toThrow("too large");
	await expect(
		readRar(memoryByteSource(original), { limits: { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 } }),
	).rejects.toThrow("too many entries");
});
