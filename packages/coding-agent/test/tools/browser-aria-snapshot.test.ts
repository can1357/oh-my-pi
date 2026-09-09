import { describe, expect, it } from "bun:test";
import { buildAriaSnapshotScript, parseAriaRefSelector } from "@oh-my-pi/pi-coding-agent/tools/browser";

describe("parseAriaRefSelector", () => {
	it("accepts the explicit aria-ref prefixes and returns the bare id", () => {
		expect(parseAriaRefSelector("aria-ref=e5")).toBe("e5");
		expect(parseAriaRefSelector("aria-ref/e12")).toBe("e12");
		expect(parseAriaRefSelector("ariaref/e0")).toBe("e0");
		expect(parseAriaRefSelector("  aria-ref=e7  ")).toBe("e7");
	});

	it("accepts bare eN/@eN ids copied straight from snapshot YAML", () => {
		// Agents copy `e501` out of `[ref=e501]` output; treating it as a CSS tag
		// selector guaranteed a zero-match timeout instead of a ref resolution.
		expect(parseAriaRefSelector("e5")).toBe("e5");
		expect(parseAriaRefSelector("@e5")).toBe("e5");
		expect(parseAriaRefSelector(" e501 ")).toBe("e501");
	});

	it("rejects css and other selectors", () => {
		expect(parseAriaRefSelector("button#go")).toBeNull();
		expect(parseAriaRefSelector("text/Submit")).toBeNull();
		expect(parseAriaRefSelector("aria-ref=button")).toBeNull(); // not an eN id
		expect(parseAriaRefSelector("aria-ref=")).toBeNull();
		expect(parseAriaRefSelector("e5x")).toBeNull(); // eN must be the whole selector
		expect(parseAriaRefSelector("section e5")).toBeNull(); // descendant CSS, not a ref
	});

	it("rejects non-string selectors (handle/Promise) with a recovery-naming ToolError", () => {
		// Regression: tab.click(await tab.id(n)) / tab.click(tab.id(n)) used to reach
		// `selector.trim()` and throw the opaque minified `A.trim is not a function`.
		const handle = {
			click: async () => {},
			asElement() {
				return this;
			},
		};
		expect(() => parseAriaRefSelector(handle as never)).toThrow(/must be a string; got an ElementHandle/);
		expect(() => parseAriaRefSelector(handle as never)).toThrow(/\(await tab\.id\(n\)\)\.click\(\)/);
		const promise = Promise.resolve(handle);
		expect(() => parseAriaRefSelector(promise as never)).toThrow(/got a Promise \(missing await\?\)/);
		promise.catch(() => {});
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
