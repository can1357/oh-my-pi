import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { bzip2Decompress, isBzip2 } from "../../src/ar/codecs/bzip2";
import { isCompressZ, lzwDecompress } from "../../src/ar/codecs/lzw";
import { ArchiveError } from "../../src/ar/error";
import { arFixture } from "./fixtures";

function sha256(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function fixture(name: string): Promise<Uint8Array> {
	return arFixture(`codecs/${name}`);
}

describe("bzip2 decoder", () => {
	test("decodes a level-1 multi-block stream byte-identically", async () => {
		const compressed = await fixture("bzip-level-1.txt.bz2");
		expect(isBzip2(compressed)).toBe(true);
		const decoded = await bzip2Decompress(compressed, 813_520);
		expect(decoded.byteLength).toBe(813_520);
		expect(sha256(decoded)).toBe("81e63e3c3942b040fbcd62e0dcfcccfa97c95ede85c0d9df1e60d9452574728b");
	});

	test("decodes a level-9 multi-block stream byte-identically", async () => {
		const compressed = await fixture("bzip-level-9.txt.bz2");
		const decoded = await bzip2Decompress(compressed, 1_829_150);
		expect(decoded.byteLength).toBe(1_829_150);
		expect(sha256(decoded)).toBe("63d3996fced6e1df4e9346ba5378620800a95ce77d51b5088863db96675a0912");
	});

	test("decodes concatenated streams", async () => {
		const compressed = await fixture("bzip-concatenated.bz2");
		const decoded = await bzip2Decompress(compressed, 71);
		expect(new TextDecoder().decode(decoded)).toBe(
			"first concatenated stream\nsecond concatenated stream\nwith another line\n",
		);
		expect(sha256(decoded)).toBe("47f7efe1fd83980f616b5e824ce079c39d83d70898a1acc7d3fa9e649d1c3cfd");
	});

	test("rejects truncated streams and bad block CRCs", async () => {
		const compressed = await fixture("bzip-level-1.txt.bz2");
		await expect(bzip2Decompress(compressed.subarray(0, compressed.byteLength - 1), 1_000_000)).rejects.toThrow(
			"Truncated bzip2 stream",
		);

		const badCrc = compressed.slice();
		badCrc[10] ^= 0x01;
		await expect(bzip2Decompress(badCrc, 1_000_000)).rejects.toThrow("Bzip2 block CRC mismatch");
	});

	test("enforces maxOutput before expansion can overrun it", async () => {
		const compressed = await fixture("bzip-level-1.txt.bz2");
		const promise = bzip2Decompress(compressed, 1000);
		await expect(promise).rejects.toBeInstanceOf(ArchiveError);
		await expect(promise).rejects.toThrow("Bzip2 output exceeds the 1000-byte limit");
	});

	test("sniffing rejects partial and invalid signatures", () => {
		expect(isBzip2(new Uint8Array([0x42, 0x5a, 0x68]))).toBe(false);
		expect(isBzip2(new Uint8Array([0x42, 0x5a, 0x68, 0x30]))).toBe(false);
	});
});

describe("ncompress LZW decoder", () => {
	test("decodes a 16-bit block-mode stream byte-identically", async () => {
		const compressed = await fixture("ncompress.bin.Z");
		expect(isCompressZ(compressed)).toBe(true);
		const decoded = await lzwDecompress(compressed, 180_000);
		expect(decoded.byteLength).toBe(180_000);
		expect(sha256(decoded)).toBe("35b19599038e534308e21e6c57cb60953ea6fb2e559ced2f870f76c3a16b2dc6");
	});

	test("resets block-mode state after a CLEAR code group", async () => {
		const compressed = new Uint8Array([
			0x1f, 0x9d, 0x89, 0x41, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x42, 0x00,
		]);
		expect(new TextDecoder().decode(await lzwDecompress(compressed, 2))).toBe("AB");
	});

	test("rejects truncated headers and reserved flags", async () => {
		await expect(lzwDecompress(new Uint8Array([0x1f, 0x9d]), 100)).rejects.toThrow("Truncated compress (.Z) header");
		await expect(lzwDecompress(new Uint8Array([0x1f, 0x9d, 0xa9]), 100)).rejects.toThrow(
			"Unsupported compress (.Z) header flags",
		);
	});

	test("rejects corrupt codes and fixture truncation", async () => {
		await expect(lzwDecompress(new Uint8Array([0x1f, 0x9d, 0x90, 0x01, 0x01]), 100)).rejects.toThrow(
			"dictionary code 257",
		);
		const compressed = await fixture("ncompress.bin.Z");
		await expect(lzwDecompress(compressed.subarray(0, compressed.byteLength - 1), 200_000)).rejects.toThrow(
			"padding",
		);
	});

	test("enforces maxOutput during dictionary expansion", async () => {
		const compressed = await fixture("ncompress.bin.Z");
		const promise = lzwDecompress(compressed, 1024);
		await expect(promise).rejects.toBeInstanceOf(ArchiveError);
		await expect(promise).rejects.toThrow("Compress (.Z) output exceeds the 1024-byte limit");
	});

	test("sniffing requires both magic bytes", () => {
		expect(isCompressZ(new Uint8Array([0x1f]))).toBe(false);
		expect(isCompressZ(new Uint8Array([0x1f, 0x9d]))).toBe(true);
		expect(isCompressZ(new Uint8Array([0x1f, 0x8b]))).toBe(false);
	});
});
