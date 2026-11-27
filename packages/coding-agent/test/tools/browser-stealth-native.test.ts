import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	applyStealthPatches,
	applyViewport,
	closeLaunchedBrowser,
	type LaunchHeadlessResult,
	launchHeadlessBrowser,
	type StealthState,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import type { Server } from "bun";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

// What an anti-bot script compares between a page and its workers.
const REPORT = `const report = () => ({
	ua: navigator.userAgent,
	brands: navigator.userAgentData.brands.map(b => b.brand + " " + b.version).join(","),
	cores: navigator.hardwareConcurrency,
	languages: navigator.languages.join(","),
});`;

let server: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;
let page: Page | undefined;
const stealth: StealthState = { browserSession: null, override: null };

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const js = { headers: { "content-type": "text/javascript" } };
			switch (new URL(request.url).pathname) {
				case "/dedicated.js":
					return new Response(`${REPORT} postMessage(report());`, js);
				case "/shared.js":
					return new Response(`${REPORT} onconnect = e => e.ports[0].postMessage(report());`, js);
				case "/service.js":
					return new Response(`${REPORT} onmessage = e => e.source.postMessage(report());`, js);
				default:
					return new Response("<!doctype html><title>stealth</title>", {
						headers: { "content-type": "text/html" },
					});
			}
		},
	});
	launched = await launchHeadlessBrowser({ headless: true });
	page = await launched.browser.newPage();
	await applyStealthPatches(launched.browser, page, stealth);
	await applyViewport(page);
	await page.goto(server.url.href);
}, 60_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
	server?.stop(true);
});

/** Runs an async function body in the page's main world, where page scripts and any patch live. */
async function inMainWorld(body: string): Promise<unknown> {
	if (!page) throw new Error("page not ready");
	return await page.evaluate(`//!world=main
(async () => {
${body}
})()`);
}

describe.skipIf(!CHROMIUM_AVAILABLE)("managed headless Chromium fingerprint", () => {
	it("reports the page's user agent, brands, cores and languages from every kind of worker", async () => {
		const pageReport = await inMainWorld(`${REPORT} return report();`);
		expect(pageReport).toMatchObject({ ua: expect.not.stringContaining("HeadlessChrome") });
		const reports = await inMainWorld(`
			const dedicated = await new Promise(resolve => {
				new Worker("/dedicated.js").onmessage = e => resolve(e.data);
			});
			const shared = await new Promise(resolve => {
				new SharedWorker("/shared.js").port.onmessage = e => resolve(e.data);
			});
			const registration = await navigator.serviceWorker.register("/service.js");
			await navigator.serviceWorker.ready;
			const service = await new Promise(resolve => {
				navigator.serviceWorker.onmessage = e => resolve(e.data);
				registration.active.postMessage("report");
			});
			return { dedicated, shared, service };
		`);
		expect(reports).toEqual({ dedicated: pageReport, shared: pageReport, service: pageReport });
	}, 30_000);

	it("sits in a window taller than its viewport on a screen that holds the window", async () => {
		const geometry = await inMainWorld(`
			return {
				windowHoldsViewport: outerWidth >= innerWidth && outerHeight > innerHeight,
				screenHoldsWindow: screen.width >= outerWidth && screen.availHeight >= outerHeight,
			};
		`);
		expect(geometry).toEqual({ windowHoldsViewport: true, screenHoldsWindow: true });
	});

	it("patches no native unless the real WebGL renderer would give the browser away", async () => {
		// A pristine realm prints a Proxy-wrapped or replaced function without its native name.
		const sources = await inMainWorld(`
			const frame = document.body.appendChild(document.createElement("iframe"));
			const pristine = frame.contentWindow.Function.prototype.toString;
			const gl = document.createElement("canvas").getContext("webgl");
			const sources = {
				toString: pristine.call(Function.prototype.toString),
				screenWidth: pristine.call(Object.getOwnPropertyDescriptor(Screen.prototype, "width").get),
				getParameter: gl ? pristine.call(gl.getParameter) : "function getParameter() { [native code] }",
			};
			frame.remove();
			return sources;
		`);
		expect(sources).toMatchObject({ screenWidth: "function get width() { [native code] }" });
		if (stealth.webglMask === false) {
			expect(sources).toEqual({
				toString: "function toString() { [native code] }",
				screenWidth: "function get width() { [native code] }",
				getParameter: "function getParameter() { [native code] }",
			});
		}
	});
});
