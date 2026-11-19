import { describe, expect, test } from "bun:test";
import { readCpio, readCpioEntriesFromBuffer, sniffCpio } from "../../src/ar/cpio";
import { ArchiveError } from "../../src/ar/error";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/ar/limits";
import { readRpm, sniffRpm } from "../../src/ar/rpm";
import { memoryByteSource } from "../../src/ar/source";
import type { ArchiveIndexEntry, FormatReadOptions } from "../../src/ar/types";
import { arFixture as fixture } from "./fixtures";

const OPTIONS: FormatReadOptions = { limits: DEFAULT_ARCHIVE_LIMITS };

function entryMap(entries: ArchiveIndexEntry[]): Map<string, ArchiveIndexEntry> {
	return new Map(entries.map(entry => [entry.path, entry]));
}

function findBytes(bytes: Uint8Array, value: string): number {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(value);
}

async function extract(entry: ArchiveIndexEntry | undefined): Promise<Uint8Array> {
	if (entry?.storage?.type !== "member") throw new Error("Expected an extractable member");
	return entry.storage.source.read(entry.size, entry.path);
}

describe("CPIO", () => {
	const variants = [
		["newc", "cpio-newc.cpio"],
		["crc", "cpio-crc.cpio"],
		["odc", "cpio-odc.cpio"],
		["old binary little-endian", "cpio-bin-le.cpio"],
		["old binary big-endian", "cpio-bin-be.cpio"],
	] as const;

	for (const [variant, fileName] of variants) {
		test(`lists and extracts ${variant}`, async () => {
			const bytes = await fixture(fileName);
			expect(sniffCpio(bytes)).toBe(true);
			const entries = entryMap(await readCpio(memoryByteSource(bytes), OPTIONS));
			expect([...entries.keys()]).toEqual(
				expect.arrayContaining(["root.txt", "hard.txt", "dir", "dir/file.txt", "dir/link"]),
			);
			expect(entries.get("dir")?.isDirectory).toBe(true);
			expect(entries.get("dir")?.mode).toBe(0o040750);
			expect(entries.get("dir/file.txt")?.mode).toBe(0o100644);
			expect(entries.get("dir/file.txt")?.mtimeMs).toBe(1_700_000_000_000);
			expect(await extract(entries.get("dir/file.txt"))).toEqual(new TextEncoder().encode("nested payload\n"));

			const root = entries.get("root.txt")!;
			const hard = entries.get("hard.txt")!;
			const member = root.storage?.type === "member" ? root : hard;
			const link = member === root ? hard : root;
			expect(await extract(member)).toEqual(new TextEncoder().encode("root payload\n"));
			expect(link.storage).toEqual({ type: "link", targetPath: member.path, resolveTarget: false });
			expect(link.size).toBe(13);

			expect(entries.get("dir/link")?.mode).toBe(0o120755);
			expect(entries.get("dir/link")?.storage).toEqual({
				type: "link",
				targetPath: "root.txt",
				resolveTarget: true,
			});
		});
	}

	test("reads a bsdtar-created portable archive", async () => {
		const bytes = await fixture("cpio-bsdtar.cpio");
		const entries = entryMap(readCpioEntriesFromBuffer(bytes, OPTIONS));
		expect(await extract(entries.get("dir/file.txt"))).toEqual(new TextEncoder().encode("nested payload\n"));
		expect(entries.get("dir/link")?.storage).toEqual({ type: "link", targetPath: "root.txt", resolveTarget: true });
	});

	test("skips device nodes, FIFOs, and sockets safely", async () => {
		const entries = entryMap(await readCpio(memoryByteSource(await fixture("cpio-specials.cpio")), OPTIONS));
		expect(entries.has("pipe")).toBe(false);
		expect(entries.has("tty")).toBe(false);
		expect(entries.has("socket")).toBe(false);
		expect(await extract(entries.get("kept.txt"))).toEqual(new TextEncoder().encode("kept\n"));
	});

	test("verifies CRC payload checksums when extracting", async () => {
		const bytes = (await fixture("cpio-crc.cpio")).slice();
		const payloadOffset = findBytes(bytes, "nested payload\n");
		expect(payloadOffset).toBeGreaterThan(0);
		bytes[payloadOffset] ^= 0x20;
		const entries = entryMap(await readCpio(memoryByteSource(bytes), OPTIONS));
		await expect(extract(entries.get("dir/file.txt"))).rejects.toThrow("invalid CRC checksum");
	});

	test("requires a complete stream and TRAILER!!!", async () => {
		const bytes = await fixture("cpio-newc.cpio");
		await expect(readCpio(memoryByteSource(bytes.subarray(0, 200)), OPTIONS)).rejects.toBeInstanceOf(ArchiveError);
		const trailerName = findBytes(bytes, "TRAILER!!!");
		expect(trailerName).toBeGreaterThan(110);
		await expect(readCpio(memoryByteSource(bytes.subarray(0, trailerName - 110)), OPTIONS)).rejects.toThrow(
			"missing TRAILER!!!",
		);
	});

	test("drops traversal paths while retaining safe members", async () => {
		const entries = entryMap(await readCpio(memoryByteSource(await fixture("cpio-traversal.cpio")), OPTIONS));
		expect(entries.has("../escape.txt")).toBe(false);
		expect(entries.has("escape.txt")).toBe(false);
		expect(await extract(entries.get("safe.txt"))).toEqual(new TextEncoder().encode("safe\n"));
	});

	test("rejects unsupported wire magic", async () => {
		const bytes = (await fixture("cpio-newc.cpio")).slice();
		bytes.set(new TextEncoder().encode("070799"), 0);
		expect(sniffCpio(bytes)).toBe(false);
		await expect(readCpio(memoryByteSource(bytes), OPTIONS)).rejects.toThrow("unsupported or corrupt magic");
	});
});

describe("RPM", () => {
	test("parses headers, decompresses gzip, and strips leading ./", async () => {
		const bytes = await fixture("minimal-gzip.rpm");
		expect(sniffRpm(bytes)).toBe(true);
		const entries = entryMap(await readRpm(memoryByteSource(bytes), OPTIONS));
		expect(entries.has("./root.txt")).toBe(false);
		expect(entries.has("root.txt")).toBe(true);
		expect(await extract(entries.get("dir/file.txt"))).toEqual(new TextEncoder().encode("nested payload\n"));
		expect(entries.get("dir/link")?.storage).toEqual({ type: "link", targetPath: "root.txt", resolveTarget: true });
	});

	for (const compressor of ["bzip2", "xz", "zstd", "lzma"] as const) {
		test(`decompresses ${compressor} payloads`, async () => {
			const entries = entryMap(await readRpm(memoryByteSource(await fixture(`minimal-${compressor}.rpm`)), OPTIONS));
			const root = entries.get("root.txt")!;
			const hard = entries.get("hard.txt")!;
			expect(await extract(root.storage?.type === "member" ? root : hard)).toEqual(
				new TextEncoder().encode("root payload\n"),
			);
		});
	}

	test("decompresses end-marked LZMA payloads with unknown declared size", async () => {
		const entries = entryMap(await readRpm(memoryByteSource(await fixture("minimal-lzma-unknown.rpm")), OPTIONS));
		expect(await extract(entries.get("dir/file.txt"))).toEqual(new TextEncoder().encode("nested payload\n"));
	});

	test("falls back to payload magic when the compressor tag is unknown", async () => {
		const bytes = (await fixture("minimal-gzip.rpm")).slice();
		const compressor = findBytes(bytes, "gzip\0");
		expect(compressor).toBeGreaterThan(0);
		bytes.set(new TextEncoder().encode("xxxx"), compressor);
		const entries = entryMap(await readRpm(memoryByteSource(bytes), OPTIONS));
		const root = entries.get("root.txt")!;
		const hard = entries.get("hard.txt")!;
		expect(await extract(root.storage?.type === "member" ? root : hard)).toEqual(
			new TextEncoder().encode("root payload\n"),
		);
	});

	test("reports unsupported payload formats with package identity", async () => {
		const bytes = (await fixture("minimal-gzip.rpm")).slice();
		const format = findBytes(bytes, "cpio\0");
		expect(format).toBeGreaterThan(0);
		bytes.set(new TextEncoder().encode("drpm"), format);
		await expect(readRpm(memoryByteSource(bytes), OPTIONS)).rejects.toThrow(
			"RPM package 'fixture-1.0' uses unsupported payload format 'drpm'",
		);
	});

	test("rejects truncated and unsupported-compressor payloads", async () => {
		const original = await fixture("minimal-gzip.rpm");
		await expect(readRpm(memoryByteSource(original.subarray(0, 120)), OPTIONS)).rejects.toBeInstanceOf(ArchiveError);
		const bytes = original.slice();
		const compressor = findBytes(bytes, "gzip\0");
		bytes.set(new TextEncoder().encode("xxxx"), compressor);
		bytes[bytes.length - 1] = 0;
		const gzipMagic = bytes.lastIndexOf(0x1f);
		if (gzipMagic >= 0 && bytes[gzipMagic + 1] === 0x8b) bytes[gzipMagic] = 0;
		await expect(readRpm(memoryByteSource(bytes), OPTIONS)).rejects.toThrow("unsupported payload compressor 'xxxx'");
	});
});
