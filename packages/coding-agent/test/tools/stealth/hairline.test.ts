import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	buildStealthInjectionScriptForTest,
	closeLaunchedBrowser,
	type LaunchHeadlessResult,
	launchHeadlessBrowser,
	STEALTH_SCRIPTS,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import type { Server } from "bun";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "../chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

/** The hairline patch alone, and the bootstrap with no patch for the raw native control. */
const PATCH = buildStealthInjectionScriptForTest([STEALTH_SCRIPTS.hairline]);
const CONTROL = buildStealthInjectionScriptForTest([]);

interface DescriptorReport {
	get: string;
	set: string;
	enumerable: boolean | undefined;
	configurable: boolean | undefined;
	hasValue: boolean;
	writable: boolean | undefined;
}

interface Measurement {
	offsetHeight: number;
	offsetWidth: number;
	rectHeight: number;
	rectWidth: number;
}

interface GetterReport {
	page: string;
	pristine: string;
	originalPristine: string;
	name: string;
	length: number;
	ownKeys: string[];
	proto: boolean;
	instanceOf: boolean;
}

interface HairlineReport {
	/** Laid-out `.5px` border: the tell the patch exists for. */
	hairline: Measurement;
	/** Sub-pixel box with side hairlines whose native `offsetHeight` is 0. */
	collapsed: Measurement;
	/** Border box that already measures an integer. */
	integer: Measurement;
	/** Collapsed box without the `modernizr` id. */
	foreign: Measurement;
	/** Collapsed `span` with the `modernizr` id: not an `HTMLDivElement`. */
	span: Measurement;
	/** `display:none` modernizr box: no layout box at all. */
	hidden: Measurement;
	descriptor: DescriptorReport | null;
	originalDescriptor: DescriptorReport | null;
	getter: GetterReport;
	widthDescriptor: { page: string; pristine: string };
	rect: { page: string; pristine: string };
}

/**
 * Reads layout and the installed accessor in the page's main world. The pristine-realm `toString`
 * comes from a fresh same-origin iframe; it bypasses the page's masked `Function.prototype.toString`
 * the same way a detector's would.
 */
const PROBE = `//!world=main
(() => {
	const frame = document.createElement("iframe");
	frame.style.display = "none";
	document.body.appendChild(frame);
	const pristineToString = frame.contentWindow.Function.prototype.toString;
	const pristine = (fn) => pristineToString.call(fn);
	const originalDescriptor = Object.getOwnPropertyDescriptor(frame.contentWindow.HTMLElement.prototype, "offsetHeight");
	const originalGetter = originalDescriptor.get;
	const originalWidthGetter = Object.getOwnPropertyDescriptor(frame.contentWindow.HTMLElement.prototype, "offsetWidth").get;

	const make = (css, id) => {
		const div = document.createElement("div");
		if (id !== null) div.id = id;
		div.style.cssText = css;
		document.body.appendChild(div);
		return div;
	};
	const hairline = make("border:.5px solid transparent", "modernizr");
	const collapsed = make(
		"height:.4px;width:10px;border-left:.5px solid transparent;border-right:.5px solid transparent",
		"modernizr",
	);
	const integer = make("height:40px;width:40px;border:.5px solid transparent", "modernizr");
	const foreign = make("height:.4px", null);
	const span = document.createElement("span");
	span.id = "modernizr";
	span.style.cssText = "display:none";
	document.body.appendChild(span);
	const hidden = make("display:none;border:.5px solid transparent", "modernizr");

	const measure = (element) => {
		const rect = element.getBoundingClientRect();
		return { offsetHeight: element.offsetHeight, offsetWidth: element.offsetWidth, rectHeight: rect.height, rectWidth: rect.width };
	};
	const describeDescriptor = (descriptor) => descriptor === null || descriptor === undefined ? null : ({
		get: typeof descriptor.get,
		set: typeof descriptor.set,
		enumerable: descriptor.enumerable,
		configurable: descriptor.configurable,
		hasValue: "value" in descriptor,
		writable: descriptor.writable,
	});
	const installed = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
	const installedGetter = installed.get;
	const installedWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

	const report = {
		hairline: measure(hairline),
		collapsed: measure(collapsed),
		integer: measure(integer),
		foreign: measure(foreign),
		span: measure(span),
		hidden: measure(hidden),
		descriptor: describeDescriptor(installed),
		originalDescriptor: describeDescriptor(originalDescriptor),
		getter: {
			page: installedGetter.toString(),
			pristine: pristine(installedGetter),
			originalPristine: pristine(originalGetter),
			name: installedGetter.name,
			length: installedGetter.length,
			ownKeys: Object.getOwnPropertyNames(installedGetter).sort(),
			proto: Object.getPrototypeOf(installedGetter) === Function.prototype,
			instanceOf: installedGetter instanceof Function,
		},
		widthDescriptor: {
			page: installedWidth.get.toString(),
			pristine: pristine(installedWidth.get),
		},
		rect: {
			page: Element.prototype.getBoundingClientRect.toString(),
			pristine: pristine(Element.prototype.getBoundingClientRect),
		},
	};
	for (const element of [hairline, collapsed, integer, foreign, span, hidden]) element.remove();
	frame.remove();
	return report;
})()`;

let server: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("<!doctype html><title>hairline</title>", { headers: { "content-type": "text/html" } }),
	});
	launched = await launchHeadlessBrowser({ headless: true });
}, 60_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
	server?.stop(true);
});

/** Opens a page with the chosen bootstrap preloaded, then probes it in the main world. */
async function probe(scripts: string): Promise<HairlineReport> {
	if (!launched || !server) throw new Error("browser not ready");
	const page: Page = await launched.browser.newPage();
	try {
		await page.evaluateOnNewDocument(scripts);
		await page.goto(server.url.href);
		return (await page.evaluate(PROBE)) as HairlineReport;
	} finally {
		await page.close();
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("stealth hairline patch", () => {
	it("rounds a collapsed hairline box to a plausible integer but leaves its rect alone", async () => {
		const patched = await probe(PATCH);
		const control = await probe(CONTROL);

		// Native rounding collapses the sub-pixel box (and the border-less div) to 0.
		expect(control.collapsed.offsetHeight).toBe(0);
		expect(control.foreign.offsetHeight).toBe(0);
		expect(control.hidden.offsetHeight).toBe(0);
		expect(control.span.offsetHeight).toBe(0);

		// The patch substitutes the degenerate height for the only element it recognises.
		expect(patched.collapsed.offsetHeight).toBe(1);
		expect(Number.isInteger(patched.collapsed.offsetHeight)).toBe(true);
		// Width is already an integer natively and matches the raw layout.
		expect(patched.collapsed.offsetWidth).toBe(control.collapsed.offsetWidth);
		expect(Number.isInteger(patched.collapsed.offsetWidth)).toBe(true);
		// `getBoundingClientRect` keeps the true sub-pixel height.
		expect(patched.collapsed.rectHeight).toBe(control.collapsed.rectHeight);
		expect(patched.collapsed.rectHeight).toBeLessThan(1);

		// The id and the div prototype are part of the gate.
		expect(patched.foreign.offsetHeight).toBe(0);
		expect(patched.span.offsetHeight).toBe(0);
		// A box with no layout still reads 1, like a collapsed one (open tell).
		expect(patched.hidden.offsetHeight).toBe(1);
	}, 30_000);

	it("leaves an already-integer measurement and a laid-out `.5px` border untouched", async () => {
		const patched = await probe(PATCH);
		const control = await probe(CONTROL);

		// On this engine `.5px` already rounds up, so the visible probe value is unchanged.
		expect(patched.hairline.offsetHeight).toBe(control.hairline.offsetHeight);
		expect(Number.isInteger(patched.hairline.offsetHeight)).toBe(true);
		expect(patched.hairline.offsetHeight).toBeGreaterThan(0);
		expect(patched.hairline.offsetWidth).toBe(control.hairline.offsetWidth);
		expect(Number.isInteger(patched.hairline.offsetWidth)).toBe(true);

		// A real 40px box plus its 1px border reports the same integer with the patch.
		expect(patched.integer.offsetHeight).toBe(42);
		expect(patched.integer.offsetWidth).toBe(42);
		expect(patched.integer).toEqual(control.integer);
		expect(patched.integer.offsetHeight).toBe(patched.integer.rectHeight);
		expect(patched.integer.offsetWidth).toBe(patched.integer.rectWidth);

		// `getBoundingClientRect` itself is the native one in both realms.
		for (const report of [patched, control]) {
			expect(report.rect.page).toBe("function getBoundingClientRect() { [native code] }");
			expect(report.rect.pristine).toBe("function getBoundingClientRect() { [native code] }");
		}
	}, 30_000);

	it("keeps the native accessor descriptor and masks the replacement in the page realm", async () => {
		const patched = await probe(PATCH);

		// Replacing the getter keeps the original accessor's attributes and does not add a value.
		expect(patched.descriptor).toEqual(patched.originalDescriptor);
		expect(patched.descriptor).toEqual({
			get: "function",
			set: "undefined",
			enumerable: true,
			configurable: true,
			hasValue: false,
			writable: undefined,
		});

		// Proxy forwards the native getter's metadata and prototype.
		expect(patched.getter.name).toBe("get offsetHeight");
		expect(patched.getter.length).toBe(0);
		expect(patched.getter.ownKeys).toEqual(["length", "name"]);
		expect(patched.getter.proto).toBe(true);
		expect(patched.getter.instanceOf).toBe(true);

		// The page's masked toString prints native accessor source...
		expect(patched.getter.page).toBe("function get offsetHeight() { [native code] }");
		expect(patched.getter.originalPristine).toBe("function get offsetHeight() { [native code] }");
		// ...but a pristine realm's own toString bypasses the registry: this is an open tell.
		expect(patched.getter.pristine).toBe("function () { [native code] }");

		// `offsetWidth` gets the same replacement, so a collapsed hairline reads an integer either way.
		expect(patched.widthDescriptor.page).toBe("function get offsetWidth() { [native code] }");
		// A pristine realm still sees a Proxy: the open tell shared by every patched accessor.
		expect(patched.widthDescriptor.pristine).toBe("function () { [native code] }");
	}, 30_000);

	it("leaves every native getter and its source alone when no patch runs", async () => {
		const control = await probe(CONTROL);

		expect(control.descriptor).toEqual(control.originalDescriptor);
		expect(control.descriptor).toEqual({
			get: "function",
			set: "undefined",
			enumerable: true,
			configurable: true,
			hasValue: false,
			writable: undefined,
		});
		expect(control.getter.name).toBe("get offsetHeight");
		expect(control.getter.page).toBe("function get offsetHeight() { [native code] }");
		expect(control.getter.pristine).toBe(control.getter.originalPristine);
		expect(control.widthDescriptor.pristine).toBe("function get offsetWidth() { [native code] }");
	}, 30_000);
});
