import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { crc32 } from "../../src/ar/checksums";
import { lzmaAloneDecompress } from "../../src/ar/codecs/lzma";
import { isXz, xzDecompress } from "../../src/ar/codecs/xz";
import { ArchiveError } from "../../src/ar/error";
import { arFixture as fixture } from "./fixtures";

const TEXT_HASH = "ee8e31cbfe3ffd471a71273fc17c68c50db0aa63d48d6b6b294f5560bfc08c2a";

function sha256(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function read32LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function write32LE(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value;
	bytes[offset + 1] = value >>> 8;
	bytes[offset + 2] = value >>> 16;
	bytes[offset + 3] = value >>> 24;
}

describe("XZ container", () => {
	test("sniffs and verifies none/CRC32/CRC64/SHA-256 stream checks", async () => {
		for (const check of ["crc32", "crc64", "sha256"]) {
			const bytes = await fixture(`xz-${check}.xz`);
			expect(isXz(bytes)).toBe(true);
			expect(sha256(await xzDecompress(bytes, 4096))).toBe(TEXT_HASH);
		}
		expect(isXz(Uint8Array.of(0xfd, 0x37))).toBe(false);
	});

	test("decodes Delta and x86 BCJ filter chains", async () => {
		const delta = await xzDecompress(await fixture("xz-delta.xz"), 4096);
		const x86 = await xzDecompress(await fixture("xz-x86.xz"), 4096);
		expect(sha256(delta)).toBe("0b74a8aff5d7381fa418fe1dcf8b84de32344acc6bea8f1ed3dac26754ba281c");
		expect(sha256(x86)).toBe("3ecc97b751572f0c2078683f95b56e0468b5d75a581531b6dee209727c3d2f48");
	});

	test("decodes and validates a multi-block threaded stream", async () => {
		const output = await xzDecompress(await fixture("xz-multiblock.xz"), 4096);
		expect(sha256(output)).toBe(TEXT_HASH);
	});

	test("decodes unknown-size LZMA-alone streams through their end marker", async () => {
		const bytes = await fixture("lzma-alone.lzma");
		expect(Array.from(bytes.subarray(5, 13))).toEqual(Array.from({ length: 8 }, () => 0xff));
		expect(sha256(await lzmaAloneDecompress(bytes, 215))).toBe(TEXT_HASH);
		await expect(lzmaAloneDecompress(bytes, 10)).rejects.toThrow("size limit");
	});

	test("rejects corrupt checks, truncation, unsupported filters, and output overflow", async () => {
		const original = await fixture("xz-crc32.xz");
		const corruptCheck = original.slice();
		const footer = corruptCheck.byteLength - 12;
		const indexSize = (read32LE(corruptCheck, footer + 4) + 1) * 4;
		const indexStart = footer - indexSize;
		corruptCheck[indexStart - 1] ^= 1;
		await expect(xzDecompress(corruptCheck, 4096)).rejects.toThrow("CRC32 mismatch");
		await expect(xzDecompress(original.subarray(0, original.byteLength - 4), 4096)).rejects.toBeInstanceOf(
			ArchiveError,
		);
		await expect(xzDecompress(original, 10)).rejects.toThrow("size limit");

		const unsupported = original.slice();
		const headerSize = (unsupported[12]! + 1) * 4;
		const headerEnd = 12 + headerSize;
		let filterId = -1;
		for (let index = 14; index < headerEnd - 4; index++)
			if (unsupported[index] === 0x21) {
				filterId = index;
				break;
			}
		if (filterId < 0) throw new Error("Fixture LZMA2 filter ID not found");
		unsupported[filterId] = 0x22;
		write32LE(unsupported, headerEnd - 4, crc32(unsupported.subarray(12, headerEnd - 4)));
		await expect(xzDecompress(unsupported, 4096)).rejects.toThrow("terminal filter ID 0x22");
	});
});
