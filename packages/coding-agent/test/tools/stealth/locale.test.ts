import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	applyStealthPatches,
	buildStealthInjectionScriptForTest,
	closeLaunchedBrowser,
	type LaunchHeadlessResult,
	launchHeadlessBrowser,
	STEALTH_SCRIPTS,
	type StealthState,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import type { Server } from "bun";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "../chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

/** The locale patch alone, and the bootstrap with no patch for the raw native control. */
const PATCH = buildStealthInjectionScriptForTest([STEALTH_SCRIPTS.locale]);
const CONTROL = buildStealthInjectionScriptForTest([]);

/**
 * The launcher claims `en-US,en`. Launching with a different accept language gives the patch
 * something to correct: natively the page, the header and a worker all say `fr-FR,fr`.
 * `--lang=en-US` pins Chromium's ICU locale, which `--accept-lang` deliberately does not touch
 * (Chrome treats the header list and the UI locale as independent).
 */
const HOST_ARGS = ["--accept-lang=fr-FR,fr", "--lang=en-US"] as const;
const HOST_LANGUAGES = ["fr-FR", "fr"];
const CLAIMED_LANGUAGES = ["en-US", "en"];

interface GetterReport {
	hasGet: boolean;
	hasSet: boolean;
	enumerable: boolean;
	configurable: boolean;
	name: string | null;
	length: number | null;
	pageSource: string | null;
	pristineSource: string | null;
	ownKeys: string[] | null;
	proto: boolean | null;
	instanceOf: boolean | null;
}

interface IntlReport {
	dateTimeLocale: string;
	numberLocale: string;
	number: string;
	dateTime: string;
	dateToString: string;
}

interface WorkerReport {
	language: string;
	languages: string;
}

interface LocaleReport {
	language: string;
	languages: string[];
	languagesFrozen: boolean;
	languagesIdentity: boolean;
	languagesMutation: number | "throw";
	languageGetter: GetterReport | null;
	languagesGetter: GetterReport | null;
	nativeLanguageGetter: GetterReport | null;
	nativeLanguagesGetter: GetterReport | null;
	languageOnPlainReceiver: string | null;
	languagesOnPlainReceiver: string | null;
	header: string | null;
	headerLanguages: string[];
	intl: IntlReport;
	worker: WorkerReport;
	prototype: boolean;
	instanceOf: boolean;
	ownLanguage: boolean;
	ownLanguages: boolean;
	ownPropertyNames: string[];
}

/**
 * Reads the navigator locale, accessors, `Intl`, the header the server saw and a dedicated
 * worker in the page's main world. The pristine-realm `toString` and `Navigator.prototype` come
 * from a fresh same-origin iframe, which a detector would also use.
 */
const PROBE = `//!world=main
(async () => {
	const frame = document.body.appendChild(document.createElement("iframe"));
	const pristineWindow = frame.contentWindow;
	const pristineToString = pristineWindow.Function.prototype.toString;
	const describeGetter = (owner, name) => {
		const descriptor = Object.getOwnPropertyDescriptor(owner, name);
		if (!descriptor) return null;
		return {
			hasGet: typeof descriptor.get === "function",
			hasSet: typeof descriptor.set === "function",
			enumerable: descriptor.enumerable,
			configurable: descriptor.configurable,
			name: typeof descriptor.get === "function" ? descriptor.get.name : null,
			length: typeof descriptor.get === "function" ? descriptor.get.length : null,
			pageSource: typeof descriptor.get === "function" ? descriptor.get.toString() : null,
			pristineSource: typeof descriptor.get === "function" ? pristineToString.call(descriptor.get) : null,
			ownKeys: typeof descriptor.get === "function" ? Object.getOwnPropertyNames(descriptor.get) : null,
			proto: typeof descriptor.get === "function" ? Object.getPrototypeOf(descriptor.get) === Function.prototype : null,
			instanceOf: typeof descriptor.get === "function" ? descriptor.get instanceof Function : null,
		};
	};
	const invocation = (getter, receiver) => {
		try {
			const value = getter.call(receiver);
			return Array.isArray(value) ? value.join(",") : value;
		} catch (error) {
			return error.constructor.name;
		}
	};
	const languages = navigator.languages;
	// Native navigator.languages is a frozen, cached array; a replacement that hands out a fresh
	// mutable array changes both the spread and the identity.
	let mutation;
	try {
		const copy = navigator.languages;
		copy.push("zz");
		mutation = copy.length;
	} catch {
		mutation = "throw";
	}
	const worker = await new Promise((resolve, reject) => {
		const instance = new Worker("/worker.js");
		instance.onmessage = (event) => resolve(event.data);
		instance.onerror = () => reject(new Error("worker failed"));
	});
	const header = await (await fetch("/echo")).json();
	const languageGetter = describeGetter(Navigator.prototype, "language");
	const languagesGetter = describeGetter(Navigator.prototype, "languages");
	const nativeLanguageGetter = describeGetter(pristineWindow.Navigator.prototype, "language");
	const nativeLanguagesGetter = describeGetter(pristineWindow.Navigator.prototype, "languages");
	frame.remove();
	return {
		language: navigator.language,
		languages: [...languages],
		languagesFrozen: Object.isFrozen(languages),
		languagesIdentity: navigator.languages === navigator.languages,
		languagesMutation: mutation,
		languageGetter,
		languagesGetter,
		nativeLanguageGetter,
		nativeLanguagesGetter,
		languageOnPlainReceiver: languageGetter ? invocation(Object.getOwnPropertyDescriptor(Navigator.prototype, "language").get, {}) : null,
		languagesOnPlainReceiver: languagesGetter ? invocation(Object.getOwnPropertyDescriptor(Navigator.prototype, "languages").get, {}) : null,
		header: header.acceptLanguage,
		headerLanguages: (header.acceptLanguage || "").split(",").map((part) => part.split(";")[0].trim()),
		intl: {
			dateTimeLocale: Intl.DateTimeFormat().resolvedOptions().locale,
			numberLocale: new Intl.NumberFormat().resolvedOptions().locale,
			number: new Intl.NumberFormat().format(1234.5),
			dateTime: new Intl.DateTimeFormat().format(new Date(0)),
			dateToString: new Date(0).toString(),
		},
		worker,
		prototype: Object.getPrototypeOf(navigator) === Navigator.prototype,
		instanceOf: navigator instanceof Navigator,
		ownLanguage: Object.getOwnPropertyDescriptor(navigator, "language") !== undefined,
		ownLanguages: Object.getOwnPropertyDescriptor(navigator, "languages") !== undefined,
		ownPropertyNames: Object.getOwnPropertyNames(navigator),
	};
})()`;

/** What the patch leaves behind in the page realm for one of the two accessors. */
const NATIVE_SHAPE = {
	hasGet: true,
	hasSet: false,
	enumerable: true,
	configurable: true,
	name: "get language",
	length: 0,
	ownKeys: ["length", "name"],
	proto: true,
	instanceOf: true,
};

let server: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const url = new URL(request.url);
			switch (url.pathname) {
				case "/echo":
					return Response.json({ acceptLanguage: request.headers.get("accept-language") });
				case "/worker.js":
					return new Response(
						"postMessage({ language: navigator.language, languages: navigator.languages.join(',') });",
						{ headers: { "content-type": "text/javascript" } },
					);
				default:
					return new Response("<!doctype html><title>locale</title>", {
						headers: { "content-type": "text/html" },
					});
			}
		},
	});
	launched = await launchHeadlessBrowser({ headless: true, args: [...HOST_ARGS] });
}, 60_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
	server?.stop(true);
});

/** Opens a page with the chosen bootstrap preloaded, then probes it in the main world. */
async function probe(scripts: string): Promise<LocaleReport> {
	if (!launched || !server) throw new Error("browser not ready");
	const page: Page = await launched.browser.newPage();
	try {
		await page.evaluateOnNewDocument(scripts);
		await page.goto(server.url.href);
		return (await page.evaluate(PROBE)) as LocaleReport;
	} finally {
		await page.close();
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("stealth locale patch", () => {
	it("presents the claimed language and languages where the browser reports the host's", async () => {
		const control = await probe(CONTROL);
		const patched = await probe(PATCH);

		// The launch flags put the host's accept language in front; the patch is what changes it.
		expect(control.language).toBe("fr-FR");
		expect(control.languages).toEqual(HOST_LANGUAGES);
		expect(patched.language).toBe("en-US");
		expect(patched.languages).toEqual(CLAIMED_LANGUAGES);

		// Replacing the accessor keeps it on `Navigator.prototype` and leaves no own shadow and no
		// change to the prototype chain or `instanceof`.
		for (const report of [control, patched]) {
			expect(report.prototype).toBe(true);
			expect(report.instanceOf).toBe(true);
			expect(report.ownLanguage).toBe(false);
			expect(report.ownLanguages).toBe(false);
			expect(report.ownPropertyNames.filter(name => /lang/i.test(name))).toEqual([]);
		}
	}, 30_000);

	it("keeps the native accessor descriptor, name and length and masks the replacements", async () => {
		const control = await probe(CONTROL);
		const patched = await probe(PATCH);

		for (const report of [control, patched]) {
			expect(report.languageGetter).not.toBeNull();
			expect(report.languagesGetter).not.toBeNull();
			// The getters stay ordinary functions with native metadata and the native attributes.
			expect(report.languageGetter).toMatchObject({
				...NATIVE_SHAPE,
				pageSource: "function get language() { [native code] }",
			});
			expect(report.languagesGetter).toMatchObject({
				...NATIVE_SHAPE,
				name: "get languages",
				pageSource: "function get languages() { [native code] }",
			});
			// The attributes are the ones the pristine realm still holds for the same accessor.
			expect(report.languageGetter).toMatchObject({
				enumerable: report.nativeLanguageGetter?.enumerable,
				configurable: report.nativeLanguageGetter?.configurable,
				name: report.nativeLanguageGetter?.name,
				length: report.nativeLanguageGetter?.length,
			});
			expect(report.languagesGetter).toMatchObject({
				enumerable: report.nativeLanguagesGetter?.enumerable,
				configurable: report.nativeLanguagesGetter?.configurable,
				name: report.nativeLanguagesGetter?.name,
				length: report.nativeLanguagesGetter?.length,
			});
		}

		// An untouched page agrees with the pristine realm on the native source.
		expect(control.languageGetter?.pristineSource).toBe(control.nativeLanguageGetter?.pristineSource);
		expect(control.languagesGetter?.pristineSource).toBe(control.nativeLanguagesGetter?.pristineSource);

		// Open tell shared with every JavaScript-defined replacement: a pristine realm's own
		// `toString` bypasses the page registry and prints the literal source.
		expect(patched.languageGetter?.pristineSource).toContain("return locale");
		expect(patched.languagesGetter?.pristineSource).toContain("return [locale");
		expect(patched.nativeLanguageGetter?.pristineSource).toBe("function get language() { [native code] }");

		// Open tell: a native accessor rejects a foreign receiver with `TypeError: Illegal
		// invocation`; the replacement getters ignore `this`.
		expect({ language: control.languageOnPlainReceiver, languages: control.languagesOnPlainReceiver }).toEqual({
			language: "TypeError",
			languages: "TypeError",
		});
		expect({ language: patched.languageOnPlainReceiver, languages: patched.languagesOnPlainReceiver }).toEqual({
			language: "en-US",
			languages: "en-US,en",
		});

		// Open tell: native `navigator.languages` is frozen, sealed and cached; the patch returns a
		// fresh mutable array on every access.
		expect({
			frozen: control.languagesFrozen,
			identity: control.languagesIdentity,
			mutation: control.languagesMutation,
		}).toEqual({
			frozen: true,
			identity: true,
			mutation: "throw",
		});
		expect({
			frozen: patched.languagesFrozen,
			identity: patched.languagesIdentity,
			mutation: patched.languagesMutation,
		}).toEqual({
			frozen: false,
			identity: false,
			mutation: 3,
		});
	}, 30_000);

	it("leaves Intl and Date on the host ICU locale, so they agree with the claim only when the host does", async () => {
		const control = await probe(CONTROL);
		const patched = await probe(PATCH);

		// `--accept-lang` does not move Chromium's ICU locale; `--lang=en-US` does. That is what
		// makes the patched navigator and `Intl` agree here, and a host with a non-English UI
		// locale would leave them disagreeing.
		expect(control.intl).toEqual({
			dateTimeLocale: "en-US",
			numberLocale: "en-US",
			number: "1,234.5",
			dateTime: "1/1/1970",
			dateToString: expect.stringContaining("Thu Jan 01 1970"),
		});
		expect(patched.intl).toEqual(control.intl);
		expect(patched.intl.dateTimeLocale).toBe(patched.language);
	}, 30_000);

	it("desyncs the echoed Accept-Language header and workers when injected without the launcher override", async () => {
		const control = await probe(CONTROL);
		const patched = await probe(PATCH);

		// Natively the server, the page and the worker all agree on the host's list.
		expect(control.header?.startsWith("fr-FR,fr")).toBe(true);
		expect(control.headerLanguages).toEqual(control.languages);
		expect(control.worker).toEqual({ language: "fr-FR", languages: "fr-FR,fr" });

		// The patch alone does not touch the request header or worker navigators: they still report
		// the host list while the page claims `en-US,en` (open tell; the launcher sets both).
		expect(patched.header?.startsWith("fr-FR,fr")).toBe(true);
		expect(patched.headerLanguages).toEqual(HOST_LANGUAGES);
		expect(patched.headerLanguages).not.toEqual(patched.languages);
		expect(patched.worker).toEqual(control.worker);
		expect(patched.worker.languages).not.toBe(patched.languages.join(","));
	}, 30_000);

	it("is redundant under the launcher override, which keeps the header and navigator in step", async () => {
		if (!server) throw new Error("server not ready");
		const browser = await launchHeadlessBrowser({ headless: true, args: [...HOST_ARGS] });
		try {
			const state: StealthState = { browserSession: null, override: null };
			const page = await browser.browser.newPage();
			await applyStealthPatches(browser.browser, page, state);
			await page.goto(server.url.href);
			const first = (await page.evaluate(PROBE)) as LocaleReport;
			await page.reload();
			const reloaded = (await page.evaluate(PROBE)) as LocaleReport;
			const other = await browser.browser.newPage();
			await other.goto(server.url.href);
			const secondTab = (await other.evaluate(PROBE)) as LocaleReport;
			await other.close();

			// `Network.setUserAgentOverride` already moved `navigator.language` before the selection
			// probe ran, so modern Chromium never selects the locale patch for this browser.
			expect(state.stealthScripts ?? []).not.toContain(STEALTH_SCRIPTS.locale);

			for (const report of [first, reloaded, secondTab]) {
				expect(report.language).toBe("en-US");
				expect(report.languages).toEqual(CLAIMED_LANGUAGES);
				// Whatever the host's accept language was, the header the server saw carries the
				// same list the page reports, and a reload or a second tab does not desync them.
				expect(report.headerLanguages).toEqual(report.languages);
				expect(report.intl.dateTimeLocale).toBe("en-US");
			}
		} finally {
			await closeLaunchedBrowser(browser);
		}
	}, 60_000);
});
