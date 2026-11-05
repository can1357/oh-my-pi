import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	containsVersionStamp,
	VERSION_STAMP_MAGIC,
	VERSION_STAMP_SIZE,
} from "../packages/natives/native/version-sentinel.js";
import { MAX_STAMP_VERSION_LENGTH, stampNativeBytes, stampNativeVersion } from "./stamp-native-version";

function placeholder(): Buffer {
	const slot = Buffer.alloc(VERSION_STAMP_SIZE);
	slot.write(VERSION_STAMP_MAGIC, "latin1");
	return slot;
}

function addon(...slots: Buffer[]): Buffer {
	return Buffer.concat([Buffer.from("\x7fELF-head"), ...slots, Buffer.from("tail-bytes")]);
}

const PAGE = 4096;
const PAGES = 3;
/** Byte offset of the first page hash: superblob header + index (20) + CodeDirectory header (88) + identifier (8). */
const FIRST_HASH = PAGE * PAGES + 20 + 96;

/**
 * A thin arm64 dylib with an embedded signature whose single SHA-256
 * CodeDirectory (`flags`) hashes its three 4 KiB pages; the stamp slot
 * straddles pages 1 and 2. Laid out by hand, like ld64.lld's linker signature.
 */
function signedMachO(flags: number): Buffer {
	const image = Buffer.alloc(FIRST_HASH + PAGES * 32);
	image.writeUInt32LE(0xfeedfacf, 0);
	image.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
	image.writeUInt32LE(6, 12); // MH_DYLIB
	image.writeUInt32LE(1, 16); // ncmds
	image.writeUInt32LE(16, 20); // sizeofcmds
	image.writeUInt32LE(0x1d, 32); // LC_CODE_SIGNATURE
	image.writeUInt32LE(16, 36);
	image.writeUInt32LE(PAGE * PAGES, 40); // dataoff
	image.writeUInt32LE(image.length - PAGE * PAGES, 44); // datasize
	placeholder().copy(image, PAGE * 2 - 20);
	const sig = PAGE * PAGES;
	image.writeUInt32BE(0xfade0cc0, sig);
	image.writeUInt32BE(image.length - sig, sig + 4);
	image.writeUInt32BE(1, sig + 8); // count
	image.writeUInt32BE(0, sig + 12); // CSSLOT_CODEDIRECTORY
	image.writeUInt32BE(20, sig + 16);
	const cd = sig + 20;
	image.writeUInt32BE(0xfade0c02, cd);
	image.writeUInt32BE(image.length - cd, cd + 4);
	image.writeUInt32BE(0x20400, cd + 8);
	image.writeUInt32BE(flags, cd + 12);
	image.writeUInt32BE(96, cd + 16); // hashOffset
	image.writeUInt32BE(88, cd + 20); // identOffset
	image.writeUInt32BE(PAGES, cd + 28); // nCodeSlots
	image.writeUInt32BE(PAGE * PAGES, cd + 32); // codeLimit
	image.writeUInt8(32, cd + 36); // hashSize
	image.writeUInt8(2, cd + 37); // SHA-256
	image.writeUInt8(12, cd + 39); // 4 KiB pages
	image.write("fixture", cd + 88, "latin1");
	for (let page = 0; page < PAGES; page++) {
		Bun.CryptoHasher.hash("sha256", image.subarray(page * PAGE, (page + 1) * PAGE)).copy(
			image,
			FIRST_HASH + page * 32,
		);
	}
	return image;
}

/** Whether every page hash in a {@link signedMachO} image matches its page, which is what macOS verifies. */
function signatureMatches(image: Buffer): boolean {
	for (let page = 0; page < PAGES; page++) {
		const stored = image.subarray(FIRST_HASH + page * 32, FIRST_HASH + (page + 1) * 32);
		const actual = Bun.CryptoHasher.hash("sha256", image.subarray(page * PAGE, (page + 1) * PAGE));
		if (!actual.equals(stored)) return false;
	}
	return true;
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

	it("keeps an ad-hoc signed Mach-O's signature valid on any host", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-stamp-"));
		try {
			const file = path.join(dir, "pi_natives.darwin-arm64.node");
			await fs.writeFile(file, signedMachO(0x20002)); // CS_ADHOC | CS_LINKER_SIGNED
			await stampNativeVersion(file, "18.4.0");
			const stamped = await fs.readFile(file);
			expect(containsVersionStamp(stamped, "18.4.0")).toBe(true);
			expect(signatureMatches(stamped)).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses to stamp a Mach-O signed by an identity and leaves it untouched", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-stamp-"));
		try {
			const file = path.join(dir, "pi_natives.darwin-arm64.node");
			const macho = signedMachO(0x10000); // CS_RUNTIME, no CS_ADHOC
			await fs.writeFile(file, macho);
			await expect(stampNativeVersion(file, "18.4.0")).rejects.toThrow("signed by an identity");
			expect((await fs.readFile(file)).equals(macho)).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("stamps a Mach-O without re-signing when the caller signs it", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-stamp-"));
		try {
			const file = path.join(dir, "pi_natives.darwin-arm64.node");
			await fs.writeFile(file, Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), placeholder()]));
			await stampNativeVersion(file, "18.4.0", { sign: false });
			expect(containsVersionStamp(await fs.readFile(file), "18.4.0")).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
