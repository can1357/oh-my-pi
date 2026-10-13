import type { DesktopRosterWindow } from "@oh-my-pi/pi-natives";
import { desktopWindowRoster } from "@oh-my-pi/pi-natives/desktop";
import type { Page } from "puppeteer-core";

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

/** Where the tab's window is on screen, in the points the window server reports; undefined if the page cannot say. */
export async function readTabFrame(page: Pick<Page, "evaluate">): Promise<Frame | undefined> {
	const read = page
		.evaluate(() => {
			const view = globalThis as unknown as {
				screenX: number;
				screenY: number;
				outerWidth: number;
				outerHeight: number;
			};
			return { x: view.screenX, y: view.screenY, width: view.outerWidth, height: view.outerHeight };
		})
		.catch(() => undefined);
	return await Promise.race([read, Bun.sleep(FRAME_TIMEOUT_MS).then(() => undefined)]);
}

/**
 * Reports the native windows a browser call raised over its tab that no page or CDP call can see or answer: the
 * browser's own popup menus and pickers, panels, and the sheets and bubbles over the tab (permission, passkey,
 * sign-in, save), each with the computer tool's handle. Only windows the tab's browser process owns, over the tab's
 * own window, that were never on screen before count; one that shows within {@link TAIL_MS} after a call returned
 * is named by the next call. macOS only, and only for browsers that show windows; a call when nothing appeared adds
 * nothing. System-owned prompts (Touch ID, keychain) are not reported: nothing on screen ties them to the tab.
 */
export class NativeWindowWatch {
	readonly #readFrame: () => Promise<Frame | undefined>;
	readonly #readRoster: () => DesktopRosterWindow[] | undefined;
	/** The tab's own window, once its frame named exactly one. */
	#tab: DesktopRosterWindow | undefined;
	/** Every window id on screen at some read: one coming back (restored, un-minimised) did not just open. */
	#seen = new Set<string>();
	/** On-screen windows when the call began. */
	#before: DesktopRosterWindow[] | undefined;
	#frame: Promise<Frame | undefined> | undefined;
	/** Windows that showed within the tail after the previous call returned, for this call to name. */
	#late: DesktopRosterWindow[] = [];
	#tailTimer: NodeJS.Timeout | undefined;

	constructor(
		readFrame: () => Promise<Frame | undefined>,
		roster: () => DesktopRosterWindow[] | undefined = readRoster,
	) {
		this.#readFrame = readFrame;
		this.#readRoster = roster;
	}

	/** Remembers what is on screen; `pageStopped` skips reading the page, which a dialog keeps from answering. */
	beginCall(pageStopped: boolean): void {
		const roster = this.#readRoster();
		if (this.#tailTimer) this.#catchUp(roster);
		this.#before = roster;
		this.#remember(roster);
		this.#frame = pageStopped ? undefined : this.#readFrame();
	}

	/**
	 * One line per window that appeared during the call or just after the previous one; empty when none did.
	 * `pageDialog` says the page waits on its own JavaScript dialog: Chrome draws that as an ordinary window over the
	 * tab, and the page-waiting report already names it, so ordinary windows are left out while it is open.
	 */
	async endCall(pageDialog = false): Promise<string[]> {
		const before = this.#before;
		const frame = await this.#frame;
		const late = this.#late;
		this.#before = undefined;
		this.#frame = undefined;
		this.#late = [];
		const after = this.#readRoster();
		if (!before || !after) {
			this.#remember(after);
			return [];
		}
		this.#findTab(before, frame);
		const lines: string[] = [];
		const onScreen = new Set(after.map(window => window.id));
		for (const window of late) {
			if (onScreen.has(window.id) && !(pageDialog && window.layer === 0)) {
				lines.push(this.#line(window, "after the previous browser call returned"));
			}
		}
		for (const window of this.#raised(after)) {
			if (!(pageDialog && window.layer === 0)) lines.push(this.#line(window, "during this call"));
		}
		this.#remember(after);
		this.#tailTimer = setTimeout(() => this.#catchUp(this.#readRoster()), TAIL_MS);
		this.#tailTimer.unref();
		return lines;
	}

	/** Takes the windows that showed since the previous call returned, while that is within the tail. */
	#catchUp(roster: DesktopRosterWindow[] | undefined): void {
		clearTimeout(this.#tailTimer);
		this.#tailTimer = undefined;
		if (!roster) return;
		this.#late.push(...this.#raised(roster));
		this.#remember(roster);
	}

	#remember(roster: DesktopRosterWindow[] | undefined): void {
		if (!roster) return;
		if (this.#seen.size > SEEN_LIMIT) this.#seen = new Set();
		for (const window of roster) this.#seen.add(window.id);
	}

	/**
	 * The tab's window: the one ordinary window at the frame the page reports. Kept while it stays on screen, since
	 * another app's window may come to share its frame; when two windows match, none is taken.
	 */
	#findTab(roster: DesktopRosterWindow[], frame: Frame | undefined): void {
		const kept = this.#tab && roster.find(window => window.id === this.#tab?.id);
		if (kept) {
			this.#tab = kept;
			return;
		}
		if (!frame) return;
		const matches = roster.filter(
			window =>
				window.layer === 0 &&
				Math.abs(window.x - frame.x) <= 2 &&
				Math.abs(window.y - frame.y) <= 2 &&
				Math.abs(window.width - frame.width) <= 2 &&
				Math.abs(window.height - frame.height) <= 2,
		);
		if (matches.length === 1) this.#tab = matches[0];
	}

	/** The windows in `roster` never seen before that the tab's browser raised over the tab. */
	#raised(roster: DesktopRosterWindow[]): DesktopRosterWindow[] {
		const tab = this.#tab;
		if (!tab) return [];
		const current = roster.find(window => window.id === tab.id) ?? tab;
		return roster.filter(
			window =>
				!this.#seen.has(window.id) &&
				window.pid === tab.pid &&
				window.alpha > 0 &&
				window.width >= 2 &&
				window.height >= 2 &&
				(window.layer >= FLOATING_LAYER
					? intersects(window, current)
					: window.layer === 0 && within(window, current)),
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

/** The on-screen windows, or undefined when the roster cannot be read (off macOS it is empty). */
function readRoster(): DesktopRosterWindow[] | undefined {
	try {
		return desktopWindowRoster().windows;
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
