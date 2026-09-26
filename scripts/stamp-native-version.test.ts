import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { containsVersionStamp } from "../packages/natives/native/version-sentinel.js";
import {
	MAX_STAMP_VERSION_LENGTH,
	stampNativeBytes,
	stampNativeVersion,
	VERSION_STAMP_MAGIC,
	VERSION_STAMP_SIZE,
} from "./stamp-native-version";

function placeholder(): Buffer {
	const slot = Buffer.alloc(VERSION_STAMP_SIZE);
	slot.write(VERSION_STAMP_MAGIC, "latin1");
	return slot;
}

function addon(...slots: Buffer[]): Buffer {
	return Buffer.concat([Buffer.from("\x7fELF-head"), ...slots, Buffer.from("tail-bytes")]);
}

describe("stampNativeBytes", () => {
	it("round-trips a version and leaves the rest of the image untouched", () => {
		const bytes = addon(placeholder());
		const before = Buffer.from(bytes);
		expect(stampNativeBytes(bytes, "18.4.0")).toBe(true);
		expect(bytes.length).toBe(before.length);
		expect(containsVersionStamp(bytes, "18.4.0")).toBe(true);
		expect(containsVersionStamp(bytes, "18.4")).toBe(false);
		const slotStart = before.indexOf(VERSION_STAMP_MAGIC);
		expect(bytes.subarray(0, slotStart).equals(before.subarray(0, slotStart))).toBe(true);
		const slotEnd = slotStart + VERSION_STAMP_SIZE;
		expect(bytes.subarray(slotEnd).equals(before.subarray(slotEnd))).toBe(true);
	});

	it("is a no-op for the same version and overwrites a different one fully", () => {
		const bytes = addon(placeholder());
		stampNativeBytes(bytes, "18.10.10");
		expect(stampNativeBytes(bytes, "18.10.10")).toBe(false);
		expect(stampNativeBytes(bytes, "18.1.1")).toBe(true);
		expect(containsVersionStamp(bytes, "18.1.1")).toBe(true);
		expect(containsVersionStamp(bytes, "18.10.10")).toBe(false);
	});

	it("rejects an image without the magic", () => {
		expect(() => stampNativeBytes(addon(Buffer.alloc(VERSION_STAMP_SIZE)), "1.0.0")).toThrow("not found");
	});

	it("rejects an image with the magic twice", () => {
		expect(() => stampNativeBytes(addon(placeholder(), placeholder()), "1.0.0")).toThrow("more than once");
	});

	it("rejects a version that does not fit the slot", () => {
		const bytes = addon(placeholder());
		expect(() => stampNativeBytes(bytes, "1".repeat(MAX_STAMP_VERSION_LENGTH + 1))).toThrow("fits at most");
		expect(stampNativeBytes(bytes, "1".repeat(MAX_STAMP_VERSION_LENGTH))).toBe(true);
		expect(bytes[bytes.indexOf(VERSION_STAMP_MAGIC) + VERSION_STAMP_SIZE - 1]).toBe(0);
	});

	it("rejects a truncated slot", () => {
		const bytes = Buffer.concat([Buffer.from("head"), placeholder().subarray(0, 40)]);
		expect(() => stampNativeBytes(bytes, "1.0.0")).toThrow("truncated");
	});
});

describe("stampNativeVersion", () => {
	it("stamps a file in place", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-stamp-"));
		try {
			const file = path.join(dir, "pi_natives.node");
			await fs.writeFile(file, addon(placeholder()));
			await stampNativeVersion(file, "18.4.0");
			expect(containsVersionStamp(await fs.readFile(file), "18.4.0")).toBe(true);
			expect(await fs.readdir(dir)).toEqual(["pi_natives.node"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "darwin")("refuses to change a Mach-O off darwin", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-stamp-"));
		try {
			const file = path.join(dir, "pi_natives.darwin-arm64.node");
			const macho = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), placeholder()]);
			await fs.writeFile(file, macho);
			await expect(stampNativeVersion(file, "18.4.0")).rejects.toThrow("only a darwin host");
			expect((await fs.readFile(file)).equals(macho)).toBe(true);
			// Already carrying the requested stamp: nothing to re-sign, so it passes.
			stampNativeBytes(macho, "18.4.0");
			await fs.writeFile(file, macho);
			await stampNativeVersion(file, "18.4.0");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
