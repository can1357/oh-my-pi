import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createHost(cwd: string, screenshotDir: string) {
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
			"browser.screenshotDir": screenshotDir,
			"tools.maxTimeout": 0,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown) =>
		prelude.invoke(parameters, { session, toolCallId: `browser-screenshot-path-${crypto.randomUUID()}` });
}

/** The destination path a browser call returned, rejecting a non-string value. */
function pathFrom(result: { details?: unknown }): string {
	if (!result.details || typeof result.details !== "object" || !("value" in result.details)) {
		throw new Error("Browser result did not include a value");
	}
	const { value } = result.details as { value: unknown };
	if (typeof value !== "string") throw new Error(`Expected a destination path, got ${JSON.stringify(value)}`);
	return value;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser screenshot path", () => {
	test("writes the capture to the requested path instead of the screenshot directory", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shot-path-cwd-"));
		const screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shot-path-dir-"));
		const invoke = createHost(cwd, screenshotDir);
		const name = `screenshot-path-${crypto.randomUUID()}`;
		const html = `<!doctype html><html><body style="margin:0;width:640px;height:480px;background:#1473e6"></body></html>`;
		await invoke({
			action: "open",
			name,
			url: `data:text/html,${encodeURIComponent(html)}`,
			viewport: { width: 640, height: 480 },
		});
		try {
			// A cwd-relative destination lands under the session cwd, parents included.
			const relative = pathFrom(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ path: "shots/relative.png", silent: true }] }],
				}),
			);
			expect(relative).toBe(path.join(cwd, "shots", "relative.png"));
			expect((await fs.readFile(relative)).subarray(0, 8)).toEqual(PNG_MAGIC);
			expect(await fs.readdir(screenshotDir)).toEqual([]);

			// An absolute destination wins over the configured screenshot directory.
			const absolute = pathFrom(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ path: path.join(cwd, "abs", "shot.jpg"), format: "jpeg" }] }],
				}),
			);
			expect(absolute).toBe(path.join(cwd, "abs", "shot.jpg"));
			expect([...(await fs.readFile(absolute)).subarray(0, 2)]).toEqual([0xff, 0xd8]);
			expect(await fs.readdir(screenshotDir)).toEqual([]);

			// Without `path` the screenshot directory is still the destination.
			const fallback = pathFrom(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ silent: true }] }],
				}),
			);
			expect(path.dirname(fallback)).toBe(screenshotDir);
			expect((await fs.readFile(fallback)).subarray(0, 8)).toEqual(PNG_MAGIC);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
			await fs.rm(screenshotDir, { recursive: true, force: true });
		}
	}, 60_000);
});
