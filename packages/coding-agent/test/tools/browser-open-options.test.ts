import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { applyIgnoreHttpsErrors, resolveInitScriptSources } from "@oh-my-pi/pi-coding-agent/tools/browser/open-options";
import { buildHeadlessLaunchArgs } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { getTab, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import type { Page } from "puppeteer-core";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const tempDirs: string[] = [];

function browserHost(cwd: string = process.cwd()) {
	const session: ToolSession = {
		cwd,
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
	return (parameters: unknown, signal?: AbortSignal) =>
		prelude.invoke(parameters, { session, toolCallId: `browser-open-options-${crypto.randomUUID()}`, signal });
}

function returnedValue(result: { details?: unknown }): unknown {
	return result.details && typeof result.details === "object" ? Reflect.get(result.details, "value") : undefined;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("browser open options CDP helpers", () => {
	it("sends the invalid-certificate override through CDP", async () => {
		const args = buildHeadlessLaunchArgs(
			{ width: 800, height: 600 },
			{ ignoreHttpsErrors: true, allowFileAccess: true },
		);
		expect(args).toContain("--hide-scrollbars");
		expect(args).toContain("--enable-features=WebMCPTesting,DevToolsWebMCPSupport");
		expect(args).toContain("--ignore-certificate-errors");
		expect(args).toContain("--allow-file-access-from-files");
		const calls: Array<{ method: string; params: unknown }> = [];
		let detached = false;
		const page = {
			createCDPSession: async () => ({
				send: async (method: string, params: unknown) => {
					calls.push({ method, params });
				},
				detach: async () => {
					detached = true;
				},
			}),
		} as unknown as Page;

		await applyIgnoreHttpsErrors(page);

		expect(calls).toEqual([{ method: "Security.setIgnoreCertificateErrors", params: { ignore: true } }]);
		expect(detached).toBe(true);
	});

	it("omits per-open launch switches unless requested", () => {
		const args = buildHeadlessLaunchArgs({ width: 800, height: 600 });
		expect(args).not.toContain("--allow-file-access-from-files");
		if (!process.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS) {
			expect(args).not.toContain("--ignore-certificate-errors");
		}
	});

	it("loads existing init-script files and preserves inline source", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-init-test-"));
		tempDirs.push(directory);
		await Bun.write(path.join(directory, "init.js"), "globalThis.fromFile = true;");
		expect(await resolveInitScriptSources(["init.js", "globalThis.inline = true;"], directory)).toEqual([
			"globalThis.fromFile = true;",
			"globalThis.inline = true;",
		]);
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser open options", () => {
	it("applies open and runtime init scripts across navigations", async () => {
		const invoke = browserHost();
		const name = `init-${crypto.randomUUID()}`;
		await invoke({
			action: "open",
			name,
			url: "data:text/html,<title>first</title>",
			init_scripts: ["globalThis.__omp_init = (globalThis.__omp_init || 0) + 1"],
		});
		expect(
			returnedValue(
				await invoke({
					action: "run",
					name,
					code: "return await tab.evaluate(() => globalThis.__omp_init);",
				}),
			),
		).toBe(1);
		expect(
			returnedValue(
				await invoke({
					action: "run",
					name,
					code: "await tab.goto('data:text/html,<title>second</title>'); return await tab.evaluate(() => globalThis.__omp_init);",
				}),
			),
		).toBe(1);
		const added = returnedValue(
			await invoke({
				action: "call",
				name,
				chain: [{ method: "addInitScript", args: ["globalThis.__omp_runtime = 42"] }],
			}),
		) as { id: string };
		expect(typeof added.id).toBe("string");
		expect(
			returnedValue(
				await invoke({
					action: "run",
					name,
					code: "await tab.goto('data:text/html,<title>third</title>'); return await tab.evaluate(() => globalThis.__omp_runtime);",
				}),
			),
		).toBe(42);
		expect(
			returnedValue(await invoke({ action: "call", name, chain: [{ method: "initScripts", args: [] }] })),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: added.id, source: expect.stringContaining("__omp_runtime") }),
			]),
		);
		await invoke({
			action: "call",
			name,
			chain: [{ method: "removeInitScript", args: [added.id] }],
		});
		expect(
			returnedValue(
				await invoke({
					action: "run",
					name,
					code: "await tab.goto('data:text/html,<title>fourth</title>'); return await tab.evaluate(() => globalThis.__omp_runtime);",
				}),
			),
		).toBeUndefined();
	});

	it("overrides navigator and request user agents", async () => {
		const seen = Promise.withResolvers<string>();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				seen.resolve(request.headers.get("user-agent") ?? "");
				return new Response("<title>ua</title>", { headers: { "content-type": "text/html" } });
			},
		});
		try {
			const invoke = browserHost();
			const name = `ua-${crypto.randomUUID()}`;
			await invoke({ action: "open", name, url: server.url.href, user_agent: "omp-open-options/1.0" });
			expect(
				returnedValue(
					await invoke({
						action: "run",
						name,
						code: "return await tab.evaluate(() => navigator.userAgent);",
					}),
				),
			).toBe("omp-open-options/1.0");
			expect(await seen.promise).toBe("omp-open-options/1.0");
		} finally {
			server.stop(true);
		}
	});

	it("keeps the tab on what loaded when the page outlasts the open timeout", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				// The image never answers, so the page never fires `load`.
				if (new URL(request.url).pathname === "/hang.png") return new Promise<Response>(() => {});
				return new Response('<title>slow</title><p>partial</p><img src="/hang.png">', {
					headers: { "content-type": "text/html" },
				});
			},
		});
		try {
			const invoke = browserHost();
			const name = `slow-${crypto.randomUUID()}`;
			const open = () => rejectionOf(invoke({ action: "open", name, url: server.url.href, timeout: 3 }));
			const keptTab = { message: expect.stringContaining(`browser.tab(${JSON.stringify(name)})`) };
			// The first open creates the tab; the second reuses the one it kept.
			expect(await open()).toMatchObject(keptTab);
			expect(await open()).toMatchObject(keptTab);
			expect(
				returnedValue(
					await invoke({
						action: "run",
						name,
						code: "return { url: tab.url(), text: await tab.evaluate(() => document.body.innerText) };",
					}),
				),
			).toEqual({ url: server.url.href, text: "partial" });
		} finally {
			server.stop(true);
		}
	}, 20_000);

	it("closes the tab its open created when the navigation fails outright, but keeps a reused one", async () => {
		const refused = Bun.serve({ port: 0, fetch: () => new Response("") });
		const url = refused.url.href;
		refused.stop(true);
		const invoke = browserHost();
		const tabNames = async () =>
			(returnedValue(await invoke({ action: "tabs" })) as Array<{ name: string }>).map(tab => tab.name);
		const name = `refused-${crypto.randomUUID()}`;
		const keptNote = `browser.tab(${JSON.stringify(name)})`;

		const fresh = await rejectionOf(invoke({ action: "open", name, url }));
		expect(fresh).toMatchObject({ message: expect.stringContaining("net::ERR_CONNECTION_REFUSED") });
		expect(fresh).not.toMatchObject({ message: expect.stringContaining(keptNote) });
		expect(getTab(name)).toBeUndefined();
		expect(await tabNames()).not.toContain(name);

		await invoke({ action: "open", name, url: "data:text/html,<title>kept</title>" });
		expect(await rejectionOf(invoke({ action: "open", name, url }))).toMatchObject({
			message: expect.stringContaining(keptNote),
		});
		expect(getTab(name)?.state).toBe("alive");
		expect(await tabNames()).toContain(name);
	});

	it("closes the tab its open created when the open is cancelled during navigation", async () => {
		const requested = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<void>();
		const server = Bun.serve({
			port: 0,
			async fetch() {
				requested.resolve();
				// Held until after the cancel, so the navigation is still pending then.
				await answer.promise;
				return new Response("<title>late</title>", { headers: { "content-type": "text/html" } });
			},
		});
		try {
			const invoke = browserHost();
			const name = `cancelled-${crypto.randomUUID()}`;
			const controller = new AbortController();
			const open = rejectionOf(invoke({ action: "open", name, url: server.url.href }, controller.signal));
			await requested.promise;
			const cancelled = getTab(name);
			expect(cancelled?.state).toBe("alive");
			controller.abort();
			expect(await open).toBeInstanceOf(ToolAbortError);
			// A cancelled run may only unwind once the pending document answers.
			answer.resolve();
			// Opens of one name run in order, so this one starts after the
			// cancelled open finished unwinding, and finds no tab to reuse.
			const reopened = await invoke({ action: "open", name });
			expect(reopened.content).toEqual([expect.objectContaining({ text: expect.stringMatching(/^Opened tab /) })]);
			expect(getTab(name)).not.toBe(cancelled);
		} finally {
			server.stop(true);
		}
	}, 20_000);

	it("reports where a download was saved when another tab set a different downloads directory", async () => {
		const payload = new TextEncoder().encode("download payload\n");
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/file") {
					return new Response(payload, {
						headers: {
							"content-type": "application/octet-stream",
							"content-disposition": 'attachment; filename="fixture.bin"',
						},
					});
				}
				return new Response('<a id="download" href="/file">download</a>', {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const first = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-download-test-"));
		const second = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-download-test-"));
		tempDirs.push(first, second);
		try {
			const invoke = browserHost();
			const name = `download-${crypto.randomUUID()}`;
			await invoke({ action: "open", name, url: server.url.href, downloads: first });
			await invoke({
				action: "open",
				name: `download-${crypto.randomUUID()}`,
				url: server.url.href,
				downloads: second,
			});
			const download = returnedValue(
				await invoke({
					action: "run",
					name,
					code: [
						"const pending = tab.waitForDownload({ timeout: 5000 });",
						"await tab.evaluate(() => document.querySelector('#download').click());",
						"return await pending;",
					].join("\n"),
				}),
			) as { path: string };
			expect(new Uint8Array(await Bun.file(download.path).arrayBuffer())).toEqual(payload);
		} finally {
			server.stop(true);
		}
	});

	it("waits for a completed download and records its bytes", async () => {
		const payload = new TextEncoder().encode("download payload\n");
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/file") {
					return new Response(payload, {
						headers: {
							"content-type": "application/octet-stream",
							"content-disposition": 'attachment; filename="fixture.bin"',
						},
					});
				}
				return new Response('<a id="download" href="/file">download</a>', {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-download-test-"));
		tempDirs.push(directory);
		try {
			const invoke = browserHost();
			const name = `download-${crypto.randomUUID()}`;
			await invoke({ action: "open", name, url: server.url.href, downloads: directory });
			const download = returnedValue(
				await invoke({
					action: "run",
					name,
					code: [
						"const pending = tab.waitForDownload({ timeout: 5000 });",
						"await tab.evaluate(() => document.querySelector('#download').click());",
						"return await pending;",
					].join("\n"),
				}),
			) as { path: string; suggestedFilename: string; url: string; bytes: number };
			expect(download.path).toBe(path.join(directory, "fixture.bin"));
			expect(download.suggestedFilename).toBe("fixture.bin");
			expect(download.url).toBe(`${server.url.href}file`);
			expect(download.bytes).toBe(payload.byteLength);
			expect(new Uint8Array(await Bun.file(download.path).arrayBuffer())).toEqual(payload);
			expect(
				returnedValue(await invoke({ action: "call", name, chain: [{ method: "downloads", args: [] }] })),
			).toEqual([download]);
		} finally {
			server.stop(true);
		}
	});

	it("tracks a download started right after waitForDownload on a tab opened without a downloads directory", async () => {
		const payload = new TextEncoder().encode("download payload\n");
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/file") {
					return new Response(payload, {
						headers: {
							"content-type": "application/octet-stream",
							"content-disposition": 'attachment; filename="fixture.bin"',
						},
					});
				}
				return new Response('<a id="download" href="/file">download</a>', {
					headers: { "content-type": "text/html" },
				});
			},
		});
		try {
			const invoke = browserHost();
			const name = `download-${crypto.randomUUID()}`;
			await invoke({ action: "open", name, url: server.url.href });
			const download = returnedValue(
				await invoke({
					action: "run",
					name,
					code: [
						"const pending = tab.waitForDownload({ timeout: 3000 });",
						"await tab.evaluate(() => document.querySelector('#download').click());",
						"return await pending;",
					].join("\n"),
				}),
			) as { path: string; bytes: number };
			tempDirs.push(path.dirname(download.path));
			expect(path.dirname(download.path)).toStartWith(path.join(os.tmpdir(), "omp-downloads-"));
			expect(download.bytes).toBe(payload.byteLength);
			expect(new Uint8Array(await Bun.file(download.path).arrayBuffer())).toEqual(payload);
		} finally {
			server.stop(true);
		}
	});
});
