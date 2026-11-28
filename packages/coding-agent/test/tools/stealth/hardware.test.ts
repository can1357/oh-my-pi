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

/**
 * The hardware patch, with the worker patch that is meant to carry the page's identity into
 * workers. Without another patch the bootstrap installs no `toString` mask at all, so the worker
 * patch is also what lets this test observe worker construction on its own terms.
 */
const PATCH = buildStealthInjectionScriptForTest([STEALTH_SCRIPTS.hardware, STEALTH_SCRIPTS.worker]);
/** The raw browser: its native core count is the value the patch has to replace. */
const CONTROL = buildStealthInjectionScriptForTest([]);
/** `hardwareConcurrencyValue` in `puppeteer/11_stealth_hardware.txt`. */
const PATCHED_CORES = 8;

interface DescriptorReport {
	hasValue: boolean;
	writable: boolean | undefined;
	enumerable: boolean | undefined;
	configurable: boolean | undefined;
	set: string;
}

interface GetterReport {
	name: string;
	length: number;
	ownKeys: string[];
	protoIsFunctionProto: boolean;
	instanceOf: boolean;
	/** `Function.prototype.toString` as the page's own (possibly masked) function prints it. */
	page: string;
	/** The same call through a fresh same-origin realm's pristine `toString`. */
	pristine: string;
}

interface WorkerReport {
	value: number;
	type: string;
	source: string;
}

interface HardwareReport {
	value: number;
	type: string;
	ownerName: string;
	ownerIsNavigatorProto: boolean;
	descriptor: DescriptorReport;
	getter: GetterReport;
	/** A known-native accessor in the same realm, as the pristine `toString` prints it. */
	pristineNative: string;
	/** Calling the accessor with a non-`Navigator` receiver. */
	illegalInvocation: string;
	deviceMemory: number | undefined;
	userAgentData: { mobile: boolean; platform: string } | null;
	/** A child frame's own realm, patched by the same bootstrap. */
	frameCores: number;
	dedicated: WorkerReport;
	shared: WorkerReport;
}

const WORKER_REPORT = `
const find = (target, prop) => {
	let owner = target;
	while (owner) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, prop);
		if (descriptor) return descriptor;
		owner = Object.getPrototypeOf(owner);
	}
	return undefined;
};
const report = () => {
	const descriptor = find(navigator, "hardwareConcurrency");
	return {
		value: navigator.hardwareConcurrency,
		type: typeof navigator.hardwareConcurrency,
		source: Function.prototype.toString.call(descriptor.get),
	};
};`;

/**
 * Reads the page's navigator in the main world, then drives both worker kinds the worker patch
 * wraps. The pristine `toString` comes from a fresh same-origin iframe, the way a detector's
 * second realm would; the bootstrap reaches child frames too, so that frame's value is compared as
 * well.
 */
const PROBE = `//!world=main
(async () => {
	const frame = document.createElement("iframe");
	frame.style.display = "none";
	document.body.appendChild(frame);
	const pristine = frame.contentWindow.Function.prototype.toString;
	const frameCores = frame.contentWindow.navigator.hardwareConcurrency;
	frame.remove();

	const find = (target, prop) => {
		let owner = target;
		while (owner) {
			const descriptor = Object.getOwnPropertyDescriptor(owner, prop);
			if (descriptor) return [owner, descriptor];
			owner = Object.getPrototypeOf(owner);
		}
		return [null, null];
	};
	const [owner, descriptor] = find(navigator, "hardwareConcurrency");
	const getter = descriptor.get;
	const probeNativeGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent").get;

	const report = {
		value: navigator.hardwareConcurrency,
		type: typeof navigator.hardwareConcurrency,
		ownerName: owner && owner.constructor && owner.constructor.name,
		ownerIsNavigatorProto: owner === Object.getPrototypeOf(navigator),
		descriptor: {
			hasValue: "value" in descriptor,
			writable: descriptor.writable,
			enumerable: descriptor.enumerable,
			configurable: descriptor.configurable,
			set: String(descriptor.set),
		},
		getter: {
			name: getter.name,
			length: getter.length,
			ownKeys: Object.getOwnPropertyNames(getter),
			protoIsFunctionProto: Object.getPrototypeOf(getter) === Function.prototype,
			instanceOf: getter instanceof Function,
			page: Function.prototype.toString.call(getter),
			pristine: pristine.call(getter),
		},
		pristineNative: pristine.call(probeNativeGetter),
		illegalInvocation: (() => {
			try {
				descriptor.get.call({});
				return "returned";
			} catch (error) {
				return error.constructor.name + ": " + error.message;
			}
		})(),
		deviceMemory: navigator.deviceMemory,
		userAgentData: navigator.userAgentData
			? { mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform }
			: null,
		frameCores,
	};

	const dedicated = await new Promise((resolve) => {
		const worker = new Worker("/dedicated.js");
		worker.onmessage = (event) => resolve(event.data);
	});
	const shared = await new Promise((resolve) => {
		const worker = new SharedWorker("/shared.js");
		worker.port.onmessage = (event) => resolve(event.data);
	});

	return { ...report, dedicated, shared };
})()`;

let server: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const javascript = { headers: { "content-type": "text/javascript" } };
			switch (new URL(request.url).pathname) {
				case "/dedicated.js":
					return new Response(`${WORKER_REPORT} postMessage(report());`, javascript);
				case "/shared.js":
					return new Response(
						`${WORKER_REPORT} onconnect = (event) => event.ports[0].postMessage(report());`,
						javascript,
					);
				default:
					return new Response("<!doctype html><title>hardware</title>", {
						headers: { "content-type": "text/html" },
					});
			}
		},
	});
	launched = await launchHeadlessBrowser({ headless: true });
}, 60_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
	server?.stop(true);
});

/** Opens a page with the chosen bootstrap preloaded, then probes it in the main world. */
async function probe(scripts: string): Promise<HardwareReport> {
	if (!launched || !server) throw new Error("browser not ready");
	const page: Page = await launched.browser.newPage();
	try {
		await page.evaluateOnNewDocument(scripts);
		await page.goto(server.url.href);
		return (await page.evaluate(PROBE)) as HardwareReport;
	} finally {
		await page.close();
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("stealth hardware patch", () => {
	it("reports the patched core count as a plausible integer, in the page and in a child frame", async () => {
		const patched = await probe(PATCH);
		const control = await probe(CONTROL);

		// The control is the real browser, so the patch has to change its report. The browser may
		// genuinely report eight cores, in which case the patch is a deliberate no-op.
		expect(Number.isInteger(control.value)).toBe(true);
		expect(control.value).toBeGreaterThan(0);
		expect(patched.value).toBe(PATCHED_CORES);
		expect(Number.isInteger(patched.value)).toBe(true);
		expect(patched.type).toBe("number");
		expect(patched.value).toBeGreaterThan(0);
		expect(patched.value).toBeLessThanOrEqual(32);

		// Plausibility against the other navigator hints: a desktop profile whose memory can plausibly
		// pair with eight cores, and a same-realm frame repeating the page's answer.
		if (patched.deviceMemory !== undefined) {
			expect(patched.deviceMemory).toBeGreaterThanOrEqual(2);
			expect(patched.value).toBeLessThanOrEqual(patched.deviceMemory * 4);
		}
		if (patched.userAgentData) {
			expect(patched.userAgentData.mobile).toBe(false);
			expect(patched.userAgentData.platform).toBe(control.userAgentData?.platform ?? patched.userAgentData.platform);
		}
		expect(patched.frameCores).toBe(patched.value);
		expect(control.frameCores).toBe(control.value);
	}, 30_000);

	it("keeps the native accessor shape and masks the replacement in the page realm", async () => {
		const patched = await probe(PATCH);
		const control = await probe(CONTROL);

		// The getter replaces the inherited accessor in place and copies every attribute.
		expect(patched.ownerIsNavigatorProto).toBe(true);
		expect(patched.ownerName).toBe("Navigator");
		expect(patched.descriptor).toEqual(control.descriptor);
		expect(patched.descriptor).toEqual({
			hasValue: false,
			writable: undefined,
			enumerable: true,
			configurable: true,
			set: "undefined",
		});

		// A plain accessor function matches the native getter's own metadata.
		expect(patched.getter.name).toBe(control.getter.name);
		expect(patched.getter.name).toBe("get hardwareConcurrency");
		expect(patched.getter.length).toBe(0);
		expect(patched.getter.ownKeys).toEqual(control.getter.ownKeys);
		expect(patched.getter.protoIsFunctionProto).toBe(true);
		expect(patched.getter.instanceOf).toBe(true);
		// Calling it on a foreign receiver still throws as the native accessor does.
		expect(patched.illegalInvocation).toBe(control.illegalInvocation);
		expect(patched.illegalInvocation).toBe("TypeError: Illegal invocation");

		// In the page's own realm the replacement is masked as the native accessor...
		expect(patched.getter.page).toBe("function get hardwareConcurrency() { [native code] }");
		// ...but a pristine realm's native `toString` bypasses the local source registry and prints the
		// replacement's JavaScript body: this is an open tell (see the audit).
		expect(control.getter.pristine).toBe("function get hardwareConcurrency() { [native code] }");
		expect(patched.pristineNative).toBe("function get userAgent() { [native code] }");
		expect(patched.getter.pristine).not.toBe(control.getter.pristine);
	}, 30_000);

	it("keeps a dedicated worker and a shared worker on the page's core count", async () => {
		const patched = await probe(PATCH);
		const control = await probe(CONTROL);

		// `buildWorkerPrelude` mirrors `hardwareConcurrency` into the blob prelude, so both wrapper
		// paths report exactly what the page reports, with a native-looking getter in the worker realm.
		for (const worker of [patched.dedicated, patched.shared]) {
			expect(worker.type).toBe("number");
			expect(worker.value).toBe(PATCHED_CORES);
			expect(Number.isInteger(worker.value)).toBe(true);
			expect(worker.source).toBe("function get hardwareConcurrency() { [native code] }");
		}
		expect(patched.dedicated.value).toBe(patched.value);
		expect(patched.shared.value).toBe(patched.value);
		expect(patched.dedicated.value).toBe(patched.shared.value);
		// The control is the real browser: its workers agree with its page at the native count, which
		// is what proves the worker side is untouched when no numeric patch is needed.
		expect(control.dedicated.value).toBe(control.value);
		expect(control.shared.value).toBe(control.value);
	}, 30_000);

	it("leaves the native core count alone unless the launcher gate sees fewer than four", async () => {
		if (!launched || !server) throw new Error("browser not ready");
		const native = (await probe(CONTROL)).value;
		const state: StealthState = { browserSession: null, override: null };
		const page: Page = await launched.browser.newPage();
		try {
			await applyStealthPatches(launched.browser, page, state);
			await page.goto(server.url.href);
			const report = (await page.evaluate(`//!world=main
				(() => {
					const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "hardwareConcurrency");
					return {
						value: navigator.hardwareConcurrency,
						page: Function.prototype.toString.call(descriptor.get),
					};
				})()`)) as { value: number; page: string };

			const gated = native > 0 && native < 4;
			// `stealthScriptsFor` selects the hardware patch (and its worker counterpart) only for a
			// low reported core count; a normal machine keeps its natives untouched.
			expect(state.stealthScripts?.includes(STEALTH_SCRIPTS.hardware)).toBe(gated);
			expect(report.value).toBe(gated ? PATCHED_CORES : native);
			if (!gated) {
				expect(report.page).toBe("function get hardwareConcurrency() { [native code] }");
			}
		} finally {
			await page.close();
		}
	}, 30_000);
});
