import { describe, expect, test } from "bun:test";
import { readArj, sniffArj } from "../../src/ar/arj";
import { ArchiveError } from "../../src/ar/error";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/ar/limits";
import { readLzh, sniffLzh } from "../../src/ar/lzh";
import { memoryByteSource } from "../../src/ar/source";
import type { ArchiveIndexEntry, FormatReader } from "../../src/ar/types";
import { arFixture as fixtureBytes } from "./fixtures";

const REPEAT_SHA256 = "6c569d00a8d8d31338d7f1ac134f0d6cbd014446568063ac0b919ab042e0dcf5";

async function readFixture(name: string, reader: FormatReader): Promise<ArchiveIndexEntry[]> {
	const bytes = await fixtureBytes(name);
	return reader(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
}

async function extract(entries: ArchiveIndexEntry[], path: string): Promise<Uint8Array> {
	const entry = entries.find(candidate => candidate.path === path);
	if (entry?.storage?.type !== "member") throw new Error(`Missing fixture member ${path}`);
	return entry.storage.source.read(entry.size, entry.path);
}

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

describe("LZH/LHA", () => {
	test("sniffs valid headers and rejects unrelated bytes", async () => {
		expect(sniffLzh(await fixtureBytes("lzh-level0-lh5.lzh"))).toBe(true);
		expect(sniffLzh(new Uint8Array(64))).toBe(false);
	});

	test.each([
		["lzh-level0-lh5.lzh", "lh5"],
		["lzh-level1-lh6.lzh", "lh6"],
		["lzh-level2-lh7.lzh", "lh7"],
	] as const)("indexes header levels and nested entries: %s (%s)", async fixture => {
		const entries = await readFixture(fixture, readLzh);
		expect(entries.map(entry => entry.path)).toEqual(["hello.txt", "nested", "nested/mode.sh", "nested/repeat.txt"]);
		expect(entries.find(entry => entry.path === "nested")?.isDirectory).toBe(true);
		expect(entries[0]?.mtimeMs).toBe(1_700_000_000_000);
		expect(sha256(await extract(entries, "nested/repeat.txt"))).toBe(REPEAT_SHA256);
	});

	test.each(["lzh-level0-lh4.lzh", "lzh-level0-lh5.lzh", "lzh-level1-lh6.lzh", "lzh-level2-lh7.lzh"] as const)(
		"decodes every static-Huffman method in %s",
		async fixture => {
			const entries = await readFixture(fixture, readLzh);
			expect(sha256(await extract(entries, "nested/repeat.txt"))).toBe(REPEAT_SHA256);
		},
	);

	test("decodes stored -lz4- and legacy -lzs- streams", async () => {
		const lz4 = await readFixture("lzh-lz4.lzh", readLzh);
		const lzs = await readFixture("lzh-lzs.lzh", readLzh);
		expect(new TextDecoder().decode(await extract(lz4, "legacy/lz4.txt"))).toBe("LArc legacy stream\n");
		expect(new TextDecoder().decode(await extract(lzs, "legacy/lzs.txt"))).toBe("LArc legacy stream\n");
	});

	test("prefers Unicode path extensions and exposes Unix metadata", async () => {
		const entries = await readFixture("lzh-unicode-level2.lzh", readLzh);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ path: "unicode/雪.txt", mode: 0x81a4, mtimeMs: 1_700_000_000_000 });
		expect(new TextDecoder().decode(await extract(entries, "unicode/雪.txt"))).toBe("Unicode LZH path\n");
	});

	test("drops traversal paths", async () => {
		expect(await readFixture("lzh-traversal.lzh", readLzh)).toEqual([]);
	});

	test("reports unsupported dynamic Huffman precisely", async () => {
		const entries = await readFixture("lzh-unsupported-lh1.lzh", readLzh);
		expect(extract(entries, "unsupported.txt")).rejects.toThrow("unsupported dynamic-Huffman method -lh1-");
	});

	test("rejects truncated headers and corrupt member CRCs", async () => {
		const original = await fixtureBytes("lzh-level2-stored.lzh");
		expect(
			readLzh(memoryByteSource(original.subarray(0, 12)), { limits: DEFAULT_ARCHIVE_LIMITS }),
		).rejects.toBeInstanceOf(ArchiveError);
		const corrupted = original.slice();
		corrupted[corrupted.length - 2]! ^= 0x80;
		const entries = await readLzh(memoryByteSource(corrupted), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(extract(entries, "nested/repeat.txt")).rejects.toThrow("CRC-16 verification");
	});
});

describe("ARJ", () => {
	test("sniffs a CRC-valid main header and rejects unrelated bytes", async () => {
		expect(sniffArj(await fixtureBytes("arj-method1.arj"))).toBe(true);
		expect(sniffArj(new Uint8Array(64))).toBe(false);
	});

	test.each([0, 1, 2, 3, 4] as const)("decodes method %i", async method => {
		const entries = await readFixture(`arj-method${method}.arj`, readArj);
		expect(entries.map(entry => entry.path)).toEqual(["hello.txt", "nested/mode.sh", "nested/repeat.txt"]);
		expect(sha256(await extract(entries, "nested/repeat.txt"))).toBe(REPEAT_SHA256);
	});

	test("exposes Unix mode and host timestamp metadata", async () => {
		const entries = await readFixture("arj-method1.arj", readArj);
		expect(entries.find(entry => entry.path === "hello.txt")).toMatchObject({
			mode: 0x81a4,
			mtimeMs: 1_700_000_000_000,
		});
		expect(entries.find(entry => entry.path === "nested/mode.sh")?.mode).toBe(0x81ed);
	});

	test.each([
		["arj-encrypted.arj", "Encrypted ARJ members are unsupported"],
		["arj-multivolume.arj", "Multi-volume ARJ members are unsupported"],
	] as const)("detects unsupported archive features in %s", async (fixture, message) => {
		expect(readFixture(fixture, readArj)).rejects.toThrow(message);
	});

	test("reports unknown methods when extraction is requested", async () => {
		const entries = await readFixture("arj-unsupported.arj", readArj);
		expect(extract(entries, "hello.txt")).rejects.toThrow("unsupported compression method 7");
	});

	test("drops traversal paths while retaining safe entries", async () => {
		const entries = await readFixture("arj-traversal.arj", readArj);
		expect(entries.map(entry => entry.path)).toEqual(["nested/mode.sh", "nested/repeat.txt"]);
	});

	test("rejects truncated and header-CRC-corrupt input", async () => {
		const original = await fixtureBytes("arj-method1.arj");
		expect(
			readArj(memoryByteSource(original.subarray(0, 20)), { limits: DEFAULT_ARCHIVE_LIMITS }),
		).rejects.toBeInstanceOf(ArchiveError);
		const corrupted = original.slice();
		corrupted[12]! ^= 1;
		expect(readArj(memoryByteSource(corrupted), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
			"archive header",
		);
	});
});
