import { describe, expect, test, vi } from "bun:test";
import type { DesktopRosterWindow } from "@oh-my-pi/pi-natives";
import { FrontTab, NativeWindowWatch, readTabFrame } from "@oh-my-pi/pi-coding-agent/tools/browser/native-windows";
import * as nativeWindows from "@oh-my-pi/pi-coding-agent/tools/browser/native-windows";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import {
	closeLaunchedBrowser,
	launchHeadlessBrowser,
	removeUserDataDir,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { frontTabSource } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const BROWSER = 501;
const USER_APP = 777;

function win(id: number, over: Partial<DesktopRosterWindow> = {}): DesktopRosterWindow {
	return {
		id: String(id),
		pid: BROWSER,
		app: "Google Chrome for Testing",
		title: "",
		x: 0,
		y: 25,
		width: 1200,
		height: 800,
		layer: 0,
		alpha: 1,
		listed: true,
		...over,
	};
}

/** The tab's window, as the page reports its own frame. */
const TAB_WINDOW = win(10, { title: "AGENT TAB" });
const USER_WINDOW = win(20, { pid: USER_APP, app: "TextEdit", x: 1210, width: 700 });
const FRAME = { x: TAB_WINDOW.x, y: TAB_WINDOW.y, width: TAB_WINDOW.width, height: TAB_WINDOW.height };

/** A watch reading `rosters` in turn; the last supplied frame and front-tab answer stay current, from in front. */
function watchWith(
	rosters: DesktopRosterWindow[][],
	frames: (typeof FRAME)[] = [],
	fronts: (boolean | undefined)[] = [],
): NativeWindowWatch {
	let frame = FRAME;
	let front: boolean | undefined = true;
	return new NativeWindowWatch(
		async () => (frame = frames.shift() ?? frame),
		async () => (front = fronts.length > 0 ? fronts.shift() : front),
		() => rosters.shift(),
	);
}

async function call(watch: NativeWindowWatch): Promise<string[]> {
	watch.beginCall(false);
	return await watch.endCall();
}

describe("native-window frame timeout cleanup", () => {
	test.each(["tab", "browser"] as const)("cancels the %s probe timer when its read wins", async probe => {
		const pending = Promise.withResolvers<typeof FRAME>();
		const page = {
			mainFrame: () => ({ isolatedRealm: () => ({ evaluate: () => pending.promise }) }),
		} as unknown as Parameters<typeof readTabFrame>[0];
		const timer = vi.spyOn(globalThis, "setTimeout");
		const clear = vi.spyOn(globalThis, "clearTimeout");
		try {
			const result =
				probe === "tab" ? readTabFrame(page) : nativeWindows.readBrowserPageFrames({ pages: async () => [] });
			pending.resolve(FRAME);
			expect(await result).toEqual(probe === "tab" ? FRAME : []);
			expect(timer).toHaveBeenCalledWith(expect.any(Function), 300);
			expect(clear).toHaveBeenCalledWith(timer.mock.results[0].value);
		} finally {
			timer.mockRestore();
			clear.mockRestore();
		}
	});
});

describe("front-tab sources", () => {
	test("reads omp's own visible Chromium and the loopback relay, and leaves every other browser out", () => {
		expect(frontTabSource({ kind: "headless", headless: true })).toBeUndefined();
		expect(frontTabSource({ kind: "headless", headless: false })).toBe("chrome");
		expect(
			frontTabSource({ kind: "spawned", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }),
		).toBe("chrome");
		expect(frontTabSource({ kind: "spawned", path: "/Applications/App.app/Contents/MacOS/App" })).toBeUndefined();
		expect(frontTabSource({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" })).toBeUndefined();
		expect(frontTabSource({ kind: "connected", cdpUrl: "https://remote.example" })).toBeUndefined();
		expect(frontTabSource({ kind: "relay", cdpUrl: "http://127.0.0.1:9224" })).toBe("relay");
		expect(frontTabSource({ kind: "relay", cdpUrl: "https://remote.example" })).toBeUndefined();
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE)("native-window frame isolation", () => {
	test("ignores page overrides of window geometry", async () => {
		const { browser, userDataDir } = await launchHeadlessBrowser({ headless: true });
		try {
			const page = await browser.newPage();
			const frame = await readTabFrame(page);
			expect(frame).toBeDefined();
			await page
				.mainFrame()
				.mainRealm()
				.evaluate(() => {
					for (const name of ["screenX", "screenY", "outerWidth", "outerHeight"]) {
						Object.defineProperty(globalThis, name, { value: 9000 });
					}
				});
			expect(await readTabFrame(page)).toEqual(frame);
		} finally {
			await closeLaunchedBrowser(browser);
			if (userDataDir) await removeUserDataDir(userDataDir);
		}
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE)("page-backed native-window candidates", () => {
	test("does not report a browser popup as an unreachable native dialog", async () => {
		const { browser, userDataDir } = await launchHeadlessBrowser({ headless: true });
		try {
			const page = await browser.newPage();
			const opened = browser.waitForTarget(target => target.opener() === page.target());
			await page
				.mainFrame()
				.mainRealm()
				.evaluate('window.open("about:blank", "popup", "width=400,height=300,left=100,top=100")');
			const popup = await (await opened).page();
			if (!popup) throw new Error("Expected a page-backed popup");
			const frame = await readTabFrame(popup);
			if (!frame) throw new Error("Expected the popup frame");
			const candidate = win(32, frame);
			const parent = win(10, {
				x: frame.x - 100,
				y: frame.y - 100,
				width: frame.width * 2,
				height: frame.height * 2,
			});
			const rosters = [[parent], [candidate, parent]];
			const watch = new NativeWindowWatch(
				async () => parent,
				async () => true,
				() => rosters.shift(),
				BROWSER,
				() => nativeWindows.readBrowserPageFrames(browser),
			);
			expect(await call(watch)).toEqual([]);
		} finally {
			await closeLaunchedBrowser(browser);
			if (userDataDir) await removeUserDataDir(userDataDir);
		}
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE || process.platform !== "darwin")("native notices in worker output", () => {
	test.each(["success", "failure", "timeout"] as const)(
		"handles %s results without delaying aborted cleanup",
		async outcome => {
			const { browser, wsEndpoint, userDataDir } = await launchHeadlessBrowser({ headless: true });
			const begin = vi.spyOn(NativeWindowWatch.prototype, "beginCall").mockImplementation(() => {});
			const end = vi.spyOn(NativeWindowWatch.prototype, "endCall").mockResolvedValue(["native notice"]);
			const timeout = new AbortController();
			const originalTimeout = AbortSignal.timeout;
			const timeoutSpy = vi
				.spyOn(AbortSignal, "timeout")
				.mockImplementation(ms => (outcome === "timeout" && ms === 30_000 ? timeout.signal : originalTimeout(ms)));
			const ready = Promise.withResolvers<WorkerOutbound>();
			const result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
			const closed = Promise.withResolvers<void>();
			let receive!: (message: WorkerInbound | WorkerOutbound) => void;
			new WorkerCore(
				{
					send(message) {
						if (message.type === "ready" || message.type === "init-failed") ready.resolve(message);
						if (message.type === "result") result.resolve(message);
						if (message.type === "tool-call") timeout.abort(new DOMException("Timed out", "TimeoutError"));
					},
					onMessage(handler) {
						receive = handler;
						return () => {};
					},
					close() {
						closed.resolve();
					},
				},
				false,
			);
			try {
				if (!userDataDir) throw new Error("Expected an isolated browser profile");
				receive({
					type: "init",
					payload: {
						mode: "headless",
						browserWSEndpoint: wsEndpoint,
						safeDir: getPuppeteerDir(),
						uploadDir: `${userDataDir}/uploads`,
						frontTab: "chrome",
					},
				});
				expect((await ready.promise).type).toBe("ready");
				receive({
					type: "run",
					id: "notice",
					name: "notice",
					code:
						outcome === "timeout"
							? 'await page.setRequestInterception(true); await __omp_call_tool__("timeout", {});'
							: outcome === "success"
								? 'process.stdout.write("progress");'
								: 'throw new Error("page failed");',
					timeoutMs: 30_000,
					session: { cwd: process.cwd() },
				});
				const reply = await result.promise;
				if (outcome === "timeout") {
					expect(reply.ok).toBe(false);
					if (reply.ok) throw new Error("Expected the run to time out");
					expect(reply.error.message).toContain("timed out");
					expect(end).not.toHaveBeenCalled();
				} else if (outcome === "failure") {
					expect(reply.ok).toBe(false);
					if (reply.ok) throw new Error("Expected the run to fail");
					expect(reply.error.message).toContain("native notice");
					expect(reply.error.stack ?? reply.error.message).toContain("native notice");
				} else {
					if (!reply.ok) throw new Error(reply.error.message);
					expect(reply.payload.displays).toEqual([
						{ type: "text", text: "progress" },
						{ type: "text", text: "native notice" },
					]);
				}
			} finally {
				receive({ type: "close" });
				await closed.promise;
				begin.mockRestore();
				end.mockRestore();
				timeoutSpy.mockRestore();
				await closeLaunchedBrowser(browser);
				if (userDataDir) await removeUserDataDir(userDataDir);
			}
		},
	);
});

describe("browser native-window report", () => {
	test("adds nothing when the call raised no window", async () => {
		const watch = watchWith([
			[TAB_WINDOW, USER_WINDOW],
			[TAB_WINDOW, USER_WINDOW],
		]);
		expect(await call(watch)).toEqual([]);
	});

	test("names a popup picker the browser opened, with the computer tool's handle", async () => {
		const picker = win(31, { layer: 101, x: 100, y: 300, width: 240, height: 180, listed: false });
		const lines = await call(
			watchWith([
				[TAB_WINDOW, USER_WINDOW],
				[picker, TAB_WINDOW, USER_WINDOW],
			]),
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("The browser opened a popup list or picker");
		expect(lines[0]).toContain("tab.select or tab.fill");
		expect(lines[0]).toContain("computer.screenshot() shows it (window 31, 240x180)");
	});

	test("names a dialog over the tab with computer.window when the computer tool lists it", async () => {
		const sheet = win(32, { x: 300, y: 120, width: 600, height: 420 });
		const [line] = await call(watchWith([[TAB_WINDOW], [sheet, TAB_WINDOW]]));
		expect(line).toContain("a dialog over the tab (print, save, sign-in, passkey or permission)");
		expect(line).toContain("computer.window(32) (600x420)");
	});

	test("ignores other apps' windows, system prompts and invisible overlays", async () => {
		const other = win(34, { pid: USER_APP, app: "TextEdit", x: 300, y: 120, width: 500, height: 300 });
		const prompt = win(33, { pid: 90, app: "SecurityAgent", layer: 1000, width: 420, height: 300, listed: false });
		const overlay = win(35, { alpha: 0, layer: 25 });
		expect(await call(watchWith([[TAB_WINDOW], [other, prompt, overlay, TAB_WINDOW]]))).toEqual([]);
	});

	test("reports nothing when the roster cannot be read", async () => {
		expect(await call(watchWith([]))).toEqual([]);
	});

	test("takes no app as the browser when another window shares the tab's frame", async () => {
		// TextEdit at the tab's exact frame, in front of it: the frame alone cannot say which one is the browser.
		const twin = win(21, { pid: USER_APP, app: "TextEdit" });
		const sheet = win(22, { pid: USER_APP, app: "TextEdit", x: 300, y: 120, width: 600, height: 420 });
		expect(
			await call(
				watchWith([
					[twin, TAB_WINDOW],
					[sheet, twin, TAB_WINDOW],
				]),
			),
		).toEqual([]);
	});

	test("does not adopt another app's matching frame when the browser pid is known", async () => {
		const twin = win(21, { pid: USER_APP, app: "TextEdit" });
		const sheet = win(22, { pid: USER_APP, app: "TextEdit", x: 300, y: 120, width: 600, height: 420 });
		const rosters = [[twin], [sheet, twin]];
		const watch = new NativeWindowWatch(
			async () => FRAME,
			async () => true,
			() => rosters.shift(),
			BROWSER,
		);
		expect(await call(watch)).toEqual([]);
	});

	test("names the picker of a tab whose window moved during the call", async () => {
		const moved = win(10, { x: 400 });
		// Only over the tab where it moved to.
		const picker = win(31, { layer: 101, x: 1300, y: 300, width: 240, height: 180 });
		const [line] = await call(watchWith([[TAB_WINDOW], [picker, moved]], [{ ...FRAME, x: moved.x }]));
		expect(line).toContain("a popup list or picker");
	});

	test("follows a tab moved to another browser window while its old window stays open", async () => {
		const moved = win(11, { x: 500 });
		const picker = win(31, { layer: 101, x: 1400, y: 300, width: 240, height: 180 });
		const watch = watchWith(
			[
				[TAB_WINDOW, moved],
				[TAB_WINDOW, moved],
				[TAB_WINDOW, moved],
				[picker, TAB_WINDOW, moved],
			],
			[FRAME, { ...FRAME, x: moved.x }],
		);
		expect(await call(watch)).toEqual([]);
		expect(await call(watch)).toHaveLength(1);
	});

	test("does not attribute a picker overlapping two browser windows", async () => {
		const other = win(11, { x: 500 });
		const picker = win(31, { layer: 101, x: 600, y: 300, width: 240, height: 180 });
		expect(
			await call(
				watchWith([
					[TAB_WINDOW, other],
					[picker, TAB_WINDOW, other],
				]),
			),
		).toEqual([]);
	});

	test("rechecks the tab list after the call instead of attributing the newly selected tab's picker", async () => {
		const picker = win(31, { layer: 101, x: 100, y: 300, width: 240, height: 180 });
		// The second call's start samples the previous tail, so the third answer is the call end's own.
		const watch = watchWith(
			[[TAB_WINDOW], [TAB_WINDOW], [TAB_WINDOW], [picker, TAB_WINDOW]],
			[],
			[true, true, false],
		);
		await call(watch);
		expect(await call(watch)).toEqual([]);
	});

	test("rechecks the tab list when a delayed picker is sampled", async () => {
		vi.useFakeTimers();
		try {
			const picker = win(31, { layer: 101, x: 100, y: 300, width: 240, height: 180 });
			const watch = watchWith(
				[[TAB_WINDOW], [TAB_WINDOW], [picker, TAB_WINDOW], [picker, TAB_WINDOW], [picker, TAB_WINDOW]],
				[],
				[true, false],
			);
			await call(watch);
			vi.advanceTimersByTime(2_000);
			expect(await call(watch)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("does not take a browser window opening or coming back for one the call raised", async () => {
		const ordinary = win(40, { x: 1210, width: 700 });
		const watch = watchWith([
			[TAB_WINDOW, ordinary],
			[TAB_WINDOW],
			[TAB_WINDOW],
			[TAB_WINDOW, ordinary],
			[TAB_WINDOW, ordinary],
			[TAB_WINDOW, ordinary, win(41, { x: 1210, width: 700 })],
		]);
		expect(await call(watch)).toEqual([]);
		// The user's other window comes back (un-minimised) between calls, then the user opens a new one.
		expect(await call(watch)).toEqual([]);
		expect(await call(watch)).toEqual([]);
	});

	test("names a sheet over the tab once, and not again when it comes back", async () => {
		const sheet = win(32, { x: 300, y: 120, width: 600, height: 420 });
		const watch = watchWith([
			[TAB_WINDOW],
			[sheet, TAB_WINDOW],
			[sheet, TAB_WINDOW],
			[sheet, TAB_WINDOW],
			[TAB_WINDOW],
			[sheet, TAB_WINDOW],
		]);
		expect(await call(watch)).toHaveLength(1);
		// Still open at the next call, then hidden and shown again (its tab switched away and back).
		expect(await call(watch)).toEqual([]);
		expect(await call(watch)).toEqual([]);
	});

	test("does not take the tab's own window coming back for a dialog over it", async () => {
		const watch = watchWith([[TAB_WINDOW], [TAB_WINDOW], [], [], [TAB_WINDOW], [TAB_WINDOW]]);
		expect(await call(watch)).toEqual([]);
		expect(await call(watch)).toEqual([]);
		expect(await call(watch)).toEqual([]);
	});

	test("names at the next call a window that showed just after the previous call returned", async () => {
		// A permission bubble shows about half a second after the click that asked for it.
		const bubble = win(38, { x: 120, y: 90, width: 320, height: 180 });
		const watch = watchWith([[TAB_WINDOW], [TAB_WINDOW], [bubble, TAB_WINDOW], [bubble, TAB_WINDOW]]);
		expect(await call(watch)).toEqual([]);
		const [line] = await call(watch);
		expect(line).toStartWith(
			"The browser opened a dialog over the tab (print, save, sign-in, passkey or permission) after the previous browser call returned.",
		);
		watch.beginCall(false);
		expect(await watch.endCall()).toEqual([]);
	});

	test("does not name a window that showed after the tail of the previous call", async () => {
		vi.useFakeTimers();
		try {
			const bubble = win(38, { x: 120, y: 90, width: 320, height: 180 });
			const watch = watchWith([
				[TAB_WINDOW],
				[TAB_WINDOW],
				[TAB_WINDOW],
				[bubble, TAB_WINDOW],
				[bubble, TAB_WINDOW],
			]);
			expect(await call(watch)).toEqual([]);
			// The tail's own read finds nothing new; the bubble shows only after it.
			vi.advanceTimersByTime(2_100);
			expect(await call(watch)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("names nothing for a background tab, whose window shows another tab's menus", async () => {
		// The tab in front of it (the user's, or another session's) opens a <select> menu during this tab's call. The
		// page still reports the frame it last showed at, and focus emulation keeps it reporting itself visible.
		const menu = win(42, { x: 40, y: 120, width: 180, height: 90, layer: 101 });
		const watch = watchWith([[TAB_WINDOW], [TAB_WINDOW], [TAB_WINDOW], [menu, TAB_WINDOW]], [], [true, true, false]);
		expect(await call(watch)).toEqual([]);
		expect(await call(watch)).toEqual([]);
	});

	test("does not take another app's window at the tab's frame while another tab is in front", async () => {
		// A maximised window of the user's app has the frame the background page last showed at.
		const other = win(43, { pid: USER_APP, app: "TextEdit" });
		const sheet = win(44, { pid: USER_APP, app: "TextEdit", x: 300, y: 120, width: 600, height: 420 });
		const watch = watchWith([[other], [other], [other, TAB_WINDOW], [other, TAB_WINDOW, sheet]], [], [false, true]);
		expect(await call(watch)).toEqual([]);
		// In front again, the browser's window and the other app's share the frame: neither is taken as the tab's.
		expect(await call(watch)).toEqual([]);
	});

	test("names nothing when the browser's tab list cannot say which tab is in front", async () => {
		const picker = win(31, { layer: 101, x: 100, y: 300, width: 240, height: 180 });
		expect(await call(watchWith([[TAB_WINDOW], [picker, TAB_WINDOW]], [], [undefined]))).toEqual([]);
	});

	test("places a window over the tab it found earlier when a dialog keeps the page from answering", async () => {
		const panel = win(39, { x: 300, y: 120, width: 600, height: 420, layer: 3 });
		const watch = watchWith([[TAB_WINDOW], [TAB_WINDOW], [TAB_WINDOW], [panel, TAB_WINDOW]]);
		await call(watch);
		watch.beginCall(true);
		const [line] = await watch.endCall(true);
		expect(line).toContain("a floating panel during this call");
	});

	test("asks the tab list while a dialog keeps the page from answering", async () => {
		// The call ends with the page's confirm() open; the user selects another tab of the window, whose menu opens.
		const menu = win(42, { x: 40, y: 120, width: 180, height: 90, layer: 101 });
		const watch = watchWith([[TAB_WINDOW], [TAB_WINDOW], [TAB_WINDOW], [menu, TAB_WINDOW]], [], [true, true, false]);
		await call(watch);
		watch.beginCall(true);
		expect(await watch.endCall(true)).toEqual([]);
	});

	test("asks the tab list at the tail while a dialog keeps the page from answering", async () => {
		vi.useFakeTimers();
		try {
			const menu = win(42, { x: 40, y: 120, width: 180, height: 90, layer: 101 });
			const watch = watchWith(
				[
					[TAB_WINDOW],
					[TAB_WINDOW],
					[TAB_WINDOW],
					[TAB_WINDOW],
					[TAB_WINDOW],
					[menu, TAB_WINDOW],
					[menu, TAB_WINDOW],
					[menu, TAB_WINDOW],
				],
				[],
				[true, true, true, false],
			);
			await call(watch);
			vi.advanceTimersByTime(2_000);
			// The call leaves the page's confirm() open; the user then selects another tab, whose menu opens.
			watch.beginCall(false);
			expect(await watch.endCall(true)).toEqual([]);
			vi.advanceTimersByTime(2_000);
			watch.beginCall(true);
			expect(await watch.endCall(true)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("leaves out the page's own JavaScript dialog, which Chrome draws over the tab", async () => {
		const confirm = win(40, { x: 400, y: 25, width: 420, height: 160 });
		const watch = watchWith([[TAB_WINDOW], [confirm, TAB_WINDOW], [confirm, TAB_WINDOW], [confirm, TAB_WINDOW]]);
		watch.beginCall(false);
		expect(await watch.endCall(true)).toEqual([]);
		watch.beginCall(true);
		expect(await watch.endCall(true)).toEqual([]);
	});

	test("leaves out a JavaScript dialog that Chrome draws just after the call returned", async () => {
		const confirm = win(41, { x: 400, y: 25, width: 420, height: 160 });
		const watch = watchWith([[TAB_WINDOW], [TAB_WINDOW], [confirm, TAB_WINDOW], [confirm, TAB_WINDOW]]);
		watch.beginCall(false);
		expect(await watch.endCall(true)).toEqual([]);
		watch.beginCall(true);
		expect(await watch.endCall(true)).toEqual([]);
	});
});

describe("front tab by the browser's tab list", () => {
	/** `/json/list` page entries, most recently shown first. */
	function list(...ids: string[]): Array<Record<string, string>> {
		return ids.map(id => ({ id, type: "page", title: id, url: `https://example.test/${id}` }));
	}

	/** Answers `Browser.getWindowForTarget` from `placement`; an id it lacks has no browser window. */
	function windows(placement: Record<string, number>): (targetId: string) => Promise<number> {
		return async targetId => {
			const window = placement[targetId];
			if (window === undefined) throw new Error(`Browser window not found for ${targetId}`);
			return window;
		};
	}

	/** One tab's reader over Chrome's list, with `placement` for its window lookups. */
	function chrome(targetId: string, placement: Record<string, number>, openedInFront = false): FrontTab {
		const endpoint = "ws://127.0.0.1:1/devtools/browser/unused";
		return new FrontTab("chrome", endpoint, targetId, windows(placement), openedInFront);
	}

	test("takes a tab alone in its window as in front", async () => {
		// The other window's tab was shown later, so Chrome lists it first.
		expect(await chrome("agent", { other: 2, agent: 1 }).inFront(list("other", "agent"))).toBe(true);
	});

	test("takes a tab as behind when a page of its window is listed before it", async () => {
		expect(await chrome("agent", { user: 1, agent: 1 }).inFront(list("user", "agent"))).toBe(false);
	});

	test("takes a tab omp opened in front for in front while no page of its window is listed before it", async () => {
		const agent = chrome("agent", { agent: 1, blank: 1, user: 1 }, true);
		expect(await agent.inFront(list("agent", "blank"))).toBe(true);
		expect(await agent.inFront(list("user", "agent", "blank"))).toBe(false);
		expect(await agent.inFront(list("agent", "user", "blank"))).toBe(true);
	});

	test("does not take a tab listed first for in front until it passes a page once listed before it", async () => {
		// Chrome ranks a tab opened in the background by its creation, so first alone cannot say it was shown.
		const agent = chrome("agent", { user: 1, agent: 1, older: 1 });
		expect(await agent.inFront(list("agent", "user"))).toBe(false);
		// The user's tab is shown, then the agent's: it could only pass the user's by being shown.
		expect(await agent.inFront(list("user", "agent"))).toBe(false);
		expect(await agent.inFront(list("agent", "user"))).toBe(true);
		// Once shown it stays known shown: a page it never passed, listed after it, changes nothing.
		expect(await agent.inFront(list("agent", "older", "user"))).toBe(true);
	});

	test("does not take a tab opened in the background for in front after the tabs listed before it close", async () => {
		// The agent opens tab A2, then A3, in the background of the window whose front tab is the user's, then closes A3.
		const second = chrome("a2", { a2: 1, a3: 1, user: 1 });
		expect(await second.inFront(list("a2", "user"))).toBe(false);
		expect(await second.inFront(list("a3", "a2", "user"))).toBe(false);
		expect(await second.inFront(list("a2", "user"))).toBe(false);
	});

	test("takes the tab in front as behind while a tab opened in the background of its window ranks first", async () => {
		const agent = chrome("agent", { opened: 1, agent: 1, user: 1 }, true);
		expect(await agent.inFront(list("agent", "user"))).toBe(true);
		expect(await agent.inFront(list("opened", "agent", "user"))).toBe(false);
	});

	test("tells each tab's place across two windows", async () => {
		// The user's tab is in front of the agent's in one window; another window shows its own tab.
		const placement = { other: 2, user: 1, agent: 1 };
		const entries = list("other", "user", "agent");
		expect(await chrome("other", placement).inFront(entries)).toBe(true);
		expect(await chrome("user", placement, true).inFront(entries)).toBe(true);
		expect(await chrome("agent", placement, true).inFront(entries)).toBe(false);
	});

	test("asks for the windows of the pages after the tab only while it is listed first and not known shown", async () => {
		// The devtools entry has no browser window to report.
		const windowOf = vi.fn(windows({ agent: 1, user: 1 }));
		const endpoint = "ws://127.0.0.1:1/devtools/browser/unused";
		const asked = () => windowOf.mock.calls.map(([id]) => id);
		expect(
			await new FrontTab("chrome", endpoint, "agent", windowOf, true).inFront(list("agent", "user", "devtools")),
		).toBe(true);
		expect(asked()).toEqual(["agent"]);
		windowOf.mockClear();
		const unshown = new FrontTab("chrome", endpoint, "agent", windowOf, false);
		expect(await unshown.inFront(list("user", "agent", "devtools"))).toBe(false);
		expect(asked()).toEqual(["user", "agent"]);
		expect(await unshown.inFront(list("agent", "user", "devtools"))).toBeUndefined();
	});

	test("names nothing over a tab opened in the background, whose page matches a window at the screen origin", async () => {
		// Chrome lists the never-shown tab first, by its creation, and its page reports the screen origin: the frame of
		// a window there (full screen, or a hidden menu bar) whose front tab, the user's, opens a menu.
		const atOrigin = win(10, { x: 0, y: 0, width: 1240, height: 860 });
		const menu = win(42, { x: 40, y: 120, width: 180, height: 90, layer: 101 });
		const rosters = [[atOrigin], [atOrigin], [atOrigin], [menu, atOrigin]];
		const agent = chrome("agent", { agent: 1, user: 1 });
		const watch = new NativeWindowWatch(
			async () => ({ x: 0, y: 0, width: 1240, height: 860 }),
			shown => agent.inFront(list("agent", "user"), shown),
			() => rosters.shift(),
			BROWSER,
		);
		expect(await call(watch)).toEqual([]);
		expect(await call(watch)).toEqual([]);
	});

	test("takes a page frame off the screen origin at one browser window as proof the tab was shown", async () => {
		// The user shows the agent's tab, opened in the background, once: Chrome still lists it first, and its page now
		// reports the frame of its window, over which the agent's own click opens a menu.
		const menu = win(42, { x: 40, y: 120, width: 180, height: 90, layer: 101 });
		const rosters = [[TAB_WINDOW], [menu, TAB_WINDOW]];
		const agent = chrome("agent", { agent: 1, user: 1 });
		const watch = new NativeWindowWatch(
			async () => FRAME,
			shown => agent.inFront(list("agent", "user"), shown),
			() => rosters.shift(),
			BROWSER,
		);
		const [line] = await call(watch);
		expect(line).toContain("computer.window(42)");
	});

	test("takes no proof from the screen origin, an ambiguous match or a window of another or unknown process", async () => {
		const atOrigin = win(10, { x: 0, y: 0, width: 1240, height: 860 });
		const twin = win(11);
		const other = win(21, { pid: USER_APP, app: "TextEdit" });
		const proofs: boolean[] = [];
		const watchAt = (frame: typeof FRAME, roster: DesktopRosterWindow[], browserPid: number | undefined) =>
			new NativeWindowWatch(
				async () => frame,
				async shown => {
					proofs.push(shown);
					return false;
				},
				() => roster,
				browserPid,
			);
		await call(watchAt({ x: 0, y: 0, width: 1240, height: 860 }, [atOrigin], BROWSER));
		await call(watchAt(FRAME, [TAB_WINDOW, twin], BROWSER));
		await call(watchAt(FRAME, [other], BROWSER));
		await call(watchAt(FRAME, [TAB_WINDOW], undefined));
		await call(watchAt(FRAME, [TAB_WINDOW, other], BROWSER));
		expect(proofs).toEqual([false, false, false, false, true]);
	});

	test("skips entries that are not pages", async () => {
		const entries = [{ id: "worker", type: "service_worker" }, { id: "frame", type: "iframe" }, ...list("agent")];
		expect(await chrome("agent", { agent: 1 }).inFront(entries)).toBe(true);
	});

	test("cannot say from an unreadable list, a missing tab or a window it cannot read", async () => {
		const agent = chrome("agent", { agent: 1 });
		for (const unreadable of [undefined, null, "[]", { pages: list("agent") }]) {
			expect(await agent.inFront(unreadable)).toBeUndefined();
		}
		expect(await agent.inFront(list("user"))).toBeUndefined();
		// The user's tab has no browser window to report.
		expect(await agent.inFront(list("user", "agent"))).toBeUndefined();
	});

	test("takes the relay extension's active flag for the tab", async () => {
		const entries = [
			{ id: "user", type: "page", active: "true" },
			{ id: "agent", type: "page", active: "false" },
			{ id: "older", type: "page" },
		];
		const windowOf = vi.fn(windows({}));
		const relay = (id: string) =>
			new FrontTab("relay", "ws://127.0.0.1:9224/devtools/browser/x", id, windowOf, false);
		expect(await relay("user").inFront(entries)).toBe(true);
		expect(await relay("agent").inFront(entries)).toBe(false);
		expect(await relay("older").inFront(entries)).toBeUndefined();
		expect(await relay("gone").inFront(entries)).toBeUndefined();
		expect(windowOf).not.toHaveBeenCalled();
	});

	test("reads the list beside the endpoint the worker drives, and cannot say when it is unreachable", async () => {
		let body = JSON.stringify(list("user", "agent"));
		const requested: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requested.push(new URL(request.url).pathname);
				return new Response(body, { headers: { "content-type": "application/json" } });
			},
		});
		const endpoint = `ws://127.0.0.1:${server.port}/devtools/browser/omp?claim=agent`;
		const placement: Record<string, number> = { user: 1, agent: 2 };
		const agent = new FrontTab("chrome", endpoint, "agent", windows(placement), false);
		try {
			expect(await agent.read()).toBe(true);
			placement.agent = 1;
			expect(await agent.read()).toBe(false);
			body = "<html>starting</html>";
			expect(await agent.read()).toBeUndefined();
			expect(requested).toEqual(["/json/list", "/json/list", "/json/list"]);
		} finally {
			server.stop(true);
		}
		expect(await agent.read()).toBeUndefined();
	});

	test("keeps the proof a read was given though the list could not answer it", async () => {
		let body = "<html>starting</html>";
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body) });
		const endpoint = `ws://127.0.0.1:${server.port}/devtools/browser/omp`;
		const agent = new FrontTab("chrome", endpoint, "agent", windows({ agent: 1, user: 1 }), false);
		try {
			expect(await agent.read(true)).toBeUndefined();
			body = JSON.stringify(list("agent", "user"));
			expect(await agent.read()).toBe(true);
		} finally {
			server.stop(true);
		}
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE)("managed browser process", () => {
	test("carries the managed browser's own process, which limits the window match", async () => {
		const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		try {
			if (!("browser" in handle)) throw new Error("Expected a puppeteer browser handle");
			expect(handle.pid).toBeGreaterThan(0);
			expect(handle.pid).toBe(handle.browser.process()?.pid);
		} finally {
			await releaseBrowser(handle, { kill: true });
		}
	});
});
