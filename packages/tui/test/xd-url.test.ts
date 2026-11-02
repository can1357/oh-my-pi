import { describe, expect, it } from "bun:test";
import { parseXdUrl, stripXdPeelableSelectors } from "../src/tools/xd-url";

describe("parseXdUrl", () => {
	it("parses a bare device URL", () => {
		expect(parseXdUrl("xd://wiki_observe")).toEqual({ name: "wiki_observe" });
	});

	it("strips a trailing :raw selector forced by the Cursor bridge", () => {
		expect(stripXdPeelableSelectors("wiki_observe:raw")).toBe("wiki_observe");
		expect(parseXdUrl("xd://wiki_observe:raw")).toEqual({ name: "wiki_observe" });
		expect(parseXdUrl("xd://wiki_observe:RAW")).toEqual({ name: "wiki_observe" });
	});

	it("strips a trailing :conflicts selector", () => {
		expect(parseXdUrl("xd://ast_edit:conflicts")).toEqual({ name: "ast_edit" });
	});

	it("still rejects path/query/fragment characters", () => {
		expect(parseXdUrl("xd://wiki_observe/docs")).toBeNull();
		expect(parseXdUrl("xd://wiki_observe?q=1")).toBeNull();
	});
});
