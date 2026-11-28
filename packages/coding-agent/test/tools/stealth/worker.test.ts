import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { launchHeadlessBrowser, type LaunchHeadlessResult } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { buildStealthInjectionScriptForTest, STEALTH_SCRIPTS } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import type { Server } from "bun";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "../chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

// The worker prelude copies these from the page, so a nested worker must agree with both.
const PAGE = (nested: string) => `<!doctype html><title>worker nesting</title>
<script>
globalThis.nestedUrl = ${JSON.stringify(nested)};
</script>`;

const NESTED_WORKER = `
const report = () => ({
	cores: navigator.hardwareConcurrency,
	languages: navigator.languages.join(","),
	ua: navigator.userAgent,
	getterSource: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "hardwareConcurrency").get),
	toStringSource: Function.prototype.toString.call(Function.prototype.toString),
});
onmessage = () => postMessage(report());
`;
// A middle worker that spawns the nested one when asked.
const MIDDLE_WORKER = `
let nested;
onmessage = event => {
	if (event.data === "spawn") {
		nested = new Worker(self.NESTED_URL);
		nested.onmessage = message => postMessage(message.data);
		nested.postMessage("report");
	} else if (event.data === "ping") {
		postMessage({ cores: navigator.hardwareConcurrency, languages: navigator.languages.join(",") });
	}
};
`;

let server: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;
let page: Page | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const { pathname } = new URL(request.url);
			const base = `http://127.0.0.1:${server?.port}`;
			const js = { headers: { "content-type": "text/javascript" } };
			if (pathname === "/middle.js") {
				return new Response(`self.NESTED_URL = ${JSON.stringify(`${base}/nested.js`)};\n${MIDDLE_WORKER}`, js);
			}
			if (pathname === "/nested.js") return new Response(NESTED_WORKER, js);
			return new Response(PAGE(`${base}/middle.js`), { headers: { "content-type": "text/html" } });
		},
	});
	launched = await launchHeadlessBrowser({ headless: true });
	page = await launched.browser.newPage();
	await page.evaluateOnNewDocument(
		buildStealthInjectionScriptForTest([STEALTH_SCRIPTS.hardware, STEALTH_SCRIPTS.locale, STEALTH_SCRIPTS.worker]),
	);
	await page.goto(server.url.href);
}, 60_000);

afterAll(async () => {
	if (launched) await launched.browser.close();
	server?.stop(true);
});

async function inMainWorld(body: string): Promise<unknown> {
	if (!page) throw new Error("page not ready");
	return await page.evaluate(`//!world=main
(async () => {
${body}
})()`);
}

describe.skipIf(!CHROMIUM_AVAILABLE)("worker realms", () => {
	it("gives a nested worker the page's values so it never reports the host's", async () => {
		const result = await inMainWorld(`
			const { promise, resolve, reject } = Promise.withResolvers();
			const middle = new Worker(globalThis.nestedUrl);
			middle.onmessage = event => resolve(event.data);
			middle.onerror = event => reject(new Error(event.message));
			middle.postMessage("spawn");
			return await promise;
		`);
		expect(result).toMatchObject({ cores: 8, languages: "en-US,en" });
		expect(String((result as { ua: string }).ua)).not.toContain("HeadlessChrome");
	});

	it("masks the nested worker's own toString and patched getter", async () => {
		const result = await inMainWorld(`
			const { promise, resolve, reject } = Promise.withResolvers();
			const middle = new Worker(globalThis.nestedUrl);
			middle.onmessage = event => resolve(event.data);
			middle.onerror = event => reject(new Error(event.message));
			middle.postMessage("spawn");
			return await promise;
		`);
		const { getterSource, toStringSource } = result as { getterSource: string; toStringSource: string };
		expect(getterSource).toBe("function get hardwareConcurrency() { [native code] }");
		expect(toStringSource).toBe("function toString() { [native code] }");
	});

	it("keeps a one-level worker patched without touching its script URL semantics", async () => {
		const result = await inMainWorld(`
			const { promise, resolve, reject } = Promise.withResolvers();
			const middle = new Worker(globalThis.nestedUrl);
			middle.onmessage = event => resolve(event.data);
			middle.onerror = event => reject(new Error(event.message));
			middle.postMessage("ping");
			return await promise;
		`);
		expect(result).toEqual({ cores: 8, languages: "en-US,en" });
	});
});
