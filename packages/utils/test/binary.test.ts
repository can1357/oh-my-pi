import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isProbablyBinary, isProbablyBinaryHeader, isProbablyBinarySync } from "@oh-my-pi/pi-utils/binary";

describe("isProbablyBinaryHeader", () => {
	it("treats empty input as text", () => {
		expect(isProbablyBinaryHeader(new Uint8Array(0))).toBe(false);
	});

	it("flags a NUL byte as binary", () => {
		// TTF/OTF, WASM, ELF, UTF-16 text all carry NUL in their first bytes.
		expect(isProbablyBinaryHeader(Buffer.from([0x00, 0x01, 0x00, 0x00]))).toBe(true);
	});

	it("flags invalid UTF-8 without a NUL as binary", () => {
		// 0xFF/0xFE never appear in valid UTF-8; a font/object header with no
		// early NUL still fails the fatal decode.
		expect(isProbablyBinaryHeader(Buffer.from([0x4d, 0x5a, 0xff, 0xfe, 0xc0, 0xc0]))).toBe(true);
	});

	it("accepts plain ASCII text", () => {
		expect(isProbablyBinaryHeader(Buffer.from("export const x = 1;\n", "utf-8"))).toBe(false);
	});

	it("accepts multibyte UTF-8 text", () => {
		expect(isProbablyBinaryHeader(Buffer.from("héllo — 日本語 🚀\n", "utf-8"))).toBe(false);
	});

	it("tolerates a multibyte sequence truncated at the header boundary", () => {
		// "😀" is 4 bytes (F0 9F 98 80); a header cut after the first 2 bytes is a
		// valid-but-incomplete sequence, not corruption — streaming decode allows it.
		const full = Buffer.from("ok 😀", "utf-8");
		const truncated = full.subarray(0, full.length - 2);
		expect(truncated.indexOf(0)).toBe(-1);
		expect(isProbablyBinaryHeader(truncated)).toBe(false);
	});
});

describe("isProbablyBinary / isProbablyBinarySync", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-binary-"));

	function writeFile(name: string, bytes: Uint8Array | string): string {
		const filePath = path.join(tempDir, name);
		fs.writeFileSync(filePath, bytes);
		return filePath;
	}

	it("classifies a binary file from disk (async + sync agree)", async () => {
		const filePath = writeFile("font.ttf", Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x0c]));
		expect(await isProbablyBinary(filePath)).toBe(true);
		expect(isProbablyBinarySync(filePath)).toBe(true);
	});

	it("classifies a UTF-8 text file from disk as text", async () => {
		const filePath = writeFile("notes.md", "# Title\n\nbody text\n");
		expect(await isProbablyBinary(filePath)).toBe(false);
		expect(isProbablyBinarySync(filePath)).toBe(false);
	});
});
