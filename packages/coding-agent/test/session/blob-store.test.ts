import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	BlobStore,
	externalizeImageData,
	parseBlobRef,
	resolveImageData,
} from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { blobExtensionForImageMimeType } from "@oh-my-pi/pi-tui/prompt/image-format";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("BlobStore image display paths", () => {
	it("creates an extension-bearing sidecar for image blobs while keeping canonical refs extensionless", async () => {
		using tempDir = TempDir.createSync("@omp-blob-store-image-link-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("image-bytes");

		const result = await store.put(data, { extension: "png" });
		expect(result.path.endsWith(result.hash)).toBe(true);
		expect(result.displayPath).toBe(`${result.path}.png`);
		expect(result.ref).toBe(`blob:sha256:${result.hash}`);
		expect(await Bun.file(result.path).bytes()).toEqual(new Uint8Array(data));
		expect(await Bun.file(result.displayPath).bytes()).toEqual(new Uint8Array(data));
	});

	it("externalizes image data with a mime-derived display extension", async () => {
		using tempDir = TempDir.createSync("@omp-blob-store-image-link-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("image-bytes");

		const ref = await externalizeImageData(store, data.toString("base64"), "image/webp");
		const hash = parseBlobRef(ref);

		expect(hash).toBeTruthy();
		expect(await Bun.file(`${tempDir.path()}/${hash}.webp`).bytes()).toEqual(new Uint8Array(data));
		expect(await resolveImageData(store, ref)).toBe(data.toString("base64"));
	});

	it("maps common image mime types to clickable file extensions", () => {
		expect(blobExtensionForImageMimeType("image/jpeg")).toBe("jpg");
		expect(blobExtensionForImageMimeType("image/png")).toBe("png");
		expect(blobExtensionForImageMimeType("text/plain")).toBeUndefined();
	});
});

describe("BlobStore content-addressed writes", () => {
	it("writes a blob once, creates the store on demand, and repairs a torn blob", async () => {
		using tempDir = TempDir.createSync("@omp-blob-store-dedupe-");
		// The store directory does not exist yet: the first put creates it.
		const store = new BlobStore(path.join(tempDir.path(), "blobs"));
		const data = Buffer.from("image-bytes");
		const { path: blobPath } = store.putSync(data);
		expect(await Bun.file(blobPath).bytes()).toEqual(new Uint8Array(data));

		// A same-content put must not republish the canonical file: an in-place
		// write would bump its mtime and a staged write + rename would give the
		// path a new file identity, so both change this fingerprint.
		const fingerprint = () => {
			const stat = fs.statSync(blobPath, { bigint: true });
			return `${stat.dev}:${stat.ino}:${stat.mtimeNs}`;
		};
		const before = fingerprint();
		store.putSync(data);
		await store.put(data);
		expect(fingerprint()).toBe(before);

		fs.truncateSync(blobPath, 3);
		await store.put(data);
		expect(await Bun.file(blobPath).bytes()).toEqual(new Uint8Array(data));
	});

	it("never leaves a partial blob at its hash path when a write is interrupted", () => {
		using tempDir = TempDir.createSync("@omp-blob-store-interrupted-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("complete-image-bytes");
		// A reader resolving the ref (or a later same-size put) must never see a
		// short file under the hash name: the interrupted write stays in staging.
		const realWriteFileSync = fs.writeFileSync;
		vi.spyOn(fs, "writeFileSync").mockImplementationOnce(
			(file: fs.PathOrFileDescriptor, written: string | NodeJS.ArrayBufferView) => {
				if (!Buffer.isBuffer(written)) throw new Error("blob writes stage raw bytes");
				realWriteFileSync(file, written.subarray(0, 5));
				throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
			},
		);
		try {
			expect(() => store.putSync(data)).toThrow("no space left on device");
		} finally {
			vi.restoreAllMocks();
		}
		expect(fs.readdirSync(tempDir.path())).toEqual([]);
	});

	it("writes a copied display sidecar once and repairs it when torn", () => {
		using tempDir = TempDir.createSync("@omp-blob-store-sidecar-copy-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("image-bytes");
		// Filesystems without hardlinks (FAT/exFAT, some network shares) take the
		// copy fallback; an existing complete copy must not be rewritten per put.
		vi.spyOn(fs, "linkSync").mockImplementation(() => {
			throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		});
		try {
			const { displayPath } = store.putSync(data, { extension: "png" });
			const writeFileSync = vi.spyOn(fs, "writeFileSync");
			store.putSync(data, { extension: "png" });
			expect(writeFileSync).not.toHaveBeenCalled();

			fs.truncateSync(displayPath, 3);
			store.putSync(data, { extension: "png" });
			expect(fs.readFileSync(displayPath)).toEqual(data);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("refreshes a long-lived reused blob's mtime so gc's write grace still covers it", () => {
		using tempDir = TempDir.createSync("@omp-blob-store-touch-");
		const store = new BlobStore(tempDir.path());
		const data = Buffer.from("old-image-bytes");
		const first = store.putSync(data);
		const old = new Date(Date.now() - 3_600_000);
		fs.utimesSync(first.path, old, old);

		// A new reference to an hour-old blob is not on disk yet; without a
		// fresh mtime a concurrent `omp gc` would sweep the blob it points to.
		store.putSync(data);

		expect(Date.now() - fs.statSync(first.path).mtimeMs).toBeLessThan(60_000);
		expect(fs.readFileSync(first.path)).toEqual(data);
	});
});
