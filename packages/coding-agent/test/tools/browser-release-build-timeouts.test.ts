import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { isPuppeteerTimeout, loadPuppeteer } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { navigateMainFrame } from "@oh-my-pi/pi-coding-agent/tools/browser/navigation";
import { getTab, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { type Page, TimeoutError } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

// Release builds minify class names, and Puppeteer names each error after its class, so its
// timeouts are named like `Og` in the shipped binary. These tests rename the class the same way.

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const server = Bun.serve({
	port: 0,
	// `/never-commits` must outlive the run budget instead of Bun's 10s idle cut.
	idleTimeout: 0,
	fetch(request) {
		// Never answers, so a navigation to it never commits.
		if (new URL(request.url).pathname === "/never-commits") return Promise.withResolvers<Response>().promise;
		return new Response("<!doctype html><title>start</title>", { headers: { "content-type": "text/html" } });
	},
});
const baseUrl = `http://127.0.0.1:${server.port}`;

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	server.stop(true);
}, 30_000);

function createHost() {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown) =>
		prelude.invoke(parameters, { session, toolCallId: "browser-release-build-timeouts-test" });
}

test("raises a main-frame wait past its timeout as Puppeteer's timeout, still named TimeoutError", async () => {
	// The tab worker loads Puppeteer before any navigation; the timeout is built from that load.
	await loadPuppeteer();
	const events = new Set<string>();
	const page = {
		mainFrame: () => ({ _lifecycleEvents: events }),
		isClosed: () => false,
		browser: () => ({ connected: true }),
	} as unknown as Page;
	const nameDescriptor = Object.getOwnPropertyDescriptor(TimeoutError, "name")!;
	Object.defineProperty(TimeoutError, "name", { ...nameDescriptor, value: "Og" });
	// Real time on purpose: the wait polls the frame on a timer and must stop reading at its deadline.
	const late = setTimeout(() => events.add("load"), 90);
	try {
		const error = await navigateMainFrame(page, "load", 60, undefined, async () => null).catch(err => err);
		// tab.goto stops the pending load only for an error it recognizes as Puppeteer's timeout.
		expect(isPuppeteerTimeout(error)).toBe(true);
		// back/forward/reload pass this error to the agent's cell, which may match on the name.
		expect(error.name).toBe("TimeoutError");
		expect(error.message).toBe("Navigation timeout of 60 ms exceeded");
	} finally {
		clearTimeout(late);
		Object.defineProperty(TimeoutError, "name", nameDescriptor);
	}
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser timeouts with release-build class names", () => {
	test("tab.goto stops a navigation that never commits", async () => {
		// The tab worker must share this process's renamed class: worker threads failing to start
		// puts a tab on the inline worker. bun runs a file's tests one at a time, so no other browser
		// call is in flight while `Worker` or the class name is replaced.
		const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker")!;
		Object.defineProperty(globalThis, "Worker", {
			...workerDescriptor,
			value: function UnavailableWorker(): never {
				throw new Error("Worker threads unavailable");
			},
		});
		const invoke = createHost();
		try {
			await invoke({ action: "open", name: "minified-timeout", url: `${baseUrl}/start` });
		} finally {
			Object.defineProperty(globalThis, "Worker", workerDescriptor);
		}
		expect(getTab("minified-timeout")).toMatchObject({ worker: { mode: "inline" } });
		const nameDescriptor = Object.getOwnPropertyDescriptor(TimeoutError, "name")!;
		Object.defineProperty(TimeoutError, "name", { ...nameDescriptor, value: "Og" });
		try {
			const error = await invoke({
				action: "run",
				name: "minified-timeout",
				timeout: 3,
				code: `await tab.goto(${JSON.stringify(`${baseUrl}/never-commits`)});`,
			}).catch(err => err);
			expect((error as Error).message).toMatch(/^tab\.goto\(.*\) timed out after \d+ms; pending navigation stopped/);
		} finally {
			Object.defineProperty(TimeoutError, "name", nameDescriptor);
		}
		// The stopped navigation no longer holds the page, so the next call answers on the old document.
		const { details } = await invoke({
			action: "run",
			name: "minified-timeout",
			timeout: 3,
			code: "return tab.url();",
		});
		expect(details).toMatchObject({ value: `${baseUrl}/start` });
	}, 60_000);
});
