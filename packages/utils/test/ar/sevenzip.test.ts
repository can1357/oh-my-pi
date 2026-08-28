import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { ArchiveError } from "../../src/ar/error";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/ar/limits";
import { readSevenZip, sniffSevenZip } from "../../src/ar/sevenzip";
import { memoryByteSource } from "../../src/ar/source";
import type { ArchiveIndexEntry } from "../../src/ar/types";
import { arFixture as fixture } from "./fixtures";

const MESSAGE_HASH = "5ef6774c4d7f61a40b8ff89151687d63129888e89efffe183d0de94da95dfd8c";

async function entries(name: string): Promise<ArchiveIndexEntry[]> {
	const bytes = await fixture(name);
	return readSevenZip(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
}

function at(index: ArchiveIndexEntry[], memberPath: string): ArchiveIndexEntry {
	const entry = index.find(candidate => candidate.path === memberPath);
	if (!entry) throw new Error(`Missing fixture member ${memberPath}`);
	return entry;
}

async function extract(entry: ArchiveIndexEntry): Promise<Uint8Array> {
	if (entry.storage?.type !== "member") throw new Error(`${entry.path} is not a regular member`);
	return entry.storage.source.read(entry.size, entry.path);
}

function sha256(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

describe("7z container", () => {
	test("sniffs, indexes nested directories, and preserves time and Unix mode", async () => {
		const bytes = await fixture("sevenzip-default.7z");
		expect(sniffSevenZip(bytes)).toBe(true);
		expect(sniffSevenZip(Uint8Array.of(0x37, 0x7a))).toBe(false);
		const index = await readSevenZip(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(index.map(entry => [entry.path, entry.isDirectory])).toEqual([
			["nested", true],
			["empty.txt", false],
			["nested/message.txt", false],
		]);
		const message = at(index, "nested/message.txt");
		expect(sha256(await extract(message))).toBe(MESSAGE_HASH);
		expect(await extract(at(index, "empty.txt"))).toEqual(new Uint8Array(0));
		expect(message.mtimeMs).toBeGreaterThan(1_700_000_000_000);
		expect(message.mode! & 0o170000).toBe(0o100000);
		expect(at(index, "nested").mode! & 0o170000).toBe(0o040000);
	});

	test("extracts Copy, LZMA, LZMA2, Delta, and BCJ x86 folders byte-identically", async () => {
		const cases: Array<readonly [string, string, string]> = [
			["sevenzip-copy.7z", "nested/message.txt", MESSAGE_HASH],
			["sevenzip-lzma.7z", "nested/message.txt", MESSAGE_HASH],
			["sevenzip-default.7z", "nested/message.txt", MESSAGE_HASH],
			["sevenzip-delta.7z", "delta.bin", "0b74a8aff5d7381fa418fe1dcf8b84de32344acc6bea8f1ed3dac26754ba281c"],
			["sevenzip-bcj.7z", "x86.bin", "3ecc97b751572f0c2078683f95b56e0468b5d75a581531b6dee209727c3d2f48"],
		];
		for (const [archive, memberPath, hash] of cases) {
			expect(sha256(await extract(at(await entries(archive), memberPath)))).toBe(hash);
		}
	});

	test("shares one decoded folder across solid members requested out of order", async () => {
		const bytes = await fixture("sevenzip-solid.7z");
		let reads = 0;
		const source = {
			size: bytes.byteLength,
			async read(start: number, end: number) {
				reads++;
				return bytes.subarray(start, end);
			},
		};
		const index = await readSevenZip(source, { limits: DEFAULT_ARCHIVE_LIMITS });
		const readsAfterIndex = reads;
		expect(sha256(await extract(at(index, "nested/message.txt")))).toBe(MESSAGE_HASH);
		expect(reads).toBe(readsAfterIndex + 1);
		expect(sha256(await extract(at(index, "alpha.txt")))).toBe(
			"a5db0353cdd8fda86cfc74087d4e52b2826e29f72b2bcc2485fa977947a8d8f1",
		);
		expect(sha256(await extract(at(index, "beta.txt")))).toBe(
			"5e78ec08a413b9961fae10bf2220968746fa770c80299f66d74a158bf5b6ac84",
		);
		expect(reads).toBe(readsAfterIndex + 1);
	});

	test("models Unix symlinks from attributes and payload", async () => {
		const link = at(await entries("sevenzip-symlink.7z"), "link-to-message");
		expect(link.mode! & 0o170000).toBe(0o120000);
		expect(link.storage).toEqual({ type: "link", targetPath: "nested/message.txt", resolveTarget: true });
	});

	test("drops traversal names without disturbing stream mapping", async () => {
		expect(await entries("sevenzip-traversal.7z")).toEqual([]);
	});

	test("rejects encrypted headers and unsupported PPMd precisely", async () => {
		await expect(entries("sevenzip-encrypted.7z")).rejects.toThrow("7zAES");
		const ppmd = at(await entries("sevenzip-ppmd.7z"), "nested/message.txt");
		await expect(extract(ppmd)).rejects.toThrow("PPMd");
	});

	test("detects truncation, payload corruption, and member-size limits", async () => {
		const original = await fixture("sevenzip-copy.7z");
		await expect(
			readSevenZip(memoryByteSource(original.subarray(0, 20)), { limits: DEFAULT_ARCHIVE_LIMITS }),
		).rejects.toBeInstanceOf(ArchiveError);
		const corrupt = original.slice();
		corrupt[32] ^= 0x80;
		const corruptIndex = await readSevenZip(memoryByteSource(corrupt), { limits: DEFAULT_ARCHIVE_LIMITS });
		await expect(extract(at(corruptIndex, "nested/message.txt"))).rejects.toBeInstanceOf(ArchiveError);
		await expect(
			readSevenZip(memoryByteSource(original), {
				limits: { ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 1 },
			}),
		).rejects.toThrow("too large");
	});
});
