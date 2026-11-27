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

/** The activity patch alone, and the bootstrap with no patch for the raw native control. */
const PATCH = buildStealthInjectionScriptForTest([STEALTH_SCRIPTS.activity]);
const CONTROL = buildStealthInjectionScriptForTest([]);

const VISIBILITY_GETTERS = ["hidden", "visibilityState", "webkitHidden", "webkitVisibilityState"] as const;

interface DescriptorShape {
	kind: "accessor" | "data";
	writable: boolean | null;
	enumerable: boolean;
	configurable: boolean;
	getType: string;
	setType: string;
}

interface GetterReport {
	key: string;
	name: string;
	length: number;
	/** What the page's (masked) `Function.prototype.toString` prints. */
	maskedSource: string;
	/** What a fresh realm's own, unmasked `toString` prints for the same function. */
	pristineSource: string;
	/** The same getter read through that realm's `Object.getOwnPropertyDescriptor`. */
	realmGetterSource: string;
	ownKeys: string[];
	protoIsFunctionPrototype: boolean;
	instanceOfFunction: boolean;
	descriptor: DescriptorShape;
}

interface FocusState {
	hasFocus: boolean;
	visibilityState: string;
	hidden: boolean;
	webkitHidden: boolean;
	webkitVisibilityState: string;
}

interface ActivityReport {
	prototype: {
		documentPrototype: boolean;
		ownHasFocus: boolean;
		ownVisibilityState: boolean;
		documentPrototypeSlot: boolean;
		htmlDocumentSlot: boolean;
	};
	hasFocus: {
		name: string;
		length: number;
		maskedSource: string;
		pristineSource: string;
		realmOwnSource: string;
		ownKeys: string[];
		protoIsFunctionPrototype: boolean;
		instanceOfFunction: boolean;
		descriptor: DescriptorShape;
	};
	getters: GetterReport[];
	toString: {
		maskedSource: string;
		descriptor: DescriptorShape;
	};
}

/**
 * Reads the installed focus/visibility surface in the page's main world. The pristine-realm
 * `toString` comes from a fresh same-origin iframe, the way a detector would get one; reading a
 * getter back through that realm's own `getOwnPropertyDescriptor` also exercises its registry.
 */
const PROBE = `//!world=main
(() => {
	const describe = (descriptor) => ({
		kind: "value" in descriptor ? "data" : "accessor",
		writable: "value" in descriptor ? descriptor.writable === true : null,
		enumerable: descriptor.enumerable === true,
		configurable: descriptor.configurable === true,
		getType: typeof descriptor.get,
		setType: typeof descriptor.set,
	});

	const frame = document.createElement("iframe");
	frame.style.display = "none";
	(document.body ?? document.documentElement).appendChild(frame);
	const realm = frame.contentWindow;
	const pristineToString = realm.Function.prototype.toString;
	const realmGetOwnPropertyDescriptor = realm.Object.getOwnPropertyDescriptor;
	const pristine = (fn) => pristineToString.call(fn);

	const getters = ${JSON.stringify([...VISIBILITY_GETTERS])}.map((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, key);
		return {
			key,
			name: descriptor.get.name,
			length: descriptor.get.length,
			maskedSource: descriptor.get.toString(),
			pristineSource: pristine(descriptor.get),
			realmGetterSource: pristine(realmGetOwnPropertyDescriptor(Document.prototype, key).get),
			ownKeys: Object.getOwnPropertyNames(descriptor.get).sort(),
			protoIsFunctionPrototype: Object.getPrototypeOf(descriptor.get) === Function.prototype,
			instanceOfFunction: descriptor.get instanceof Function,
			descriptor: describe(descriptor),
		};
	});

	const hasFocusDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "hasFocus");
	const toStringDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");

	const report = {
		prototype: {
			documentPrototype: Object.getPrototypeOf(document) === HTMLDocument.prototype,
			ownHasFocus: Object.hasOwn(document, "hasFocus"),
			ownVisibilityState: Object.hasOwn(document, "visibilityState"),
			documentPrototypeSlot: Object.hasOwn(Document.prototype, "hasFocus"),
			htmlDocumentSlot: Object.hasOwn(HTMLDocument.prototype, "hasFocus"),
		},
		hasFocus: {
			name: hasFocusDescriptor.value.name,
			length: hasFocusDescriptor.value.length,
			maskedSource: hasFocusDescriptor.value.toString(),
			pristineSource: pristine(hasFocusDescriptor.value),
			realmOwnSource: pristine(realm.Document.prototype.hasFocus),
			ownKeys: Object.getOwnPropertyNames(hasFocusDescriptor.value).sort(),
			protoIsFunctionPrototype: Object.getPrototypeOf(hasFocusDescriptor.value) === Function.prototype,
			instanceOfFunction: hasFocusDescriptor.value instanceof Function,
			descriptor: describe(hasFocusDescriptor),
		},
		getters,
		toString: {
			maskedSource: toStringDescriptor.value.toString(),
			descriptor: describe(toStringDescriptor),
		},
	};
	frame.remove();
	return report;
})()`;

const ACCESSOR_SHAPE: DescriptorShape = {
	kind: "accessor",
	writable: null,
	enumerable: true,
	configurable: true,
	getType: "function",
	setType: "undefined",
};

const METHOD_SHAPE: DescriptorShape = {
	kind: "data",
	writable: true,
	enumerable: true,
	configurable: true,
	getType: "undefined",
	setType: "undefined",
};

const READ_STATE = `//!world=main
(() => ({
	hasFocus: document.hasFocus(),
	visibilityState: document.visibilityState,
	hidden: document.hidden,
	webkitHidden: document.webkitHidden,
	webkitVisibilityState: document.webkitVisibilityState,
}))()`;

const INSTALL_EVENTS = `//!world=main
(() => {
	window.__activityEvents = [];
	for (const type of ["focus", "blur"]) {
		window.addEventListener(type, () => window.__activityEvents.push(type));
	}
	document.addEventListener("visibilitychange", () => window.__activityEvents.push("visibilitychange:" + document.visibilityState));
})()`;

const READ_EVENTS = `//!world=main
window.__activityEvents`;

let server: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () =>
			new Response("<!doctype html><title>activity</title><body>activity</body>", {
				headers: { "content-type": "text/html" },
			}),
	});
	launched = await launchHeadlessBrowser({ headless: true });
}, 60_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
	server?.stop(true);
});

/** Opens a tab with the chosen bootstrap preloaded. Caller closes it. */
async function openPage(scripts: string): Promise<Page> {
	if (!launched || !server) throw new Error("browser not ready");
	const page = await launched.browser.newPage();
	await page.evaluateOnNewDocument(scripts);
	await page.goto(server.url.href);
	return page;
}

/** Opens, probes and closes one tab so descriptor tests never share a page. */
async function probe(scripts: string): Promise<ActivityReport> {
	const page = await openPage(scripts);
	try {
		return (await page.evaluate(PROBE)) as ActivityReport;
	} finally {
		await page.close();
	}
}

async function readState(page: Page): Promise<FocusState> {
	return (await page.evaluate(READ_STATE)) as FocusState;
}

async function installEvents(page: Page): Promise<void> {
	await page.evaluate(INSTALL_EVENTS);
}

async function resetEvents(page: Page): Promise<void> {
	await page.evaluate(`//!world=main\nwindow.__activityEvents = []`);
}

async function readEvents(page: Page): Promise<string[]> {
	return (await page.evaluate(READ_EVENTS)) as string[];
}

/** Polls a page-side read until the browser has settled into the focus state the step expects. */
async function waitFor<T>(read: () => Promise<T>, settled: (value: T) => boolean, label: string): Promise<T> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const value = await read();
		if (settled(value)) return value;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(25);
	}
}

/** Every visibility view of the document must tell the same story as `visibilityState`. */
function expectConsistentFocus(state: FocusState): void {
	expect(state.hasFocus).toBe(state.visibilityState === "visible");
	expect(state.hidden).toBe(state.visibilityState === "hidden");
	expect(state.webkitHidden).toBe(state.hidden);
	expect(state.webkitVisibilityState).toBe(state.visibilityState);
}

describe.skipIf(!CHROMIUM_AVAILABLE)("stealth activity patch", () => {
	it("presents the replaced getters and hasFocus as native with native descriptor attributes", async () => {
		const patched = await probe(PATCH);
		const control = await probe(CONTROL);

		// The accessors stay on the same prototype the native ones lived on; the instance keeps
		// its HTMLDocument prototype and gains no own slots.
		expect(patched.prototype).toEqual({
			documentPrototype: true,
			ownHasFocus: false,
			ownVisibilityState: false,
			documentPrototypeSlot: true,
			htmlDocumentSlot: false,
		});

		expect(patched.getters.map(getter => getter.key)).toEqual([...VISIBILITY_GETTERS]);
		for (let index = 0; index < patched.getters.length; index++) {
			const getter = patched.getters[index];
			const native = control.getters[index];
			const expected = `function get ${getter.key}() { [native code] }`;

			// The page reads native accessor source through its masked toString.
			expect(getter.maskedSource).toBe(expected);
			// A detector reading the getter back through a fresh realm's descriptor gets native too.
			expect(getter.realmGetterSource).toBe(expected);
			expect(getter.name).toBe(`get ${getter.key}`);
			expect(getter.length).toBe(0);
			// No own `toString` (or other shim) was added to make the source look native.
			expect(getter.ownKeys).toEqual(["length", "name"]);
			expect(getter.protoIsFunctionPrototype).toBe(true);
			expect(getter.instanceOfFunction).toBe(true);
			expect(getter.descriptor).toEqual(ACCESSOR_SHAPE);
			// The untouched native descriptor has exactly these attributes.
			expect(getter.descriptor).toEqual(native.descriptor);
			// A realm whose own toString is unmasked looks through the page's registry: open tell.
			expect(getter.pristineSource).toContain("[native code]");
		}

		expect(patched.hasFocus.maskedSource).toBe("function hasFocus() { [native code] }");
		expect(patched.hasFocus.descriptor).toEqual(METHOD_SHAPE);
		expect(patched.hasFocus.descriptor).toEqual(control.hasFocus.descriptor);
		expect(patched.hasFocus.name).toBe("hasFocus");
		expect(patched.hasFocus.length).toBe(0);
		expect(patched.hasFocus.ownKeys).toEqual(["length", "name"]);
		expect(patched.hasFocus.protoIsFunctionPrototype).toBe(true);
		expect(patched.hasFocus.instanceOfFunction).toBe(true);
		// A realm with an unmasked toString still sees the replacement's source (open tell); its own
		// copy of the method was registered by that realm's bootstrap and reads native.
		expect(patched.hasFocus.pristineSource).toContain("[native code]");
		expect(patched.hasFocus.realmOwnSource).toBe("function hasFocus() { [native code] }");

		// The mask itself keeps the native toString descriptor; only the value is replaced.
		expect(patched.toString.maskedSource).toBe("function toString() { [native code] }");
		expect(patched.toString.descriptor).toEqual(control.toString.descriptor);
		expect(control.toString.maskedSource).toBe("function toString() { [native code] }");
	}, 30_000);

	it("leaves the getters and hasFocus untouched when no patch runs", async () => {
		const control = await probe(CONTROL);

		for (const getter of control.getters) {
			const expected = `function get ${getter.key}() { [native code] }`;
			expect(getter.maskedSource).toBe(expected);
			expect(getter.pristineSource).toBe(expected);
			expect(getter.realmGetterSource).toBe(expected);
			expect(getter.descriptor).toEqual(ACCESSOR_SHAPE);
		}

		expect(control.hasFocus.maskedSource).toBe("function hasFocus() { [native code] }");
		expect(control.hasFocus.pristineSource).toBe("function hasFocus() { [native code] }");
		expect(control.hasFocus.descriptor).toEqual(METHOD_SHAPE);
		// Without a patch the pristine realm and the page realm agree, so nothing masks anything.
		expect(control.toString.maskedSource).toBe("function toString() { [native code] }");
	}, 30_000);

	it("keeps hasFocus and visibilityState in agreement as focus moves between tabs", async () => {
		const patched = await openPage(PATCH);
		const control = await openPage(CONTROL);
		try {
			await installEvents(patched);
			await installEvents(control);

			// Focus the patched tab: the control tab is genuinely hidden by the browser.
			await patched.bringToFront();
			const controlBlurred = await waitFor(
				() => readState(control),
				state => state.visibilityState === "hidden" && !state.hasFocus,
				"control tab to blur",
			);
			expect(controlBlurred).toEqual({
				hasFocus: false,
				visibilityState: "hidden",
				hidden: true,
				webkitHidden: true,
				webkitVisibilityState: "hidden",
			});
			expectConsistentFocus(controlBlurred);
			expect(await readEvents(control)).toContain("blur");
			expect(await readEvents(control)).toContain("visibilitychange:hidden");

			const patchedFocused = await readState(patched);
			expect(patchedFocused).toEqual({
				hasFocus: true,
				visibilityState: "visible",
				hidden: false,
				webkitHidden: false,
				webkitVisibilityState: "visible",
			});
			expectConsistentFocus(patchedFocused);

			// Move focus away from the patched tab. Its getters may not follow, but every one of them
			// must keep agreeing and the page's focus/visibility listeners must still fire.
			await resetEvents(patched);
			await resetEvents(control);
			await control.bringToFront();
			const controlFocused = await waitFor(
				() => readState(control),
				state => state.visibilityState === "visible" && state.hasFocus,
				"control tab to gain focus",
			);
			await waitFor(
				() => readEvents(patched),
				events => events.includes("blur"),
				"patched tab to receive blur",
			);

			const patchedBlurred = await readState(patched);
			expect(patchedBlurred).toEqual({
				hasFocus: true,
				visibilityState: "visible",
				hidden: false,
				webkitHidden: false,
				webkitVisibilityState: "visible",
			});
			expectConsistentFocus(patchedBlurred);
			// The control proves the tab really is hidden: only the patch keeps claiming otherwise.
			expect(controlFocused).toMatchObject({ hasFocus: true, visibilityState: "visible" });

			const patchedEvents = await readEvents(patched);
			const controlEvents = await readEvents(control);
			expect(patchedEvents).toContain("blur");
			// Page code observes the patched getter inside its own handler, so it never sees "hidden".
			expect(patchedEvents).toContain("visibilitychange:visible");
			expect(patchedEvents).not.toContain("visibilitychange:hidden");
			expect(controlEvents).toContain("focus");
			expect(controlEvents).toContain("visibilitychange:visible");

			// Back to the patched tab: focus listeners fire again and the claims stay plausible.
			await resetEvents(patched);
			await patched.bringToFront();
			await waitFor(
				() => readEvents(patched),
				events => events.includes("focus"),
				"patched tab to regain focus",
			);
			const patchedRefocused = await readState(patched);
			expect(patchedRefocused).toEqual({
				hasFocus: true,
				visibilityState: "visible",
				hidden: false,
				webkitHidden: false,
				webkitVisibilityState: "visible",
			});
			expectConsistentFocus(patchedRefocused);
			const controlBlurredAgain = await waitFor(
				() => readState(control),
				state => state.visibilityState === "hidden" && !state.hasFocus,
				"control tab to blur again",
			);
			expect(controlBlurredAgain).toMatchObject({ hasFocus: false, visibilityState: "hidden", hidden: true });
			expectConsistentFocus(controlBlurredAgain);
		} finally {
			await patched.close();
			await control.close();
		}
	}, 30_000);
});
