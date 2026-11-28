import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	CMUX_CONSOLE_CAPTURE_SCRIPT,
	isLocalDocumentUrl,
} from "@oh-my-pi/pi-coding-agent/tools/browser/console-capture";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-console-"));
const session: ToolSession = {
	cwd: root,
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({
		// Managed Chromium, whether or not omp's WebKit engine is installed on this machine.
		"browser.webkit": false,
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"browser.tern": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-console-test" };

interface CaptureEntry {
	seq: number;
	type: string;
	level: string;
	text: string;
	location?: string;
	args?: unknown[];
}

interface CaptureResult {
	entries: CaptureEntry[];
	nextSeq: number;
	dropped: number;
	captureStartedAt?: number;
}

/**
 * Counts how often logging an Error made the browser format its stack (`Error.prepareStackTrace`) or read a `stack`
 * getter: both happen only while a CDP client has the Runtime domain enabled, which is how anti-bot scripts spot it.
 */
const RUNTIME_PROBE = `(() => {
	let hits = 0;
	let probe;
	const original = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
	Error.prepareStackTrace = (error, frames) => {
		if (error === probe) hits++;
		return String(error);
	};
	try {
		probe = new Error("probe");
		console.debug(probe);
	} finally {
		if (original) Object.defineProperty(Error, "prepareStackTrace", original);
		else delete Error.prepareStackTrace;
	}
	const withGetter = new Error("getter");
	Object.defineProperty(withGetter, "stack", { configurable: false, enumerable: false, get() { hits++; return ""; } });
	console.debug(withGetter);
	return hits;
})()`;

/** A page whose first script records the probe in its title, before any omp call can touch it. */
function probePage(label: string): string {
	return `<!doctype html><title>pending</title><script>
		console.log(${JSON.stringify(`${label} loaded`)});
		document.title = "probe:" + ${RUNTIME_PROBE};
	</script><a id="public" href="${PUBLIC_URL}">public</a>`;
}

const PUBLIC_URL = "http://public-site.test/";

const localServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/to-public") return Response.redirect(`${PUBLIC_URL}redirected`, 302);
		return new Response(probePage(`local ${url.pathname}`), { headers: { "content-type": "text/html" } });
	},
});
const LOCAL_URL = `http://127.0.0.1:${localServer.port}`;

async function invoke(parameters: unknown) {
	return await prelude.invoke(parameters, context);
}

function valueFrom<T>(result: { details?: unknown }): T {
	const details = result.details;
	if (!details || typeof details !== "object" || !("value" in details)) {
		return undefined as T;
	}
	return details.value as T;
}

async function call(method: string, args: unknown[] = []): Promise<unknown> {
	const result = await invoke({ action: "call", name: "console", chain: [{ method, args }] });
	return valueFrom(result);
}

async function routePublicSite(): Promise<void> {
	await call("route", [`${PUBLIC_URL}to-local`, { status: 302, headers: { location: `${LOCAL_URL}/from-public` } }]);
	await call("route", [`${PUBLIC_URL}**`, { status: 200, contentType: "text/html", body: probePage("public") }]);
}

/** Uncaught exceptions arrive from the browser after the evaluate that scheduled them, so reads poll briefly. */
async function pollEntries(method: "console" | "errors", text: string): Promise<CaptureResult> {
	let result = (await call(method)) as CaptureResult;
	for (let attempt = 0; attempt < 50 && !result.entries.some(entry => entry.text.includes(text)); attempt++) {
		await Bun.sleep(20);
		result = (await call(method)) as CaptureResult;
	}
	return result;
}

afterAll(async () => {
	localServer.stop(true);
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	await fs.rm(root, { recursive: true, force: true });
});

describe("isLocalDocumentUrl", () => {
	it("treats local schemes, local hosts and private addresses as local, everything else as public", () => {
		const local = [
			"file:///tmp/page.html",
			"data:text/html,x",
			"about:blank",
			"blob:https://example.com/0f0e",
			"http://localhost:3000/",
			"http://app.localhost/",
			"http://printer.local/",
			"http://127.0.0.1/",
			"http://127.8.9.1/",
			"http://[::1]:8080/",
			"http://10.1.2.3/",
			"http://172.16.0.1/",
			"http://172.31.255.255/",
			"http://192.168.1.1/",
			"http://169.254.10.10/",
			"http://[fd12:3456::1]/",
			"http://[fe80::1]/",
		];
		const publicUrls = [
			"https://example.com/",
			"http://public-site.test/",
			"http://172.32.0.1/",
			"http://11.0.0.1/",
			"http://[2001:db8::1]/",
			"https://localhost.example.com/",
			"chrome-error://chromewebdata/",
			"not a url",
		];
		expect(local.filter(url => !isLocalDocumentUrl(url))).toEqual([]);
		expect(publicUrls.filter(url => isLocalDocumentUrl(url))).toEqual([]);
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser console capture and performance artifacts", () => {
	it("captures persistent console/errors with cursors and bounded overflow", async () => {
		const html = `<!doctype html><title>capture</title><script>
				console.warn("fixture warning", { source: "page" });
				throw new Error("fixture boom");
			</script>`;
		await invoke({ action: "open", name: "console", url: `data:text/html,${encodeURIComponent(html)}` });
		try {
			const consoleResult = (await call("console", [{ level: "warn" }])) as CaptureResult;
			expect(consoleResult.captureStartedAt).toBeUndefined();
			const warning = consoleResult.entries.find(entry => entry.text.includes("fixture warning"));
			expect(warning).toMatchObject({ type: "console", level: "warn" });
			expect(warning?.location).toContain("data:text/html");
			expect(warning?.args).toEqual(["fixture warning", { source: "page" }]);

			await call("evaluate", ["fetch('http://127.0.0.1:1/fail').catch(() => false)"]);
			const errors = (await call("errors")) as CaptureResult;
			const pageError = errors.entries.find(entry => entry.text.includes("fixture boom"));
			expect(pageError).toMatchObject({ type: "pageerror", level: "error" });
			expect(pageError?.location).toContain("data:text/html");
			expect(errors.entries.some(entry => entry.type === "requestfailed" && entry.text.includes("/fail"))).toBe(
				true,
			);

			const cursor = ((await call("console")) as CaptureResult).nextSeq;
			await call("evaluate", ['console.info("newer message")']);
			const newer = (await call("console", [{ since: cursor }])) as CaptureResult;
			expect(newer.entries.map(entry => entry.text)).toEqual(["newer message"]);
			expect(newer.entries[0]?.seq).toBeGreaterThan(cursor);

			await call("console", [{ clear: true }]);
			expect((await call("console")) as CaptureResult).toMatchObject({ entries: [] });
			expect((await call("errors")) as CaptureResult).toMatchObject({ entries: [] });

			await call("evaluate", [
				"(() => { for (let i = 0; i < 520; i++) console.log('overflow-' + i); return true; })()",
			]);
			const overflow = (await call("console")) as CaptureResult;
			expect(overflow.entries).toHaveLength(500);
			expect(overflow.dropped).toBe(20);
			expect(overflow.entries[0]?.text).toBe("overflow-20");

			await call("clearConsole");
			expect((await call("console")) as CaptureResult).toMatchObject({ entries: [], dropped: 0 });

			// This integration check deliberately exercises the worker's real timeout signal.
			let timeoutMessage = "";
			try {
				await invoke({
					action: "run",
					name: "console",
					timeout: 0.5,
					code: `await tab.evaluate("setTimeout(() => { throw new Error('during timeout') }, 0)");
await wait(5_000);`,
				});
			} catch (error) {
				timeoutMessage = error instanceof Error ? error.message : String(error);
			}
			expect(timeoutMessage).toContain("1 page error(s) since run start — see tab.errors()");
		} finally {
			await invoke({ action: "close", name: "console" });
		}
	}, 30_000);

	it("keeps Runtime off on a public page until the first console()/errors() call, then captures", async () => {
		await invoke({ action: "open", name: "console" });
		try {
			await routePublicSite();
			await call("goto", [PUBLIC_URL]);
			expect(await call("title")).toBe("probe:0");
			expect(await call("evaluate", [RUNTIME_PROBE])).toBe(0);

			const before = Date.now();
			const armed = (await call("console")) as CaptureResult;
			expect(armed.entries).toEqual([]);
			expect(armed.captureStartedAt).toBeGreaterThanOrEqual(before);
			expect(armed.captureStartedAt).toBeLessThanOrEqual(Date.now());
			expect(await call("evaluate", [RUNTIME_PROBE])).toBeGreaterThan(0);

			await call("evaluate", [
				"(() => { console.info('public after arm'); setTimeout(() => { throw new Error('public boom'); }, 0); return true; })()",
			]);
			const logged = await pollEntries("console", "public after arm");
			expect(logged.entries.map(entry => entry.text)).toContain("public after arm");
			expect(logged.entries.map(entry => entry.text)).not.toContain("public loaded");
			expect(logged.captureStartedAt).toBe(armed.captureStartedAt);
			const errors = await pollEntries("errors", "public boom");
			expect(errors.entries.find(entry => entry.text.includes("public boom"))).toMatchObject({ type: "pageerror" });
			expect(errors.captureStartedAt).toBe(armed.captureStartedAt);

			// Once armed by a read, capture outlives navigation to another public document.
			await call("goto", [`${PUBLIC_URL}next`]);
			expect(await call("title")).toBe("probe:1");
		} finally {
			await invoke({ action: "close", name: "console" });
		}
	}, 30_000);

	it("records local pages from load and detaches before a public document's scripts run", async () => {
		await invoke({ action: "open", name: "console", url: `${LOCAL_URL}/start` });
		try {
			await routePublicSite();
			expect(await call("evaluate", [RUNTIME_PROBE])).toBeGreaterThan(0);

			// Page-initiated navigation: detached from the main-frame document request.
			await invoke({
				action: "run",
				name: "console",
				code: `await tab.click("#public"); await tab.waitForUrl(${JSON.stringify(PUBLIC_URL)}); await tab.waitForText("public");`,
			});
			expect(await call("title")).toBe("probe:0");

			// A local URL redirecting to a public one: detached on the redirect hop.
			await call("goto", [`${LOCAL_URL}/to-public`]);
			expect(await call("url")).toBe(`${PUBLIC_URL}redirected`);
			expect(await call("title")).toBe("probe:0");

			// A public URL redirecting to a local one ends armed, with the local document's load recorded.
			await call("goto", [`${PUBLIC_URL}to-local`]);
			expect(await call("url")).toBe(`${LOCAL_URL}/from-public`);
			expect(await call("evaluate", [RUNTIME_PROBE])).toBeGreaterThan(0);
			await call("evaluate", ["setTimeout(() => { throw new Error('local boom'); }, 0)"]);
			const logged = (await call("console")) as CaptureResult;
			expect(logged.captureStartedAt).toBeUndefined();
			const texts = logged.entries.map(entry => entry.text);
			expect(texts).toContain("local /start loaded");
			expect(texts).toContain("local /from-public loaded");
			expect(texts).not.toContain("public loaded");
			const errors = await pollEntries("errors", "local boom");
			expect(errors.entries.find(entry => entry.text.includes("local boom"))).toMatchObject({ type: "pageerror" });
		} finally {
			await invoke({ action: "close", name: "console" });
		}
	}, 30_000);

	it("captures JSON objects with non-callable primitive methods without poisoning subsequent reads", async () => {
		const html = `<!doctype html><script>
			console.log("hostile", { toString: "x", valueOf: "y" });
		</script>`;
		await invoke({ action: "open", name: "console", url: `data:text/html,${encodeURIComponent(html)}` });
		try {
			const first = (await call("console")) as CaptureResult;
			expect(first.entries.find(entry => entry.text === 'hostile {"toString":"x","valueOf":"y"}')).toMatchObject({
				type: "console",
				args: ["hostile", { toString: "x", valueOf: "y" }],
			});
			await call("evaluate", ['console.info("after hostile")']);
			const next = (await call("console", [{ since: first.nextSeq }])) as CaptureResult;
			expect(next.entries.map(entry => entry.text)).toEqual(["after hostile"]);
			expect(((await call("errors")) as CaptureResult).entries).toEqual([]);
		} finally {
			await invoke({ action: "close", name: "console" });
		}
	}, 30_000);

	it("keeps the fields of non-Error rejections in page errors, bounded like console arguments", async () => {
		await invoke({ action: "open", name: "console", url: "data:text/html,<title>rejections</title>" });
		try {
			await call("evaluate", [
				`(() => {
					setTimeout(() => {
						Promise.reject({ name: "ProbeObject", message: "OMP_OBJECT_DETAILS", code: "SAFE_TEST", detail: { stage: "synthetic" } });
						Promise.reject("plain rejection reason");
						Promise.reject({ blob: "x".repeat(20000) });
					}, 0);
					return true;
				})()`,
			]);
			let entries: CaptureEntry[] = [];
			for (let attempt = 0; attempt < 50 && entries.length < 3; attempt++) {
				await Bun.sleep(20);
				entries = ((await call("errors")) as CaptureResult).entries;
			}
			expect(entries.map(entry => entry.text).slice(0, 2)).toEqual([
				'{"name":"ProbeObject","message":"OMP_OBJECT_DETAILS","code":"SAFE_TEST","detail":{"stage":"synthetic"}}',
				"plain rejection reason",
			]);
			const oversized = entries[2]?.text ?? "";
			expect(oversized.startsWith('{"blob":"xxx')).toBe(true);
			expect(oversized.length).toBe(8_193);
		} finally {
			await invoke({ action: "close", name: "console" });
		}
	}, 30_000);

	it("keeps the cmux page hook from throwing on values whose text conversion throws", async () => {
		await invoke({ action: "open", name: "console", url: "data:text/html,<title>cmux hook</title>" });
		try {
			const result = await call("evaluate", [
				`(() => {
					${CMUX_CONSOLE_CAPTURE_SCRIPT};
					console.log("hostile", { toString: "x", valueOf: "y" });
					const { proxy, revoke } = Proxy.revocable({}, {});
					revoke();
					console.log("revoked", proxy);
					return globalThis.__ompConsoleCapture.entries;
				})()`,
			]);
			expect(result).toEqual([
				expect.objectContaining({
					type: "console",
					text: 'hostile {"toString":"x","valueOf":"y"}',
					args: ["hostile", { toString: "x", valueOf: "y" }],
				}),
				expect.objectContaining({
					type: "console",
					text: "revoked [unserializable]",
					args: ["revoked", "[unserializable]"],
				}),
			]);
		} finally {
			await invoke({ action: "close", name: "console" });
		}
	}, 30_000);

	it("keeps the fields of non-Error rejections in the cmux page hook", async () => {
		await invoke({ action: "open", name: "console", url: "data:text/html,<title>cmux rejections</title>" });
		try {
			const result = await call("evaluate", [
				`(async () => {
					${CMUX_CONSOLE_CAPTURE_SCRIPT};
					Promise.reject({ name: "ProbeObject", message: "OMP_OBJECT_DETAILS", code: "SAFE_TEST" });
					Promise.reject(new Error("native rejection"));
					const capture = globalThis.__ompConsoleCapture;
					for (let attempt = 0; attempt < 100 && capture.entries.length < 2; attempt++) {
						await new Promise(resolve => setTimeout(resolve, 10));
					}
					return capture.entries.map(entry => entry.text);
				})()`,
			]);
			expect(result).toEqual([
				'{"name":"ProbeObject","message":"OMP_OBJECT_DETAILS","code":"SAFE_TEST"}',
				"native rejection",
			]);
		} finally {
			await invoke({ action: "close", name: "console" });
		}
	}, 30_000);

	it("writes Chromium traces and CPU profiles and reports lifecycle metrics", async () => {
		await invoke({ action: "open", name: "console", url: "data:text/html,<title>profile</title>" });
		try {
			const tracePath = path.join(root, "capture-trace.json");
			await call("traceStart", [{ screenshots: false }]);
			await call("evaluate", ["document.body.textContent = 'traced'"]);
			expect(await call("traceStop", [{ path: tracePath }])).toBe(tracePath);
			const trace: unknown = JSON.parse(await fs.readFile(tracePath, "utf8"));
			expect(trace).toEqual(expect.objectContaining({ traceEvents: expect.any(Array) }));
			if (!trace || typeof trace !== "object" || !("traceEvents" in trace) || !Array.isArray(trace.traceEvents)) {
				throw new Error("trace output did not contain traceEvents");
			}
			expect(trace.traceEvents.length).toBeGreaterThan(0);

			const profilePath = path.join(root, "capture.cpuprofile");
			await call("profileStart");
			await call("evaluate", [
				"(() => { let total = 0; for (let i = 0; i < 200000; i++) total += Math.sqrt(i); return total; })()",
			]);
			expect(await call("profileStop", [{ path: profilePath }])).toBe(profilePath);
			const profile: unknown = JSON.parse(await fs.readFile(profilePath, "utf8"));
			expect(profile).toEqual(expect.objectContaining({ nodes: expect.any(Array) }));
			if (!profile || typeof profile !== "object" || !("nodes" in profile) || !Array.isArray(profile.nodes)) {
				throw new Error("CPU profile output did not contain nodes");
			}
			expect(profile.nodes.length).toBeGreaterThan(0);

			const metrics = (await call("metrics")) as Record<string, number>;
			expect(metrics.domContentLoaded).toBeGreaterThanOrEqual(0);
			expect(metrics.load).toBeGreaterThanOrEqual(0);
			expect(metrics.Documents).toBeGreaterThan(0);
		} finally {
			await invoke({ action: "close", name: "console" });
		}
	}, 30_000);
});
