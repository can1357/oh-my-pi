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

		const writeFileSync = vi.spyOn(fs, "writeFileSync");
		const bunWrite = vi.spyOn(Bun, "write");
		try {
			const blobWrites = () =>
				[...writeFileSync.mock.calls, ...bunWrite.mock.calls].filter(([target]) => target === blobPath).length;
			store.putSync(data);
			await store.put(data);
			expect(blobWrites()).toBe(0);

			fs.truncateSync(blobPath, 3);
			await store.put(data);
			expect(blobWrites()).toBe(1);
			expect(await Bun.file(blobPath).bytes()).toEqual(new Uint8Array(data));
		} finally {
			writeFileSync.mockRestore();
			bunWrite.mockRestore();
		}
	});
});
