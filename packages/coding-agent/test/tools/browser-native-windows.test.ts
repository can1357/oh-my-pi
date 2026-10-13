import { describe, expect, test } from "bun:test";
import type { DesktopRosterWindow } from "@oh-my-pi/pi-natives";
import { NativeWindowWatch } from "@oh-my-pi/pi-coding-agent/tools/browser/native-windows";
import { browserShowsWindows } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

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

function watchWith(rosters: DesktopRosterWindow[][]): NativeWindowWatch {
	return new NativeWindowWatch(
		async () => FRAME,
		() => rosters.shift(),
	);
}

async function call(watch: NativeWindowWatch): Promise<string[]> {
	watch.beginCall(false);
	return await watch.endCall();
}

describe("browsers that show windows", () => {
	test("leaves a headless browser out, its recycled tabs included, and keeps every visible one", () => {
		// A recycled tab attaches to its browser, which used to count as showing windows.
		expect(browserShowsWindows({ kind: "headless", headless: true })).toBe(false);
		expect(browserShowsWindows({ kind: "headless", headless: false })).toBe(true);
		expect(browserShowsWindows({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" })).toBe(true);
		expect(browserShowsWindows({ kind: "spawned", path: "/Applications/App.app" })).toBe(true);
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

	test("names the picker of a tab whose window moved during the call", async () => {
		const moved = win(10, { x: 400 });
		// Only over the tab where it moved to.
		const picker = win(31, { layer: 101, x: 1300, y: 300, width: 240, height: 180 });
		const [line] = await call(watchWith([[TAB_WINDOW], [picker, moved]]));
		expect(line).toContain("a popup list or picker");
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
		const bubble = win(38, { x: 120, y: 90, width: 320, height: 180 });
		const watch = watchWith([[TAB_WINDOW], [TAB_WINDOW], [TAB_WINDOW], [bubble, TAB_WINDOW], [bubble, TAB_WINDOW]]);
		expect(await call(watch)).toEqual([]);
		// The tail's own read finds nothing new; the bubble shows only after it.
		await Bun.sleep(2_100);
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
