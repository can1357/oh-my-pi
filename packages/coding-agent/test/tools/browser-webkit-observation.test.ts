/**
 * A tab on a server that observes pages natively (its welcome lists `console`
 * and `network`, as omp's WebKit host's does): what omp puts in the page's
 * world, and where the console and request logs come from. Driven through the
 * prelude against a fake `ABHost` process.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { getTab, releaseTab, type WebKitTabSession } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { createFakeHost, type FakeHost } from "./webkit-fake-host";

// Ambient browser env of the developer's shell (and of an omp running the suite) must not pick the backend.
const ENV_KEYS = [
	"PI_BROWSER_WEBKIT",
	"PI_BROWSER_WEBKIT_PATH",
	"PI_BROWSER_RELAY",
	"PI_BROWSER_TERN",
	"PI_BROWSER_CMUX",
	"TERN_PANE_SOCKET",
	"TERN_PANE",
	"CMUX_SOCKET_PATH",
];
const TAB = "wk-observed";

let savedEnv: Map<string, string | undefined>;
let fake: FakeHost;
let tab: WebKitTabSession;

beforeEach(async () => {
	savedEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	fake = await createFakeHost();
	process.env.PI_BROWSER_WEBKIT_PATH = fake.dir;
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "browser.enabled": true, "browser.relay": false, "tools.maxTimeout": 0 }),
	};
	await createBrowserPrelude(session).invoke(
		{ action: "open", name: TAB, timeout: 10 },
		{ session, toolCallId: "webkit-observation" },
	);
	const opened = getTab(TAB);
	if (opened?.backend !== "webkit") throw new Error("expected a WebKit tab");
	tab = opened;
});

afterEach(async () => {
	await releaseTab(TAB, { kill: false }).catch(() => undefined);
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fake.remove();
});

/** The page-world script sources of the last `scripts` list the host was sent. */
async function pageScripts(): Promise<string[]> {
	const last = (await fake.requests()).findLast(request => request.op === "scripts");
	const scripts = (last?.scripts ?? []) as Array<{ source: string; world: string }>;
	return scripts.filter(script => script.world === "page").map(script => script.source);
}

/** Append engine events to the tab's block, as the host would. */
async function emit(events: Array<Record<string, unknown>>): Promise<void> {
	await tab.browser.webkit.client.request({ op: "emit", block: tab.ternTab.block, events });
}

/** A message a page-world capture script posted. */
function pageMessage(body: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "message",
		world: "page",
		main: true,
		url: "https://site.example/",
		body: JSON.stringify({ omp: "tern", ...body }),
	};
}

describe("a tab on a server that observes pages natively", () => {
	it("puts nothing in the page's world until a helper needs it, and takes the capture out again", async () => {
		// The open: every script list sent holds isolated-world scripts only, and nothing was evaluated in the page.
		const opening = await fake.requests();
		const lists = opening.filter(request => request.op === "scripts");
		expect(lists.length).toBeGreaterThan(0);
		for (const list of lists) {
			expect((list.scripts as Array<{ world: string }>).map(script => script.world)).not.toContain("page");
		}
		expect(opening.filter(request => request.op === "eval" && request.world === "page")).toEqual([]);

		// A route needs the capture script; it stays while any route is left.
		await tab.ternTab.route("**/api/**", { abort: true });
		const withRoute = await pageScripts();
		expect(withRoute).toHaveLength(1);
		expect(withRoute[0]).toContain("__ompTernCapture");
		await tab.ternTab.route(/tracking/, { abort: true });
		await tab.ternTab.unroute("**/api/**");
		expect(await pageScripts()).toHaveLength(1);
		await tab.ternTab.unroute(/tracking/);
		expect(await pageScripts()).toEqual([]);

		// So does an emulation the capture implements, until it is cleared.
		await tab.ternTab.emulate({ offline: true });
		expect((await pageScripts()).join("\n")).toContain("__ompTernCapture");
		await tab.ternTab.emulate({ offline: false });
		expect(await pageScripts()).toEqual([]);

		// The Web Vitals observers become a document-start script with the first vitals() call.
		await tab.ternTab.vitals({ reload: false });
		const withVitals = await pageScripts();
		expect(withVitals).toHaveLength(1);
		expect(withVitals[0]).toContain("__ompBrowserVitals");
	});

	it("reads console messages, page errors and every resource load from the engine's events", async () => {
		await emit([
			{
				type: "console",
				level: "warning",
				text: "careful",
				source: "console-api",
				url: "https://site.example/app.js",
				line: 7,
			},
			{
				type: "console",
				level: "error",
				text: "ReferenceError: Can't find variable: nope",
				source: "javascript",
				url: "https://site.example/app.js",
				line: 9,
			},
			{
				type: "request",
				id: 1,
				url: "https://site.example/",
				method: "GET",
				headers: { Accept: "text/html" },
				main: true,
			},
			{
				type: "response",
				id: 1,
				url: "https://site.example/",
				status: 200,
				mime: "text/html",
				headers: {},
				main: true,
			},
			{ type: "requestFinished", id: 1, length: 5120 },
			{
				type: "request",
				id: 2,
				url: "https://site.example/app.css",
				method: "GET",
				headers: { "Sec-Fetch-Dest": "style" },
				main: false,
			},
			{
				type: "response",
				id: 2,
				url: "https://site.example/app.css",
				status: 404,
				mime: "text/html",
				headers: {},
				main: false,
			},
			{ type: "request", id: 3, url: "https://cdn.example/pixel.png", method: "GET", headers: {}, main: false },
			{
				type: "requestFailed",
				id: 3,
				url: "https://cdn.example/pixel.png",
				error: "A server with the specified hostname could not be found.",
			},
		]);

		const logged = await tab.ternTab.console();
		expect(logged.entries).toMatchObject([
			{ type: "console", level: "warn", text: "careful", location: "https://site.example/app.js:7" },
		]);
		const errors = await tab.ternTab.errors();
		expect(errors.entries).toMatchObject([
			{
				type: "pageerror",
				text: "ReferenceError: Can't find variable: nope",
				location: "https://site.example/app.js:9",
			},
			{
				type: "requestfailed",
				text: "A server with the specified hostname could not be found.: https://cdn.example/pixel.png",
			},
		]);

		const requests = await tab.ternTab.requests();
		expect(requests).toMatchObject([
			{
				url: "https://site.example/",
				resourceType: "document",
				status: 200,
				ok: true,
				sizes: { responseBody: 5120 },
			},
			// The request said what it was for; the 404 page's MIME type does not change that.
			{ url: "https://site.example/app.css", resourceType: "stylesheet", status: 404, ok: false },
			{
				url: "https://cdn.example/pixel.png",
				failureText: "A server with the specified hostname could not be found.",
			},
		]);
		expect(requests[0]?.requestHeaders).toEqual({ accept: "text/html" });
		// The engine keeps no bodies: the record comes back without one.
		const detail = await tab.ternTab.request(requests[0]!.id);
		expect(detail.status).toBe(200);
		expect(detail.body).toBeUndefined();
	});

	it("keeps the engine as the logs' source while a capture script is installed", async () => {
		await tab.ternTab.route("**/mock", { status: 200, body: "{}" });
		await emit([
			// The capture wraps the console and fetch: the same message and the same load arrive twice.
			pageMessage({ kind: "console", level: "log", text: "once", args: ["once"] }),
			{ type: "console", level: "log", text: "once", source: "console-api" },
			pageMessage({
				kind: "request",
				id: "d:1",
				method: "GET",
				url: "https://site.example/real",
				resourceType: "fetch",
				headers: {},
			}),
			{
				type: "request",
				id: 4,
				url: "https://site.example/real",
				method: "GET",
				headers: { "Sec-Fetch-Dest": "empty" },
				main: false,
			},
			{
				type: "response",
				id: 4,
				url: "https://site.example/real",
				status: 200,
				mime: "application/json",
				headers: {},
				main: false,
			},
			pageMessage({
				kind: "response",
				id: "d:1",
				url: "https://site.example/real",
				status: 200,
				headers: {},
				routed: false,
				local: false,
			}),
			// The route answered this one in the page: the engine never saw it.
			pageMessage({
				kind: "request",
				id: "d:2",
				method: "GET",
				url: "https://site.example/mock",
				resourceType: "fetch",
				headers: {},
			}),
			pageMessage({
				kind: "response",
				id: "d:2",
				url: "https://site.example/mock",
				status: 200,
				headers: {},
				routed: true,
				local: true,
			}),
		]);

		expect((await tab.ternTab.console()).entries.map(entry => entry.text)).toEqual(["once"]);
		expect((await tab.ternTab.requests()).map(record => [record.url, record.resourceType, record.status])).toEqual([
			["https://site.example/real", "fetch", 200],
			["https://site.example/mock", "fetch", 200],
		]);
	});
});
