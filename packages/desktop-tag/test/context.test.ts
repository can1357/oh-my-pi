import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	type BrowserContextCaptureOptions,
	BrowserContextError,
	type CapturedBrowserContext,
} from "../src/browser-context";
import {
	assertCaptureOptions,
	buildScreenshotScript,
	buildWindowScreenshotScript,
	CaptureService,
	captureScreenshot,
	isBrowserForegroundProcess,
	requestIxBridgeCommand,
} from "../src/context";
import type { CaptureRegion } from "../src/types";

function capturedBrowserContext(): CapturedBrowserContext {
	return {
		status: "captured",
		routing: { resolvedLane: "agent-a", source: "lane-lease", tabGroup: "work" },
		provider: "slack",
		identity: {
			tabId: 42,
			url: "https://acme.slack.com/client/T1/C2",
			title: "Support",
			group: { id: 7, title: "work" },
			epochMs: 1_788_800_000_000,
			timestamp: "2026-07-11T10:00:00.000Z",
		},
		accessibility: {
			text: "Rendered page content",
			tree: [{ role: "main", name: "Support chat" }],
			truncated: false,
		},
		chat: {
			messages: [{ role: "user", author: "Pat", text: "Can you help?" }],
			loadedHistoryOnly: true,
			truncated: false,
		},
		redactions: { promptInjection: false, sensitiveTokens: true },
	};
}

async function withCaptureTempDir<T>(run: (tempDir: string) => Promise<T>): Promise<T> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-tag-context-test-"));
	try {
		return await run(tempDir);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

const invalidRegions: Array<[keyof CaptureRegion, CaptureRegion, string]> = [
	["x", { x: Number.NEGATIVE_INFINITY, y: 1, width: 10, height: 10 }, "finite number"],
	["y", { x: 1, y: Number.NaN, width: 10, height: 10 }, "finite number"],
	["width", { x: 1, y: 1, width: 0, height: 10 }, "finite positive number"],
	["width", { x: 1, y: 1, width: -1, height: 10 }, "finite positive number"],
	["height", { x: 1, y: 1, width: 10, height: Number.POSITIVE_INFINITY }, "finite positive number"],
];

describe("capture validation", () => {
	it("requires a region for region captures", () => {
		expect(() => assertCaptureOptions({ mode: "region", userRequest: "inspect this" })).toThrow(
			"Region capture requires a region",
		);
	});

	it.each([
		["zero", { x: 0, y: 0, width: 10, height: 10 }],
		["negative", { x: -1920, y: -240, width: 1920, height: 1080 }],
	] as const)("accepts %s desktop origins", (_name, region) => {
		expect(() => assertCaptureOptions({ mode: "region", userRequest: "inspect this", region })).not.toThrow();
	});

	it("rejects unknown capture modes", () => {
		expect(() => assertCaptureOptions({ mode: "desktop", userRequest: "inspect this" })).toThrow(
			"Unsupported capture mode",
		);
	});

	it.each(invalidRegions)("rejects an invalid %s before screenshot capture", async (field, region, requirement) => {
		await expect(captureScreenshot("unused.png", region)).rejects.toThrow(
			`Capture region ${field} must be a ${requirement}`,
		);
	});

	it("rejects a malformed region supplied for a non-region mode", () => {
		expect(() =>
			assertCaptureOptions({
				mode: "screen",
				userRequest: "inspect this",
				region: { x: 1, y: 1, width: 0, height: 10 },
			}),
		).toThrow("Capture region width must be a finite positive number");
	});
});

describe("screenshot modes", () => {
	it("uses foreground HWND bounds for window capture, not primary-screen bounds", () => {
		const script = buildWindowScreenshotScript("C:\\temp\\window.png");

		expect(script).toContain("GetForegroundWindow");
		expect(script).toContain("GetWindowRect");
		expect(script).toContain("$bounds.Left, $bounds.Top");
		expect(script).not.toContain("PrimaryScreen");
	});

	it("keeps full-screen and explicit-region capture paths distinct", () => {
		const screenScript = buildScreenshotScript("screen.png");
		const regionScript = buildScreenshotScript("region.png", { x: -100, y: 20, width: 300, height: 200 });

		expect(screenScript).toContain("PrimaryScreen.Bounds");
		expect(regionScript).toContain("CopyFromScreen(-100, 20, 0, 0");
		expect(regionScript).not.toContain("GetForegroundWindow");
	});
});

describe("browser evidence capture", () => {
	it("captures full rendered browser and chat evidence with a unique session identity", async () => {
		const requests: BrowserContextCaptureOptions[] = [];
		const client = {
			capture: async (options: BrowserContextCaptureOptions) => {
				requests.push(options);
				return capturedBrowserContext();
			},
		};
		const packet = await withCaptureTempDir(tempDir =>
			new CaptureService(tempDir, client).capture({ mode: "browser", userRequest: "summarize this page" }),
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ lane: "agent-a", includeChat: true });
		expect(requests[0]?.session).toBe(`desktop-tag:${packet.captureId}`);
		expect(packet.browser).toMatchObject({
			evidenceStatus: "captured",
			url: "https://acme.slack.com/client/T1/C2",
			title: "Support",
			tabId: "42",
			provider: "slack",
			accessibility: { text: "Rendered page content" },
			chat: { loadedHistoryOnly: true, messages: [{ text: "Can you help?" }] },
			redactions: { sensitiveTokens: true },
		});
	});

	it("captures browser evidence for supported foreground browser and chat processes", async () => {
		let captures = 0;
		const client = {
			capture: async () => {
				captures += 1;
				return capturedBrowserContext();
			},
		};
		const packet = await withCaptureTempDir(tempDir =>
			new CaptureService(tempDir, client, async () => ({ processName: "Teams.exe", windowTitle: "Chat" })).capture({
				mode: "screen",
				includeActiveAppState: true,
				userRequest: "reply to the conversation",
			}),
		);

		expect(captures).toBe(1);
		expect(packet.browser.evidenceStatus).toBe("captured");
		expect(isBrowserForegroundProcess("chrome.exe")).toBe(true);
		expect(isBrowserForegroundProcess("notepad.exe")).toBe(false);
	});

	it("returns an explicit warning instead of claiming evidence when IX is disconnected", async () => {
		const client = {
			capture: async (): Promise<CapturedBrowserContext> => {
				throw new BrowserContextError("disconnected", "IX Bridge extension is not connected");
			},
		};
		const packet = await withCaptureTempDir(tempDir =>
			new CaptureService(tempDir, client).capture({ mode: "browser", userRequest: "inspect the page" }),
		);

		expect(packet.browser).toEqual({
			evidenceStatus: "unavailable",
			warnings: ["IX browser evidence unavailable (disconnected): IX Bridge extension is not connected"],
		});
		expect(packet.browser.accessibility).toBeUndefined();
	});
});

describe("IX Bridge command timeout", () => {
	it("gives each browser command a fresh bounded abort signal", async () => {
		const originalFetch = globalThis.fetch;
		const signals: AbortSignal[] = [];
		const bodies: string[] = [];
		globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
			if (!init?.signal) throw new Error("missing abort signal");
			signals.push(init.signal);
			bodies.push(String(init.body));
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
			});
		}) as typeof fetch;

		try {
			const results = await Promise.allSettled([
				requestIxBridgeCommand("get_url", 5),
				requestIxBridgeCommand("get_title", 5),
			]);
			expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
			expect(signals).toHaveLength(2);
			expect(signals[0]).not.toBe(signals[1]);
			expect(signals.every(signal => signal.aborted)).toBe(true);
			expect(bodies.map(body => JSON.parse(body).action)).toEqual(["get_url", "get_title"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
