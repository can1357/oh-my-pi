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

/** The iframe patch alone, and the bootstrap with no patch for the raw native control. */
const PATCH = buildStealthInjectionScriptForTest([STEALTH_SCRIPTS.iframe]);
const CONTROL = buildStealthInjectionScriptForTest([]);

/** A read that may cross an origin boundary: `SecurityError` instead of a throw out of the probe. */
type Guarded<T> = { ok: true; value: T } | { ok: false; name: string };

interface DescriptorShape {
	hasValue: boolean;
	writable: boolean | undefined;
	enumerable: boolean | undefined;
	configurable: boolean | undefined;
	get: string;
	set: string;
}

interface AccessorShape {
	/** `toString()` in the page, which the mask covers. */
	page: string;
	/** `toString()` from a fresh same-origin realm, which bypasses the mask. */
	pristine: string;
	name: string;
	length: number;
	ownKeys: string[];
	proto: boolean;
	instanceOf: boolean;
}

interface FreshWindow {
	hasWindow: boolean;
	url: string;
	readyState: string;
	identity: boolean;
	self: boolean;
	window: boolean;
	frames: boolean;
	globalThis: boolean;
	frameElement: boolean;
	closed: boolean;
}

interface SrcdocWindow {
	hasWindow: boolean;
	/** Whether the window read before the `srcdoc` assignment is still the one exposed after it. */
	sameAsBefore: boolean;
	url: string;
	readyState: string;
	srcdoc: string;
	attribute: string | null;
	identity: boolean;
	self: boolean;
	window: boolean;
	frames: boolean;
	globalThis: boolean;
	frameElement: boolean;
	closed: boolean;
}

interface LoadedWindow {
	hasWindow: boolean;
	url: string;
	text: string;
	markup: string;
	srcdoc: string;
	identityWithSync: boolean;
	frameElement: boolean;
}

/** How the proxy reports the window's own accessors: native windows hand out accessors, not data. */
interface ProxyFace {
	nestedLength: number;
	hasIndexKey: boolean;
	self: boolean;
	frameElement: boolean;
	ownSelf: string;
	ownFrames: string;
	ownFrameElement: string;
	ownLength: string;
}

interface IframeReport {
	fresh: FreshWindow;
	srcdoc: { sync: SrcdocWindow; loaded: LoadedWindow };
	accessors: {
		contentWindow: AccessorShape;
		srcdocGetter: AccessorShape;
		srcdocSetter: AccessorShape;
		referenceGetter: AccessorShape;
		referenceSetter: AccessorShape;
	};
	descriptors: {
		contentWindow: DescriptorShape;
		srcdoc: DescriptorShape;
		nativeContentWindow: DescriptorShape;
		nativeSrcdoc: DescriptorShape;
	};
	proxy: ProxyFace;
	sandbox: {
		hasWindow: boolean;
		documentUrl: Guarded<string>;
		self: boolean;
		frameElement: Guarded<boolean>;
	};
	crossOrigin: {
		hasWindow: boolean;
		syncDocumentUrl: Guarded<string>;
		documentUrl: Guarded<string>;
		locationHref: Guarded<string>;
		frameElement: Guarded<boolean>;
		identity: boolean;
		length: Guarded<number>;
		self: Guarded<boolean>;
	};
	proxiedCrossOrigin: {
		hasWindow: boolean;
		identity: boolean;
		documentUrl: Guarded<string>;
		locationHref: Guarded<string>;
		frameElement: Guarded<boolean>;
		self: Guarded<boolean>;
		length: Guarded<number>;
	};
	nullCases: {
		detached: boolean;
		detachedWithSrcdoc: boolean;
		removedBefore: boolean;
		removedAfter: boolean;
		proxiedRemovedBefore: boolean;
		proxiedRemovedAfter: boolean;
		hidden: boolean;
		templateBefore: boolean;
		templateAfter: boolean;
	};
}

/**
 * Exercises the patch in the page's main world; the pristine-realm `toString` comes from a fresh
 * same-origin iframe, exactly as a detector would reach one. A fresh page is used per bootstrap so
 * a previously registered patch cannot leak into the control.
 */
const probeSource = (otherOrigin: string) => `//!world=main
(async () => {
	const read = (fn) => {
		try {
			return { ok: true, value: fn() };
		} catch (error) {
			return { ok: false, name: error.name };
		}
	};
	const waitForLoad = (frame) => new Promise((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
	const clean = [];
	const append = (element) => {
		document.body.appendChild(element);
		clean.push(element);
		return element;
	};

	const pristineFrame = append(document.createElement("iframe"));
	const pristineToString = pristineFrame.contentWindow.Function.prototype.toString;
	const pristine = (fn) => pristineToString.call(fn);
	const pristineIframeProto = pristineFrame.contentWindow.HTMLIFrameElement.prototype;

	const describeDescriptor = (descriptor) => descriptor === undefined ? null : ({
		hasValue: "value" in descriptor,
		writable: descriptor.writable,
		enumerable: descriptor.enumerable,
		configurable: descriptor.configurable,
		get: typeof descriptor.get,
		set: typeof descriptor.set,
	});
	const describeAccessor = (fn) => ({
		page: fn.toString(),
		pristine: pristine(fn),
		name: fn.name,
		length: fn.length,
		ownKeys: Object.getOwnPropertyNames(fn).sort(),
		proto: Object.getPrototypeOf(fn) === Function.prototype,
		instanceOf: fn instanceof Function,
	});

	// Item 1: a freshly inserted iframe exposes its window in the same tick.
	const fresh = append(document.createElement("iframe"));
	const freshWindow = fresh.contentWindow;
	const freshAgain = fresh.contentWindow;

	const docFrame = append(document.createElement("iframe"));
	const beforeSrcdoc = docFrame.contentWindow;
	const markup = '<p id="mark">srcdoc-ok</p>';
	const docLoaded = waitForLoad(docFrame);
	docFrame.srcdoc = markup;
	const syncWindow = docFrame.contentWindow;
	const sync = {
		hasWindow: syncWindow !== null,
		sameAsBefore: syncWindow === beforeSrcdoc,
		url: syncWindow.document.URL,
		readyState: syncWindow.document.readyState,
		srcdoc: docFrame.srcdoc,
		attribute: docFrame.getAttribute("srcdoc"),
		identity: syncWindow === docFrame.contentWindow,
		self: syncWindow.self === syncWindow,
		window: syncWindow.window === syncWindow,
		frames: syncWindow.frames === syncWindow,
		globalThis: syncWindow.globalThis === syncWindow,
		frameElement: syncWindow.frameElement === docFrame,
		closed: syncWindow.closed,
	};
	await docLoaded;
	const loadedWindow = docFrame.contentWindow;
	const loaded = {
		hasWindow: loadedWindow !== null,
		url: loadedWindow.document.URL,
		text: loadedWindow.document.body.textContent,
		markup: loadedWindow.document.querySelector("#mark").textContent,
		srcdoc: docFrame.srcdoc,
		identityWithSync: loadedWindow === syncWindow,
		frameElement: loadedWindow.frameElement === docFrame,
	};

	// Item 2: the installed accessors and their descriptors.
	const contentWindowDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
	const srcdocDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc");
	const nativeContentWindowDescriptor = Object.getOwnPropertyDescriptor(pristineIframeProto, "contentWindow");
	const nativeSrcdocDescriptor = Object.getOwnPropertyDescriptor(pristineIframeProto, "srcdoc");
	// A main-realm native accessor pair, for shape fields that are realm-relative (prototype identity).
	const referenceGetter = Object.getOwnPropertyDescriptor(Node.prototype, "textContent").get;
	const referenceSetter = Object.getOwnPropertyDescriptor(Node.prototype, "textContent").set;
	const accessors = {
		contentWindow: describeAccessor(contentWindowDescriptor.get),
		srcdocGetter: describeAccessor(srcdocDescriptor.get),
		srcdocSetter: describeAccessor(srcdocDescriptor.set),
		referenceGetter: describeAccessor(referenceGetter),
		referenceSetter: describeAccessor(referenceSetter),
	};

	// The proxy's own face, measured on a srcdoc frame that actually has two child frames.
	const nestedFrame = append(document.createElement("iframe"));
	const nestedLoaded = waitForLoad(nestedFrame);
	nestedFrame.srcdoc = "<iframe></iframe><iframe></iframe>";
	await nestedLoaded;
	const nestedWindow = nestedFrame.contentWindow;
	const windowKind = (key) => {
		const descriptor = Object.getOwnPropertyDescriptor(nestedWindow, key);
		if (descriptor === undefined) return "absent";
		return "value" in descriptor ? "data" : "accessor";
	};
	const proxy = {
		nestedLength: nestedWindow.length,
		hasIndexKey: Object.getOwnPropertyNames(nestedWindow).includes("0"),
		self: nestedWindow.self === nestedWindow,
		frameElement: nestedWindow.frameElement === nestedFrame,
		ownSelf: windowKind("self"),
		ownFrames: windowKind("frames"),
		ownFrameElement: windowKind("frameElement"),
		ownLength: windowKind("length"),
	};

	// Item 3: sandbox, cross-origin and platform-null cases.
	const detached = document.createElement("iframe");
	const detachedWithSrcdoc = document.createElement("iframe");
	detachedWithSrcdoc.srcdoc = "<p>detached</p>";
	const removed = append(document.createElement("iframe"));
	const removedBefore = removed.contentWindow !== null;
	removed.remove();
	const proxiedRemoved = append(document.createElement("iframe"));
	proxiedRemoved.srcdoc = "<p>proxied</p>";
	const proxiedRemovedBefore = proxiedRemoved.contentWindow !== null;
	proxiedRemoved.remove();
	const hidden = append(document.createElement("iframe"));
	hidden.style.display = "none";
	const template = document.createElement("template");
	template.innerHTML = "<iframe></iframe>";
	const templateFrame = template.content.firstElementChild;
	const templateBefore = templateFrame.contentWindow === null;
	append(templateFrame);
	const templateAfter = templateFrame.contentWindow !== null;

	const sandbox = append(document.createElement("iframe"));
	sandbox.setAttribute("sandbox", "allow-scripts");
	const sandboxLoaded = waitForLoad(sandbox);
	sandbox.srcdoc = "<script>document.body.textContent = 'sandbox-ok'<\\/script>";
	await sandboxLoaded;
	const sandboxWindow = sandbox.contentWindow;
	const sandboxReport = {
		hasWindow: sandboxWindow !== null,
		documentUrl: read(() => sandboxWindow.document.URL),
		self: sandboxWindow.self === sandboxWindow,
		frameElement: read(() => sandboxWindow.frameElement === sandbox),
	};

	const cross = append(document.createElement("iframe"));
	const crossLoaded = waitForLoad(cross);
	cross.src = ${JSON.stringify(otherOrigin)};
	const crossSync = cross.contentWindow;
	const crossSyncDocument = read(() => cross.contentWindow.document.URL);
	await crossLoaded;
	const crossWindow = cross.contentWindow;
	const crossReport = {
		hasWindow: crossWindow !== null,
		syncDocumentUrl: crossSyncDocument,
		documentUrl: read(() => crossWindow.document.URL),
		locationHref: read(() => crossWindow.location.href),
		frameElement: read(() => crossWindow.frameElement === cross),
		identity: crossSync === crossWindow,
		length: read(() => crossWindow.length),
		self: read(() => crossWindow.self === crossWindow),
	};

	// An iframe the patch proxied through srcdoc, then navigated to another origin.
	const proxied = append(document.createElement("iframe"));
	proxied.srcdoc = "<p>proxied</p>";
	const proxiedSync = proxied.contentWindow;
	proxied.removeAttribute("srcdoc");
	const proxiedLoaded = waitForLoad(proxied);
	proxied.src = ${JSON.stringify(otherOrigin)};
	await proxiedLoaded;
	const proxiedWindow = proxied.contentWindow;
	const proxiedReport = {
		hasWindow: proxiedWindow !== null,
		identity: proxiedSync === proxiedWindow,
		documentUrl: read(() => proxiedWindow.document.URL),
		locationHref: read(() => proxiedWindow.location.href),
		frameElement: read(() => proxiedWindow.frameElement === proxied),
		self: read(() => proxiedWindow.self === proxiedWindow),
		length: read(() => proxiedWindow.length),
	};

	const report = {
		fresh: {
			hasWindow: freshWindow !== null,
			url: freshWindow.document.URL,
			readyState: freshWindow.document.readyState,
			identity: freshWindow === freshAgain,
			self: freshWindow.self === freshWindow,
			window: freshWindow.window === freshWindow,
			frames: freshWindow.frames === freshWindow,
			globalThis: freshWindow.globalThis === freshWindow,
			frameElement: freshWindow.frameElement === fresh,
			closed: freshWindow.closed,
		},
		srcdoc: { sync, loaded },
		accessors,
		descriptors: {
			contentWindow: describeDescriptor(contentWindowDescriptor),
			srcdoc: describeDescriptor(srcdocDescriptor),
			nativeContentWindow: describeDescriptor(nativeContentWindowDescriptor),
			nativeSrcdoc: describeDescriptor(nativeSrcdocDescriptor),
		},
		proxy,
		sandbox: sandboxReport,
		crossOrigin: crossReport,
		proxiedCrossOrigin: proxiedReport,
		nullCases: {
			detached: detached.contentWindow === null,
			detachedWithSrcdoc: detachedWithSrcdoc.contentWindow === null,
			removedBefore,
			removedAfter: removed.contentWindow === null,
			proxiedRemovedBefore,
			proxiedRemovedAfter: proxiedRemoved.contentWindow === null,
			hidden: hidden.contentWindow !== null,
			templateBefore,
			templateAfter,
		},
	};
	// Removal nulls contentWindow natively, so every reading above happens while connected.
	for (const frame of clean) frame.remove();
	return report;
})()`;

let server: Server<undefined> | undefined;
let otherServer: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	// Two ports on one host are two origins, so the cross-origin frame is a real one.
	const page = { headers: { "content-type": "text/html" } };
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("<!doctype html><title>iframe</title>", page),
	});
	otherServer = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("<!doctype html><title>other</title><p id=other>other</p>", page),
	});
	launched = await launchHeadlessBrowser({ headless: true });
}, 60_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
	server?.stop(true);
	otherServer?.stop(true);
});

/** Opens a fresh page with the chosen bootstrap preloaded, then probes it in the main world. */
async function probe(scripts: string): Promise<IframeReport> {
	if (!launched || !server || !otherServer) throw new Error("browser not ready");
	const page: Page = await launched.browser.newPage();
	try {
		await page.evaluateOnNewDocument(scripts);
		await page.goto(server.url.href);
		return (await page.evaluate(probeSource(otherServer.url.href))) as IframeReport;
	} finally {
		await page.close();
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("stealth iframe patch", () => {
	it("exposes a same-tick contentWindow with an about:blank document and still renders srcdoc", async () => {
		const patched = await probe(PATCH);
		const control = await probe(CONTROL);

		// A plain iframe needs no proxy: it already behaves like the unpatched browser.
		expect(patched.fresh).toEqual(control.fresh);
		expect(patched.fresh).toEqual({
			hasWindow: true,
			url: "about:blank",
			readyState: "complete",
			identity: true,
			self: true,
			window: true,
			frames: true,
			globalThis: true,
			frameElement: true,
			closed: false,
		});

		// Before it loads, a srcdoc frame already has a same-origin window with a plausible URL.
		expect(patched.srcdoc.sync.hasWindow).toBe(true);
		expect(patched.srcdoc.sync.url).toBe("about:blank");
		expect(patched.srcdoc.sync.readyState).toBe("complete");
		expect(patched.srcdoc.sync.srcdoc).toBe('<p id="mark">srcdoc-ok</p>');
		expect(patched.srcdoc.sync.attribute).toBe('<p id="mark">srcdoc-ok</p>');
		expect(patched.srcdoc.sync.identity).toBe(true);
		expect(patched.srcdoc.sync.self).toBe(true);
		expect(patched.srcdoc.sync.window).toBe(true);
		expect(patched.srcdoc.sync.frames).toBe(true);
		expect(patched.srcdoc.sync.globalThis).toBe(true);
		expect(patched.srcdoc.sync.frameElement).toBe(true);
		expect(patched.srcdoc.sync.closed).toBe(false);
		// Open tell: the `srcdoc` setter swaps a window read beforehand for the proxy, while a
		// native WindowProxy keeps its identity across the same assignment.
		expect(patched.srcdoc.sync.sameAsBefore).toBe(false);
		expect(control.srcdoc.sync.sameAsBefore).toBe(true);

		// Once loaded, the frame is at `about:srcdoc` with the assigned markup rendered.
		expect(patched.srcdoc.loaded.hasWindow).toBe(true);
		expect(patched.srcdoc.loaded.url).toBe("about:srcdoc");
		expect(patched.srcdoc.loaded.text).toBe("srcdoc-ok");
		expect(patched.srcdoc.loaded.markup).toBe("srcdoc-ok");
		expect(patched.srcdoc.loaded.srcdoc).toBe('<p id="mark">srcdoc-ok</p>');
		expect(patched.srcdoc.loaded.frameElement).toBe(true);
		expect(patched.srcdoc.loaded.identityWithSync).toBe(true);
		expect(patched.srcdoc.loaded).toEqual(control.srcdoc.loaded);
	}, 30_000);

	it("keeps the native descriptor attributes and masks the replaced accessors in the page realm", async () => {
		const patched = await probe(PATCH);
		const control = await probe(CONTROL);

		// Replacement keeps every flag and the get/set split of the native accessors.
		expect(patched.descriptors.contentWindow).toEqual(patched.descriptors.nativeContentWindow);
		expect(patched.descriptors.srcdoc).toEqual(patched.descriptors.nativeSrcdoc);
		expect(patched.descriptors.contentWindow).toEqual({
			hasValue: false,
			writable: undefined,
			enumerable: true,
			configurable: true,
			get: "function",
			set: "undefined",
		});
		expect(patched.descriptors.srcdoc).toEqual({
			hasValue: false,
			writable: undefined,
			enumerable: true,
			configurable: true,
			get: "function",
			set: "function",
		});

		// Metadata is the native shape: same name, arity, own keys, prototype and `instanceof`.
		const shape = ({ length, ownKeys, proto, instanceOf }: AccessorShape) => ({
			length,
			ownKeys,
			proto,
			instanceOf,
		});
		expect(patched.accessors.contentWindow.name).toBe("get contentWindow");
		expect(shape(patched.accessors.contentWindow)).toEqual(shape(patched.accessors.referenceGetter));
		expect(patched.accessors.srcdocGetter.name).toBe("get srcdoc");
		expect(shape(patched.accessors.srcdocGetter)).toEqual(shape(patched.accessors.referenceGetter));
		expect(patched.accessors.srcdocSetter.name).toBe("set srcdoc");
		expect(shape(patched.accessors.srcdocSetter)).toEqual(shape(patched.accessors.referenceSetter));

		// The mask is real: an untouched native still prints native through the pristine realm.
		expect(patched.accessors.referenceGetter).toEqual(control.accessors.referenceGetter);
		expect(patched.accessors.referenceGetter.pristine).toBe("function get textContent() { [native code] }");
		expect(patched.accessors.referenceSetter.page).toBe("function set textContent() { [native code] }");

		// The page's masked toString prints the replacements as native accessors.
		expect(patched.accessors.contentWindow.page).toBe("function get contentWindow() { [native code] }");
		expect(patched.accessors.srcdocGetter.page).toBe("function get srcdoc() { [native code] }");
		expect(patched.accessors.srcdocSetter.page).toBe("function set srcdoc() { [native code] }");

		// Open tell: a pristine realm's own toString bypasses the registry, so the JS replacements
		// read as source there. Proxy-wrapping them (as the hairline patch does) hides the body.
		expect(patched.accessors.contentWindow.pristine).toBe("function get contentWindow() { [native code] }");
		expect(patched.accessors.srcdocGetter.pristine).toBe("function get srcdoc() { [native code] }");
		expect(patched.accessors.srcdocSetter.pristine).toBe("function set srcdoc() { [native code] }");
		for (const accessor of [
			patched.accessors.contentWindow,
			patched.accessors.srcdocGetter,
			patched.accessors.srcdocSetter,
		]) {
			expect(accessor.pristine).toContain("[native code]");
		}

		// Without the patch the same probe sees the native accessors in both realms.
		expect(control.accessors.contentWindow.page).toBe("function get contentWindow() { [native code] }");
		expect(control.accessors.contentWindow.pristine).toBe("function get contentWindow() { [native code] }");
		expect(control.accessors.contentWindow.name).toBe("get contentWindow");
		expect(control.accessors.contentWindow.length).toBe(0);
		expect(control.accessors.srcdocGetter.pristine).toBe("function get srcdoc() { [native code] }");
		expect(control.accessors.srcdocSetter.pristine).toBe("function set srcdoc() { [native code] }");
		expect(control.descriptors.contentWindow).toEqual(control.descriptors.nativeContentWindow);
		expect(control.descriptors.srcdoc).toEqual(control.descriptors.nativeSrcdoc);
	}, 30_000);

	it("proxies a srcdoc frame's window and hides its child frames", async () => {
		const patched = await probe(PATCH);
		const control = await probe(CONTROL);

		// The proxy keeps the identity surface self-consistent.
		expect(patched.proxy.self).toBe(true);
		expect(patched.proxy.frameElement).toBe(true);

		// Open tell: the proxy reports no child frames and no frame-index keys, where the browser
		// reports both for the two nested iframes inside the srcdoc document.
		expect(patched.proxy.nestedLength).toBe(0);
		expect(patched.proxy.hasIndexKey).toBe(false);
		expect(control.proxy.nestedLength).toBe(2);
		expect(control.proxy.hasIndexKey).toBe(true);

		// Open tell: these window properties are data descriptors on the proxy, accessors natively.
		expect(patched.proxy.ownSelf).toBe("data");
		expect(patched.proxy.ownFrames).toBe("data");
		expect(patched.proxy.ownFrameElement).toBe("data");
		expect(patched.proxy.ownLength).toBe("data");
		expect(control.proxy.ownSelf).toBe("accessor");
		expect(control.proxy.ownFrames).toBe("accessor");
		expect(control.proxy.ownFrameElement).toBe("accessor");
		expect(control.proxy.ownLength).toBe("accessor");
	}, 30_000);

	it("matches the unpatched browser for sandboxed, cross-origin and platform-null frames", async () => {
		const patched = await probe(PATCH);
		const control = await probe(CONTROL);

		expect(patched.sandbox).toEqual(control.sandbox);
		expect(patched.crossOrigin).toEqual(control.crossOrigin);
		expect(patched.proxiedCrossOrigin).toEqual(control.proxiedCrossOrigin);
		expect(patched.nullCases).toEqual(control.nullCases);

		// A sandboxed frame still has a window, but its opaque origin blocks document reads.
		expect(patched.sandbox.hasWindow).toBe(true);
		expect(patched.sandbox.self).toBe(true);
		expect(patched.sandbox.documentUrl).toEqual({ ok: false, name: "SecurityError" });
		expect(patched.sandbox.frameElement).toEqual({ ok: false, name: "SecurityError" });

		// Cross-origin: the initial about:blank document is readable in the same tick, then the
		// frame's own properties cross the origin boundary exactly as natively.
		expect(patched.crossOrigin.hasWindow).toBe(true);
		expect(patched.crossOrigin.syncDocumentUrl).toEqual({ ok: true, value: "about:blank" });
		expect(patched.crossOrigin.identity).toBe(true);
		expect(patched.crossOrigin.documentUrl).toEqual({ ok: false, name: "SecurityError" });
		expect(patched.crossOrigin.locationHref).toEqual({ ok: false, name: "SecurityError" });
		expect(patched.crossOrigin.frameElement).toEqual({ ok: false, name: "SecurityError" });
		expect(patched.crossOrigin.length).toEqual({ ok: true, value: 0 });
		expect(patched.crossOrigin.self).toEqual({ ok: true, value: true });

		// The same holds for an iframe the patch proxied through `srcdoc` before navigating it.
		expect(patched.proxiedCrossOrigin.hasWindow).toBe(true);
		expect(patched.proxiedCrossOrigin.identity).toBe(true);
		expect(patched.proxiedCrossOrigin.documentUrl).toEqual({ ok: false, name: "SecurityError" });
		expect(patched.proxiedCrossOrigin.locationHref).toEqual({ ok: false, name: "SecurityError" });
		expect(patched.proxiedCrossOrigin.self).toEqual({ ok: true, value: true });
		expect(patched.proxiedCrossOrigin.length).toEqual({ ok: true, value: 0 });

		// `contentWindow` is null only where the platform says so.
		expect(patched.nullCases).toEqual({
			detached: true,
			detachedWithSrcdoc: true,
			removedBefore: true,
			removedAfter: true,
			proxiedRemovedBefore: true,
			proxiedRemovedAfter: true,
			hidden: true,
			templateBefore: true,
			templateAfter: true,
		});
	}, 30_000);
});
