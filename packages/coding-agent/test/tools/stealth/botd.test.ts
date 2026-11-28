import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	buildStealthInjectionScriptForTest,
	closeLaunchedBrowser,
	type LaunchHeadlessResult,
	launchHeadlessBrowser,
	STEALTH_SCRIPTS,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "../chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const BOTD = [STEALTH_SCRIPTS.botd] as const;
const NONE = [] as const;
/** A page with no `chrome` at all, so the patch has to fabricate the object it stands on. */
const STRIP_CHROME = `Object.defineProperty(window, "chrome", {
	value: {},
	writable: true,
	enumerable: true,
	configurable: false,
});`;
const PAGE = "<!doctype html><title>botd</title>";
const SECURE = "https://stealth.test";
const INSECURE = "http://insecure.test";
/** A synthetic port id: 32 chars of a-p, the shape chrome extensions use. */
const EXTENSION_ID = "a".repeat(32);

interface FrameReport {
	plain: string;
	getDetails: string;
	isInstalled: string;
	getIsInstalled: string;
	runningState: string;
	csi: string;
	loadTimes: string;
	sendMessage: string;
	connect: string;
	permission: string;
	permissionShape: string;
	permissionState: string;
	webdriver: string;
	webdriverValue: boolean;
	webdriverPresent: boolean;
}

type Shape = { get: string; hasSet: boolean; enumerable: boolean; configurable: boolean; hasWritable: boolean };

let launched: LaunchHeadlessResult | undefined;
let secure: Page | undefined;
let secureControl: Page | undefined;
let insecure: Page | undefined;
let insecureControl: Page | undefined;
let forced: Page | undefined;
let forcedControl: Page | undefined;
let secureOwnKeys: { window: string[]; navigator: string[]; permissions: string[] };
let insecureOwnKeys: { window: string[]; navigator: string[]; permissions: string[] };

function serve(page: Page, origin: string): void {
	page.on("request", request => {
		const url = new URL(request.url());
		if (url.origin !== origin) {
			void request.abort();
			return;
		}
		void request.respond({ status: 200, contentType: "text/html", body: PAGE });
	});
}

async function open(origin: string, scripts: readonly string[], preludes: readonly string[] = []): Promise<Page> {
	if (!launched) throw new Error("browser not ready");
	const page = await launched.browser.newPage();
	await page.setRequestInterception(true);
	serve(page, origin);
	for (const prelude of preludes) await page.evaluateOnNewDocument(prelude);
	await page.evaluateOnNewDocument(buildStealthInjectionScriptForTest(scripts));
	await page.goto(`${origin}/page`);
	return page;
}

/** Runs an async body in the page's main world, where the bootstrap and the page scripts live. */
async function mainWorld(page: Page, body: string): Promise<unknown> {
	return await page.evaluate(`//!world=main
(async () => {
${body}
})()`);
}

/**
 * What a realm reports about the names it replaced. The frame bootstraps the same patches into its
 * own realm, so its registry answers for the functions it owns: a patched native prints as native
 * there, while an unpatched function still leaks its source (the `plain` control).
 */
const FRAME_PROBE = `(() => {
	const toString = Function.prototype.toString;
	const descriptor = Reflect.getOwnPropertyDescriptor;
	const shape = (target, key) => {
		const found = descriptor(target, key);
		return {
			get: typeof found.get,
			hasSet: found.set !== undefined,
			enumerable: found.enumerable,
			configurable: found.configurable,
			hasWritable: "writable" in found,
		};
	};
	const runtime = window.chrome && window.chrome.runtime;
	return {
		plain: toString.call(function plain() {}),
		getDetails: toString.call(window.chrome.app.getDetails),
		isInstalled: (() => {
			const found = descriptor(window.chrome.app, "isInstalled");
			return found.get ? toString.call(found.get) : "";
		})(),
		getIsInstalled: toString.call(window.chrome.app.getIsInstalled),
		runningState: toString.call(window.chrome.app.runningState),
		csi: toString.call(window.chrome.csi),
		loadTimes: toString.call(window.chrome.loadTimes),
		sendMessage: runtime ? toString.call(runtime.sendMessage) : "",
		connect: runtime ? toString.call(runtime.connect) : "",
		permission: (() => {
			const found = descriptor(Notification, "permission");
			return found.get ? toString.call(found.get) : "";
		})(),
		permissionShape: JSON.stringify(shape(Notification, "permission")),
		permissionState: Notification.permission,
		webdriver: toString.call(descriptor(Navigator.prototype, "webdriver").get),
		webdriverValue: navigator.webdriver,
		webdriverPresent: "webdriver" in navigator,
	};
})()`;

/** Compares patched functions against their pristine-realm rendering. */
async function frameSources(page: Page, path: string): Promise<FrameReport> {
	const result = await mainWorld(
		page,
		`	const frame = document.body.appendChild(document.createElement("iframe"));
	frame.src = ${JSON.stringify(path)};
	await new Promise(resolve => {
		frame.onload = resolve;
	});
	const report = frame.contentWindow.eval(${JSON.stringify(FRAME_PROBE)});
	frame.remove();
	return report;`,
	);
	return result as FrameReport;
}

function shapeOf(page: Page, target: string, key: string): Promise<Shape> {
	return mainWorld(
		page,
		`	const found = Object.getOwnPropertyDescriptor(${target}, ${JSON.stringify(key)});
	return {
		get: typeof found.get,
		hasSet: found.set !== undefined,
		enumerable: found.enumerable,
		configurable: found.configurable,
		hasWritable: "writable" in found,
	};`,
	) as Promise<Shape>;
}

async function ownKeys(page: Page): Promise<{ window: string[]; navigator: string[]; permissions: string[] }> {
	return (await mainWorld(
		page,
		`	const sorted = value => Object.getOwnPropertyNames(value).sort();
	return { window: sorted(window), navigator: sorted(navigator), permissions: sorted(navigator.permissions) };`,
	)) as { window: string[]; navigator: string[]; permissions: string[] };
}

const NATIVE = (name: string) => `function ${name}() { [native code] }`;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	launched = await launchHeadlessBrowser({ headless: true });
	secure = await open(SECURE, BOTD);
	secureControl = await open(SECURE, NONE);
	insecure = await open(INSECURE, BOTD);
	insecureControl = await open(INSECURE, NONE);
	forced = await open(SECURE, BOTD, [STRIP_CHROME]);
	forcedControl = await open(SECURE, NONE, [STRIP_CHROME]);
	secureOwnKeys = await ownKeys(secure);
	insecureOwnKeys = await ownKeys(insecure);
}, 120_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("botd patch", () => {
	it("leaves navigator.webdriver false, present, and shaped like the native accessor", async () => {
		if (!secure) throw new Error("page not ready");
		// The launch drops `--enable-automation`, so webdriver already reads false and the patch's
		// normalisation block never fires. A browser that starts out true would be left with no
		// `webdriver` at all: the patch deletes the prototype getter instead of redefining it.
		const report = (await mainWorld(
			secure,
			`	return {
		value: navigator.webdriver,
		present: "webdriver" in navigator,
		own: Object.hasOwn(navigator, "webdriver"),
	};`,
		)) as { value: unknown; present: boolean; own: boolean };
		expect(report).toEqual({ value: false, present: true, own: false });
		const sources = await frameSources(secure, "/frame");
		expect(sources.webdriverValue).toBe(false);
		expect(sources.webdriverPresent).toBe(true);
		expect(sources.webdriver).toBe(NATIVE("get webdriver"));
		expect(await shapeOf(secure, "Navigator.prototype", "webdriver")).toEqual({
			get: "function",
			hasSet: false,
			enumerable: true,
			configurable: true,
			hasWritable: false,
		});
	});

	it("fills window.chrome with the native app, csi and loadTimes surface", async () => {
		if (!secure) throw new Error("page not ready");
		const report = (await mainWorld(
			secure,
			`	const app = window.chrome.app;
	const timing = window.chrome.loadTimes();
	const load = window.chrome.csi();
	return {
		appKeys: Object.getOwnPropertyNames(app).sort(),
		details: app.getDetails(),
		installed: app.getIsInstalled(),
		running: app.runningState(),
		isInstalled: app.isInstalled,
		detailError: (() => {
			try {
				app.getDetails(1);
			} catch (error) {
				return String(error);
			}
		})(),
		installState: app.InstallState,
		runningState: app.RunningState,
		loadKeys: Object.keys(timing).sort(),
		loadConnection: timing.connectionInfo,
		loadNavigation: timing.navigationType,
		loadSpdy: timing.wasFetchedViaSpdy,
		csiKeys: Object.keys(load).sort(),
		csiTran: load.tran,
		csiStart: load.startE,
		csiOnload: load.onloadT,
		csiPage: load.pageT,
	};`,
		)) as Record<string, unknown>;
		expect(report).toMatchObject({
			// On a secure origin Chrome ships `app` itself; `installState` is the native extra.
			appKeys: [
				"InstallState",
				"RunningState",
				"getDetails",
				"getIsInstalled",
				"installState",
				"isInstalled",
				"runningState",
			],
			details: null,
			installed: false,
			isInstalled: false,
			running: "cannot_run",
			detailError: expect.stringMatching(
				/^TypeError: Error in invocation of app\.getDetails\(\)/,
			) as unknown as string,
			installState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
			runningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
			loadKeys: [
				"commitLoadTime",
				"connectionInfo",
				"finishDocumentLoadTime",
				"finishLoadTime",
				"firstPaintAfterLoadTime",
				"firstPaintTime",
				"navigationType",
				"npnNegotiatedProtocol",
				"requestTime",
				"startLoadTime",
				"wasAlternateProtocolAvailable",
				"wasFetchedViaSpdy",
				"wasNpnNegotiated",
			],
			csiKeys: ["onloadT", "pageT", "startE", "tran"],
			csiTran: 15,
		});
		expect(typeof report.loadConnection).toBe("string");
		expect(typeof report.loadNavigation).toBe("string");
		expect(typeof report.loadSpdy).toBe("boolean");
		expect(report.csiPage as number).toBeGreaterThanOrEqual(0);
		expect(report.csiOnload as number).toBeGreaterThanOrEqual(report.csiStart as number);
		// Native Chrome reports `isInstalled` as a data property, not an accessor.
		expect(await shapeOf(secure, "window.chrome.app", "isInstalled")).toEqual({
			get: "undefined",
			hasSet: false,
			enumerable: true,
			configurable: true,
			hasWritable: true,
		});
	});

	it("adds a chrome.runtime surface that validates its arguments like Chrome", async () => {
		if (!secure) throw new Error("page not ready");
		const report = (await mainWorld(
			secure,
			`	const runtime = window.chrome.runtime;
	const attempt = call => {
		try {
			return { value: String(call()) };
		} catch (error) {
			return { error: String(error), name: error.constructor.name };
		}
	};
	const port = runtime.connect(${JSON.stringify(EXTENSION_ID)});
	return {
		portKeys: Object.getOwnPropertyNames(port).sort(),
		brokenPost: (() => {
			try {
				port.postMessage();
			} catch (error) {
				return String(error);
			}
		})(),
		keys: Object.getOwnPropertyNames(runtime).sort(),
		id: runtime.id,
		platformOs: runtime.PlatformOs,
		platformArch: runtime.PlatformArch,
		installReason: runtime.OnInstalledReason,
		restartReason: runtime.OnRestartRequiredReason,
		update: runtime.RequestUpdateCheckStatus,
		sendNoArgs: attempt(() => runtime.sendMessage()),
		sendOneArg: attempt(() => runtime.sendMessage(${JSON.stringify(EXTENSION_ID)})),
		sendOk: attempt(() => runtime.sendMessage(${JSON.stringify(EXTENSION_ID)}, { hello: 1 })),
		sendBadId: attempt(() => runtime.sendMessage("zz", {})),
		sendTooMany: attempt(() => runtime.sendMessage(${JSON.stringify(EXTENSION_ID)}, 1, {}, () => {}, 5)),
		connectNone: attempt(() => runtime.connect()),
		connectInfoOnly: attempt(() => runtime.connect({ name: "n" })),
		connectBadId: attempt(() => runtime.connect("zz")),
	};`,
		)) as Record<string, unknown>;
		expect(report.keys).toEqual([
			"OnInstalledReason",
			"OnRestartRequiredReason",
			"PlatformArch",
			"PlatformNaclArch",
			"PlatformOs",
			"RequestUpdateCheckStatus",
			"connect",
			"id",
			"sendMessage",
		]);
		expect(report.id).toBeUndefined();
		expect(report.platformOs).toEqual({
			ANDROID: "android",
			CROS: "cros",
			LINUX: "linux",
			MAC: "mac",
			OPENBSD: "openbsd",
			WIN: "win",
		});
		expect(report.installReason).toEqual({
			CHROME_UPDATE: "chrome_update",
			INSTALL: "install",
			SHARED_MODULE_UPDATE: "shared_module_update",
			UPDATE: "update",
		});
		expect(report.restartReason).toEqual({
			APP_UPDATE: "app_update",
			OS_UPDATE: "os_update",
			PERIODIC: "periodic",
		});
		expect(report.update).toEqual({
			NO_UPDATE: "no_update",
			THROTTLED: "throttled",
			UPDATE_AVAILABLE: "update_available",
		});
		const preamble = "Error in invocation of runtime.sendMessage(optional string extensionId";
		expect(report.sendNoArgs).toEqual({
			error: `TypeError: ${preamble}, any message, optional object options, optional function responseCallback): No matching signature.`,
			name: "TypeError",
		});
		expect(report.sendOneArg).toMatchObject({ name: "TypeError" });
		expect(report.sendOk).toEqual({ value: "undefined" });
		expect(report.sendBadId).toEqual({
			error: `TypeError: ${preamble}, any message, optional object options, optional function responseCallback): Invalid extension id: 'zz'`,
			name: "TypeError",
		});
		expect(report.sendTooMany).toMatchObject({ name: "TypeError" });
		expect(report.connectNone).toMatchObject({ name: "TypeError" });
		expect(report.connectInfoOnly).toMatchObject({ name: "TypeError" });
		expect(report.connectBadId).toMatchObject({ name: "TypeError" });
		expect(report.portKeys).toEqual(["disconnect", "name", "onDisconnect", "onMessage", "postMessage", "sender"]);
		expect(report.brokenPost).toBe("TypeError: Insufficient number of arguments.");
	});

	it("prints every fabricated function as native code in another realm", async () => {
		if (!forced || !secure) throw new Error("page not ready");
		// The forced page has no native chrome, so every surface here was written by the patch.
		const sources = await frameSources(forced, "/frame");
		expect(sources.plain).toBe("function plain() {}");
		expect(sources.getDetails).toBe(NATIVE("getDetails"));
		expect(sources.getIsInstalled).toBe(NATIVE("getIsInstalled"));
		expect(sources.runningState).toBe(NATIVE("runningState"));
		expect(sources.csi).toBe(NATIVE("csi"));
		expect(sources.loadTimes).toBe(NATIVE("loadTimes"));
		expect(sources.sendMessage).toBe(NATIVE("sendMessage"));
		expect(sources.connect).toBe(NATIVE("connect"));
		// `isInstalled` is a plain data property, as in Chrome itself, so the probe finds no accessor
		// to stringify and nothing leaks; the descriptor shape is asserted separately below.
		expect(sources.isInstalled).toBe("");
		// The same surfaces on the untouched managed page read native there too.
		const native = await frameSources(secure, "/frame");
		expect(native.permission).toBe(NATIVE("get permission"));
	});

	it("reports Notification.permission and the notification permission state consistently", async () => {
		if (!secure) throw new Error("page not ready");
		const report = (await mainWorld(
			secure,
			`	const status = await navigator.permissions.query({ name: "notifications" });
	return {
		permission: Notification.permission,
		state: status.state,
		statusPrototype: Object.getPrototypeOf(status) === PermissionStatus.prototype,
		onchange: "onchange" in status,
	};`,
		)) as Record<string, unknown>;
		expect(report).toEqual({
			permission: "default",
			state: "prompt",
			statusPrototype: true,
			onchange: true,
		});
		// `default` is the listener-facing word for the `prompt` state; Chrome maps them the same way.
		const pristine = await frameSources(secure, "/frame");
		expect(pristine.permissionShape).toBe(JSON.stringify(await shapeOf(secure, "Notification", "permission")));
		expect(pristine.permissionState).toBe("default");
	});

	it("keeps window, navigator and its permissions object free of new own keys", async () => {
		if (!secure || !secureControl) throw new Error("page not ready");
		const control = await ownKeys(secureControl);
		expect(secureOwnKeys).toEqual(control);
		expect(secureOwnKeys.permissions).toEqual([]);
		// The managed page really does carry the patched surface, so the equality above is not vacuous.
		expect(await mainWorld(secure, "return typeof window.chrome.runtime")).toBe("object");
	});

	it("holds the same own-key shape on an insecure origin, where only the query is replaced", async () => {
		if (!insecure || !insecureControl) throw new Error("page not ready");
		const control = await ownKeys(insecureControl);
		expect(insecureOwnKeys.window).toEqual(control.window);
		expect(insecureOwnKeys.navigator).toEqual(control.navigator);
		// The insecure branch replaces `query` on the prototype, so the instance gains no own key.
		expect(insecureOwnKeys.permissions.filter(key => !control.permissions.includes(key))).toEqual([]);
	});

	it("answers notification queries with denied on an insecure origin", async () => {
		if (!insecure) throw new Error("page not ready");
		const report = (await mainWorld(
			insecure,
			`	const status = await navigator.permissions.query({ name: "notifications" });
	const geo = await navigator.permissions.query({ name: "geolocation" });
	const webd = navigator.webdriver;
	return {
		state: status.state,
		onchange: "onchange" in status,
		statusPrototype: Object.getPrototypeOf(status) === PermissionStatus.prototype,
		geolocation: geo.state,
		// Chrome already denies notifications on a non-trustworthy origin; the patch agrees.
		permission: Notification.permission,
		webdriver: webd,
		runtime: typeof window.chrome.runtime,
	};`,
		)) as Record<string, unknown>;
		expect(report).toEqual({
			state: "denied",
			onchange: true,
			statusPrototype: true,
			geolocation: "denied",
			permission: "denied",
			webdriver: false,
			runtime: "undefined",
		});
	});

	it("fabricates absent chrome APIs with Chrome's own shape", async () => {
		if (!forced) throw new Error("page not ready");
		const report = (await mainWorld(
			forced,
			`	const app = window.chrome.app;
	return {
		chromeKeys: Object.getOwnPropertyNames(window.chrome).sort(),
		chromeConfigurable: Object.getOwnPropertyDescriptor(window, "chrome").configurable,
		appKeys: Object.getOwnPropertyNames(app).sort(),
		details: app.getDetails(),
		installed: app.isInstalled,
		running: app.runningState(),
		loadKeys: Object.keys(window.chrome.loadTimes()).length,
		csiKeys: Object.keys(window.chrome.csi()).sort(),
		runtimeKeys: Object.getOwnPropertyNames(window.chrome.runtime).sort(),
	};`,
		)) as Record<string, unknown>;
		expect(report.chromeKeys).toEqual(["app", "csi", "loadTimes", "runtime"]);
		expect(report.chromeConfigurable).toBe(false);
		expect(report.appKeys).toEqual([
			"InstallState",
			"RunningState",
			"getDetails",
			"getIsInstalled",
			"isInstalled",
			"runningState",
		]);
		expect(report).toMatchObject({
			details: null,
			installed: false,
			running: "cannot_run",
			loadKeys: 13,
			csiKeys: ["onloadT", "pageT", "startE", "tran"],
			runtimeKeys: [
				"OnInstalledReason",
				"OnRestartRequiredReason",
				"PlatformArch",
				"PlatformNaclArch",
				"PlatformOs",
				"RequestUpdateCheckStatus",
				"connect",
				"id",
				"sendMessage",
			],
		});
	});

	it("leaves a page without the patch on its native chrome and permission state", async () => {
		if (!secureControl || !forcedControl || !insecureControl) throw new Error("page not ready");
		const report = (await mainWorld(
			secureControl,
			`	return {
		runtime: "runtime" in window.chrome,
		appKeys: Object.getOwnPropertyNames(window.chrome.app).sort(),
		permission: Notification.permission,
		state: (await navigator.permissions.query({ name: "notifications" })).state,
		webdriver: navigator.webdriver,
	};`,
		)) as Record<string, unknown>;
		expect(report).toEqual({
			runtime: false,
			appKeys: [
				"InstallState",
				"RunningState",
				"getDetails",
				"getIsInstalled",
				"installState",
				"isInstalled",
				"runningState",
			],
			permission: "default",
			state: "prompt",
			webdriver: false,
		});
		expect((await mainWorld(forcedControl, "return Object.getOwnPropertyNames(window.chrome)")) as string[]).toEqual(
			[],
		);
		expect(
			(await mainWorld(insecureControl, "return Object.getOwnPropertyNames(navigator.permissions)")) as string[],
		).toEqual([]);
	});
});
