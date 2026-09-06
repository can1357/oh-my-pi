import { afterAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { encodeAsar, readAsar, sniffAsar } from "../../src/ar/asar";
import { ArchiveError } from "../../src/ar/error";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/ar/limits";
import { memoryByteSource } from "../../src/ar/source";
import type { ArchiveIndexEntry } from "../../src/ar/types";
import { arFixture } from "./fixtures";

const TEMP_ROOTS: string[] = [];
const encoder = new TextEncoder();

function writeUInt32(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
	bytes[offset + 2] = (value >>> 16) & 0xff;
	bytes[offset + 3] = (value >>> 24) & 0xff;
}

function headerFixture(files: Record<string, unknown>, payload = new Uint8Array()): Uint8Array {
	const json = encoder.encode(JSON.stringify({ files }));
	const paddedJsonSize = json.byteLength + ((4 - (json.byteLength % 4)) % 4);
	const innerPayloadSize = 4 + paddedJsonSize;
	const headerSize = 4 + innerPayloadSize;
	const bytes = new Uint8Array(8 + headerSize + payload.byteLength);
	writeUInt32(bytes, 0, 4);
	writeUInt32(bytes, 4, headerSize);
	writeUInt32(bytes, 8, innerPayloadSize);
	writeUInt32(bytes, 12, json.byteLength);
	bytes.set(json, 16);
	bytes.set(payload, 8 + headerSize);
	return bytes;
}

function findEntry(entries: ArchiveIndexEntry[], memberPath: string): ArchiveIndexEntry {
	const entry = entries.find(candidate => candidate.path === memberPath);
	if (!entry) throw new Error(`Missing test entry ${memberPath}`);
	return entry;
}

async function readMember(entry: ArchiveIndexEntry): Promise<Uint8Array> {
	if (entry.storage?.type !== "member") throw new Error(`Test entry ${entry.path} is not a member`);
	return entry.storage.source.read(entry.size, entry.path);
}

afterAll(async () => {
	for (const root of TEMP_ROOTS) await fs.rm(root, { recursive: true, force: true });
});

describe("ASAR fixtures", () => {
	test("lists nested directories and lazily extracts packed members", async () => {
		const bytes = await arFixture("asar-valid.asar");
		expect(sniffAsar(bytes)).toBe(true);
		const entries = await readAsar(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(entries.map(entry => [entry.path, entry.isDirectory, entry.size]).sort()).toEqual([
			["docs", true, 0],
			["docs/hello.txt", false, 11],
			["empty.bin", false, 0],
		]);
		expect(new TextDecoder().decode(await readMember(findEntry(entries, "docs/hello.txt")))).toBe("hello asar\n");
		expect(await readMember(findEntry(entries, "empty.bin"))).toEqual(new Uint8Array());
	});

	test("rejects bad Pickle, oversized header, and escaping link fixtures precisely", async () => {
		const badPickle = await arFixture("asar-bad-pickle.asar");
		await expect(readAsar(memoryByteSource(badPickle), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
			"Invalid ASAR archive: invalid size pickle",
		);
		const oversized = await arFixture("asar-oversized-header.asar");
		await expect(readAsar(memoryByteSource(oversized), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
			"ASAR header is too large",
		);
		const linkEscape = await arFixture("asar-link-escape.asar");
		await expect(readAsar(memoryByteSource(linkEscape), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
			"links outside the archive",
		);
	});

	test("unpacked sibling reads verify the declared size", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-asar-test-"));
		TEMP_ROOTS.push(root);
		const archivePath = path.join(root, "bundle.asar");
		const bytes = await arFixture("asar-unpacked.asar");
		await Bun.write(archivePath, bytes);
		await fs.mkdir(`${archivePath}.unpacked`, { recursive: true });
		await Bun.write(path.join(`${archivePath}.unpacked`, "external.txt"), "short");
		const entries = await readAsar(memoryByteSource(bytes), {
			archivePath,
			limits: DEFAULT_ARCHIVE_LIMITS,
		});
		await expect(readMember(findEntry(entries, "external.txt"))).rejects.toThrow(
			"size differs from its archive header (5 != 8 bytes)",
		);
	});
});

test("encodeAsar round-trips nested and zero-length members", async () => {
	const bytes = await encodeAsar([
		["top.txt", encoder.encode("top")],
		["nested/data.bin", new Uint8Array([0, 1, 2, 255])],
		["nested/zero", new Uint8Array()],
	] as const);
	expect(sniffAsar(bytes)).toBe(true);
	const entries = await readAsar(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
	expect(entries.map(entry => entry.path).sort()).toEqual(["nested", "nested/data.bin", "nested/zero", "top.txt"]);
	expect(await readMember(findEntry(entries, "top.txt"))).toEqual(encoder.encode("top"));
	expect(await readMember(findEntry(entries, "nested/data.bin"))).toEqual(new Uint8Array([0, 1, 2, 255]));
});

test("maps links and executable flags and verifies integrity", async () => {
	const payload = encoder.encode("payload");
	const hash = crypto.createHash("sha256").update(payload).digest("hex");
	const bytes = headerFixture(
		{
			bin: {
				size: payload.byteLength,
				offset: "0",
				executable: true,
				integrity: { algorithm: "SHA256", hash, blockSize: 4 * 1024 * 1024, blocks: [hash] },
			},
			alias: { link: "bin" },
		},
		payload,
	);
	const entries = await readAsar(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
	expect(findEntry(entries, "bin").mode).toBe(0o100755);
	expect(findEntry(entries, "alias").storage).toEqual({ type: "link", targetPath: "bin", resolveTarget: true });
	expect(await readMember(findEntry(entries, "bin"))).toEqual(payload);

	bytes[bytes.byteLength - 1] ^= 1;
	const changed = await readAsar(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
	await expect(readMember(findEntry(changed, "bin"))).rejects.toThrow("failed SHA256 integrity verification");
});

test("rejects traversal, malformed records, truncation, and non-zero Pickle padding", async () => {
	for (const bytes of [
		headerFixture({ "../escape": { size: 0, offset: "0" } }),
		headerFixture({ bad: { size: -1, offset: "0" } }),
		headerFixture({ bad: { size: 1, offset: "0" } }),
		headerFixture({ bad: { size: 0, offset: 1 } }),
	]) {
		await expect(readAsar(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toBeInstanceOf(
			ArchiveError,
		);
	}

	const valid = headerFixture({ abc: { size: 0, offset: "0" } });
	await expect(readAsar(memoryByteSource(valid.subarray(0, 15)), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
		"truncated header",
	);
	const jsonSize = valid[12]! | (valid[13]! << 8) | (valid[14]! << 16) | (valid[15]! << 24);
	const paddingOffset = 16 + jsonSize;
	if (paddingOffset < 8 + (valid[4]! | (valid[5]! << 8) | (valid[6]! << 16) | (valid[7]! << 24))) {
		valid[paddingOffset] = 1;
		await expect(readAsar(memoryByteSource(valid), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
			"non-zero pickle string padding",
		);
	}
});

test("enforces header, entry, member, and path limits before indexing", async () => {
	const bytes = headerFixture({ one: { size: 1, offset: "0" }, two: { size: 0, offset: "1" } }, new Uint8Array([1]));
	await expect(
		readAsar(memoryByteSource(bytes), {
			limits: { ...DEFAULT_ARCHIVE_LIMITS, maxIndexSize: 8 },
		}),
	).rejects.toThrow("ASAR header is too large");
	await expect(
		readAsar(memoryByteSource(bytes), {
			limits: { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 },
		}),
	).rejects.toThrow("too many entries");
	await expect(
		readAsar(memoryByteSource(bytes), {
			limits: { ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 0 },
		}),
	).rejects.toThrow("too large to extract");
	await expect(
		readAsar(memoryByteSource(headerFixture({ lengthy: { size: 0, offset: "0" } })), {
			limits: { ...DEFAULT_ARCHIVE_LIMITS, maxPathBytes: 3 },
		}),
	).rejects.toThrow("entry name exceeds 3 bytes");
});

test("encodeAsar rejects unsafe, duplicate, and file-crossing paths", async () => {
	for (const members of [
		[["../escape", new Uint8Array()]],
		[["bad\0name", new Uint8Array()]],
		[
			["same", new Uint8Array()],
			["same", new Uint8Array()],
		],
		[
			["file", new Uint8Array()],
			["file/child", new Uint8Array()],
		],
	] as const) {
		await expect(encodeAsar(members)).rejects.toBeInstanceOf(ArchiveError);
	}
});
