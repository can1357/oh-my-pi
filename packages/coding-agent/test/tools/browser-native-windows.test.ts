import { describe, expect, test, vi } from "bun:test";
import type { DesktopRosterWindow } from "@oh-my-pi/pi-natives";
import { NativeWindowWatch, readTabFrame } from "@oh-my-pi/pi-coding-agent/tools/browser/native-windows";
import * as nativeWindows from "@oh-my-pi/pi-coding-agent/tools/browser/native-windows";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import {
	closeLaunchedBrowser,
	launchHeadlessBrowser,
	removeUserDataDir,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { browserShowsWindows } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
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
const FRAME = { x: TAB_WINDOW.x, y: TAB_WINDOW.y, width: TAB_WINDOW.width, height: TAB_WINDOW.height, visible: true };
const HIDDEN = { ...FRAME, visible: false };

/** A watch reading `rosters` in turn; the last supplied frame stays current. */
function watchWith(rosters: DesktopRosterWindow[][], frames: (typeof FRAME)[] = []): NativeWindowWatch {
	let frame = FRAME;
	return new NativeWindowWatch(
		async () => (frame = frames.shift() ?? frame),
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

describe("browsers that show windows", () => {
	test("leaves headless and unidentified CDP browsers out, including recycled tabs", () => {
		expect(browserShowsWindows({ kind: "headless", headless: true })).toBe(false);
		expect(browserShowsWindows({ kind: "headless", headless: false })).toBe(true);
		expect(browserShowsWindows({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" })).toBe(false);
		expect(browserShowsWindows({ kind: "connected", cdpUrl: "https://remote.example" })).toBe(false);
		expect(browserShowsWindows({ kind: "relay", cdpUrl: "http://127.0.0.1:9224" })).toBe(true);
		expect(browserShowsWindows({ kind: "relay", cdpUrl: "https://remote.example" })).toBe(false);
		expect(browserShowsWindows({ kind: "spawned", path: "/Applications/App.app" })).toBe(true);
	});
});

describe.skipIf(!CHROMIUM_AVAILABLE)("native-window frame isolation", () => {
	test("ignores page overrides of window geometry and visibility", async () => {
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
					Object.defineProperty(document, "visibilityState", { value: "hidden" });
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
				async () => ({ ...parent, visible: true }),
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
	test("separates a notice from an unterminated stdout write", async () => {
		const { browser, wsEndpoint, userDataDir } = await launchHeadlessBrowser({ headless: true });
		const begin = vi.spyOn(NativeWindowWatch.prototype, "beginCall").mockImplementation(() => {});
		const end = vi.spyOn(NativeWindowWatch.prototype, "endCall").mockResolvedValue(["native notice"]);
		const ready = Promise.withResolvers<WorkerOutbound>();
		const result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
		const closed = Promise.withResolvers<void>();
		let receive!: (message: WorkerInbound | WorkerOutbound) => void;
		new WorkerCore(
			{
				send(message) {
					if (message.type === "ready" || message.type === "init-failed") ready.resolve(message);
					if (message.type === "result") result.resolve(message);
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
					showsWindows: true,
				},
			});
			expect((await ready.promise).type).toBe("ready");
			receive({
				type: "run",
				id: "notice",
				name: "notice",
				code: 'process.stdout.write("progress");',
				timeoutMs: 30_000,
				session: { cwd: process.cwd() },
			});
			const reply = await result.promise;
			if (!reply.ok) throw new Error(reply.error.message);
			expect(reply.payload.displays).toEqual([
				{ type: "text", text: "progress" },
				{ type: "text", text: "native notice" },
			]);
		} finally {
			receive({ type: "close" });
			await closed.promise;
			begin.mockRestore();
			end.mockRestore();
			await closeLaunchedBrowser(browser);
			if (userDataDir) await removeUserDataDir(userDataDir);
		}
	});
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

	test("rechecks visibility after the call instead of attributing the newly selected tab's picker", async () => {
		const picker = win(31, { layer: 101, x: 100, y: 300, width: 240, height: 180 });
		let frame = FRAME;
		const rosters = [[TAB_WINDOW], [TAB_WINDOW], [TAB_WINDOW], [picker, TAB_WINDOW]];
		const watch = new NativeWindowWatch(
			async () => frame,
			() => rosters.shift(),
		);
		await call(watch);
		watch.beginCall(false);
		frame = HIDDEN;
		expect(await watch.endCall()).toEqual([]);
	});

	test("rechecks visibility when a delayed picker is sampled", async () => {
		vi.useFakeTimers();
		try {
			const picker = win(31, { layer: 101, x: 100, y: 300, width: 240, height: 180 });
			let frame = FRAME;
			const rosters = [[TAB_WINDOW], [TAB_WINDOW], [picker, TAB_WINDOW], [picker, TAB_WINDOW], [picker, TAB_WINDOW]];
			const watch = new NativeWindowWatch(
				async () => frame,
				() => rosters.shift(),
			);
			await call(watch);
			frame = HIDDEN;
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
		// The tab in front of it (the user's, or another session's) opens a <select> menu during this tab's call.
		const menu = win(42, { x: 40, y: 120, width: 180, height: 90, layer: 101 });
		const watch = watchWith([[TAB_WINDOW], [TAB_WINDOW], [TAB_WINDOW], [menu, TAB_WINDOW]], [FRAME, HIDDEN]);
		expect(await call(watch)).toEqual([]);
		expect(await call(watch)).toEqual([]);
	});

	test("does not take another app's window at the tab's frame while the page is hidden", async () => {
		// The browser's window is on another Space; a maximised window of the user's app has the same frame.
		const other = win(43, { pid: USER_APP, app: "TextEdit" });
		const sheet = win(44, { pid: USER_APP, app: "TextEdit", x: 300, y: 120, width: 600, height: 420 });
		const watch = watchWith([[other], [other], [other, TAB_WINDOW], [other, TAB_WINDOW, sheet]], [HIDDEN, FRAME]);
		expect(await call(watch)).toEqual([]);
		// Back on screen, the browser's window and the other app's share the frame: neither is taken as the tab's.
		expect(await call(watch)).toEqual([]);
	});

	test("places a window over the tab it found earlier when a dialog keeps the page from answering", async () => {
		const panel = win(39, { x: 300, y: 120, width: 600, height: 420, layer: 3 });
		const watch = watchWith([[TAB_WINDOW], [TAB_WINDOW], [TAB_WINDOW], [panel, TAB_WINDOW]]);
		await call(watch);
		watch.beginCall(true);
		const [line] = await watch.endCall(true);
		expect(line).toContain("a floating panel during this call");
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
