import type { DesktopRosterWindow } from "@oh-my-pi/pi-natives";
import { desktopWindowRoster } from "@oh-my-pi/pi-natives/desktop";
import { isRecord, prompt, withTimeout } from "@oh-my-pi/pi-utils";
import type { Browser, Page } from "puppeteer-core";
import { probeCdpResponse } from "./attach";
import nativeWindowNotice from "../../prompts/tools/browser-native-window.md" with { type: "text" };

/** Longest a call waits to read where the tab's window is on screen. */
const FRAME_TIMEOUT_MS = 300;
/** Longest a call waits for the browser's tab list to say whether its tab is the one in front. */
const TAB_LIST_TIMEOUT_MS = 300;
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

/**
 * The tab list that says whether a call's tab is the one in front of its window. The page cannot say: omp
 * focus-emulates every tab it drives, which keeps a background tab's `document.visibilityState` "visible".
 * - `chrome`: Chrome's own `/json/list`, which ranks pages by when each was last shown, or created if never shown.
 * - `relay`: the omp relay's `/json/list`, whose `active` marks the extension's selected tab of each window.
 */
export type FrontTabSource = "chrome" | "relay";

/** Where the tab's window is on screen, in the points the window server reports; undefined if the page cannot say. */
export async function readTabFrame(page: Pick<Page, "mainFrame">): Promise<Frame | undefined> {
	const read = page
		.mainFrame()
		.isolatedRealm()
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
 * Whether one tab is the one in front of its window, by the tab list served at `/json/list` beside `endpoint`, the
 * browser endpoint its worker drives. `windowOf` names the browser window a target is in.
 *
 * The relay's entries carry the extension's `active`, the selected tab of each window. Chrome lists pages most
 * recently shown first: `DevToolsHttpHandler::RespondToJsonList` sorts by `GetLastActivityTime()`, which for a page is
 * its `WebContents::GetLastActiveTimeTicks()`. Chrome sets that when the tab is created and whenever it is updated
 * while visible with `is_activity` (`WebContentsImpl::UpdateVisibilityAndNotifyPageAndView`); a hidden tab is left
 * alone, so focus emulation and captures of a background tab do not move it. A tab listed after another page of its
 * window is behind it. One listed before every other page of its window is in front only if it has been shown, since
 * a tab never shown ranks by its creation: a tab opened in the background itself reads first until another tab of its
 * window is shown. omp knows a tab was shown when it opened the tab in front of its window, when its page reports a
 * browser window's place (see {@link NativeWindowWatch}), or once the list places the tab ahead of a page a read saw
 * listed before it, which it cannot pass without being shown. A tab alone in its window is in front of it.
 */
export class FrontTab {
	readonly #source: FrontTabSource;
	readonly #endpoint: string;
	readonly #targetId: string;
	readonly #windowOf: (targetId: string) => Promise<number>;
	/** Whether the tab has been shown since it opened, so Chrome ranks it by when it was last shown. */
	#shown: boolean;
	/** Pages of the tab's window that some read listed before it, while it was not known to have been shown. */
	#ahead = new Set<string>();

	/** `openedInFront`: omp opened the tab in front of its window, which shows it. */
	constructor(
		source: FrontTabSource,
		endpoint: string,
		targetId: string,
		windowOf: (targetId: string) => Promise<number>,
		openedInFront: boolean,
	) {
		this.#source = source;
		this.#endpoint = endpoint;
		this.#targetId = targetId;
		this.#windowOf = windowOf;
		this.#shown = openedInFront;
	}

	/**
	 * Whether the tab is in front of its window now; undefined when the list cannot be read or cannot say. `shown`: the
	 * caller has proof the tab has been shown.
	 */
	async read(shown = false): Promise<boolean | undefined> {
		if (shown) this.#shown = true;
		const read = (async () => {
			const response = await probeCdpResponse(`http://${new URL(this.#endpoint).host}/json/list`, {
				timeoutMs: TAB_LIST_TIMEOUT_MS,
			});
			if (response?.status !== 200) return undefined;
			return await this.inFront(JSON.parse(Buffer.from(response.body, "latin1").toString("utf8")));
		})().catch(() => undefined);
		return await withTimeout(read, TAB_LIST_TIMEOUT_MS, "Timed out reading the tab list").catch(() => undefined);
	}

	/**
	 * Whether `list`, one `/json/list` answer, shows the tab in front of its window; undefined when it cannot say: not a
	 * list, the tab missing from it, or a window that cannot be read. `shown`: as for {@link read}.
	 */
	async inFront(list: unknown, shown = false): Promise<boolean | undefined> {
		if (shown) this.#shown = true;
		if (!Array.isArray(list)) return undefined;
		const pages = list.filter(
			(entry): entry is { id: string; active?: unknown } =>
				isRecord(entry) && entry.type === "page" && typeof entry.id === "string",
		);
		const index = pages.findIndex(entry => entry.id === this.#targetId);
		if (index === -1) return undefined;
		if (this.#source === "relay") {
			const active = pages[index]!.active;
			return active === "true" ? true : active === "false" ? false : undefined;
		}
		const ids = pages.map(entry => entry.id);
		const windowsOf = (from: number, to: number) => Promise.all(ids.slice(from, to).map(id => this.#windowOf(id)));
		let windows: number[];
		try {
			windows = await windowsOf(0, index + 1);
		} catch {
			return undefined;
		}
		const own = windows[index];
		const before = ids.slice(0, index).filter((_, i) => windows[i] === own);
		if (this.#shown) return before.length === 0;
		if (before.length > 0) {
			this.#ahead = new Set(before);
			return false;
		}
		// Listed first but not known to have been shown: in front only alone in its window, or once it passes a page
		// that a read saw listed before it.
		let later: number[];
		try {
			later = await windowsOf(index + 1, ids.length);
		} catch {
			return undefined;
		}
		const after = ids.slice(index + 1).filter((_, i) => later[i] === own);
		// Only ever set: an abandoned read finishing late must not undo a proof a newer read was given.
		if (after.some(id => this.#ahead.has(id))) this.#shown = true;
		this.#ahead = new Set();
		return after.length === 0 || this.#shown;
	}
}

/**
 * Reports the native windows a browser call raised over its tab that no page or CDP call can see or answer: the
 * browser's own popup menus and pickers, panels, and the sheets and bubbles over the tab (permission, passkey,
 * sign-in, save), each with the computer tool's handle. Only windows the tab's browser process owns, over the tab's
 * own window, that were never on screen before count, and only while the browser's tab list shows the tab in front
 * of that window: a background tab shares its window with the tab in front, whose menus are not its own. When the
 * list cannot say, nothing is named. One that shows within the tail after a call returned is named by the next call.
 * macOS only, and only for browsers that show windows; a call when nothing appeared adds nothing. System-owned prompts
 * (Touch ID, keychain) are not reported: nothing on screen ties them to the tab.
 *
 * A page learns its window's place only while shown in it (`RenderWidgetHostImpl::SendScreenRects` skips hidden
 * widgets, and a Mac view knows its window's frame only once in one), so a page never shown reports the screen
 * origin. A frame elsewhere that matches exactly one window of the browser's process proves the tab has been shown,
 * which the tab list needs (see {@link FrontTab}).
 */
export class NativeWindowWatch {
	readonly #readFrame: () => Promise<Frame | undefined>;
	readonly #readFront: (shown: boolean) => Promise<boolean | undefined>;
	readonly #readRoster: () => DesktopRosterWindow[] | undefined;
	readonly #browserPid: number | undefined;
	readonly #readPageFrames: () => Promise<Frame[] | undefined>;
	/** The tab's own window, once its frame named exactly one while the tab was in front. */
	#tab: DesktopRosterWindow | undefined;
	/** Whether the browser's tab list showed the tab in front of its window at the last read. */
	#front = false;
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
		readFrame: () => Promise<Frame | undefined>,
		readFront: (shown: boolean) => Promise<boolean | undefined>,
		roster: () => DesktopRosterWindow[] | undefined = readRoster,
		browserPid?: number,
		readPageFrames: () => Promise<Frame[] | undefined> = async () => [],
	) {
		this.#readFrame = readFrame;
		this.#readFront = readFront;
		this.#readRoster = roster;
		this.#readPageFrames = readPageFrames;
		this.#browserPid = browserPid;
	}

	/** Remembers what is on screen; `pageStopped` skips the page's frame, which a dialog keeps from answering. */
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
		const late = this.#late;
		this.#before = undefined;
		this.#late = [];
		const frame = pageDialog ? undefined : await this.#readFrame();
		const after = this.#readRoster();
		if (!before || !after) {
			this.#remember(after);
			return [];
		}
		this.#front = (await this.#readFront(this.#proves(after, frame))) === true;
		this.#findTab(after, frame);
		const lines: string[] = [];
		const onScreen = new Set(after.map(window => window.id));
		for (const window of late) {
			if (onScreen.has(window.id) && !(pageDialog && window.layer === 0)) {
				lines.push(notice(window, true));
			}
		}
		for (const window of await this.#raised(after)) {
			if (!(pageDialog && window.layer === 0)) lines.push(notice(window, false));
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
		const frame = this.#pageStopped ? undefined : await this.#readFrame();
		this.#front = (await this.#readFront(this.#proves(roster, frame))) === true;
		this.#findTab(roster, frame);
		this.#late.push(...(await this.#raised(roster)));
		this.#remember(roster);
	}

	#remember(roster: DesktopRosterWindow[] | undefined): void {
		if (!roster) return;
		if (this.#seen.size > SEEN_LIMIT) this.#seen = new Set();
		for (const window of roster) this.#seen.add(window.id);
	}

	/** Whether `frame`, off the screen origin, matches exactly one window of the browser's known process. */
	#proves(roster: DesktopRosterWindow[], frame: Frame | undefined): boolean {
		if (!frame || (frame.x === 0 && frame.y === 0) || this.#browserPid === undefined) return false;
		return this.#windowsAt(roster, frame).length === 1;
	}

	/** The ordinary windows at `frame`, of the browser's process when that is known. */
	#windowsAt(roster: DesktopRosterWindow[], frame: Frame): DesktopRosterWindow[] {
		return roster.filter(
			window =>
				window.layer === 0 &&
				(this.#browserPid === undefined || window.pid === this.#browserPid) &&
				sameFrame(window, frame),
		);
	}

	/**
	 * The tab's window: one ordinary window at the tab's frame while the tab is in front. A retained window must still
	 * match that frame, since the user can drag a tab into another window. Without a frame, or while another tab is in
	 * front (a background page keeps the frame it last showed at), only a retained on-screen id survives.
	 */
	#findTab(roster: DesktopRosterWindow[], frame: Frame | undefined): void {
		const kept = this.#tab && roster.find(window => window.id === this.#tab?.id);
		if (!frame || !this.#front) {
			this.#tab = kept;
			return;
		}
		const matches = this.#windowsAt(roster, frame);
		this.#tab = matches.length === 1 ? matches[0] : undefined;
	}

	/** The windows in `roster` never seen before that the tab's browser raised over the tab while it was in front. */
	async #raised(roster: DesktopRosterWindow[]): Promise<DesktopRosterWindow[]> {
		const tab = this.#tab;
		if (!tab || !this.#front) return [];
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

/** What the browser raised, when, and how the agent reaches it: the page cannot, the computer tool can. */
function notice(window: DesktopRosterWindow, previous: boolean): string {
	return prompt
		.render(nativeWindowNotice, {
			menu: window.layer >= MENU_LAYER,
			floating: window.layer >= FLOATING_LAYER,
			previous,
			listed: window.listed,
			id: window.id,
			size: `${Math.round(window.width)}x${Math.round(window.height)}`,
		})
		.trim();
}
