/**
 * First browser use may download Chrome for Testing (~180 MB). That install
 * is not part of the open, so it must not be charged against the requested
 * `timeout`: with a 30s default it timed out on ordinary connections and left
 * agents believing the tool was broken. The caller's abort signal still cuts
 * the wait short.
 *
 * Installation delay is controlled; the Eval regression drives real Chromium.
 */

import { afterAll, afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import * as launch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError, ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const DOWNLOAD_FAILED = "sentinel: Chromium install finished after the open timeout";

function createBrowserHost() {
	const session: ToolSession = {
		cwd: "/tmp",
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
	return (parameters: unknown, signal?: AbortSignal) =>
		prelude.invoke(parameters, { session, toolCallId: "browser-open-download-test", signal });
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe("browser open during first-use Chromium download", () => {
	// Both the isolated Eval worker and the browser host use real deadlines;
	// fake timers cannot advance the worker's clock. Delay only the install,
	// then drive a real page through Eval to catch an outer watchdog reset.
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps the Eval kernel alive through installation and then drives a page with default browser options",
		async () => {
			const executable = await launch.ensureChromiumExecutable();
			const session: ToolSession = {
				cwd: process.cwd(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				settings: Settings.isolated({ "async.enabled": false, "browser.cmux": false }),
				getEvalSessionId: () => "browser-download-regression",
				getEvalPreludes: () => [prelude],
			};
			const prelude = createBrowserPrelude(session);
			const tool = new EvalTool(session);
			await tool.execute("browser-warm-eval", { language: "js", code: "var marker = 'kernel survived';" });
			const entered = Promise.withResolvers<void>();
			const download = Promise.withResolvers<string | undefined>();
			spyOn(launch, "ensureChromiumExecutable").mockImplementation(() => {
				entered.resolve();
				return download.promise;
			});
			const resultPromise = tool.execute("browser-download-eval", {
				language: "js",
				timeout: 1,
				code: `var tab = await browser.open();
await tab.goto('data:text/html,<button onclick="document.title=123">Run</button>');
await tab.click("button");
print(marker, await tab.title());
await tab.close();`,
			});
			await Promise.race([
				entered.promise,
				resultPromise.then(result => {
					throw new Error(`Eval finished before browser installation: ${JSON.stringify(result)}`);
				}),
			]);
			await Bun.sleep(1_100);
			download.resolve(executable);
			const result = await resultPromise;
			expect(result.details?.cells?.[0]?.status).toBe("complete");
			expect(result.content.some(block => block.type === "text" && block.text.includes("kernel survived 123"))).toBe(
				true,
			);
		},
		20_000,
	);

	it("still lets the caller abort while the download is pending", async () => {
		const download = Promise.withResolvers<string>();
		const entered = Promise.withResolvers<void>();
		spyOn(launch, "ensureChromiumExecutable").mockImplementation(() => {
			entered.resolve();
			return download.promise;
		});
		const invoke = createBrowserHost();
		const controller = new AbortController();
		const opening = invoke({ action: "open", name: "download", url: "about:blank", timeout: 30 }, controller.signal);
		await entered.promise;
		controller.abort();
		await expect(opening).rejects.toBeInstanceOf(ToolAbortError);
		download.reject(new ToolError(DOWNLOAD_FAILED));
	});
});
