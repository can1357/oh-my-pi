import { describe, expect, test } from "bun:test";
import { ArchiveError } from "../../src/ar/error";
import { DEFAULT_ARCHIVE_LIMITS } from "../../src/ar/limits";
import { openArchive } from "../../src/ar/open";
import { ArchiveReader } from "../../src/ar/reader";
import { type ByteSource, memoryByteSource } from "../../src/ar/source";
import { encodeTar, readTar } from "../../src/ar/tar";
import { arFixture as fixture } from "./fixtures";

describe("plain tar range reads", () => {
	test("lists past the in-memory ceiling without reading unrelated payloads", async () => {
		const bytes = await encodeTar([
			["large.bin", new Uint8Array(8192)],
			["identity.json", new TextEncoder().encode('{"ok":true}')],
		]);
		const reads: [number, number][] = [];
		const source: ByteSource = {
			size: bytes.byteLength,
			async read(start, end) {
				reads.push([start, end]);
				return bytes.subarray(start, end);
			},
		};
		const entries = await readTar(source, {
			limits: { ...DEFAULT_ARCHIVE_LIMITS, maxInMemorySize: 1024 },
		});
		const archive = new ArchiveReader("tar", entries, { ...DEFAULT_ARCHIVE_LIMITS, maxMemberSize: 4096 });
		expect(archive.listDirectory("").map(entry => [entry.name, entry.size])).toEqual([
			["identity.json", 11],
			["large.bin", 8192],
		]);
		expect(reads).toEqual([
			[0, 512],
			[8704, 9216],
			[9728, 10240],
		]);
		expect(new TextDecoder().decode((await archive.readFile("identity.json")).bytes)).toBe('{"ok":true}');
		expect(reads.at(-1)).toEqual([9216, 9227]);
		const beforeOversizedRead = reads.length;
		await expect(archive.readFile("large.bin")).rejects.toThrow("too large to extract");
		expect(reads.length).toBe(beforeOversizedRead);
	});

	test("opens a plain tar above a lowered in-memory limit through the public API", async () => {
		const bytes = await encodeTar([
			["first.txt", new TextEncoder().encode("first")],
			["fill.bin", new Uint8Array(6000)],
			["last.txt", new TextEncoder().encode("last")],
		]);
		const archive = await openArchive({ bytes, format: "tar" }, { limits: { maxInMemorySize: 1024 } });
		expect(new TextDecoder().decode((await archive.readFile("last.txt")).bytes)).toBe("last");
		expect(new TextDecoder().decode((await archive.readFile("first.txt")).bytes)).toBe("first");
	});

	test("preserves PAX and GNU names, links, and sparse metadata with ranged indexing", async () => {
		for (const [name, member, expected] of [
			["tar-pax-long.tar", undefined, "pax long path\n"],
			["tar-gnu-longlink.tar", undefined, "gnu long link payload\n"],
			["tar-gnu-long-links.tar", "pkg/current", "long target\n"],
			["tar-links.tar", "pkg/hard.txt", "shared content\n"],
			["tar-sparse-oldgnu.tar", "after.txt", "after sparse\n"],
		] as const) {
			const bytes = await fixture(name);
			const archive = await openArchive({ bytes, format: "tar" }, { limits: { maxInMemorySize: 512 } });
			const memberPath =
				member ??
				[...archive.indexEntries()].find(
					entry => entry.path.endsWith("payload.txt") && !entry.path.endsWith("/._payload.txt"),
				)!.path;
			expect(new TextDecoder().decode((await archive.readFile(memberPath)).bytes)).toBe(expected);
			if (name === "tar-sparse-oldgnu.tar") {
				await expect(archive.readFile("data/sparse.bin")).rejects.toThrow("sparse file");
			}
		}
	});

	test("rejects truncated headers, payloads, and short selected-member reads", async () => {
		const bytes = await fixture("tar-ustar.tar");
		const limits = { ...DEFAULT_ARCHIVE_LIMITS, maxInMemorySize: 512 };
		await expect(readTar(memoryByteSource(bytes.subarray(0, 100)), { limits })).rejects.toBeInstanceOf(ArchiveError);
		await expect(readTar(memoryByteSource(await fixture("tar-truncated.tar")), { limits })).rejects.toThrow(
			"truncated",
		);
		let shortReads = false;
		const entries = await readTar(
			{
				size: bytes.byteLength,
				async read(start, end) {
					return bytes.subarray(start, shortReads ? end - 1 : end);
				},
			},
			{ limits },
		);
		shortReads = true;
		await expect(new ArchiveReader("tar", entries).readFile("hello.txt")).rejects.toThrow("truncated");
	});

	test("keeps corrupt-header, entry, path, and metadata limits on the ranged path", async () => {
		const bytes = await fixture("tar-ustar.tar");
		const limits = { ...DEFAULT_ARCHIVE_LIMITS, maxInMemorySize: 512 };
		const corrupt = bytes.slice();
		corrupt[0] ^= 1;
		await expect(readTar(memoryByteSource(corrupt), { limits })).rejects.toThrow("corrupt tar archive header");
		await expect(readTar(memoryByteSource(bytes), { limits: { ...limits, maxEntries: 1 } })).rejects.toThrow(
			"too many entries",
		);
		await expect(readTar(memoryByteSource(bytes), { limits: { ...limits, maxPathBytes: 5 } })).rejects.toThrow(
			"exceeds 5 bytes",
		);
		await expect(
			readTar(memoryByteSource(await fixture("tar-pax-long.tar")), { limits: { ...limits, maxIndexSize: 8 } }),
		).rejects.toThrow("PAX metadata is too large");
	});

	test("rejects unsafe source and member sizes and wraps source failures", async () => {
		for (const firstByte of [0x80, 0xff]) {
			const bytes = await encodeTar([["invalid.bin", new Uint8Array(0)]]);
			// Base-256 values outside the nonnegative safe-integer range, with
			// a valid checksum so numeric validation, not sniffing, rejects them.
			bytes.fill(0xff, 124, 136);
			bytes[124] = firstByte;
			bytes.fill(0x20, 148, 156);
			let checksum = 0;
			for (const byte of bytes.subarray(0, 512)) checksum += byte;
			bytes.set(new TextEncoder().encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
			await expect(
				readTar(memoryByteSource(bytes), {
					limits: { ...DEFAULT_ARCHIVE_LIMITS, maxInMemorySize: 512 },
				}),
			).rejects.toThrow("Invalid tar member size");
		}
		for (const size of [-1, Number.MAX_SAFE_INTEGER + 1]) {
			let reads = 0;
			await expect(
				readTar(
					{
						size,
						async read() {
							reads++;
							throw new Error("must not read an unsafe source");
						},
					},
					{ limits: DEFAULT_ARCHIVE_LIMITS },
				),
			).rejects.toThrow("too large to read safely");
			expect(reads).toBe(0);
		}
		await expect(
			readTar(
				{
					size: 1024,
					async read() {
						throw new Error("source unavailable");
					},
				},
				{ limits: DEFAULT_ARCHIVE_LIMITS },
			),
		).rejects.toBeInstanceOf(ArchiveError);
	});
});
