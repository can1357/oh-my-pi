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

/**
 * The tampering patch is the mask itself: it installs the `toString` proxy and replaces
 * `Object.getOwnPropertyDescriptor`. The bootstrap only runs it when another patch replaced a
 * native, so pair it with one that always does to exercise the mask on its own terms.
 */
const TAMPERING = buildStealthInjectionScriptForTest([STEALTH_SCRIPTS.tampering, STEALTH_SCRIPTS.activity]);
const CONTROL = buildStealthInjectionScriptForTest([]);

/** Everything the patch registers native-looking source for, in its own order. */
const REGISTERED = [
	"alert",
	"prompt",
	"confirm",
	"fetch",
	"XMLHttpRequest",
	"WebSocket",
	"getItem",
	"setItem",
	"getCurrentPosition",
	"watchPosition",
	"getImageData",
	"toDataURL",
	"toBlob",
] as const;

interface DescriptorReport {
	hasValue: boolean;
	value: unknown;
	writable: boolean | undefined;
	enumerable: boolean | undefined;
	configurable: boolean | undefined;
	getType: string;
	setType: string;
	getPristine: string | null;
	getPage: string | null;
	setPristine: string | null;
	setPage: string | null;
}

interface TamperingReport {
	registered: { name: string; present: boolean; pristine: string | null; page: string | null }[];
	gopd: {
		name: string;
		length: number;
		pristineSource: string;
		pageSource: string;
		descriptor: DescriptorReport;
	};
	ordinary: DescriptorReport;
	arrayLength: DescriptorReport;
	missing: boolean;
	accessor: DescriptorReport;
	readThroughAccessor: number;
	maskedToString: { pristine: string; page: string };
}

const PROBE = `//!world=main
(() => {
	const frame = document.createElement("iframe");
	frame.style.display = "none";
	document.body.appendChild(frame);
	// A fresh same-origin realm still holds the browser's own Function.prototype.toString, so a
	// call through it shows what the page would print for a function it never patched.
	const pristineToString = frame.contentWindow.Function.prototype.toString;
	const pristine = (fn) => pristineToString.call(fn);
	const describe = (descriptor) => descriptor === undefined ? null : ({
		hasValue: "value" in descriptor,
		value: "value" in descriptor ? (typeof descriptor.value === "function" ? "[function]" : descriptor.value) : undefined,
		writable: descriptor.writable,
		enumerable: descriptor.enumerable,
		configurable: descriptor.configurable,
		getType: typeof descriptor.get,
		setType: typeof descriptor.set,
		getPristine: typeof descriptor.get === "function" ? pristine(descriptor.get) : null,
		getPage: typeof descriptor.get === "function" ? descriptor.get.toString() : null,
		setPristine: typeof descriptor.set === "function" ? pristine(descriptor.set) : null,
		setPage: typeof descriptor.set === "function" ? descriptor.set.toString() : null,
	});

	const entries = [
		["alert", window.alert],
		["prompt", window.prompt],
		["confirm", window.confirm],
		["fetch", window.fetch],
		["XMLHttpRequest", window.XMLHttpRequest],
		["WebSocket", window.WebSocket],
		["getItem", window.localStorage && window.localStorage.getItem],
		["setItem", window.localStorage && window.localStorage.setItem],
		["getCurrentPosition", window.navigator.geolocation && window.navigator.geolocation.getCurrentPosition],
		["watchPosition", window.navigator.geolocation && window.navigator.geolocation.watchPosition],
		["getImageData", window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype.getImageData],
		["toDataURL", window.HTMLCanvasElement && window.HTMLCanvasElement.prototype.toDataURL],
		["toBlob", window.HTMLCanvasElement && window.HTMLCanvasElement.prototype.toBlob],
	];
	const registered = entries.map(([name, fn]) => ({
		name,
		present: typeof fn === "function",
		pristine: typeof fn === "function" ? pristine(fn) : null,
		page: typeof fn === "function" ? fn.toString() : null,
	}));

	const gopd = Object.getOwnPropertyDescriptor;
	const gopdDescriptor = Object.getOwnPropertyDescriptor(Object, "getOwnPropertyDescriptor");
	const ordinary = Object.getOwnPropertyDescriptor({ plain: 1 }, "plain");
	const arrayLength = Object.getOwnPropertyDescriptor([1, 2], "length");
	const missing = Object.getOwnPropertyDescriptor({}, "absent") === undefined;

	// An accessor written in this page, copied flag-for-flag onto a holder object.
	const source = {
		get x() {
			return 42;
		},
		set x(_value) {},
	};
	const holder = {};
	Object.defineProperty(holder, "x", Object.getOwnPropertyDescriptor(source, "x"));
	const accessor = Object.getOwnPropertyDescriptor(holder, "x");
	const readThroughAccessor = holder.x;

	frame.remove();
	return {
		registered,
		gopd: {
			name: gopd.name,
			length: gopd.length,
			pristineSource: pristine(gopd),
			pageSource: gopd.toString(),
			descriptor: describe(gopdDescriptor),
		},
		ordinary: describe(ordinary),
		arrayLength: describe(arrayLength),
		missing,
		accessor: describe(accessor),
		readThroughAccessor,
		maskedToString: {
			pristine: pristine(Function.prototype.toString),
			page: Function.prototype.toString.toString(),
		},
	};
})()`;

let server: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () =>
			new Response("<!doctype html><title>tampering</title>", { headers: { "content-type": "text/html" } }),
	});
	launched = await launchHeadlessBrowser({ headless: true });
}, 60_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
	server?.stop(true);
});

/** Opens a page with the chosen bootstrap preloaded, then probes it in the main world. */
async function probe(scripts: string): Promise<TamperingReport> {
	if (!launched || !server) throw new Error("browser not ready");
	const page: Page = await launched.browser.newPage();
	try {
		await page.evaluateOnNewDocument(scripts);
		await page.goto(server.url.href);
		return (await page.evaluate(PROBE)) as TamperingReport;
	} finally {
		await page.close();
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("stealth tampering patch", () => {
	it("registers native source for every fingerprinted function and masks the descriptors it hands out", async () => {
		const report = await probe(TAMPERING);

		expect(report.registered.map(entry => entry.name)).toEqual([...REGISTERED]);
		for (const entry of report.registered) {
			expect({ name: entry.name, present: entry.present }).toEqual({ name: entry.name, present: true });
			const native = `function ${entry.name}() { [native code] }`;
			expect({ name: entry.name, pristine: entry.pristine }).toEqual({ name: entry.name, pristine: native });
			expect({ name: entry.name, page: entry.page }).toEqual({ name: entry.name, page: native });
		}

		// The replacement itself is registered too, so the page's toString renders it native.
		expect(report.gopd.name).toBe("getOwnPropertyDescriptor");
		expect(report.gopd.length).toBe(2);
		// A pristine realm has its own unmasked toString, so a JS-defined replacement still reads as
		// source there; the page's masked toString is what makes it look native.
		expect(report.gopd.pageSource).toBe("function getOwnPropertyDescriptor() { [native code] }");
		expect(report.gopd.descriptor).toEqual({
			hasValue: true,
			value: "[function]",
			writable: true,
			enumerable: false,
			configurable: true,
			getType: "undefined",
			setType: "undefined",
			getPristine: null,
			getPage: null,
			setPristine: null,
			setPage: null,
		});

		// Ordinary objects keep their genuine data descriptors.
		expect(report.ordinary).toEqual({
			hasValue: true,
			value: 1,
			writable: true,
			enumerable: true,
			configurable: true,
			getType: "undefined",
			setType: "undefined",
			getPristine: null,
			getPage: null,
			setPristine: null,
			setPage: null,
		});
		expect(report.arrayLength).toEqual({
			hasValue: true,
			value: 2,
			writable: true,
			enumerable: false,
			configurable: false,
			getType: "undefined",
			setType: "undefined",
			getPristine: null,
			getPage: null,
			setPristine: null,
			setPage: null,
		});
		expect(report.missing).toBe(true);

		// A page-defined accessor is reported with its true attributes, but the getter handed out
		// prints as native through the masked Function.prototype.toString.
		expect(report.accessor.hasValue).toBe(false);
		expect(report.accessor.writable).toBeUndefined();
		expect(report.accessor.enumerable).toBe(true);
		expect(report.accessor.configurable).toBe(true);
		expect(report.accessor.getType).toBe("function");
		expect(report.accessor.setType).toBe("function");
		expect(report.accessor.getPristine).toBe("function get x() { [native code] }");
		expect(report.accessor.getPristine).toContain("[native code]");
		expect(report.accessor.getPage).toBe("function get x() { [native code] }");
		expect(report.accessor.setPristine).toContain("[native code]");
		expect(report.accessor.setPage).toBe("function set x() { [native code] }");
		expect(report.readThroughAccessor).toBe(42);
		// The mask is a Proxy, and a pristine realm renders a Proxy as anonymous native code; the
		// control below renders the same native as `function toString()…`, so the two disagree.
		expect(report.maskedToString).toEqual({
			pristine: "function toString() { [native code] }",
			page: "function toString() { [native code] }",
		});
	}, 30_000);

	it("leaves every native untouched when no patch runs", async () => {
		const report = await probe(CONTROL);

		for (const entry of report.registered) {
			expect(entry.present).toBe(true);
			expect(entry.pristine).toBe(`function ${entry.name}() { [native code] }`);
		}
		expect(report.gopd.pristineSource).toBe("function getOwnPropertyDescriptor() { [native code] }");
		expect(report.gopd.pageSource).toBe("function getOwnPropertyDescriptor() { [native code] }");
		expect(report.ordinary.value).toBe(1);
		expect(report.maskedToString).toEqual({
			pristine: "function toString() { [native code] }",
			page: "function toString() { [native code] }",
		});
		expect(report.missing).toBe(true);

		// Without the patch the same probe sees the accessor's real source: the mask is what changed.
		expect(report.accessor.getPage).toContain("return 42");
		expect(report.accessor.getPage).not.toContain("[native code]");
		expect(report.accessor.getPristine).toContain("return 42");
		expect(report.accessor.setPage).not.toContain("[native code]");
		expect(report.readThroughAccessor).toBe(42);
	}, 30_000);
});
