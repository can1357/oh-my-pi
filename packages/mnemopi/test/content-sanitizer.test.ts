import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	computeSha256,
	isDataUri,
	looksLikeBase64Blob,
	parseDataUri,
	sanitizeContent,
	shannonEntropy,
	storeBlob,
} from "@oh-my-pi/pi-mnemopi/core/content-sanitizer";

const ORIGINAL_BLOB_DIR = process.env.MNEMOPI_BLOB_DIR;

afterEach(() => {
	if (ORIGINAL_BLOB_DIR === undefined) {
		delete process.env.MNEMOPI_BLOB_DIR;
	} else {
		process.env.MNEMOPI_BLOB_DIR = ORIGINAL_BLOB_DIR;
	}
});

function useTempBlobDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-blobs-"));
	process.env.MNEMOPI_BLOB_DIR = join(dir, "blobs");
	return process.env.MNEMOPI_BLOB_DIR;
}

describe("content sanitizer data URI parsing", () => {
	it("detects data URI prefixes only", () => {
		expect(isDataUri("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
		expect(isDataUri("data:text/plain;base64,SGVsbG8=")).toBe(true);
		expect(isDataUri("Hello world")).toBe(false);
		expect(isDataUri("just some text")).toBe(false);
	});

	it("parses base64 data URIs with explicit and default mime types", () => {
		const pngDot = Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).toString("base64");
		expect(parseDataUri(`data:image/png;base64,${pngDot}`)).toEqual([
			"image/png",
			Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
		]);
		expect(parseDataUri("data:;base64,SGVsbG8=")).toEqual(["application/octet-stream", Buffer.from("Hello")]);
	});

	it("rejects invalid base64 and missing schemes", () => {
		expect(parseDataUri("data:image/png;base64,!!!not-valid!!!")).toBeNull();
		expect(parseDataUri("just text")).toBeNull();
	});
});

describe("content sanitizer entropy heuristic", () => {
	it("separates uniform random-looking text from prose and repeated characters", () => {
		const uniform = "abcdefghijklmnopqrstuvwxyz0123456789+/ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(2000);
		const prose = "hello world this is normal english text with common letters and patterns ".repeat(1000);
		const repeated = "aaaaa".repeat(10000);

		expect(shannonEntropy(uniform)).toBeGreaterThan(5.5);
		expect(shannonEntropy(prose)).toBeLessThan(5.0);
		expect(shannonEntropy(repeated)).toBeLessThan(0.1);
		expect(shannonEntropy("")).toBe(0.0);
	});

	it("flags large high-entropy base64-like payloads only", () => {
		const raw = Buffer.allocUnsafe(150_000);
		for (let i = 0; i < raw.length; i += 1) raw[i] = i & 0xff;
		const b64 = raw.toString("base64");
		const code = "def foo():\n    return 42\n".repeat(20000);

		expect(looksLikeBase64Blob(b64)).toBe(true);
		expect(looksLikeBase64Blob(code)).toBe(false);
	});
});

describe("content sanitizer blob storage", () => {
	it("stores blobs by sha256 and is idempotent", () => {
		const blobRoot = useTempBlobDir();
		const data = Buffer.from("binary blob content for testing");
		const sha = storeBlob(data);
		const path = join(blobRoot, sha.slice(0, 2), sha.slice(0, 4), sha);
		const mtime = statSync(path).mtimeMs;

		expect(sha).toHaveLength(64);
		expect(computeSha256(data)).toBe(sha);
		expect(readFileSync(path)).toEqual(data);
		expect(storeBlob(data)).toBe(sha);
		expect(statSync(path).mtimeMs).toBe(mtime);
	});
});

describe("sanitize_content", () => {
	it("passes through normal and small content", () => {
		const content = "This is normal conversational text.";
		expect(sanitizeContent(content)).toEqual([content, {}]);
		expect(sanitizeContent("Small text, under all thresholds.")).toEqual(["Small text, under all thresholds.", {}]);
	});

	it("extracts data URIs with metadata", () => {
		useTempBlobDir();
		const raw = Buffer.from("\x89PNG header fake binary data for test", "binary");
		const result = sanitizeContent(`data:image/png;base64,${raw.toString("base64")}`);

		expect(result[0]).toContain("Binary content extracted");
		expect(result[0]).toContain("blob://sha256/");
		expect(result[1].extraction_reason).toBe("data_uri");
		expect(result[1].mime).toBe("image/png");
		expect(result[1].original_size).toBe(raw.length);
	});

	it("extracts content above the hard cap", () => {
		useTempBlobDir();
		const [sanitized, meta] = sanitizeContent("x".repeat(1_000_001));
		expect(sanitized).toContain("Large content extracted");
		expect(meta.extraction_reason).toBe("size_cap");
	});

	it("extracts high-entropy payloads but leaves large prose untouched", () => {
		useTempBlobDir();
		const raw = Buffer.allocUnsafe(150_000);
		for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 31) & 0xff;
		const highEntropy = raw.toString("base64");
		const prose =
			"This is a normal paragraph of English text. It discusses various topics in a conversational tone. ".repeat(
				3000,
			);

		const [sanitized, meta] = sanitizeContent(highEntropy);
		expect(sanitized).toContain("Encoded content extracted");
		expect(meta.extraction_reason).toBe("high_entropy");
		expect(meta.entropy).toBeGreaterThan(5.0);
		expect(sanitizeContent(prose)).toEqual([prose, {}]);
	});
});
