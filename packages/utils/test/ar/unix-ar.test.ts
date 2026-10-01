import { describe, expect, test } from "bun:test";
import { readDeb, sniffDeb } from "../../src/ar/deb";
import { ArchiveError } from "../../src/ar/error";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/ar/limits";
import { memoryByteSource } from "../../src/ar/source";
import type { ArchiveIndexEntry } from "../../src/ar/types";
import { readUnixAr, readUnixArEntriesFromBuffer, sniffUnixAr } from "../../src/ar/unix-ar";
import { arFixture as fixture } from "./fixtures";

const decoder = new TextDecoder();

function findEntry(entries: ArchiveIndexEntry[], memberPath: string): ArchiveIndexEntry {
	const entry = entries.find(candidate => candidate.path === memberPath);
	if (!entry) throw new Error(`Missing test entry ${memberPath}`);
	return entry;
}

async function readMember(entry: ArchiveIndexEntry): Promise<Uint8Array> {
	if (entry.storage?.type !== "member") throw new Error(`Test entry ${entry.path} is not a member`);
	return entry.storage.source.read(entry.size, entry.path);
}

describe("Unix ar", () => {
	test("reads BSD short and extended names from bsdtar", async () => {
		const bytes = await fixture("unix-bsdtar.a");
		expect(sniffUnixAr(bytes)).toBe(true);
		const entries = await readUnixAr(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(entries.map(entry => entry.path)).toEqual([
			"short.txt",
			"deep.txt",
			"this-is-a-very-long-member-name.txt",
		]);
		expect(decoder.decode(await readMember(findEntry(entries, "short.txt")))).toBe("short member\n");
		expect(decoder.decode(await readMember(findEntry(entries, "deep.txt")))).toBe("nested member\n");
		const long = findEntry(entries, "this-is-a-very-long-member-name.txt");
		expect(decoder.decode(await readMember(long))).toBe("long member\n");
		expect(long.mode).toBe(0o100644);
		expect(long.mtimeMs).toBeGreaterThan(0);
	});

	test("handles Darwin ar NUL-padded BSD names and skips its symbol table", async () => {
		const bytes = await fixture("unix-bsd.a");
		const entries = readUnixArEntriesFromBuffer(bytes, { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(entries.map(entry => entry.path)).toEqual(["short.txt", "this-is-a-very-long-member-name.txt"]);
		expect(entries.some(entry => entry.path.includes("SYMDEF"))).toBe(false);
		expect(decoder.decode(await readMember(findEntry(entries, "short.txt")))).toStartWith("short member\n");
	});

	test("resolves GNU long names, creates parents, and drops traversal", async () => {
		const bytes = await fixture("unix-gnu.a");
		const entries = await readUnixAr(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(entries.map(entry => entry.path).sort()).toEqual([
			"nested",
			"nested/really-long-file-name.txt",
			"short.txt",
		]);
		const long = findEntry(entries, "nested/really-long-file-name.txt");
		expect(long.mode).toBe(0o100644);
		expect(long.mtimeMs).toBe(1_700_000_000_000);
		expect(decoder.decode(await readMember(long))).toBe("gnu long\n");
	});

	test("accepts blank optional numeric fields", async () => {
		const bytes = (await fixture("unix-gnu.a")).slice();
		const shortHeaderOffset = 192;
		bytes.fill(0x20, shortHeaderOffset + 16, shortHeaderOffset + 28);
		bytes.fill(0x20, shortHeaderOffset + 40, shortHeaderOffset + 48);
		const entries = await readUnixAr(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		const short = findEntry(entries, "short.txt");
		expect(short.mtimeMs).toBeUndefined();
		expect(short.mode).toBeUndefined();
		expect(decoder.decode(await readMember(short))).toBe("short gnu\n");
	});

	test("lists COFF import-library members without parsing COFF payloads", async () => {
		const bytes = await fixture("windows-import.lib");
		const entries = await readUnixAr(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(entries.map(entry => entry.path)).toEqual(["short.obj", "very-long-windows-object-name.obj"]);
		expect(decoder.decode(await readMember(findEntry(entries, "short.obj")))).toBe("COFF-short");
		expect(decoder.decode(await readMember(findEntry(entries, "very-long-windows-object-name.obj")))).toBe(
			"COFF-long",
		);
	});

	test("indexes with ranges and defers ordinary member payload reads", async () => {
		const bytes = await fixture("unix-gnu.a");
		let bytesRead = 0;
		const entries = await readUnixAr(
			{
				size: bytes.byteLength,
				async read(start, end) {
					bytesRead += end - start;
					return bytes.subarray(start, end);
				},
			},
			{ limits: DEFAULT_ARCHIVE_LIMITS },
		);
		const indexedBytesRead = bytesRead;
		expect(indexedBytesRead).toBeLessThan(bytes.byteLength);
		await readMember(findEntry(entries, "short.txt"));
		expect(bytesRead).toBeGreaterThan(indexedBytesRead);
	});

	test("rejects truncation, malformed headers, missing long tables, and configured limits", async () => {
		const original = await fixture("unix-gnu.a");
		await expect(
			readUnixAr(memoryByteSource(original.subarray(0, original.byteLength - 1)), {
				limits: DEFAULT_ARCHIVE_LIMITS,
			}),
		).rejects.toBeInstanceOf(ArchiveError);

		const badHeader = original.slice();
		badHeader[8 + 58] = 0;
		await expect(readUnixAr(memoryByteSource(badHeader), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
			"member header",
		);

		const missingTable = original.slice();
		missingTable.set(new TextEncoder().encode("not-table       "), 8 + 60 + 4);
		await expect(readUnixAr(memoryByteSource(missingTable), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
			"missing long-name table",
		);

		await expect(
			readUnixAr(memoryByteSource(original), {
				limits: { ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 8 },
			}),
		).rejects.toThrow("too large to extract");
		await expect(
			readUnixAr(memoryByteSource(original), {
				limits: { ...DEFAULT_ARCHIVE_LIMITS, maxPathBytes: 10 },
			}),
		).rejects.toThrow("member path exceeds 10 bytes");
	});
});

describe("deb", () => {
	test("presents debian-binary, prefixed control files, and data at root", async () => {
		const bytes = await fixture("tiny.deb");
		expect(sniffDeb(bytes)).toBe(true);
		const entries = await readDeb(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
		expect(entries.map(entry => entry.path).sort()).toEqual([
			"control",
			"control/control",
			"control/escape-link",
			"control/missing-link",
			"control/postinst",
			"debian-binary",
			"usr",
			"usr/share",
			"usr/share/demo",
			"usr/share/demo/hello.txt",
		]);
		expect(decoder.decode(await readMember(findEntry(entries, "debian-binary")))).toBe("2.0\n");
		expect(decoder.decode(await readMember(findEntry(entries, "control/control")))).toContain("Package: tiny\n");
		expect(findEntry(entries, "control/postinst").mode! & 0o777).toBe(0o755);
		expect(findEntry(entries, "control/missing-link").storage).toEqual({
			type: "link",
			targetPath: "control/missing-target",
			resolveTarget: false,
		});
		expect(findEntry(entries, "control/escape-link").storage).toEqual({
			type: "link",
			targetPath: "../../outside",
			resolveTarget: false,
		});
		expect(decoder.decode(await readMember(findEntry(entries, "usr/share/demo/hello.txt")))).toBe("hello from deb\n");
	});

	for (const [archiveName, compression] of [
		["tiny-uncompressed.deb", "uncompressed"],
		["tiny-bz2.deb", "bzip2"],
		["tiny-xz.deb", "xz"],
		["tiny-zst.deb", "zstd"],
		["tiny-lzma.deb", "LZMA-alone"],
	] as const) {
		test(`expands ${compression} control tar members`, async () => {
			const bytes = await fixture(archiveName);
			const entries = await readDeb(memoryByteSource(bytes), { limits: DEFAULT_ARCHIVE_LIMITS });
			expect(decoder.decode(await readMember(findEntry(entries, "control/control")))).toContain("Package: tiny\n");
			expect(decoder.decode(await readMember(findEntry(entries, "usr/share/demo/hello.txt")))).toBe(
				"hello from deb\n",
			);
		});
	}

	test("requires debian-binary first and rejects unsupported control compression", async () => {
		const arBytes = await fixture("unix-gnu.a");
		expect(sniffDeb(arBytes)).toBe(false);
		await expect(readDeb(memoryByteSource(arBytes), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
			"first member is not debian-binary",
		);

		const debBytes = await fixture("tiny.deb");
		const unsupported = debBytes.slice();
		const marker = new TextEncoder().encode("control.tar.gz");
		const markerOffset = unsupported.findIndex((_, index) =>
			marker.every((byte, markerIndex) => unsupported[index + markerIndex] === byte),
		);
		expect(markerOffset).toBeGreaterThan(0);
		unsupported.set(new TextEncoder().encode("control.tar.zz"), markerOffset);
		await expect(readDeb(memoryByteSource(unsupported), { limits: DEFAULT_ARCHIVE_LIMITS })).rejects.toThrow(
			"Unsupported deb tar compression",
		);
	});
});
