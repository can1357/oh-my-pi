import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { gunzipRustdocJson, gunzipRustdocJsonAsync } from "../../src/web/scrapers/docs-rs";

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

	test("async variant applies the same cap", async () => {
		const json = JSON.stringify({ root: "0", index: { "0": { name: "demo" } } });
		expect(await gunzipRustdocJsonAsync(gzipSync(json))).toBe(json);
		await expect(gunzipRustdocJsonAsync(gzipSync("x".repeat(4096)), 1024)).rejects.toThrow(RangeError);
	});
});
