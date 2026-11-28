import { describe, expect, test } from "bun:test";
import { writeChunksToSink } from "../../src/ar/chunk-sink";
import { openArchive } from "../../src/ar/open";
import { type ByteSource, fileByteSource, STREAM_CHUNK_SIZE } from "../../src/ar/source";
import { encodeArchive, writeArchive, writeTarArchive } from "../../src/ar/write";
import { TempDir } from "../../src/temp";

/** Bytes that differ at every offset of a chunk, so a misplaced chunk changes the result. */
function patterned(size: number): Uint8Array {
	return new Uint8Array(size).map((_, index) => index % 251);
}

describe("plain tar written member by member", () => {
	test("replaces a longer existing file with writeArchive's tar bytes, streaming a Blob member", async () => {
		using dir = TempDir.createSync("@omp-tar-stream-");
		const payload = dir.join("payload.bin");
		await Bun.write(payload, patterned(3 * STREAM_CHUNK_SIZE + 123));
		const members = [
			["notes/readme.txt", "hello\n"],
			["payload.bin", Bun.file(payload)],
			// Past the ustar name and prefix fields: written with a PAX path record.
			[`${"deep/".repeat(60)}name.txt`, new TextEncoder().encode("long")],
			["win\\style.txt", "backslash"],
			["empty/", ""],
		] as const;
		const inMemory = dir.join("in-memory.tar");
		const streamed = dir.join("streamed.tar");
		await writeArchive(inMemory, "tar", members);
		// Longer than the archive: without truncation its tail would stay after the archive.
		await Bun.write(streamed, patterned(4 * STREAM_CHUNK_SIZE));
		await writeTarArchive(streamed, members);
		// The digest of upstream main's `encodeArchive("tar", members)` (d1503d33), so a change to the
		// encoder the two writers share cannot pass by changing both.
		const expected = "3665e12bb76b3f1debe87f6d2bcd5be3ea4e54b654d6f1adff940cd6891e4d51";
		const streamedBytes = await Bun.file(streamed).bytes();
		const inMemoryBytes = await Bun.file(inMemory).bytes();
		expect(streamedBytes.byteLength).toBe(inMemoryBytes.byteLength);
		expect(Bun.SHA256.hash(streamedBytes, "hex")).toBe(expected);
		expect(Bun.SHA256.hash(inMemoryBytes, "hex")).toBe(expected);
	});

	test("rejects a blob that reports a smaller size once streaming starts", async () => {
		using dir = TempDir.createSync("@omp-tar-stream-");
		/** Its stream matches the new size, but not the size in the header. */
		class ShrunkBlob extends Blob {
			#streaming = false;

			override get size(): number {
				return super.size + (this.#streaming ? 0 : 1);
			}

			override stream() {
				this.#streaming = true;
				return super.stream();
			}
		}
		await expect(writeTarArchive(dir.join("out.tar"), [["data.bin", new ShrunkBlob(["abc"])]])).rejects.toThrow(
			"Tar member 'data.bin' changed size while it was written",
		);
	});

	test("reads a member of a plain tar on disk in ranges of at most 1 MiB", async () => {
		using dir = TempDir.createSync("@omp-tar-stream-");
		const oneMiB = 1024 * 1024;
		const bytes = patterned(2 * oneMiB + 77);
		const archivePath = dir.join("members.tar");
		await writeTarArchive(archivePath, [
			["first.txt", "first"],
			["data.bin", bytes],
		]);
		const file = fileByteSource(archivePath);
		const reads: [number, number][] = [];
		const source: ByteSource = {
			size: file.size,
			async read(start, end) {
				reads.push([start, end]);
				return file.read(start, end);
			},
		};
		const archive = await openArchive({ source, format: "tar" });
		reads.length = 0;
		const chunks: Uint8Array[] = [];
		for await (const chunk of archive.readFileChunks("data.bin")) chunks.push(chunk);
		expect(reads.map(([start, end]) => end - start)).toEqual([oneMiB, oneMiB, 77]);
		expect(chunks.map(chunk => chunk.byteLength)).toEqual([oneMiB, oneMiB, 77]);
		expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
	});

	test("writes the same tar bytes as before, for a fixed set of members, into a directory it creates", async () => {
		using dir = TempDir.createSync("@omp-tar-stream-");
		const members = [
			["notes/readme.txt", "hello\n"],
			[`${"deep/".repeat(60)}name.txt`, new TextEncoder().encode("long")],
			["win\\style.txt", "backslash"],
			["empty/", ""],
			["blocks.bin", patterned(1536)],
			["unicode/naïve-日本.txt", "ü"],
		] as const;
		// The digest of upstream main's `encodeArchive("tar", members)` (1263bcd8), so a change to the
		// encoder the two writers share cannot pass by changing both.
		const expected = "cdbfc5210cdbdc75b9a60261b210da9a533ecf0a7c411d125721f48c82b31adf";
		// Neither parent directory exists yet: the writer creates them.
		const streamed = dir.join("missing", "parent", "streamed.tar");
		await writeTarArchive(streamed, members);
		expect(Bun.SHA256.hash(await Bun.file(streamed).bytes(), "hex")).toBe(expected);
		expect(Bun.SHA256.hash(await encodeArchive("tar", members), "hex")).toBe(expected);
	});

	test("streams a Blob from another realm, which is not instanceof Blob, instead of reading it whole", async () => {
		using dir = TempDir.createSync("@omp-tar-stream-");
		const bytes = patterned(2 * STREAM_CHUNK_SIZE + 5);
		const source = new Blob([bytes]);
		// A Blob made in another realm (a `node:vm` context, a polyfill) has the Blob methods but not this
		// realm's prototype. Its `stream()` works; reading it whole through `arrayBuffer()` is refused.
		const foreign = {
			size: source.size,
			type: source.type,
			stream: () => source.stream(),
			arrayBuffer: () => Promise.reject(new Error("the member was read whole through arrayBuffer()")),
		} as unknown as Blob;
		expect(foreign instanceof Blob).toBe(false);
		const streamed = dir.join("foreign.tar");
		await writeTarArchive(streamed, [["data.bin", foreign]]);
		expect(Bun.SHA256.hash(await Bun.file(streamed).bytes(), "hex")).toBe(
			Bun.SHA256.hash(await encodeArchive("tar", [["data.bin", bytes]]), "hex"),
		);
	});
});

describe("chunks written to a sink", () => {
	test("asks for the next chunk only after the sink finished the previous write", async () => {
		const events: string[] = [];
		const sink = {
			write(chunk: Uint8Array) {
				events.push(`write ${chunk[0]}`);
				return Bun.sleep(5).then(() => {
					events.push(`written ${chunk[0]}`);
					return chunk.byteLength;
				});
			},
			async end() {
				events.push("end");
				return 0;
			},
		};
		async function* chunks(): AsyncGenerator<Uint8Array> {
			for (const n of [1, 2]) {
				events.push(`next ${n}`);
				yield new Uint8Array([n]);
			}
		}
		await writeChunksToSink(sink, chunks());
		expect(events).toEqual(["next 1", "write 1", "written 1", "next 2", "write 2", "written 2", "end"]);
	});
});
