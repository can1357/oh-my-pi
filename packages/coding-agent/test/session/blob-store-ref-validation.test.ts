import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	BlobStore,
	parseBlobRef,
	resolveImageData,
	resolveImageDataSync,
	resolveImageDataUrl,
} from "../../src/session/blob-store";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "blob-store-test-"));
const blobDir = path.join(base, "agent", "blobs", "data");
fs.mkdirSync(blobDir, { recursive: true });
fs.writeFileSync(path.join(base, "secret.txt"), "TOP-SECRET-CONTENTS");
const store = new BlobStore(blobDir);

afterAll(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

describe("parseBlobRef validation", () => {
	it("accepts a canonical 64-char lowercase hex suffix", () => {
		const hash = "a".repeat(64);
		expect(parseBlobRef(`blob:sha256:${hash}`)).toBe(hash);
	});

	it("returns null for non-blob strings", () => {
		expect(parseBlobRef("data:image/png;base64,AAAA")).toBeNull();
	});

	it.each([
		"../../../secret.txt",
		`${"../".repeat(6)}etc/passwd`,
		"A".repeat(64), // uppercase hex is not the canonical shape
		"a".repeat(63), // too short
		"a".repeat(65), // too long
		"", // empty
	])("rejects malformed suffix %p", suffix => {
		expect(parseBlobRef(`blob:sha256:${suffix}`)).toBeNull();
	});
});

describe("blob resolution path confinement", () => {
	const traversalRef = "blob:sha256:../../../secret.txt";

	it("leaves a traversal ref unresolved instead of reading outside the blob dir (base64 path)", async () => {
		expect(await resolveImageData(store, traversalRef)).toBe(traversalRef);
		expect(resolveImageDataSync(store, traversalRef)).toBe(traversalRef);
	});

	it("leaves a traversal ref unresolved instead of reading outside the blob dir (data-url path)", async () => {
		expect(await resolveImageDataUrl(store, traversalRef)).toBe(traversalRef);
	});

	it("still resolves a valid stored blob", async () => {
		const put = store.putSync(Buffer.from("hello"));
		expect(Buffer.from(resolveImageDataSync(store, put.ref), "base64").toString("utf8")).toBe("hello");
		expect(Buffer.from(await resolveImageData(store, put.ref), "base64").toString("utf8")).toBe("hello");
	});
});
