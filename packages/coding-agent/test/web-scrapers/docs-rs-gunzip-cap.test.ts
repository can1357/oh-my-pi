import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { gunzipRustdocJson, MAX_RUSTDOC_GUNZIP_BYTES } from "../../src/web/scrapers/docs-rs";

describe("docs.rs rustdoc gunzip cap", () => {
	test("decompresses payloads under the cap", () => {
		const json = JSON.stringify({ root: "0", index: { "0": { name: "demo" } } });
		expect(gunzipRustdocJson(gzipSync(json))).toBe(json);
	});

	test("rejects payloads whose decompressed size exceeds the cap", () => {
		// A tiny compressed body expanding past the (test-scaled) cap must throw,
		// which handleDocsRs converts into a null result instead of parsing.
		const oversized = gzipSync("x".repeat(4096));
		expect(() => gunzipRustdocJson(oversized, 1024)).toThrow(RangeError);
	});

	test("default cap is 256 MiB", () => {
		expect(MAX_RUSTDOC_GUNZIP_BYTES).toBe(256 * 1024 * 1024);
	});
});
