import { describe, expect, it } from "bun:test";
import {
	buildAriaSnapshotScript,
	diffAriaSnapshot,
	parseAriaRefSelector,
	postProcessAriaSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser";
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
describe("buildAriaSnapshotScript", () => {
	describe("snapshot post-processing", () => {
		const snapshot = [
			"- document [ref=e1]:",
			'  - main "Account" [ref=e2]:',
			'    - paragraph "Static copy" [ref=e3]',
			"    - generic [ref=e4]:",
			'      - button "Save" [ref=e5]',
			'    - link "Help" [ref=e6]',
			"    - generic [ref=e7]:",
			'      - paragraph "Details" [ref=e8]',
		].join("\n");

		it("keeps interactive nodes and their ancestor path while dropping static siblings", () => {
			const filtered = postProcessAriaSnapshot(snapshot, { interactive: true });
			expect(filtered).toContain('main "Account" [ref=e2]');
			expect(filtered).toContain('button "Save" [ref=e5]');
			expect(filtered).toContain('link "Help" [ref=e6]');
			expect(filtered).not.toContain("Static copy");
		});

		it("removes empty structural wrappers without removing their contents", () => {
			const compact = postProcessAriaSnapshot(snapshot, { compact: true });
			expect(compact).toContain("generic [ref=e4]");
			expect(compact).not.toContain("generic [ref=e7]");
			expect(compact).toContain('paragraph "Details" [ref=e8]');
		});

		it("appends resolved hrefs to links", () => {
			const decorated = postProcessAriaSnapshot(snapshot, { urls: true }, { e6: "https://example.com/help" });
			expect(decorated).toContain('link "Help" [ref=e6] [href="https://example.com/help"]');
		});
	});

	describe("snapshot diffing", () => {
		it("returns stable unchanged revisions and a smaller line delta", () => {
			const baselines = new Map<string, { url: string; revision: number; snapshot: string }>();
			const initial = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
			const changed = initial.replace("line 15", "changed");
			expect(diffAriaSnapshot(baselines, "key", "https://example.com/a", initial)).toMatchObject({
				status: "full",
				revision: 1,
			});
			expect(diffAriaSnapshot(baselines, "key", "https://example.com/a", initial)).toEqual({
				status: "unchanged",
				revision: 1,
			});
			expect(diffAriaSnapshot(baselines, "key", "https://example.com/a", changed)).toMatchObject({
				status: "delta",
				revision: 2,
				baseRevision: 1,
			});
			expect(diffAriaSnapshot(baselines, "key", "https://example.com/b", changed)).toMatchObject({
				status: "full",
				revision: 3,
			});
		});
	});
});
