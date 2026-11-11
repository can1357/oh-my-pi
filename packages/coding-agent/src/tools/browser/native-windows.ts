import type { DesktopRosterWindow } from "@oh-my-pi/pi-natives";
import { desktopWindowRoster } from "@oh-my-pi/pi-natives/desktop";
import { withTimeout } from "@oh-my-pi/pi-utils";
import type { Browser, Page } from "puppeteer-core";

/** Longest a call waits to read where the tab's window is on screen. */
const FRAME_TIMEOUT_MS = 300;
/**
 * How long after a call returns a window it raised may still show: a `<select>` menu takes tens of ms, a permission
 * bubble up to about 1.7 s. One that shows later is not attributed to the call.
 */
const TAIL_MS = 2_000;
/** macOS floating-panel window level: the colour panel and other inspector panels. */
const FLOATING_LAYER = 3;
/** macOS popup-menu window level: a `<select>`'s menu and Chrome's colour and date pickers. */
const MENU_LAYER = 101;
/** Window ids remembered as already seen before the set starts over from what is on screen. */
const SEEN_LIMIT = 4_096;

interface Frame {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The tab's window frame, and whether the page is the one showing in it (not a background tab, not minimised). */
interface TabView extends Frame {
	visible: boolean;
}

/** Where the tab's window is on screen, in the points the window server reports; undefined if the page cannot say. */
export async function readTabFrame(page: Pick<Page, "mainFrame">): Promise<TabView | undefined> {
	const read = page
		.mainFrame()
		.isolatedRealm()
		.evaluate(() => {
			const view = globalThis as unknown as {
				screenX: number;
				screenY: number;
				outerWidth: number;
				outerHeight: number;
				document: { visibilityState: string };
			};
			return {
				x: view.screenX,
				y: view.screenY,
				width: view.outerWidth,
				height: view.outerHeight,
				visible: view.document.visibilityState === "visible",
			};
		})
		.catch(() => undefined);
	return await withTimeout(read, FRAME_TIMEOUT_MS, "Timed out reading the tab frame").catch(() => undefined);
}

/** Page-backed browser windows are not native dialogs; an unreadable target leaves their identity uncertain. */
export async function readBrowserPageFrames(browser: Pick<Browser, "pages">): Promise<Frame[] | undefined> {
	const read = browser
		.pages()
		.then(pages => Promise.all(pages.map(readTabFrame)))
		.then(frames =>
			frames.some(frame => frame === undefined) ? undefined : frames.filter(frame => frame !== undefined),
		)
		.catch(() => undefined);
	return await withTimeout(read, FRAME_TIMEOUT_MS, "Timed out reading browser page frames").catch(() => undefined);
}

/**
 * Reports the native windows a browser call raised over its tab that no page or CDP call can see or answer: the
 * browser's own popup menus and pickers, panels, and the sheets and bubbles over the tab (permission, passkey,
 * sign-in, save), each with the computer tool's handle. Only windows the tab's browser process owns, over the tab's
 * own window, that were never on screen before count, and only while the page is the one showing in that window: a
 * background tab shares its window with the tab in front, whose menus are not its own. One that shows within the
 * tail after a call returned is named by the next call. macOS only, and only for browsers that show windows; a call
 * when nothing appeared adds nothing. System-owned prompts (Touch ID, keychain) are not reported: nothing on screen
 * ties them to the tab.
 */
export class NativeWindowWatch {
	readonly #readFrame: () => Promise<TabView | undefined>;
	readonly #readRoster: () => DesktopRosterWindow[] | undefined;
	readonly #browserPid: number | undefined;
	readonly #readPageFrames: () => Promise<Frame[] | undefined>;
	/** The tab's own window, once its frame named exactly one while the page showed. */
	#tab: DesktopRosterWindow | undefined;
	/** Whether the page showed in its window at the last read; a dialog-stopped page keeps the previous answer. */
	#visible = false;
	/** Every window id on screen at some read: one coming back (restored, un-minimised) did not just open. */
	#seen = new Set<string>();
	/** On-screen windows when the call began. */
	#before: DesktopRosterWindow[] | undefined;
	#pageStopped = false;
	#catchingUp: Promise<void> | undefined;
	/** Windows that showed within the tail after the previous call returned, for this call to name. */
	#late: DesktopRosterWindow[] = [];
	#tailTimer: NodeJS.Timeout | undefined;

	constructor(
		readFrame: () => Promise<TabView | undefined>,
		roster: () => DesktopRosterWindow[] | undefined = readRoster,
		browserPid?: number,
		readPageFrames: () => Promise<Frame[] | undefined> = async () => [],
	) {
		this.#readFrame = readFrame;
		this.#readRoster = roster;
		this.#readPageFrames = readPageFrames;
		this.#browserPid = browserPid;
	}

	/** Remembers what is on screen; `pageStopped` skips reading the page, which a dialog keeps from answering. */
	beginCall(pageStopped: boolean): void {
		this.#pageStopped = pageStopped;
		const roster = this.#readRoster();
		if (this.#tailTimer) this.#catchingUp = this.#catchUp(roster);
		this.#before = roster;
	}

	/**
	 * One line per window that appeared during the call or just after the previous one; empty when none did.
	 * `pageDialog` says the page waits on its own JavaScript dialog: Chrome draws that as an ordinary window over the
	 * tab, and the page-waiting report already names it, so ordinary windows are left out while it is open.
	 */
	async endCall(pageDialog = false): Promise<string[]> {
		await this.#catchingUp;
		this.#catchingUp = undefined;
		const before = this.#before;
		this.#remember(before);
		this.#pageStopped = pageDialog;
		const frame = pageDialog ? undefined : await this.#readFrame();
		const late = this.#late;
		this.#before = undefined;
		this.#late = [];
		const after = this.#readRoster();
		if (!before || !after) {
			this.#remember(after);
			return [];
		}
		if (!pageDialog) this.#visible = frame?.visible ?? false;
		this.#findTab(after, frame);
		const lines: string[] = [];
		const onScreen = new Set(after.map(window => window.id));
		for (const window of late) {
			if (onScreen.has(window.id) && !(pageDialog && window.layer === 0)) {
				lines.push(this.#line(window, "after the previous browser call returned"));
			}
		}
		for (const window of await this.#raised(after)) {
			if (!(pageDialog && window.layer === 0)) lines.push(this.#line(window, "during this call"));
		}
		this.#remember(after);
		this.#tailTimer = setTimeout(() => {
			this.#catchingUp = this.#catchUp(this.#readRoster());
		}, TAIL_MS);
		this.#tailTimer.unref();
		return lines;
	}

	/** Takes the windows that showed since the previous call returned, while that is within the tail. */
	async #catchUp(roster: DesktopRosterWindow[] | undefined): Promise<void> {
		clearTimeout(this.#tailTimer);
		this.#tailTimer = undefined;
		if (!roster) return;
		const stopped = this.#pageStopped;
		const frame = stopped ? undefined : await this.#readFrame();
		if (!stopped) this.#visible = frame?.visible ?? false;
		this.#findTab(roster, frame);
		this.#late.push(...(await this.#raised(roster)));
		this.#remember(roster);
	}

	#remember(roster: DesktopRosterWindow[] | undefined): void {
		if (!roster) return;
		if (this.#seen.size > SEEN_LIMIT) this.#seen = new Set();
		for (const window of roster) this.#seen.add(window.id);
	}

	/**
	 * The tab's window: one ordinary window at its current visible frame. A retained window must still match that
	 * frame, since the user can drag a tab into another window. Without a frame, only a retained on-screen id survives.
	 */
	#findTab(roster: DesktopRosterWindow[], frame: TabView | undefined): void {
		const kept = this.#tab && roster.find(window => window.id === this.#tab?.id);
		if (!frame?.visible) {
			this.#tab = kept;
			return;
		}
		const matches = roster.filter(
			window =>
				window.layer === 0 &&
				(this.#browserPid === undefined || window.pid === this.#browserPid) &&
				sameFrame(window, frame),
		);
		this.#tab = matches.length === 1 ? matches[0] : undefined;
	}

	/** The windows in `roster` never seen before that the tab's browser raised over the tab while the page showed. */
	async #raised(roster: DesktopRosterWindow[]): Promise<DesktopRosterWindow[]> {
		const tab = this.#tab;
		if (!tab || !this.#visible) return [];
		const current = roster.find(window => window.id === tab.id) ?? tab;
		const raised = roster.filter(
			window =>
				!this.#seen.has(window.id) &&
				window.pid === tab.pid &&
				window.alpha > 0 &&
				window.width >= 2 &&
				window.height >= 2 &&
				(window.layer >= FLOATING_LAYER
					? intersects(window, current)
					: window.layer === 0 && within(window, current)) &&
				// A popup shared by overlapping browser windows cannot be tied to this tab.
				!roster.some(
					other =>
						other.id !== current.id &&
						other.id !== window.id &&
						other.pid === tab.pid &&
						other.layer === 0 &&
						other.alpha > 0 &&
						intersects(window, other),
				),
		);
		if (!raised.some(window => window.layer === 0)) return raised;
		const pages = await this.#readPageFrames();
		return raised.filter(
			window => window.layer !== 0 || (pages !== undefined && !pages.some(frame => sameFrame(window, frame))),
		);
	}

	#line(window: DesktopRosterWindow, when: string): string {
		const what =
			window.layer >= MENU_LAYER
				? "a popup list or picker (a <select>'s menu, or a colour or date picker; set the value with tab.select or tab.fill instead)"
				: window.layer >= FLOATING_LAYER
					? "a floating panel"
					: "a dialog over the tab (print, save, sign-in, passkey or permission)";
		return `The browser opened ${what} ${when}. ${handle(window)}`;
	}
}

function sameFrame(window: Frame, frame: Frame): boolean {
	return (
		Math.abs(window.x - frame.x) <= 2 &&
		Math.abs(window.y - frame.y) <= 2 &&
		Math.abs(window.width - frame.width) <= 2 &&
		Math.abs(window.height - frame.height) <= 2
	);
}

/** The on-screen windows, or undefined when the roster cannot be read (off macOS it is empty). */
function readRoster(): DesktopRosterWindow[] | undefined {
	try {
		return desktopWindowRoster();
	} catch {
		return undefined;
	}
}

function intersects(window: Frame, tab: Frame): boolean {
	return (
		window.x < tab.x + tab.width &&
		tab.x < window.x + window.width &&
		window.y < tab.y + tab.height &&
		tab.y < window.y + window.height
	);
}

/** Inside the tab's window and smaller than it: a sheet or bubble over the tab, not another browser window. */
function within(window: Frame, tab: Frame): boolean {
	return (
		window.x >= tab.x - 1 &&
		window.y >= tab.y - 1 &&
		window.x + window.width <= tab.x + tab.width + 1 &&
		window.y + window.height <= tab.y + tab.height + 1 &&
		window.width * window.height < tab.width * tab.height * 0.9
	);
}

/** How the agent reaches the window: the page cannot, the computer tool can. */
function handle(window: DesktopRosterWindow): string {
	const size = `${Math.round(window.width)}x${Math.round(window.height)}`;
	return window.listed
		? `It is on the user's screen, outside the page: computer.window(${window.id}) (${size}) reads, answers or closes it.`
		: `It is on the user's screen, outside the page; computer.screenshot() shows it (window ${window.id}, ${size}).`;
}
