import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	acquireBrowser,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import {
	WebMcpController,
	type WebMcpEventsResult,
	type WebMcpInvokeResult,
	type WebMcpListResult,
} from "@oh-my-pi/pi-coding-agent/tools/browser/webmcp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const BROWSER_TEST_TIMEOUT_MS = 30_000;

// One headless Chromium for the file, held across it; the browser host's tabs open in it too. Each test closes the
// pages and tabs it opened.
let sharedHeadless: PuppeteerBrowserHandle | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	const launched = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
	if (!("browser" in launched)) throw new Error("Expected a Puppeteer browser");
	holdBrowser(launched);
	sharedHeadless = launched;
});

function headless(): PuppeteerBrowserHandle {
	if (!sharedHeadless?.browser.connected) throw new Error("Expected the shared headless browser");
	return sharedHeadless;
}

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
	if (sharedHeadless) await releaseBrowser(sharedHeadless, { kill: true });
});

function servePage(body: string): Bun.Server<undefined> {
	return Bun.serve({
		port: 0,
		hostname: "localhost",
		fetch: () => new Response(`<!doctype html>${body}`, { headers: { "content-type": "text/html" } }),
	});
}

describe.skipIf(!CHROMIUM_AVAILABLE)("browser WebMCP helpers", () => {
	it(
		"discovers, invokes, bounds trust, and reports native registrations",
		async () => {
			const invoke = createBrowserHost();
			// localhost is a secure context, so Chromium exposes its own modelContext.
			using server = servePage(`<title>loading</title>
<form toolname="search_form" tooldescription="Searches the page."><input name="q"></form>
<script>
(async () => {
  const context = document.modelContext ?? navigator.modelContext;
  await context.registerTool({
    name: "sum_values",
    description: "Adds two values from the page.",
    inputSchema: {
      type: "object",
      properties: { left: { type: "number" }, right: { type: "number" } },
      required: ["left", "right"]
    },
    execute({ left, right }) { return { total: left + right }; }
  });
  await context.registerTool({
    name: "large_result",
    description: "Returns an oversized page result.",
    inputSchema: { type: "object" },
    execute() { return "x".repeat(70 * 1024); }
  });
  await context.registerTool({
    name: "throw_page_error",
    description: "Throws page-provided text.",
    inputSchema: { type: "object" },
    execute() { throw new Error("PAGE_SENTINEL_FAILURE"); }
  });
  document.title = "registered";
})();
</script>`);
			await invoke({ action: "open", name: "webmcp", url: `http://localhost:${server.port}/` });
			expect(valueFrom<string>(await invoke(call("webmcp", "evaluate", ["document.title"])))).toBe("registered");

			const summary = valueFrom<WebMcpListResult>(await invoke(call("webmcp", "webmcpList")));
			expect(summary).toMatchObject({ status: "ready", truncated: false, untrusted: true });
			expect(summary.tools.map(tool => tool.name)).toEqual([
				"large_result",
				"search_form",
				"sum_values",
				"throw_page_error",
			]);
			expect(summary.tools.every(tool => tool.inputSchema === undefined)).toBe(true);
			expect(new Set(summary.tools.map(tool => tool.origin))).toEqual(new Set([`http://localhost:${server.port}`]));

			const detail = valueFrom<WebMcpListResult>(
				await invoke(call("webmcp", "webmcpList", [{ name: "sum_values" }])),
			);
			expect(detail.tools).toEqual([
				expect.objectContaining({
					name: "sum_values",
					inputSchema: expect.objectContaining({ type: "object", required: ["left", "right"] }),
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
				["registered", "search_form"],
				["registered", "sum_values"],
				["registered", "throw_page_error"],
			]);
			await invoke({ action: "close", name: "webmcp", kill: true });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	it(
		"leaves the page's globals and modelContext alone, before and after a webmcp helper runs",
		async () => {
			const invoke = createBrowserHost();
			using server = servePage(`<title>untouched</title>`);
			// What the page itself can see of omp: an omp global, a wrapped platform method, a polyfilled context.
			const pageView = `JSON.stringify({
  ompGlobals: Object.getOwnPropertyNames(globalThis).filter(name => name.startsWith("__ompWebMcp")),
  nativeRegisterTool: typeof ModelContext === "undefined"
    ? null
    : /\\[native code\\]/.test(Function.prototype.toString.call(ModelContext.prototype.registerTool)),
  ownModelContext: Object.getOwnPropertyNames(navigator).concat(Object.getOwnPropertyNames(document)).includes("modelContext"),
  modelContext: "modelContext" in navigator || "modelContext" in document,
})`;
			await invoke({ action: "open", name: "webmcp-untouched", url: `http://localhost:${server.port}/` });
			const secure = { ompGlobals: [], nativeRegisterTool: true, ownModelContext: false, modelContext: true };
			expect(JSON.parse(valueFrom<string>(await invoke(call("webmcp-untouched", "evaluate", [pageView]))))).toEqual(
				secure,
			);
			await invoke(call("webmcp-untouched", "webmcpList"));
			expect(JSON.parse(valueFrom<string>(await invoke(call("webmcp-untouched", "evaluate", [pageView]))))).toEqual(
				secure,
			);

			// No secure context, so no platform API, and omp adds none.
			await invoke(call("webmcp-untouched", "goto", ["data:text/html,<title>insecure</title>"]));
			expect(JSON.parse(valueFrom<string>(await invoke(call("webmcp-untouched", "evaluate", [pageView]))))).toEqual({
				ompGlobals: [],
				nativeRegisterTool: null,
				ownModelContext: false,
				modelContext: false,
			});
			await invoke({ action: "close", name: "webmcp-untouched", kill: true });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	it(
		"says why a page gets no WebMCP instead of listing no tools",
		async () => {
			const invoke = createBrowserHost();
			await invoke({ action: "open", name: "webmcp-none", url: "data:text/html,<title>insecure</title>" });
			const listed = valueFrom<WebMcpListResult>(await invoke(call("webmcp-none", "webmcpList")));
			expect(listed).toMatchObject({ status: "unavailable", tools: [], untrusted: true });
			expect(listed.reason).toContain("secure context");
			expect(listed.reason).toContain("origin trial");
			expect(listed.reason).toContain("--enable-features=WebMCP");
			const error = await rejectionOf(invoke(call("webmcp-none", "webmcpInvoke", ["anything", {}])));
			expect(String(error)).toContain("Chrome does not expose WebMCP to this page");
			await invoke({ action: "close", name: "webmcp-none", kill: true });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	it(
		"lists and invokes a tool a cross-origin iframe registers in its own process",
		async () => {
			const invoke = createBrowserHost();
			// 127.0.0.1 and localhost are different sites, so the iframe gets its own renderer and CDP session.
			using child = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: () =>
					new Response(
						`<!doctype html><title>child</title><script>
document.modelContext.registerTool({
  name: "child_tool",
  description: "Answers from the iframe.",
  inputSchema: { type: "object" },
  execute() { return { from: location.origin }; }
});
</script>`,
						{ headers: { "content-type": "text/html" } },
					),
			});
			using parent = servePage(
				`<title>parent</title><iframe allow="tools" src="http://127.0.0.1:${child.port}/" onload="document.title = 'loaded'"></iframe>`,
			);
			await invoke({ action: "open", name: "webmcp-oopif", url: `http://localhost:${parent.port}/` });
			expect(valueFrom<string>(await invoke(call("webmcp-oopif", "evaluate", ["document.title"])))).toBe("loaded");
			const listed = valueFrom<WebMcpListResult>(await invoke(call("webmcp-oopif", "webmcpList")));
			expect(listed.tools).toEqual([
				expect.objectContaining({ name: "child_tool", origin: `http://127.0.0.1:${child.port}` }),
			]);
			const result = valueFrom<WebMcpInvokeResult>(
				await invoke(call("webmcp-oopif", "webmcpInvoke", ["child_tool", {}])),
			);
			expect(result).toEqual({ ok: true, result: { from: `http://127.0.0.1:${child.port}` }, untrusted: true });
			await invoke({ action: "close", name: "webmcp-oopif", kill: true });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	it(
		"keeps a page alive whose same-site iframe is touched before it navigates",
		async () => {
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
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	it(
		"forgets a page's tools once it navigates and finds the next page's",
		async () => {
			using server = Bun.serve({
				port: 0,
				hostname: "localhost",
				fetch: request => {
					const name = new URL(request.url).pathname.slice(1);
					return new Response(
						`<!doctype html><title>${name}</title><script>document.modelContext.registerTool({ name: "${name}_tool", description: "Page tool.", inputSchema: { type: "object" }, execute: () => "${name}" });</script>`,
						{ headers: { "content-type": "text/html" } },
					);
				},
			});
			const handle = headless();
			const page = await handle.browser.newPage();
			try {
				const controller = new WebMcpController(page);
				await page.goto(`http://localhost:${server.port}/first`);
				expect((await controller.list()).tools.map(tool => tool.name)).toEqual(["first_tool"]);
				await page.goto(`http://localhost:${server.port}/second`);
				expect((await controller.list()).tools.map(tool => tool.name)).toEqual(["second_tool"]);
				// Back from the back/forward cache: Chrome announces the restored page's tools again.
				await page.goBack();
				expect((await controller.list()).tools.map(tool => tool.name)).toEqual(["first_tool"]);
				expect((await controller.events()).events.map(event => [event.type, event.name])).toEqual([
					["registered", "first_tool"],
					["registered", "second_tool"],
					["unregistered", "first_tool"],
					["registered", "first_tool"],
					["unregistered", "second_tool"],
				]);
			} finally {
				await page.close();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	it(
		"cancels the page's tool invocation when the call is aborted",
		async () => {
			using server = servePage(`<title>hang</title><script>
document.modelContext.registerTool({ name: "never_answers", description: "Hangs.", inputSchema: { type: "object" }, execute: () => Promise.withResolvers().promise });
</script>`);
			const handle = headless();
			const page = await handle.browser.newPage();
			try {
				await page.goto(`http://localhost:${server.port}/`);
				const observer = await page.createCDPSession();
				const invoked = Promise.withResolvers<void>();
				const responded = Promise.withResolvers<string>();
				observer.on("WebMCP.toolInvoked", () => invoked.resolve());
				observer.on("WebMCP.toolResponded", event => responded.resolve(event.status));
				await observer.send("WebMCP.enable");
				const aborter = new AbortController();
				const call = new WebMcpController(page).invoke("never_answers", {}, {}, aborter.signal);
				await invoked.promise;
				aborter.abort();
				expect(await rejectionOf(call)).toBeInstanceOf(Error);
				expect(await responded.promise).toBe("Canceled");
				await observer.detach();
			} finally {
				await page.close();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	it(
		"never starts the page's tool once the call is aborted",
		async () => {
			using server = servePage(`<title>idle</title><script>
document.modelContext.registerTool({ name: "rename_page", description: "Renames.", inputSchema: { type: "object" }, execute: () => { document.title = "executed"; return 1; } });
</script>`);
			const handle = headless();
			const page = await handle.browser.newPage();
			try {
				await page.goto(`http://localhost:${server.port}/`);
				const controller = new WebMcpController(page);
				expect((await controller.list()).tools.map(tool => tool.name)).toEqual(["rename_page"]);
				const aborted = AbortSignal.abort();
				expect(await rejectionOf(controller.invoke("rename_page", {}, {}, aborted))).toBeInstanceOf(Error);
				expect(await page.title()).toBe("idle");
			} finally {
				await page.close();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	it(
		"lists a same-process iframe's tools, registered before the first call, until the iframe navigates",
		async () => {
			const invoke = createBrowserHost();
			// Same site, other port: the iframe shares the page's renderer and CDP session.
			using child = Bun.serve({
				port: 0,
				hostname: "localhost",
				fetch: request =>
					new Response(
						new URL(request.url).pathname === "/plain"
							? "<!doctype html><title>plain</title>"
							: `<!doctype html><title>child</title><script>
document.modelContext.registerTool({ name: "child_tool", description: "Answers from the iframe.", inputSchema: { type: "object" }, execute: () => ({ from: "child" }) });
</script>`,
						{ headers: { "content-type": "text/html" } },
					),
			});
			using parent = servePage(
				`<title>parent</title><iframe allow="tools" src="http://localhost:${child.port}/" onload="document.title = 'loaded'"></iframe>`,
			);
			await invoke({ action: "open", name: "webmcp-child", url: `http://localhost:${parent.port}/` });
			expect(valueFrom<string>(await invoke(call("webmcp-child", "evaluate", ["document.title"])))).toBe("loaded");
			const listed = valueFrom<WebMcpListResult>(await invoke(call("webmcp-child", "webmcpList")));
			expect(listed.tools).toEqual([
				expect.objectContaining({ name: "child_tool", origin: `http://localhost:${child.port}` }),
			]);
			const result = valueFrom<WebMcpInvokeResult>(
				await invoke(call("webmcp-child", "webmcpInvoke", ["child_tool", {}])),
			);
			expect(result).toEqual({ ok: true, result: { from: "child" }, untrusted: true });
			await invoke(
				call("webmcp-child", "evaluate", [
					`(() => { const { promise, resolve } = Promise.withResolvers(); const frame = document.querySelector("iframe"); frame.onload = resolve; frame.src = "http://localhost:${child.port}/plain"; return promise.then(() => null); })()`,
				]),
			);
			expect(valueFrom<WebMcpListResult>(await invoke(call("webmcp-child", "webmcpList"))).tools).toEqual([]);
			await invoke({ action: "close", name: "webmcp-child", kill: true });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	it(
		"stops following a cross-origin iframe's session once the iframe is gone",
		async () => {
			using child = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: () =>
					new Response("<!doctype html><title>child</title>", { headers: { "content-type": "text/html" } }),
			});
			using parent = servePage(`<title>parent</title><iframe src="http://127.0.0.1:${child.port}/"></iframe>`);
			const handle = headless();
			const page = await handle.browser.newPage();
			try {
				await page.goto(`http://localhost:${parent.port}/`, { waitUntil: "load" });
				const oopif = page.frames().find(frame => frame.client !== page.mainFrame().client);
				if (!oopif) throw new Error("Expected the cross-origin iframe in its own process");
				const session = oopif.client;
				const controller = new WebMcpController(page);
				await controller.list();
				expect(session.listenerCount("WebMCP.toolsAdded")).toBe(1);
				await page.evaluate(`document.querySelector("iframe").remove()`);
				await controller.list();
				expect(session.listenerCount("WebMCP.toolsAdded")).toBe(0);
			} finally {
				await page.close();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	it(
		"blames the Chrome version only when invokeTool itself is missing, not for another error saying something wasn't found",
		async () => {
			using server = servePage(`<title>tool</title><script>
document.modelContext.registerTool({ name: "rename_page", description: "Renames.", inputSchema: { type: "object" }, execute: () => 1 });
</script>`);
			const handle = headless();
			const page = await handle.browser.newPage();
			try {
				await page.goto(`http://localhost:${server.port}/`);
				const session = page.mainFrame().client;
				const send = session.send.bind(session);
				let failure = "";
				// Puppeteer's ProtocolError message: the method, then Chrome's own message.
				session.send = ((method: string, ...rest: unknown[]) => {
					if (method === "WebMCP.invokeTool")
						return Promise.reject(new Error(`Protocol error (${method}): ${failure}`));
					return (send as (method: string, ...rest: unknown[]) => Promise<unknown>)(method, ...rest);
				}) as typeof session.send;
				const controller = new WebMcpController(page);

				failure = "No frame with the given id wasn't found";
				const result = await controller.invoke("rename_page", {});
				expect(result).toMatchObject({ ok: false, untrusted: true });
				if (result.ok) throw new Error("Expected the invocation to fail");
				expect(result.error).toContain("No frame with the given id wasn't found");

				failure = "'WebMCP.invokeTool' wasn't found";
				expect(String(await rejectionOf(controller.invoke("rename_page", {})))).toContain(
					"invoking needs Chrome 149 or newer",
				);
			} finally {
				await page.close();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	it(
		"says the browser has no WebMCP when its DevTools protocol lacks the domain",
		async () => {
			const page = await headless().browser.newPage();
			try {
				// Chrome before 147 answers with the method-not-found error for the whole domain.
				const session = page.mainFrame().client;
				const send = session.send.bind(session);
				session.send = ((method: string, ...rest: unknown[]) => {
					if (method === "WebMCP.enable")
						return Promise.reject(new Error(`Protocol error (${method}): '${method}' wasn't found`));
					return (send as (method: string, ...rest: unknown[]) => Promise<unknown>)(method, ...rest);
				}) as typeof session.send;
				const listed = await new WebMcpController(page).list();
				expect(listed).toMatchObject({ status: "unavailable", tools: [] });
				expect(listed.reason).toContain("lacks the WebMCP domain");
			} finally {
				await page.close();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
