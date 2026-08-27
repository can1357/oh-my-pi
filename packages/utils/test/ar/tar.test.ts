import { describe, expect, test } from "bun:test";
import { ArchiveError } from "../../src/ar/error";
import { type ArchiveLimits, DEFAULT_ARCHIVE_LIMITS } from "../../src/ar/limits";
import { memoryByteSource } from "../../src/ar/source";
import { encodeTar, readTar, readTarEntriesFromBuffer, sniffTar } from "../../src/ar/tar";
import type { ArchiveIndexEntry, FormatReadOptions } from "../../src/ar/types";
import { arFixture as fixture } from "./fixtures";

const options: FormatReadOptions = { limits: DEFAULT_ARCHIVE_LIMITS };

function index(bytes: Uint8Array, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ArchiveIndexEntry[] {
	return readTarEntriesFromBuffer(bytes, { limits });
}

function entryAt(entries: readonly ArchiveIndexEntry[], memberPath: string): ArchiveIndexEntry {
	const entry = entries.find(candidate => candidate.path === memberPath);
	if (!entry) throw new Error(`Missing test entry ${memberPath}`);
	return entry;
}

async function memberBytes(entry: ArchiveIndexEntry): Promise<Uint8Array> {
	if (entry.storage?.type !== "member") throw new Error(`Test entry ${entry.path} is not readable`);
	return entry.storage.source.read(entry.size, entry.path);
}

describe("tar reader", () => {
	test("indexes ustar paths, modes, mtimes, directories, and member bytes", async () => {
		const bytes = await fixture("tar-ustar.tar");
		expect(sniffTar(bytes)).toBe(true);
		const entries = index(bytes);
		expect(entries.map(entry => entry.path)).toEqual(["nested", "hello.txt", "nested/data.bin"]);
		const hello = entryAt(entries, "hello.txt");
		expect(hello.mode).toBe(0o640);
		expect(hello.mtimeMs).toBe(1_700_000_000_000);
		expect(new TextDecoder().decode(await memberBytes(hello))).toBe("hello tar\n");
		expect(entryAt(entries, "nested").isDirectory).toBe(true);
		expect(entryAt(entries, "nested/data.bin").mode).toBe(0o755);
		expect([...(await memberBytes(entryAt(entries, "nested/data.bin")))]).toEqual([0, 1, 2, 255]);
	});

	test("reads a whole ByteSource once and rejects short source reads", async () => {
		const bytes = await fixture("tar-ustar.tar");
		let reads = 0;
		const entries = await readTar(
			{
				size: bytes.byteLength,
				async read(start, end) {
					reads++;
					return bytes.subarray(start, end);
				},
			},
			options,
		);
		expect(reads).toBe(1);
		expect(await memberBytes(entryAt(entries, "hello.txt"))).toEqual(new TextEncoder().encode("hello tar\n"));
		await expect(
			readTar(
				{
					size: bytes.byteLength,
					async read(start, end) {
						return bytes.subarray(start, end - 1);
					},
				},
				options,
			),
		).rejects.toThrow("truncated");
	});

	test("applies PAX local long paths and global set/delete records", async () => {
		const longEntries = index(await fixture("tar-pax-long.tar"));
		const long = longEntries.find(entry => entry.path.endsWith("/payload.txt"));
		expect(long?.path.length).toBeGreaterThan(160);
		expect(new TextDecoder().decode(await memberBytes(long!))).toBe("pax long path\n");

		const globalEntries = index(await fixture("tar-pax-global.tar"));
		expect(new TextDecoder().decode(await memberBytes(entryAt(globalEntries, "global.txt")))).toBe("global\n");
		expect(new TextDecoder().decode(await memberBytes(entryAt(globalEntries, "literal.txt")))).toBe("literal\n");
		expect(globalEntries.some(entry => entry.path === "ignored.txt")).toBe(false);
	});

	test("applies GNU L and K long records", async () => {
		const longNameEntries = index(await fixture("tar-gnu-longlink.tar"));
		const longName = longNameEntries.find(entry => entry.path.endsWith("payload.txt"));
		expect(longName?.path.length).toBeGreaterThan(150);
		expect(new TextDecoder().decode(await memberBytes(longName!))).toBe("gnu long link payload\n");

		const longLinkEntries = index(await fixture("tar-gnu-long-links.tar"));
		const link = entryAt(longLinkEntries, "pkg/current");
		expect(new TextDecoder().decode(await memberBytes(link))).toBe("long target\n");
	});

	test("resolves hard links, relative file symlinks, and directory aliases", async () => {
		const entries = index(await fixture("tar-links.tar"));
		expect(new TextDecoder().decode(await memberBytes(entryAt(entries, "pkg/hard.txt")))).toBe("shared content\n");
		expect(new TextDecoder().decode(await memberBytes(entryAt(entries, "pkg/bin/tool")))).toBe(
			"export const tool = true;\n",
		);
		const directoryAlias = entryAt(entries, "pkg/current");
		expect(directoryAlias.isDirectory).toBe(true);
		expect(directoryAlias.storage).toEqual({ type: "link", targetPath: "pkg/lib", resolveTarget: false });
		const dangling = entryAt(entries, "pkg/dangling");
		expect(dangling.storage).toEqual({ type: "link", targetPath: "pkg/missing-target", resolveTarget: false });
	});

	test("rejects dependency cycles while preserving self-cyclic and dangling symlink records", async () => {
		await expect(fixture("tar-cyclic-links.tar").then(bytes => index(bytes))).rejects.toThrow(
			"cyclic or unsupported links",
		);
		const source = await fixture("tar-links.tar");
		const dangling = entryAt(index(source), "pkg/dangling");
		expect(dangling.storage?.type).toBe("link");
	});

	test("recognizes GNU sparse PAX 0.0, 0.1, and 1.0 but rejects extraction precisely", async () => {
		for (const name of ["tar-sparse-pax-0.0.tar", "tar-sparse-pax-0.1.tar", "tar-sparse-pax.tar"]) {
			const entries = index(await fixture(name));
			const sparse = entryAt(entries, "data/sparse.bin");
			expect(sparse.size).toBe(33_554_432);
			await expect(memberBytes(sparse)).rejects.toThrow("sparse file");
			expect(new TextDecoder().decode(await memberBytes(entryAt(entries, "after.txt")))).toBe("after sparse\n");
		}
	});

	test("consumes old-GNU sparse continuation metadata before later members", async () => {
		const entries = index(await fixture("tar-sparse-oldgnu.tar"));
		await expect(memberBytes(entryAt(entries, "data/sparse.bin"))).rejects.toThrow("sparse file");
		expect(new TextDecoder().decode(await memberBytes(entryAt(entries, "after.txt")))).toBe("after sparse\n");
	});

	test("accepts base-256 numerics, signed checksums, and old-GNU rename records", async () => {
		const base256 = entryAt(index(await fixture("tar-base256.tar")), "binary.txt");
		expect(base256.size).toBe(3);
		expect(base256.mtimeMs).toBe(42_000);
		expect(new TextDecoder().decode(await memberBytes(base256))).toBe("bin");
		const signed = entryAt(index(await fixture("tar-signed-checksum.tar")), "signed.txt");
		expect(new TextDecoder().decode(await memberBytes(signed))).toBe("signed");

		const renamed = index(await fixture("tar-oldgnu-rename.tar"));
		expect(renamed.some(entry => entry.path === "old/file.txt")).toBe(false);
		expect(new TextDecoder().decode(await memberBytes(entryAt(renamed, "moved/file.txt")))).toBe("renamed\n");
		expect(new TextDecoder().decode(await memberBytes(entryAt(renamed, "outside.txt")))).toBe("renamed\n");
	});

	test("drops traversal entries and rejects corrupt, truncated, unterminated, or multi-volume archives", async () => {
		const traversal = index(await fixture("tar-traversal.tar"));
		expect(traversal.map(entry => entry.path)).toEqual(["safe.txt"]);
		expect(new TextDecoder().decode(await memberBytes(traversal[0]!))).toBe("safe");

		const truncated = await fixture("tar-truncated.tar");
		expect(() => index(truncated)).toThrow("truncated");
		const valid = await fixture("tar-ustar.tar");
		expect(() => index(valid.subarray(0, valid.byteLength - 1024))).toThrow("missing terminating zero block");
		const corrupt = valid.slice();
		corrupt[0] ^= 1;
		expect(() => index(corrupt)).toThrow("corrupt tar archive header");
		expect(sniffTar(corrupt)).toBe(false);

		const multiVolume = await fixture("tar-unsupported-multivolume.tar");
		expect(() => index(multiVolume)).toThrow("multi-volume tar members are not supported");
	});

	test("enforces archive, member, path, entry, and metadata limits", async () => {
		const bytes = await fixture("tar-ustar.tar");
		expect(() => index(bytes, { ...DEFAULT_ARCHIVE_LIMITS, maxInMemorySize: bytes.byteLength - 1 })).toThrow(
			"too large to read in memory",
		);
		expect(() => index(bytes, { ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 3 })).toThrow("too large to extract");
		expect(() => index(bytes, { ...DEFAULT_ARCHIVE_LIMITS, maxPathBytes: 5 })).toThrow("exceeds 5 bytes");
		expect(() => index(bytes, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 })).toThrow("too many entries");
		const pax = await fixture("tar-pax-long.tar");
		expect(() => index(pax, { ...DEFAULT_ARCHIVE_LIMITS, maxIndexSize: 8 })).toThrow("PAX metadata is too large");
	});
});

describe("tar writer", () => {
	test("is deterministic, creates parent directories, and round-trips PAX paths", async () => {
		const longPath = `long/${"segment".repeat(30)}/payload.txt`;
		const members = [
			["tree/repeat.txt", new Uint8Array(1025).fill(0x41)],
			["tree/deep/note.txt", new TextEncoder().encode("nested")],
			[longPath, new TextEncoder().encode("long name")],
		] as const;
		const first = await encodeTar(members);
		const second = await encodeTar(members);
		expect(first).toEqual(second);
		expect(first.byteLength % 512).toBe(0);
		expect(sniffTar(first)).toBe(true);
		const entries = index(first);
		expect(entryAt(entries, "tree").isDirectory).toBe(true);
		expect(entryAt(entries, "tree/deep").isDirectory).toBe(true);
		expect(entryAt(entries, "tree/repeat.txt").mode).toBe(0o644);
		expect(entryAt(entries, "tree").mode).toBe(0o755);
		expect(await memberBytes(entryAt(entries, "tree/repeat.txt"))).toEqual(members[0][1]);
		expect(new TextDecoder().decode(await memberBytes(entryAt(entries, longPath)))).toBe("long name");
	});

	test("supports explicit empty directories and rejects unsafe or conflicting paths", async () => {
		const encoded = await encodeTar([["empty/", new Uint8Array(0)]]);
		expect(entryAt(index(encoded), "empty").isDirectory).toBe(true);
		await expect(encodeTar([["../escape", new Uint8Array(0)]])).rejects.toBeInstanceOf(ArchiveError);
		await expect(
			encodeTar([
				["node", new Uint8Array(0)],
				["node/child", new Uint8Array(0)],
			]),
		).rejects.toThrow("not a directory");
		await expect(encodeTar([["empty/", new Uint8Array([1])]])).rejects.toThrow("cannot contain file data");
	});

	test("empty output is a valid two-zero-block tar", async () => {
		const encoded = await encodeTar([]);
		expect(encoded.byteLength).toBe(1024);
		expect(sniffTar(encoded)).toBe(true);
		expect(await readTar(memoryByteSource(encoded), options)).toEqual([]);
	});
});
