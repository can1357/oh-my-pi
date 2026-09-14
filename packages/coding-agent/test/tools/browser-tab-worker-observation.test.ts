import { describe, expect, it, vi } from "bun:test";
import type { ElementHandle, Page } from "puppeteer-core";
import { captureAriaSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/aria/aria-snapshot";
import { ensureChromiumExecutable, loadPuppeteer } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	collectBiDiObservationEntries,
	createRunPageScope,
	parseAriaSnapshotLines,
	resolvePageViewport,
	type WorkerCore,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function fakeActionableHandle(
	options: {
		tagName?: string;
		type?: string | null;
		checked?: boolean;
		ariaChecked?: string | null;
	} = {},
): ElementHandle {
	const element = {
		disabled: false,
		required: false,
		readOnly: false,
		multiple: false,
		tagName: options.tagName ?? "BUTTON",
		checked: options.checked,
		ownerDocument: { getElementById: () => null },
		getAttribute: (name: string) => {
			if (name === "type") return options.type ?? null;
			if (name === "aria-checked") return options.ariaChecked ?? null;
			return null;
		},
		matches: () => false,
	};
	return {
		isIntersectingViewport: async () => true,
		evaluate: async (fn: (value: typeof element) => unknown) => fn(element),
		dispose: async () => {},
	} as unknown as ElementHandle;
}

function observationHarness(
	viewport: { width: number; height: number },
	handle: ElementHandle = fakeActionableHandle(),
) {
	const cached = new Map<number, ElementHandle>();
	let nextId = 0;
	const core = {
		nextElementId: () => ++nextId,
		cacheElement: (id: number, value: ElementHandle) => cached.set(id, value),
	} as unknown as WorkerCore;
	const page = {
		evaluate: async () => viewport,
		evaluateHandle: async () => ({ asElement: () => handle }),
	} as unknown as Page;
	return { core, page, cached };
}

describe("attached Firefox viewport metadata", () => {
	it("uses the live layout viewport when Puppeteer has no emulated viewport", async () => {
		const page = {
			viewport: () => null,
			evaluate: async () => ({ width: 1440, height: 812 }),
		} as unknown as Page;

		expect(await resolvePageViewport(page)).toEqual({ width: 1440, height: 812 });
	});
});

describe("Firefox BiDi viewport observation", () => {
	it("keeps visible reference-less content using serialized viewport-relative boxes", async () => {
		const { core, page } = observationHarness({ width: 800, height: 600 });
		const snapshot = [
			'- heading "Visible heading" [level=2] [box=10,20,200,40]',
			'- paragraph "Partially visible" [box=790,100,40,20]',
			'- paragraph "Parent" [box=20,200,300,80]',
			'  - text: "Visible child text"',
			'- paragraph "Geometry-less sibling"',
			'  - text: "Must not borrow the previous sibling box"',
		].join("\n");

		const entries = await collectBiDiObservationEntries(core, page, snapshot, {
			includeAll: true,
			viewportOnly: true,
			refOwner: "test-owner",
		});

		expect(
			entries.map((entry: { role: string; name?: string; actionable?: boolean }) => [
				entry.role,
				entry.name,
				entry.actionable,
			]),
		).toEqual([
			["heading", "Visible heading", false],
			["paragraph", "Partially visible", false],
			["paragraph", "Parent", false],
			["text", "Visible child text", false],
		]);
	});

	it("drops offscreen, zero-area, and geometry-less reference-less content", async () => {
		const { core, page } = observationHarness({ width: 800, height: 600 });
		const snapshot = [
			'- heading "Below viewport" [box=10,600,200,40]',
			'- paragraph "Left of viewport" [box=-100,10,100,20]',
			'- paragraph "Zero width" [box=10,10,0,20]',
			'- paragraph "Zero height" [box=10,10,20,0]',
			'- text: "No geometric ancestor"',
		].join("\n");

		const entries = await collectBiDiObservationEntries(core, page, snapshot, {
			includeAll: true,
			viewportOnly: true,
			refOwner: "test-owner",
		});

		expect(entries).toEqual([]);
	});

	it("retains a visible ref-based actionable node with its real ref resolution path", async () => {
		const { core, page, cached } = observationHarness({ width: 800, height: 600 });
		const entries = await collectBiDiObservationEntries(core, page, '- button "Submit" [ref=e7] [box=20,20,100,30]', {
			includeAll: true,
			viewportOnly: true,
			refOwner: "test-owner",
		});

		expect(entries).toEqual([{ id: 1, role: "button", name: "Submit", states: [] }]);
		expect(cached.has(1)).toBe(true);
	});

	it("does not synthesize checked=false for an ordinary textbox", async () => {
		const handle = fakeActionableHandle({ tagName: "INPUT", type: "text", checked: false });
		const { core, page } = observationHarness({ width: 800, height: 600 }, handle);

		const entries = await collectBiDiObservationEntries(core, page, '- textbox "Name" [ref=e1]', {
			includeAll: true,
			viewportOnly: false,
			refOwner: "test-owner",
		});

		expect(entries[0]?.states).toEqual([]);
	});

	it("retains native checkbox and radio checked states", async () => {
		const checkbox = observationHarness(
			{ width: 800, height: 600 },
			fakeActionableHandle({ tagName: "INPUT", type: "checkbox", checked: false }),
		);
		const radio = observationHarness(
			{ width: 800, height: 600 },
			fakeActionableHandle({ tagName: "INPUT", type: "radio", checked: true }),
		);

		const checkboxEntries = await collectBiDiObservationEntries(
			checkbox.core,
			checkbox.page,
			'- checkbox "Email updates" [ref=e1]',
			{ includeAll: true, viewportOnly: false, refOwner: "test-owner" },
		);
		const radioEntries = await collectBiDiObservationEntries(radio.core, radio.page, '- radio "Daily" [ref=e2]', {
			includeAll: true,
			viewportOnly: false,
			refOwner: "test-owner",
		});

		expect(checkboxEntries[0]?.states).toEqual(["checked=false"]);
		expect(radioEntries[0]?.states).toEqual(["checked=true"]);
	});

	it("retains authored aria-checked on custom widgets", async () => {
		const handle = fakeActionableHandle({ tagName: "DIV", ariaChecked: "mixed" });
		const { core, page } = observationHarness({ width: 800, height: 600 }, handle);

		const entries = await collectBiDiObservationEntries(core, page, '- checkbox "Select all" [ref=e1]', {
			includeAll: true,
			viewportOnly: false,
			refOwner: "test-owner",
		});

		expect(entries[0]?.states).toEqual(["checked=mixed"]);
	});

	it("parses serialized getBoundingClientRect coordinates and inherits ancestor boxes for text", () => {
		expect(parseAriaSnapshotLines('- paragraph "Parent" [box=-10,20,31,41]\n  - text: Child')).toEqual([
			{ role: "paragraph", name: "Parent", states: [], box: { x: -10, y: 20, width: 31, height: 41 } },
			{ role: "text", name: "Child", states: [], box: { x: -10, y: 20, width: 31, height: 41 } },
		]);
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"recovers caught navigation timeouts on existing and newly returned pages",
		async () => {
			const puppeteer = await loadPuppeteer();
			const browser = await puppeteer.launch({
				executablePath: await ensureChromiumExecutable(),
				headless: true,
				args: ["--no-sandbox"],
			});
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				async fetch() {
					await Bun.sleep(200);
					return new Response("loaded");
				},
			});
			try {
				const primary = await browser.newPage();
				const existing = await browser.newPage();
				for (const source of [
					"existing",
					"new",
					"context-new",
					"context-pages",
					"target-page",
					"target-as-page",
				] as const) {
					let recoveryRequired = false;
					const scope = createRunPageScope(primary, () => {
						recoveryRequired = true;
					});
					scope.instrumentBrowser(browser);
					try {
						let secondary: Page;
						if (source === "existing")
							secondary = (await browser.pages()).find(candidate => candidate === existing)!;
						else if (source === "new") secondary = await browser.newPage();
						else if (source === "context-new") secondary = await browser.defaultBrowserContext().newPage();
						else if (source === "context-pages")
							secondary = (await browser.defaultBrowserContext().pages()).find(
								candidate => candidate === existing,
							)!;
						else {
							const target = browser.targets().find(candidate => candidate === existing.target())!;
							secondary = source === "target-page" ? (await target.page())! : await target.asPage();
						}
						await secondary.goto(server.url.href, { timeout: 30 }).catch(() => {});
						expect(recoveryRequired).toBe(true);
						await secondary.setRequestInterception(true);
						secondary.on("request", request => {
							void request.continue();
						});
						await scope.cleanup();
						await secondary.goto("data:text/html,<title>After cleanup</title>", { timeout: 2000 });
						expect(await secondary.title()).toBe("After cleanup");
					} finally {
						await scope.cleanup();
					}
				}
			} finally {
				server.stop(true);
				await browser.close();
			}
		},
		15_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)("removes user listeners without breaking internal page events", async () => {
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			args: ["--no-sandbox"],
		});
		try {
			const page = await browser.newPage();
			let internalCalls = 0;
			const retained = () => {
				internalCalls++;
			};
			page.on("domcontentloaded", retained);
			const scope = createRunPageScope(page);
			const removed = vi.fn();
			const oneShot = vi.fn();
			page.on("domcontentloaded", removed);
			page.once("domcontentloaded", oneShot);
			page.off("domcontentloaded", oneShot);
			page.removeAllListeners();
			await page.goto("data:text/html,first");
			expect(internalCalls).toBe(1);
			expect(removed).not.toHaveBeenCalled();
			expect(oneShot).not.toHaveBeenCalled();
			page.once("domcontentloaded", oneShot);
			await page.goto("data:text/html,second");
			await page.goto("data:text/html,third");
			expect(oneShot).toHaveBeenCalledTimes(1);
			page.on("domcontentloaded", removed);
			await scope.cleanup();
			await page.goto("data:text/html,after");
			expect(internalCalls).toBe(4);
			expect(removed).not.toHaveBeenCalled();
		} finally {
			await browser.close();
		}
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"filters real serialized page content without dropping visible headings",
		async () => {
			const puppeteer = await loadPuppeteer();
			const browser = await puppeteer.launch({
				executablePath: await ensureChromiumExecutable(),
				headless: true,
				args: ["--no-sandbox"],
			});
			try {
				const page = await browser.newPage();
				await page.setViewport({ width: 800, height: 600 });
				await page.setContent(
					"<h2>Visible heading</h2><p>Visible paragraph</p><button>Submit</button>" +
						'<div id="keyboard" tabindex="0">Keyboard control</div><div id="ordinary">Not focusable</div><p style="position:absolute;top:1500px">Offscreen paragraph</p>',
				);
				const snapshot = await captureAriaSnapshot(page, null, { boxes: true }, "viewport-test");
				const { core, cached } = observationHarness({ width: 800, height: 600 });
				const entries = await collectBiDiObservationEntries(core, page, snapshot, {
					includeAll: true,
					viewportOnly: true,
					refOwner: "viewport-test",
				});
				expect(entries.some(entry => entry.role === "heading" && entry.name === "Visible heading")).toBe(true);
				expect(
					entries.some(entry => entry.name === "Visible paragraph"),
					snapshot,
				).toBe(true);
				expect(entries.some(entry => entry.role === "button" && entry.name === "Submit")).toBe(true);
				expect(entries.some(entry => entry.name === "Offscreen paragraph")).toBe(false);
				const interactive = await collectBiDiObservationEntries(core, page, snapshot, {
					includeAll: false,
					viewportOnly: true,
					refOwner: "viewport-test",
				});
				const elementIds = await Promise.all(
					interactive
						.filter(entry => entry.actionable !== false)
						.map(entry => cached.get(entry.id)!.evaluate(element => element.id)),
				);
				expect(elementIds).toContain("keyboard");
				expect(elementIds).not.toContain("ordinary");
				for (const method of ["goto", "setContent"] as const) {
					const frame = page.mainFrame();
					const timeout = new Error("navigation timeout");
					timeout.name = "TimeoutError";
					const mock = vi.spyOn(frame, method).mockRejectedValue(timeout);
					let cleanupRequired = false;
					const scope = createRunPageScope(page, () => {
						cleanupRequired = true;
					});
					try {
						await page
							.mainFrame()
							[method]("about:blank")
							.catch(() => undefined);
						expect(cleanupRequired).toBe(true);
					} finally {
						await scope.cleanup();
						mock.mockRestore();
					}
				}
			} finally {
				await browser.close();
			}
		},
		30_000,
	);
});
