import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	applyStealthPatches,
	closeLaunchedBrowser,
	type LaunchHeadlessResult,
	launchHeadlessBrowser,
	STEALTH_SCRIPTS,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import type { Server } from "bun";
import type { Frame, Page } from "puppeteer-core";
import { chromiumAvailable } from "../chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const FRAME = `<!doctype html><title>frame</title><body>frame</body>`;

/** What a detector reads from a frame's own realm. */
const PROBE = `//!world=main
	(() => ({
		cores: navigator.hardwareConcurrency,
		languages: navigator.languages.join(","),
		getterSource: Function.prototype.toString.call(
			Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "hardwareConcurrency").get,
		),
		toStringSource: Function.prototype.toString.call(Function.prototype.toString),
	}))()`;

let host: Server<undefined> | undefined;
let other: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;
let page: Page | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	other = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(FRAME, { headers: { "content-type": "text/html" } }),
	});
	host = Bun.serve({
		port: 0,
		hostname: "localhost",
		fetch: () =>
			new Response("<!doctype html><title>host</title><body>host</body>", {
				headers: { "content-type": "text/html" },
			}),
	});
	launched = await launchHeadlessBrowser({ headless: true });
	page = await launched.browser.newPage();
	await applyStealthPatches(launched.browser, page, {
		browserSession: null,
		override: null,
		stealthScripts: [STEALTH_SCRIPTS.hardware, STEALTH_SCRIPTS.locale, STEALTH_SCRIPTS.worker],
	});
	await page.goto(host.url.href);
}, 60_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
	host?.stop(true);
	other?.stop(true);
});

/** Appends an iframe and resolves the frame once it committed its own document. */
async function frame(url: string): Promise<Frame> {
	if (!page) throw new Error("page not ready");
	const pending = page.waitForFrame(candidate => candidate.url() === url);
	await page.evaluate(
		`(() => {
			const element = document.createElement("iframe");
			element.width = "300";
			element.height = "150";
			element.src = ${JSON.stringify(url)};
			document.body.append(element);
		})()`,
	);
	return await pending;
}

describe.skipIf(!CHROMIUM_AVAILABLE)("frame realms", () => {
	it("gives a cross-origin frame the page's values and mask", async () => {
		const cross = await frame(`http://127.0.0.1:${other?.port}/`);
		expect(await cross.evaluate(PROBE)).toEqual({
			cores: 8,
			languages: "en-US,en",
			getterSource: "function get hardwareConcurrency() { [native code] }",
			toStringSource: "function toString() { [native code] }",
		});
	}, 30_000);

	it("keeps a same-origin frame in step with the page", async () => {
		const same = await frame(`http://localhost:${host?.port}/same`);
		expect(await same.evaluate(PROBE)).toMatchObject({ cores: 8, languages: "en-US,en" });
	}, 30_000);
});
