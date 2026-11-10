import { describe, expect, it } from "bun:test";
import { parseXdUrl } from "../src/tools/xd-url";

describe("parseXdUrl", () => {
	it("parses a bare device URL", () => {
		expect(parseXdUrl("xd://wiki_observe")).toEqual({ name: "wiki_observe" });
	});

	it("keeps a trailing :raw or :conflicts suffix in the device name", () => {
		// Write dispatch uses this name. Peeling it would run `ast_edit` for
		// `xd://ast_edit:raw` and turn `xd://:raw` into the root listing.
		expect(parseXdUrl("xd://wiki_observe:raw")).toEqual({ name: "wiki_observe:raw" });
		expect(parseXdUrl("xd://wiki_observe:RAW")).toEqual({ name: "wiki_observe:RAW" });
		expect(parseXdUrl("xd://ast_edit:conflicts")).toEqual({ name: "ast_edit:conflicts" });
		expect(parseXdUrl("xd://:raw")).toEqual({ name: ":raw" });
	});

	it("rejects path and query characters", () => {
		expect(parseXdUrl("xd://wiki_observe/docs")).toBeNull();
		expect(parseXdUrl("xd://wiki_observe?q=1")).toBeNull();
	});
});
