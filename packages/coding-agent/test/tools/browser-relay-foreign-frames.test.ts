import { afterEach, describe, expect, it } from "bun:test";
import {
	closeLaunchedBrowser,
	ensureChromiumExecutable,
	RENDERER_PRIORITY_ARGS,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { type HiddenFrame, isHiddenFrame } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import puppeteer from "puppeteer-core";
import { onForeignFramesHidden, pastForeignFrames } from "../../../browser-relay/extension/foreign-frames";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const REFUSAL = new Error("Cannot access a chrome-extension:// URL of different extension");
/** Another installed extension, as Chrome names extension ids: 32 letters a-p. */
const OTHER_ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER_MENU = `chrome-extension://${OTHER_ID}/inline/menu.html?token=secret#type=menu`;
const OTHER_CARD = `chrome-extension://${OTHER_ID}/inline/notification.html`;
const OTHER_TITLE = `Other vault ${"menu ".repeat(20)}`;
/** The relay extension's own id. */
const RELAY_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";

/**
 * What the page loads for a frame `src`: another extension's exposed page, with its title, the relay's own page (its
 * world may load it, under the URL Chrome normalises), or nothing.
 */
function loadInPage(url: string): { url: string; title?: string } | null {
	if (url.toLowerCase().startsWith(`chrome-extension://${RELAY_ID}/`)) return { url: url.toLowerCase(), title: "omp" };
	return url.startsWith(`chrome-extension://${OTHER_ID}/inline/`) ? { url, title: OTHER_TITLE } : null;
}

/**
 * Install a `chrome` global whose `scripting.executeScript` reports `found` foreign frames, the first sweep emptying
 * `emptiedByFrame`, or throws when the page cannot be scripted (`null`); returns the sweeps it ran. A frame-targeted
 * call is the report's probe, answered by `loadInPage` once `probe(frameId)` settles. The real sweep and probe run in
 * Chrome in `browser-relay-tab-isolation.test.ts`.
 */
function sweepsEmptying(
	found: number | null,
	emptiedByFrame = (): Record<number, string[]> => ({ 0: Array.from({ length: found ?? 0 }, () => OTHER_MENU) }),
	probe: (frameId: number) => Promise<void> = async () => {},
): number[] {
	const sweeps: number[] = [];
	let emptiedBefore = 0;
	Reflect.set(globalThis, "chrome", {
		runtime: { id: RELAY_ID },
		scripting: {
			executeScript: async (injection: { target: { tabId: number; frameIds?: number[] }; args: unknown[] }) => {
				if (injection.target.frameIds) {
					const [frameId] = injection.target.frameIds;
					await probe(frameId);
					return [{ frameId, result: (injection.args[0] as string[]).map(loadInPage) }];
				}
				sweeps.push(injection.target.tabId);
				if (found === null) throw new Error("Cannot access contents of the page");
				const emptied = Object.entries(sweeps.length === 1 ? emptiedByFrame() : {});
				emptiedBefore += emptied.reduce((count, [, srcs]) => count + srcs.length, 0);
				// The first frame carries every frame found, emptied now or before.
				const total = { found: Math.max(found, emptiedBefore), emptied: [] as string[] };
				if (emptied.length === 0) return [{ frameId: 0, result: total }];
				return emptied.map(([frameId, srcs], i) => ({
					frameId: Number(frameId),
					result: { found: i === 0 ? total.found : 0, emptied: srcs },
				}));
			},
		},
	});
	return sweeps;
}

/** A request Chrome refuses `times` times for a foreign frame, then runs; `onRetry` sees each later attempt. */
function refused(times: number, onRetry: () => void = () => {}): () => Promise<string> {
	let attempts = 0;
	return async () => {
		if (attempts++ < times) throw REFUSAL;
		onRetry();
		return "attached";
	};
}

describe("pastForeignFrames", () => {
	const saved = Reflect.get(globalThis, "chrome");
	afterEach(() => {
		Reflect.set(globalThis, "chrome", saved);
		onForeignFramesHidden(() => {});
	});

	it("shares one sweep among the commands of a refused burst, then retries each", async () => {
		const sweeps = sweepsEmptying(1);
		const refusedOnce = () => {
			let attempts = 0;
			return async () => {
				if (attempts++ === 0) throw REFUSAL;
				return attempts;
			};
		};
		expect(await Promise.all([pastForeignFrames(1, refusedOnce()), pastForeignFrames(1, refusedOnce())])).toEqual([
			2, 2,
		]);
		expect(sweeps).toEqual([1]);
	});

	it("rethrows Chrome's refusal when the tab has no foreign frame to empty", async () => {
		const sweeps = sweepsEmptying(0);
		let attempts = 0;
		const failure = await rejectionOf(
			pastForeignFrames(1, async () => {
				attempts++;
				throw REFUSAL;
			}),
		);
		expect(failure).toBe(REFUSAL);
		expect(attempts).toBe(1);
		expect(sweeps).toEqual([1]);
	});

	it("rethrows the refusal when the page cannot be scripted", async () => {
		sweepsEmptying(null);
		expect(await rejectionOf(pastForeignFrames(1, () => Promise.reject(REFUSAL)))).toBe(REFUSAL);
	});

	it("reports each emptied page the page itself can load once, by id, path and cut title, and skips the rest", async () => {
		// A page can add frames of its own whose `src` only looks like another extension's; it cannot load them. One
		// names the relay's own page with its id upper-cased, past the sweep's own-id check; the relay never hides those.
		const decoys = [
			"chrome-extension://a b/x",
			"chrome-extension://pppppppppppppppppppppppppppppppp/x",
			`chrome-extension://${OTHER_ID}/private.html`,
			`chrome-extension://${RELAY_ID.toUpperCase()}/options.html`,
		];
		const sweeps = sweepsEmptying(0, () => ({ 0: [OTHER_MENU, OTHER_MENU, ...decoys] }));
		const reports: Array<[number, HiddenFrame[]]> = [];
		const reported = Promise.withResolvers<void>();
		onForeignFramesHidden((tabId, frames) => {
			reports.push([tabId, frames]);
			reported.resolve();
		});
		// The second refusal's sweep finds the same frames already emptied: nothing new to report.
		expect(await pastForeignFrames(7, refused(2))).toBe("attached");
		expect(sweeps).toEqual([7, 7]);
		await reported.promise;
		expect(reports).toEqual([
			[7, [{ extensionId: OTHER_ID, path: "inline/menu.html", title: OTHER_TITLE.slice(0, 60) }]],
		]);
	});

	it("retries without waiting for the report of what the sweep emptied", async () => {
		// The probe answers only once the retry ran; a sweep that held the retry for it would report nothing.
		const probe = Promise.withResolvers<void>();
		sweepsEmptying(1, undefined, () => probe.promise);
		const reported = Promise.withResolvers<HiddenFrame[]>();
		onForeignFramesHidden((_, frames) => reported.resolve(frames));
		expect(await pastForeignFrames(3, refused(1, probe.resolve))).toBe("attached");
		expect(await reported.promise).toEqual([
			{ extensionId: OTHER_ID, path: "inline/menu.html", title: OTHER_TITLE.slice(0, 60) },
		]);
	});

	it("still retries when the report fails", async () => {
		sweepsEmptying(1, undefined, () => Promise.reject(new Error("Frame with ID 0 was removed.")));
		expect(await pastForeignFrames(4, refused(1))).toBe("attached");
	});

	it("reports the frames whose probe ran when another frame's document is gone", async () => {
		sweepsEmptying(
			0,
			() => ({ 0: [OTHER_MENU], 4: [OTHER_CARD] }),
			async frameId => {
				if (frameId === 0) throw new Error("Frame with ID 0 was removed.");
			},
		);
		const reported = Promise.withResolvers<HiddenFrame[]>();
		onForeignFramesHidden((_, frames) => reported.resolve(frames));
		expect(await pastForeignFrames(5, refused(1))).toBe("attached");
		expect(await reported.promise).toEqual([
			{ extensionId: OTHER_ID, path: "inline/notification.html", title: OTHER_TITLE.slice(0, 60) },
		]);
	});

	it("never sweeps for other errors", async () => {
		const sweeps = sweepsEmptying(1);
		const other = new Error("No tab with given id 1.");
		expect(await rejectionOf(pastForeignFrames(1, () => Promise.reject(other)))).toBe(other);
		expect(sweeps).toEqual([]);
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"hides the emptied menu frame, so the button under it takes the click",
		async () => {
			const browser = await puppeteer.launch({
				executablePath: await ensureChromiumExecutable(),
				headless: true,
				args: ["--no-first-run", ...RENDERER_PRIORITY_ARGS],
			});
			try {
				const page = await browser.newPage();
				// A password manager's inline menu, drawn below the field over the page's Next button.
				await page.setContent(`<input type="password"><br><button>Next</button>
<iframe src="chrome-extension://${OTHER_ID}/menu.html"
  style="position: absolute; left: 0; top: 0; width: 300px; height: 200px; z-index: 2147483647"></iframe>`);
				// The injected function runs in the page, as `chrome.scripting.executeScript` runs it.
				Reflect.set(globalThis, "chrome", {
					runtime: { id: "selfextensionid" },
					scripting: {
						executeScript: async (injection: { func: (...args: never[]) => unknown; args?: unknown[] }) => [
							{
								frameId: 0,
								result: await page.evaluate(`(() => {
								globalThis.chrome = { dom: { openOrClosedShadowRoot: element => element.shadowRoot } };
								return (${String(injection.func)})(...${JSON.stringify(injection.args ?? [])});
							})()`),
							},
						],
					},
				});
				let attempts = 0;
				await pastForeignFrames(1, async () => {
					if (attempts++ === 0) throw REFUSAL;
				});
				expect(
					await page.$eval("button", button => {
						const box = button.getBoundingClientRect();
						return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button;
					}),
				).toBeTrue();
				expect(await page.$eval("iframe", frame => frame.hasAttribute("srcdoc"))).toBeTrue();
			} finally {
				await closeLaunchedBrowser(browser);
			}
		},
		30_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"reads a frame's page only up to its title, however large the page",
		async () => {
			// A page whose title comes first and whose body never ends.
			const encoder = new TextEncoder();
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: request =>
					new URL(request.url).pathname === "/endless"
						? new Response(
								new ReadableStream({
									start: controller => controller.enqueue(encoder.encode("<title>Endless vault page</title>")),
									pull: controller => controller.enqueue(new Uint8Array(64 * 1024)),
								}),
								{ headers: { "Content-Type": "text/html" } },
							)
						: new Response("<title>Login</title>", { headers: { "Content-Type": "text/html" } }),
			});
			const browser = await puppeteer.launch({
				executablePath: await ensureChromiumExecutable(),
				headless: true,
				args: ["--no-first-run", ...RENDERER_PRIORITY_ARGS],
			});
			try {
				const page = await browser.newPage();
				await page.goto(server.url.href);
				const endless = new URL("/endless", server.url).href;
				// The sweep empties a frame of that page; the probe runs in the page, as Chrome runs it.
				const probed = Promise.withResolvers<unknown>();
				Reflect.set(globalThis, "chrome", {
					runtime: { id: RELAY_ID },
					scripting: {
						executeScript: async (injection: {
							target: { frameIds?: number[] };
							func: (...args: never[]) => unknown;
							args?: unknown[];
						}) => {
							if (!injection.target.frameIds) return [{ frameId: 0, result: { found: 1, emptied: [endless] } }];
							const result = await page.evaluate(
								`(${String(injection.func)})(...${JSON.stringify(injection.args ?? [])})`,
							);
							probed.resolve(result);
							return [{ frameId: 0, result }];
						},
					},
				});
				await pastForeignFrames(1, refused(1));
				// Reading the whole body would run into the probe's time limit and name nothing.
				expect(await probed.promise).toEqual([{ url: endless, title: "Endless vault page" }]);
			} finally {
				await closeLaunchedBrowser(browser);
				server.stop(true);
			}
		},
		30_000,
	);
});

describe("isHiddenFrame", () => {
	it("keeps only well-formed frames from a reply off the socket", () => {
		expect(
			[
				{ extensionId: OTHER_ID, path: "inline/menu.html", title: "Vault" },
				{ extensionId: OTHER_ID, path: "inline/notification.html" },
				{ extensionId: OTHER_ID, path: "x.html", title: { toString: "Vault" } },
				{ extensionId: OTHER_ID },
				"inline/menu.html",
				null,
			].filter(isHiddenFrame),
		).toEqual([
			{ extensionId: OTHER_ID, path: "inline/menu.html", title: "Vault" },
			{ extensionId: OTHER_ID, path: "inline/notification.html" },
		]);
	});
});
