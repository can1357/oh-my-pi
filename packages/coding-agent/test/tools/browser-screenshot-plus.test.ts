import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ScreenshotResult } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

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
			"tools.maxTimeout": 0,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown) =>
		prelude.invoke(parameters, { session, toolCallId: `browser-screenshot-plus-${crypto.randomUUID()}` });
}

function valueFrom<T>(result: { details?: unknown }): T {
	if (!result.details || typeof result.details !== "object" || !("value" in result.details)) {
		throw new Error("Browser result did not include a value");
	}
	return result.details.value as T;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser screenshot parity", () => {
	test("annotates observed ids, detects pixel changes, writes JPEG screenshots, and prints PDF", async () => {
		const invoke = createHost();
		const name = `screenshot-plus-${crypto.randomUUID()}`;
		const html = `<!doctype html><html><head><style>
body { margin: 0; width: 800px; height: 600px; background: white; }
button { margin: 80px; width: 180px; height: 60px; }
#change { position: absolute; left: 350px; top: 250px; width: 200px; height: 160px; background: #1473e6; }
</style></head><body>
<button onclick="document.title='clicked'">Submit</button><div id="change"></div>
</body></html>`;
		await invoke({
			action: "open",
			name,
			url: `data:text/html,${encodeURIComponent(html)}`,
			viewport: { width: 800, height: 600 },
		});
		try {
			const observed = valueFrom<{ elements: Array<{ id: number; role: string; name?: string }> }>(
				await invoke({ action: "call", name, chain: [{ method: "observe", args: [] }] }),
			);
			const button = observed.elements.find(element => element.role === "button" && element.name === "Submit");
			expect(button).toBeDefined();

			// Regression: puppeteer returns a Uint8Array; encoding it with
			// `toString("base64")` produced decimal text that decoded to garbage
			// (0x0 dimensions, "image decoder failed", corrupt file on disk).
			const plain = await invoke({ action: "call", name, chain: [{ method: "screenshot", args: [] }] });
			const plainText = plain.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(plainText).not.toContain("image decoder failed");
			expect(plainText).toMatch(/Dimensions: [1-9]\d*x[1-9]\d*/);
			const plainShots =
				plain.details && typeof plain.details === "object" && "screenshots" in plain.details
					? plain.details.screenshots
					: undefined;
			// The prelude reports the worker's ScreenshotResult[] verbatim under details.screenshots.
			const plainInfo = Array.isArray(plainShots) ? (plainShots as ScreenshotResult[])[0] : undefined;
			if (!plainInfo) throw new Error("Expected one screenshot result");
			expect(plainInfo.width).toBeGreaterThan(0);
			const plainMeta = await new Bun.Image(await fs.readFile(plainInfo.dest)).metadata();
			expect(plainMeta.width).toBe(plainInfo.width);

			const annotated = await invoke({
				action: "call",
				name,
				chain: [{ method: "screenshot", args: [{ annotate: true }] }],
			});
			const legendText = annotated.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(legendText).toContain(`[${button?.id}] button "Submit"`);
			await invoke({
				action: "call",
				name,
				chain: [
					{ method: "id", args: [button?.id] },
					{ method: "click", args: [] },
				],
			});
			expect(valueFrom<string>(await invoke({ action: "call", name, chain: [{ method: "title", args: [] }] }))).toBe(
				"clicked",
			);

			type ChangeResult = { path?: string; changed: boolean; revision: number; pixelChangeRatio: number };
			const first = valueFrom<ChangeResult>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ ifChanged: true, silent: true }] }],
				}),
			);
			const staticCapture = valueFrom<ChangeResult>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ ifChanged: true, silent: true }] }],
				}),
			);
			expect(first).toMatchObject({ changed: true, revision: 1 });
			expect(staticCapture).toEqual({ changed: false, revision: 1, pixelChangeRatio: 0 });
			const baselinePath = valueFrom<string>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ format: "png", silent: true }] }],
				}),
			);

			await invoke({
				action: "call",
				name,
				chain: [{ method: "evaluate", args: ["document.querySelector('#change').style.background = '#e62929'"] }],
			});
			const changed = valueFrom<ChangeResult>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ ifChanged: true, silent: true }] }],
				}),
			);
			expect(changed.changed).toBe(true);
			expect(changed.revision).toBe(2);
			expect(changed.pixelChangeRatio).toBeGreaterThan(0);
			const diff = valueFrom<{ pixelChangeRatio: number; changed: boolean; diffPath: string }>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "diffScreenshot", args: [baselinePath] }],
				}),
			);
			expect(diff.changed).toBe(true);
			expect(diff.pixelChangeRatio).toBeGreaterThan(0);
			expect((await fs.readFile(diff.diffPath)).subarray(0, 8)).toEqual(
				Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			);

			await invoke({
				action: "call",
				name,
				chain: [
					{
						method: "evaluate",
						args: [
							"document.body.insertAdjacentHTML('beforeend', '<i style=position:absolute;left:1px;top:1px>!</i>')",
						],
					},
				],
			});
			const suppressed = valueFrom<ChangeResult>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ threshold: 0.1, silent: true }] }],
				}),
			);
			expect(suppressed.changed).toBe(false);
			expect(suppressed.pixelChangeRatio).toBeGreaterThan(0);
			expect(suppressed.pixelChangeRatio).toBeLessThan(0.1);

			const jpegPath = valueFrom<string>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "screenshot", args: [{ format: "jpeg", quality: 75, silent: true }] }],
				}),
			);
			expect(jpegPath.endsWith(".jpg")).toBe(true);
			const jpeg = await fs.readFile(jpegPath);
			expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);

			const pdfPath = valueFrom<string>(
				await invoke({
					action: "call",
					name,
					chain: [{ method: "pdf", args: [{ printBackground: true }] }],
				}),
			);
			const pdf = await fs.readFile(pdfPath);
			expect(pdf.byteLength).toBeGreaterThan(100);
			expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
		} finally {
			await invoke({ action: "close", name, kill: true }).catch(() => undefined);
		}
	}, 30_000);
});
