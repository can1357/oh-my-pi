import { describe, expect, it } from "bun:test";
import { buildAriaSnapshotScript, parseAriaRefSelector } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { captureAriaSnapshot, resolveAriaRefHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/aria/aria-snapshot";
import { ensureChromiumExecutable, loadPuppeteer } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

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

describe("ARIA snapshot ownership", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"rejects refs overwritten by another alias and resolves refreshed refs to the correct control",
		async () => {
			const puppeteer = await loadPuppeteer();
			const browser = await puppeteer.launch({
				executablePath: await ensureChromiumExecutable(),
				headless: true,
				args: ["--no-sandbox"],
			});
			try {
				const page = await browser.newPage();
				await page.setContent(
					'<button id="first">First</button><button id="second" onclick="document.title = \'second clicked\'">Second</button>',
				);
				const second = await page.$("#second");
				if (!second) throw new Error("Missing fixture button");
				const original = await captureAriaSnapshot(page, second, {}, "alias-a");
				const originalRef = original.match(/\[ref=(e\d+)\]/)?.[1];
				if (!originalRef) throw new Error("Missing snapshot ref");
				await captureAriaSnapshot(page, null, {}, "alias-b");
				await expect(resolveAriaRefHandle(page, originalRef, "alias-a")).rejects.toThrow(
					"invalidated by another alias",
				);
				const refreshed = await captureAriaSnapshot(page, second, {}, "alias-a");
				const ref = refreshed.match(/\[ref=(e\d+)\]/)?.[1];
				if (!ref) throw new Error("Missing refreshed ref");
				const handle = await resolveAriaRefHandle(page, ref, "alias-a");
				if (!handle) throw new Error("Missing refreshed handle");
				await handle.click();
				expect(await page.title()).toBe("second clicked");
				await page.evaluate(buildAriaSnapshotScript(undefined));
				await expect(resolveAriaRefHandle(page, ref, "alias-a")).rejects.toThrow("invalidated by another alias");
				await expect(page.evaluate(buildAriaSnapshotScript("#missing"))).rejects.toThrow("matched no element");
			} finally {
				await browser.close();
			}
		},
		30_000,
	);
});
