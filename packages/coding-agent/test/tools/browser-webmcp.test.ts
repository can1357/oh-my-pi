import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { acquireBrowser, holdBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import {
	installWebMcp,
	installWebMcpPageHook,
	WEBMCP_BRIDGE_KEY,
	type WebMcpEventsResult,
	type WebMcpInvokeResult,
	type WebMcpListResult,
	webMcpSnapshotInPage,
} from "@oh-my-pi/pi-coding-agent/tools/browser/webmcp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function createBrowserHost() {
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
	return (parameters: unknown) => prelude.invoke(parameters, { session, toolCallId: "browser-webmcp-test" });
}

function call(name: string, method: string, args: unknown[] = []) {
	return name.length > 0
		? { action: "call", name, chain: [{ method, args }] }
		: { action: "call", chain: [{ method, args }] };
}

function valueFrom<T>(result: { details?: unknown }): T {
	const details = result.details;
	if (!details || typeof details !== "object" || !("value" in details)) {
		throw new Error("Browser call returned no value");
	}
	return details.value as T;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser WebMCP helpers", () => {
	it("discovers, invokes, bounds trust, and reports page-side registrations", async () => {
		const invoke = createBrowserHost();
		const html = `<!doctype html>
<html><head><title>loading</title></head><body><script>
(async () => {
  window.webmcpSurface = navigator.modelContext?.constructor?.name === "ModelContext" ? "native" : "hook-polyfill";
  await navigator.modelContext.registerTool({
    name: "sum_values",
    description: "Adds two values from the page.",
    inputSchema: {
      type: "object",
      properties: { left: { type: "number" }, right: { type: "number" } },
      required: ["left", "right"]
    },
    annotations: { readOnlyHint: true },
    execute({ left, right }) { return { total: left + right }; }
  });
  await navigator.modelContext.registerTool({
    name: "large_result",
    description: "Returns an oversized page result.",
    inputSchema: { type: "object" },
    execute() { return "x".repeat(70 * 1024); }
  });
  await navigator.modelContext.registerTool({
    name: "throw_page_error",
    description: "Throws page-provided text.",
    inputSchema: { type: "object" },
    execute() { throw new Error("PAGE_SENTINEL_FAILURE"); }
  });
  document.title = "registered";
})();
</script></body></html>`;
		const url = `data:text/html,${encodeURIComponent(html)}`;
		await invoke({ action: "open", name: "webmcp", url });

		const surface = valueFrom<string>(await invoke(call("webmcp", "evaluate", ["window.webmcpSurface"])));
		// Chrome 150 with WebMCP flags does not expose its secure-context API to data: pages; the preload polyfill runs.
		expect(surface).toBe("hook-polyfill");

		const summary = valueFrom<WebMcpListResult>(await invoke(call("webmcp", "webmcpList")));
		expect(summary).toMatchObject({
			status: "ready",
			truncated: false,
			untrusted: true,
		});
		expect(summary.tools.map(tool => tool.name)).toEqual(["large_result", "sum_values", "throw_page_error"]);
		expect(summary.tools.every(tool => tool.inputSchema === undefined)).toBe(true);

		const detail = valueFrom<WebMcpListResult>(await invoke(call("webmcp", "webmcpList", [{ name: "sum_values" }])));
		expect(detail.tools).toEqual([
			expect.objectContaining({
				name: "sum_values",
				inputSchema: expect.objectContaining({ type: "object", required: ["left", "right"] }),
				annotations: { readOnlyHint: true },
				untrusted: true,
			}),
		]);

		const result = valueFrom<WebMcpInvokeResult>(
			await invoke(call("webmcp", "webmcpInvoke", ["sum_values", { left: 20, right: 22 }])),
		);
		expect(result).toEqual({ ok: true, result: { total: 42 }, untrusted: true });

		const largeResult = valueFrom<WebMcpInvokeResult>(
			await invoke(call("webmcp", "webmcpInvoke", ["large_result", {}])),
		);
		expect(largeResult).toMatchObject({ ok: true, truncated: true, untrusted: true });
		expect(Buffer.byteLength(JSON.stringify(largeResult), "utf8")).toBeLessThanOrEqual(64 * 1024);

		const failure = valueFrom<WebMcpInvokeResult>(
			await invoke(call("webmcp", "webmcpInvoke", ["throw_page_error", {}])),
		);
		expect(failure).toMatchObject({ ok: false, untrusted: true });
		if (failure.ok) throw new Error("Expected page tool failure");
		expect(failure.error).toContain("BEGIN UNTRUSTED WEBMCP CONTENT");
		expect(failure.error).toContain("PAGE_SENTINEL_FAILURE");
		expect(failure.error).toContain("END UNTRUSTED WEBMCP CONTENT");

		const events = valueFrom<WebMcpEventsResult>(await invoke(call("webmcp", "webmcpEvents")));
		expect(events).toMatchObject({ untrusted: true, truncated: false });
		expect(events.events.map(event => [event.type, event.name])).toEqual([
			["registered", "large_result"],
			["registered", "sum_values"],
			["registered", "throw_page_error"],
		]);
		await invoke({ action: "close", name: "webmcp", kill: true });
	}, 30_000);

	it("keeps a page alive whose same-site iframe is touched before it navigates", async () => {
		const invoke = createBrowserHost();
		// Same site, other origin: the iframe shares the parent's renderer.
		using child = Bun.serve({
			port: 0,
			hostname: "localhost",
			fetch: () =>
				new Response("<!doctype html><title>child</title>child", { headers: { "content-type": "text/html" } }),
		});
		using parent = Bun.serve({
			port: 0,
			hostname: "localhost",
			fetch: () =>
				new Response(
					`<!doctype html><title>parent</title><body><script>
const frame = document.createElement("iframe");
frame.onload = () => { document.title = "iframe loaded"; };
frame.src = "http://localhost:${child.port}/";
document.body.appendChild(frame);
// Touching the window before it navigates gives its initial empty document a script context.
frame.contentWindow.location.href;
// Chromium exposes its context on document or navigator, depending on the version.
const context = document.modelContext ?? navigator.modelContext;
window.webmcpSurface = context.constructor.name;
context.registerTool({
  name: "page_title",
  description: "Returns the page title.",
  inputSchema: { type: "object" },
  execute() { return { title: document.title }; }
});
</script></body>`,
					{ headers: { "content-type": "text/html" } },
				),
		});

		await invoke({ action: "open", name: "webmcp-iframe", url: `http://localhost:${parent.port}/`, timeout: 10 });
		expect(valueFrom<string>(await invoke(call("webmcp-iframe", "evaluate", ["document.title"])))).toBe(
			"iframe loaded",
		);
		// Only Chromium's own modelContext reaches the duplicate bind; the polyfill would pass regardless.
		expect(valueFrom<string>(await invoke(call("webmcp-iframe", "evaluate", ["window.webmcpSurface"])))).toBe(
			"ModelContext",
		);
		const listed = valueFrom<WebMcpListResult>(await invoke(call("webmcp-iframe", "webmcpList")));
		expect(listed.tools.map(tool => tool.name)).toEqual(["page_title"]);
		const result = valueFrom<WebMcpInvokeResult>(
			await invoke(call("webmcp-iframe", "webmcpInvoke", ["page_title", {}])),
		);
		expect(result).toEqual({ ok: true, result: { title: "iframe loaded" }, untrusted: true });
		await invoke({ action: "close", name: "webmcp-iframe", kill: true });
	}, 30_000);

	// The hook reaches a loaded page when omp attaches to it: a context the page set up itself is
	// patched directly, not through Chromium's ModelContext prototype.
	it.each([
		{
			setup: "a non-configurable accessor",
			define: `Object.defineProperty(navigator, "modelContext", { get: () => window.pageContext });`,
			registerOn: "navigator.modelContext",
		},
		{
			setup: "an accessor the page read before attach",
			define: `Object.defineProperty(navigator, "modelContext", { configurable: true, get: () => window.pageContext });
window.cachedContext = navigator.modelContext;`,
			registerOn: "window.cachedContext",
		},
		{
			setup: "an accessor that yields no context",
			define: `Object.defineProperty(navigator, "modelContext", { configurable: true, get: () => undefined });`,
			registerOn: "navigator.modelContext",
		},
		{
			setup: "a prototype accessor the page read before attach",
			define: `Object.defineProperty(Navigator.prototype, "modelContext", { configurable: true, get: () => window.pageContext });
window.cachedContext = navigator.modelContext;`,
			registerOn: "window.cachedContext",
		},
		{
			setup: "a prototype accessor that yields no context",
			define: `Object.defineProperty(Navigator.prototype, "modelContext", { configurable: true, get: () => undefined });`,
			registerOn: "navigator.modelContext",
		},
		{
			setup: "a data property holding null",
			define: `Object.defineProperty(navigator, "modelContext", { configurable: true, value: null });`,
			registerOn: "navigator.modelContext",
		},
		{
			setup: "a prototype accessor that yields null",
			define: `Object.defineProperty(Navigator.prototype, "modelContext", { configurable: true, get: () => null });`,
			registerOn: "navigator.modelContext",
		},
		{
			setup: "a bound prototype accessor the page read before attach",
			define: `Object.defineProperty(Navigator.prototype, "modelContext", { configurable: true, get: function () { return window.pageContext; }.bind(null) });
window.cachedContext = navigator.modelContext;`,
			registerOn: "window.cachedContext",
		},
	])(
		"mirrors a tool registered after attach on a page whose modelContext is $setup",
		async ({ define, registerOn }) => {
			const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("browser" in handle)) throw new Error("Expected a Puppeteer browser");
			holdBrowser(handle);
			const page = await handle.browser.newPage();
			try {
				await page.goto("data:text/html,<title>page-owned context</title>");
				// The realm installWebMcp hooks in existing frames.
				const realm = page.mainFrame().mainRealm();
				await realm.evaluate(`window.pageContext = { registerTool() {}, unregisterTool() {} };\n${define}\nnull;`);
				const controller = await installWebMcp(page);
				await realm.evaluate(
					`${registerOn}.registerTool({ name: "page_owned", description: "Page tool.", inputSchema: { type: "object" }, execute: () => ({ value: 42 }) })`,
				);
				expect((await controller.list()).tools.map(tool => tool.name)).toEqual(["page_owned"]);
				expect(await controller.invoke("page_owned", {})).toEqual({
					ok: true,
					result: { value: 42 },
					untrusted: true,
				});
				await controller.dispose();
			} finally {
				await page.close();
				await releaseBrowser(handle, { kill: false });
			}
		},
	);

	// `window.nativeRegister` is Chromium's method from before attach.
	it.each([
		{
			change: "left registerTool alone",
			afterAttach: "",
			check: `ModelContext.prototype.registerTool === window.nativeRegister`,
		},
		{
			change: "replaced registerTool",
			afterAttach: `window.pageRegister = function registerTool() {};
ModelContext.prototype.registerTool = window.pageRegister;`,
			check: `ModelContext.prototype.registerTool === window.pageRegister`,
		},
		{
			change: "made registerTool non-enumerable",
			afterAttach: `Object.defineProperty(ModelContext.prototype, "registerTool", { enumerable: false });`,
			check: `(d => d.value === window.nativeRegister && !d.enumerable)(Object.getOwnPropertyDescriptor(ModelContext.prototype, "registerTool"))`,
		},
	])("restores only its own methods on dispose after the page $change", async ({ afterAttach, check }) => {
		// A secure context, so Chromium exposes its own ModelContext.
		using server = Bun.serve({
			port: 0,
			hostname: "localhost",
			fetch: () =>
				new Response("<!doctype html><title>dispose</title>", { headers: { "content-type": "text/html" } }),
		});
		const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in handle)) throw new Error("Expected a Puppeteer browser");
		holdBrowser(handle);
		const page = await handle.browser.newPage();
		try {
			await page.goto(`http://localhost:${server.port}/`);
			const realm = page.mainFrame().mainRealm();
			await realm.evaluate(`window.nativeRegister = ModelContext.prototype.registerTool; null;`);
			const controller = await installWebMcp(page);
			await realm.evaluate(`${afterAttach}\nnull;`);
			await controller.dispose();
			expect(await realm.evaluate(check)).toBe(true);
		} finally {
			await page.close();
			await releaseBrowser(handle, { kill: false });
		}
	});

	it("keeps an attached page alive whose document is replaced through a javascript: URL", async () => {
		using server = Bun.serve({
			port: 0,
			hostname: "localhost",
			fetch: () =>
				new Response("<!doctype html><title>before</title>", { headers: { "content-type": "text/html" } }),
		});
		const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in handle)) throw new Error("Expected a Puppeteer browser");
		holdBrowser(handle);
		const page = await handle.browser.newPage();
		try {
			await page.goto(`http://localhost:${server.port}/`);
			const realm = page.mainFrame().mainRealm();
			const controller = await installWebMcp(page);
			// Puppeteer loses track of a javascript:-replaced document's realm, so the new document reports
			// through a CDP binding.
			const session = await page.createCDPSession();
			await session.send("Runtime.enable");
			await session.send("Runtime.addBinding", { name: "reportSurface" });
			const reported = Promise.withResolvers<string>();
			session.on("Runtime.bindingCalled", event => reported.resolve(event.payload));
			let crashed = false;
			page.on("error", () => {
				crashed = true;
			});
			// The replacement document is the frame's second; reading its context binds a second time if omp
			// created one in the first.
			const html = `<script>reportSurface((document.modelContext ?? navigator.modelContext).constructor.name);</script>`;
			await realm.evaluate(`location.href = "javascript:" + ${JSON.stringify(JSON.stringify(html))}; null;`);
			expect(await reported.promise).toBe("ModelContext");
			// The kill can land after the report; a killed renderer answers nothing more and the test times out.
			const alive = await session.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
			expect(alive.result.value).toBe(2);
			expect(crashed).toBe(false);
			await controller.dispose();
		} finally {
			await page.close();
			await releaseBrowser(handle, { kill: false });
		}
	}, 10_000);

	it.each([
		{
			setup: "held before attach",
			define: `window.pageContext = document.modelContext ?? navigator.modelContext;`,
		},
		{
			setup: "exposed on document with its own registerTool",
			define: `window.pageContext = document.modelContext ?? navigator.modelContext;
const nativeRegister = pageContext.registerTool;
pageContext.registerTool = function (tool, options) { return nativeRegister.call(this, tool, options); };
Object.defineProperty(document, "modelContext", { configurable: true, value: pageContext });`,
		},
	])("mirrors a tool registered after attach through a native modelContext $setup", async ({ define }) => {
		using server = Bun.serve({
			port: 0,
			hostname: "localhost",
			fetch: () =>
				new Response("<!doctype html><title>cached</title>", { headers: { "content-type": "text/html" } }),
		});
		const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in handle)) throw new Error("Expected a Puppeteer browser");
		holdBrowser(handle);
		const page = await handle.browser.newPage();
		try {
			await page.goto(`http://localhost:${server.port}/`);
			const realm = page.mainFrame().mainRealm();
			await realm.evaluate(`${define}\nnull;`);
			const controller = await installWebMcp(page);
			await realm.evaluate(
				`pageContext.registerTool({ name: "native_tool", description: "Page tool.", inputSchema: { type: "object" }, execute: () => ({ value: 42 }) })`,
			);
			// The page-side mirror, which is all omp has when the browser lacks WebMCP over CDP.
			const snapshot = await realm.evaluate(webMcpSnapshotInPage, WEBMCP_BRIDGE_KEY);
			expect(snapshot.tools.map(tool => tool.name)).toEqual(["native_tool"]);
			await controller.dispose();
		} finally {
			await page.close();
			await releaseBrowser(handle, { kill: false });
		}
	});

	it("calls a page-owned context's methods on that context when the page detaches them", async () => {
		const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in handle)) throw new Error("Expected a Puppeteer browser");
		holdBrowser(handle);
		const page = await handle.browser.newPage();
		try {
			await page.goto("data:text/html,<title>detached</title>");
			const realm = page.mainFrame().mainRealm();
			await realm.evaluate(`window.pageContext = {
  names: new Set(),
  registerTool(tool) { this.names.add(tool.name); },
  unregisterTool(name) { this.names.delete(name); },
};
Object.defineProperty(navigator, "modelContext", { configurable: true, value: window.pageContext });
null;`);
			const controller = await installWebMcp(page);
			await realm.evaluate(
				`(({ registerTool }) => registerTool({ name: "detached", description: "Page tool.", inputSchema: { type: "object" }, execute: () => 1 }))(navigator.modelContext)`,
			);
			expect(await realm.evaluate(`[...pageContext.names]`)).toEqual(["detached"]);
			expect((await controller.list()).tools.map(tool => tool.name)).toEqual(["detached"]);
			await realm.evaluate(`(({ unregisterTool }) => unregisterTool("detached"))(navigator.modelContext)`);
			expect(await realm.evaluate(`pageContext.names.size`)).toBe(0);
			expect((await controller.list()).tools).toEqual([]);
			await controller.dispose();
		} finally {
			await page.close();
			await releaseBrowser(handle, { kill: false });
		}
	});

	// The hook reads `document.modelContext ?? navigator.modelContext` without the platform API.
	it.each([
		{ owner: "document", nativeAvailable: false },
		{ owner: "navigator", nativeAvailable: true },
	])(
		"reports nativeAvailable $nativeAvailable when $owner has a null modelContext",
		async ({ owner, nativeAvailable }) => {
			const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("browser" in handle)) throw new Error("Expected a Puppeteer browser");
			holdBrowser(handle);
			const page = await handle.browser.newPage();
			try {
				await page.goto("data:text/html,<title>null context</title>");
				const realm = page.mainFrame().mainRealm();
				await realm.evaluate(
					`Object.defineProperty(${owner}, "modelContext", { configurable: true, value: null }); null;`,
				);
				await realm.evaluate(installWebMcpPageHook, WEBMCP_BRIDGE_KEY);
				expect((await realm.evaluate(webMcpSnapshotInPage, WEBMCP_BRIDGE_KEY)).nativeAvailable).toBe(
					nativeAvailable,
				);
			} finally {
				await page.close();
				await releaseBrowser(handle, { kill: false });
			}
		},
	);
});
