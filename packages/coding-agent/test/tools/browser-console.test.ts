import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { CMUX_CONSOLE_CAPTURE_SCRIPT } from "@oh-my-pi/pi-coding-agent/tools/browser/console-capture";
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
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
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
}

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

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	await fs.rm(root, { recursive: true, force: true });
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

	it("captures JSON objects with non-callable primitive methods without poisoning subsequent reads", async () => {
		const html = `<!doctype html><script>
			console.log("hostile", { toString: "x", valueOf: "y" });
		</script>`;
		await invoke({ action: "open", name: "console-hostile", url: `data:text/html,${encodeURIComponent(html)}` });
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
			await invoke({ action: "close", name: "console-hostile" });
		}
	}, 30_000);

	it("keeps the cmux page hook from throwing on JSON objects with non-callable primitive methods", async () => {
		await invoke({ action: "open", name: "console-cmux-hook", url: "data:text/html,<title>cmux hook</title>" });
		try {
			const result = await call("evaluate", [
				`(() => {
					${CMUX_CONSOLE_CAPTURE_SCRIPT};
					console.log("hostile", { toString: "x", valueOf: "y" });
					return globalThis.__ompConsoleCapture.entries;
				})()`,
			]);
			expect(result).toEqual([
				expect.objectContaining({
					type: "console",
					text: 'hostile {"toString":"x","valueOf":"y"}',
					args: ["hostile", { toString: "x", valueOf: "y" }],
				}),
			]);
		} finally {
			await invoke({ action: "close", name: "console-cmux-hook" });
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
