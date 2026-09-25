import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { applyIgnoreHttpsErrors, resolveInitScriptSources } from "@oh-my-pi/pi-coding-agent/tools/browser/open-options";
import { buildHeadlessLaunchArgs } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import type { Page } from "puppeteer-core";
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
			"tools.maxTimeout": 0,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown) =>
		prelude.invoke(parameters, { session, toolCallId: `browser-open-options-${crypto.randomUUID()}` });
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
});
