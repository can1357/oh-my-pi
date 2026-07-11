import { describe, expect, it } from "bun:test";
import { buildAriaSnapshotScript, parseAriaRefSelector } from "@pk-nerdsaver-ai/pi-coding-agent/tools/browser";

describe("parseAriaRefSelector", () => {
	it("accepts the explicit aria-ref prefixes and returns the bare id", () => {
		expect(parseAriaRefSelector("aria-ref=e5")).toBe("e5");
		expect(parseAriaRefSelector("aria-ref/e12")).toBe("e12");
		expect(parseAriaRefSelector("ariaref/e0")).toBe("e0");
		expect(parseAriaRefSelector("  aria-ref=e7  ")).toBe("e7");
	});

	it("rejects a bare eN id so action selectors mean the same on both backends", () => {
		// cmux already uses bare `eN`/`@eN` for its native observe refs; requiring
		// the prefix keeps `tab.click("e5")` from meaning different things per backend.
		expect(parseAriaRefSelector("e5")).toBeNull();
		expect(parseAriaRefSelector("@e5")).toBeNull();
	});

	it("rejects css and other selectors", () => {
		expect(parseAriaRefSelector("button#go")).toBeNull();
		expect(parseAriaRefSelector("text/Submit")).toBeNull();
		expect(parseAriaRefSelector("aria-ref=button")).toBeNull(); // not an eN id
		expect(parseAriaRefSelector("aria-ref=")).toBeNull();
	});
});

describe("buildAriaSnapshotScript", () => {
	it("resolves a CSS root selector in-page and throws on miss", () => {
		const script = buildAriaSnapshotScript("main .post");
		expect(script).toContain('var __sel="main .post"');
		expect(script).toContain("document.querySelector(__sel)");
		expect(script).toContain("matched no element");
		// The vendored bundle's entry is invoked against the resolved root.
		expect(script).toContain("module.exports.ariaSnapshot(__root,");
	});

	it("defaults the root to the whole document when no selector is given", () => {
		const script = buildAriaSnapshotScript(undefined);
		expect(script).toContain("var __sel=null");
		expect(script).toContain("module.exports.ariaSnapshot(__root,");
	});

	it("threads depth and boxes options into the request payload", () => {
		const script = buildAriaSnapshotScript(undefined, { depth: 3, boxes: true });
		expect(script).toContain('"depth":3');
		expect(script).toContain('"boxes":true');
	});
});
