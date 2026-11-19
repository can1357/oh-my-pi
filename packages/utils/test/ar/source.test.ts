import { afterAll, describe, expect, it } from "bun:test";
import { cachingByteSource, encodeArchive, httpByteSource, openArchive } from "@oh-my-pi/pi-utils/ar";

// The remote-source contract: an archive served over HTTP with Range support
// must be listable and member-readable through ranged requests only (no full
// download), servers without Range support must fall back to one bounded
// buffered download, and the block cache must coalesce small header reads.

const DECODER = new TextDecoder();

const zipBytes = await encodeArchive("zip", [
	["docs/readme.md", "# remote readme\n"],
	["docs/data.bin", "0123456789".repeat(64)],
	// Incompressible padding so the archive spans many 256-byte cache blocks.
	["docs/pad.bin", crypto.getRandomValues(new Uint8Array(4096))],
]);

let rangeRequests = 0;
let fullRequests = 0;
const rangedServer = Bun.serve({
	port: 0,
	fetch(request) {
		const range = request.headers.get("range");
		if (!range) {
			fullRequests++;
			return new Response(zipBytes);
		}
		rangeRequests++;
		const match = /^bytes=(\d+)-(\d+)$/.exec(range);
		if (!match) return new Response("bad range", { status: 416 });
		const start = Number(match[1]);
		const end = Math.min(Number(match[2]), zipBytes.byteLength - 1);
		return new Response(zipBytes.subarray(start, end + 1), {
			status: 206,
			headers: { "content-range": `bytes ${start}-${end}/${zipBytes.byteLength}` },
		});
	},
});
const ignoringServer = Bun.serve({
	port: 0,
	fetch: () => new Response(zipBytes),
});

afterAll(() => {
	rangedServer.stop(true);
	ignoringServer.stop(true);
});

describe("ar remote sources", () => {
	it("lists and reads a remote zip via ranged requests without a full download", async () => {
		const source = await httpByteSource(String(rangedServer.url));
		expect(source.size).toBe(zipBytes.byteLength);

		const archive = await openArchive({ source, format: "zip", path: "remote.zip" });
		const names = archive.listDirectory("docs").map(entry => entry.name);
		expect(names).toEqual(["data.bin", "pad.bin", "readme.md"]);

		const file = await archive.readFile("docs/readme.md");
		expect(DECODER.decode(file.bytes)).toBe("# remote readme\n");
		expect(fullRequests).toBe(0);
		expect(rangeRequests).toBeGreaterThan(0);
	});

	it("falls back to one bounded buffered download when Range is ignored", async () => {
		const source = await httpByteSource(String(ignoringServer.url));
		expect(source.size).toBe(zipBytes.byteLength);
		const archive = await openArchive({ source, format: "zip" });
		const file = await archive.readFile("docs/data.bin");
		expect(file.bytes.byteLength).toBe(640);
	});

	it("rejects a no-Range body larger than the fallback cap", async () => {
		await expect(httpByteSource(String(ignoringServer.url), { maxFallbackBytes: 8 })).rejects.toThrow(
			/too large to buffer/,
		);
	});

	it("coalesces small reads into shared cached block fetches", async () => {
		let reads = 0;
		const inner = {
			size: zipBytes.byteLength,
			async read(start: number, end: number) {
				reads++;
				return zipBytes.subarray(start, end);
			},
		};
		const cached = cachingByteSource(inner, { blockSize: 256, maxBlocks: 8 });
		// Two overlapping small reads inside one block: one upstream fetch.
		const first = await cached.read(0, 16);
		const second = await cached.read(4, 30);
		expect(reads).toBe(1);
		expect(first).toEqual(zipBytes.subarray(0, 16));
		expect(second).toEqual(zipBytes.subarray(4, 30));
		// A read spanning two blocks fetches only the missing one.
		await cached.read(200, 300);
		expect(reads).toBe(2);
		// Huge reads bypass the cache with one direct fetch.
		await cached.read(0, zipBytes.byteLength);
		expect(reads).toBe(3);
	});
});
