import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ScreenshotResult } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function createHost(model?: Model) {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModel: () => model,
		settings: Settings.isolated({
			// Managed Chromium, whether or not omp's WebKit engine is installed on this machine.
			"browser.webkit": false,
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
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
			expect(plainText.split("\n")[0]).toMatch(/^Screenshot [1-9]\d*x[1-9]\d*\./);
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

	/** A page whose 40px button at (`left`, `top`) titles the document "hit"; a click anywhere else titles it "miss x,y". */
	function targetPage(left: number, top: number): string {
		const html = `<!doctype html><html><head><style>
body { margin: 0; }
#target { position: absolute; left: ${left}px; top: ${top}px; width: 40px; height: 40px; }
</style></head><body>
<button id="target" onclick="event.stopPropagation(); document.title = 'hit'">Go</button>
<script>document.addEventListener("click", event => { document.title = "miss " + event.clientX + "," + event.clientY; });</script>
</body></html>`;
		return `data:text/html,${encodeURIComponent(html)}`;
	}

	/** Size of the image the model was shown for a screenshot call. */
	function shownSize(shot: { details?: unknown }): [number, number] {
		const shots =
			shot.details && typeof shot.details === "object" && "screenshots" in shot.details
				? (shot.details.screenshots as ScreenshotResult[])
				: [];
		return [shots[0]?.width ?? 0, shots[0]?.height ?? 0];
	}

	/** Run `body` with opens going to headless Chromium: backend overrides would send them to a relay or cmux surface. */
	async function withoutBackendOverrides(body: () => Promise<void>): Promise<void> {
		const savedEnv = { ...process.env };
		for (const key of ["PI_BROWSER_RELAY", "PI_BROWSER_CMUX", "PI_BROWSER_TERN"]) delete process.env[key];
		try {
			await body();
		} finally {
			Object.assign(process.env, savedEnv);
		}
	}

	// Scale 0 keeps the browser's own device scale (1 in headless Chromium).
	test.each([1.25, 2, 0])(
		"a screenshot at device scale %p is in CSS pixels, so a position read off it clicks there",
		async scale => {
			await withoutBackendOverrides(async () => {
				const invoke = createHost();
				const name = `screenshot-click-${crypto.randomUUID()}`;
				try {
					await invoke({
						action: "open",
						name,
						url: targetPage(700, 500),
						viewport: { width: 1200, height: 700, scale },
					});
					const shot = await invoke({ action: "call", name, chain: [{ method: "screenshot", args: [] }] });
					expect(shownSize(shot)).toEqual([1200, 700]);
					// The button's centre on the image is its centre on the page.
					await invoke({ action: "call", name, chain: [{ method: "clickAt", args: [720, 520] }] });
					expect(
						valueFrom<string>(await invoke({ action: "call", name, chain: [{ method: "title", args: [] }] })),
					).toBe("hit");
				} finally {
					await invoke({ action: "close", name, kill: true }).catch(() => undefined);
				}
			});
		},
		30_000,
	);

	test("sizes a viewport screenshot for the session's model, so the model's own resize never moves it", async () => {
		// Claude's standard tier takes at most 1,568 patches of 28px: the API would shrink a 1440x900 image to
		// 1389x868 after the tool had reported it, moving every position read off it by 3.5%.
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-6");
		await withoutBackendOverrides(async () => {
			const invoke = createHost(model);
			const name = `screenshot-model-${crypto.randomUUID()}`;
			try {
				await invoke({
					action: "open",
					name,
					url: targetPage(1380, 840),
					viewport: { width: 1440, height: 900, scale: 1 },
				});
				const shot = await invoke({ action: "call", name, chain: [{ method: "screenshot", args: [] }] });
				expect(shownSize(shot)).toEqual([1389, 868]);
				// The button's centre (1400, 860 CSS px) as it appears on that image.
				const onImage = [Math.round((1400 * 1389) / 1440), Math.round((860 * 868) / 900)];
				await invoke({ action: "call", name, chain: [{ method: "clickAt", args: onImage }] });
				expect(
					valueFrom<string>(await invoke({ action: "call", name, chain: [{ method: "title", args: [] }] })),
				).toBe("hit");
			} finally {
				await invoke({ action: "close", name, kill: true }).catch(() => undefined);
			}
		});
	}, 30_000);

	test("a viewport past the size cap arrives scaled, and positions on that image still click there", async () => {
		await withoutBackendOverrides(async () => {
			const invoke = createHost();
			const name = `screenshot-click-${crypto.randomUUID()}`;
			const title = async () =>
				valueFrom<string>(await invoke({ action: "call", name, chain: [{ method: "title", args: [] }] }));
			try {
				await invoke({
					action: "open",
					name,
					url: targetPage(1400, 900),
					viewport: { width: 2000, height: 1200, scale: 1 },
				});
				const shot = await invoke({ action: "call", name, chain: [{ method: "screenshot", args: [] }] });
				expect(shownSize(shot)).toEqual([1568, 941]);
				const text = shot.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("\n");
				expect(text).toContain("2000x1200 viewport");

				// The button's centre (1420, 920 CSS px) as it appears on the image.
				const onImage = [Math.round((1420 * 1568) / 2000), Math.round((920 * 941) / 1200)];
				await invoke({ action: "call", name, chain: [{ method: "clickAt", args: onImage }] });
				expect(await title()).toBe("hit");

				// The same position measured on the page says so.
				await invoke({ action: "call", name, chain: [{ method: "evaluate", args: ["document.title = ''"] }] });
				await invoke({ action: "call", name, chain: [{ method: "clickAt", args: [1420, 920, { css: true }] }] });
				expect(await title()).toBe("hit");

				// A resized viewport is not the one pictured: image positions fail instead of landing elsewhere.
				await invoke({
					action: "call",
					name,
					chain: [{ method: "emulate", args: [{ viewport: { width: 1000, height: 600 } }] }],
				});
				const stale = await invoke({ action: "call", name, chain: [{ method: "clickAt", args: onImage }] }).then(
					() => undefined,
					(error: unknown) => error,
				);
				if (!(stale instanceof Error)) throw new Error("clickAt took an image position on a resized viewport");
				expect(stale.message).toContain("new screenshot");
			} finally {
				await invoke({ action: "close", name, kill: true }).catch(() => undefined);
			}
		});
	}, 30_000);
});
