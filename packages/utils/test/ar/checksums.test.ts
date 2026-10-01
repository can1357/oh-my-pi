import { describe, expect, it } from "bun:test";
import { crc16Arc, crc32, crc64 } from "@oh-my-pi/pi-utils/ar/checksums";

// Containers store these exact values on the wire; if any of them drifts
// (e.g. Bun.hash.crc32 seed semantics stop matching zlib chaining), every
// archive CRC verification in ar/ starts rejecting valid archives.
const CHECK = new TextEncoder().encode("123456789");

describe("ar checksums", () => {
	it("computes the CRC-32/IEEE check value and chains via seed", () => {
		expect(crc32(CHECK)).toBe(0xcbf43926);
		expect(crc32(CHECK.subarray(4), crc32(CHECK.subarray(0, 4)))).toBe(0xcbf43926);
		expect(crc32(new Uint8Array(0))).toBe(0);
	});

	it("computes the CRC-64/XZ check value and chains via seed", () => {
		expect(crc64(CHECK)).toBe(0x995dc9bbdf1939fan);
		expect(crc64(CHECK.subarray(4), crc64(CHECK.subarray(0, 4)))).toBe(0x995dc9bbdf1939fan);
		expect(crc64(new Uint8Array(0))).toBe(0n);
	});

	it("computes the CRC-16/ARC check value and chains via seed", () => {
		expect(crc16Arc(CHECK)).toBe(0xbb3d);
		expect(crc16Arc(CHECK.subarray(4), crc16Arc(CHECK.subarray(0, 4)))).toBe(0xbb3d);
		expect(crc16Arc(new Uint8Array(0))).toBe(0);
	});
});
