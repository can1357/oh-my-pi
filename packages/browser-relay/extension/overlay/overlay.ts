/**
 * The page overlay for one document: owns the single host element the overlay ever adds to a page, and routes the
 * worker's {@link OverlayCommand}s to the arrow, the presence chrome, the favicon and the pickers.
 *
 * The host is appended once and then left alone (no attributes, no re-insertion) until `unmount`: a click's
 * delivery check watches the page for mutations, and everything the overlay draws happens inside the closed shadow
 * root where that check can't see it.
 */
import {
	OVERLAY_HOST_TAG,
	type OverlayCommand,
	type OverlayEvent,
	type PickResult,
	SETTINGS_KEY,
	type TabActivity,
} from "../messages";
import { afterFrames, el } from "./dom";
import { Favicon } from "./favicon";
import { Picker } from "./picker";
import { Pointer } from "./pointer";
import { Presence } from "./presence";
import { OVERLAY_CSS } from "./styles";

/** A `hide` whose `show` never arrives is forgiven after this long, so a dead capture can't blank the overlay. */
const CONCEAL_LIMIT_MS = 15_000;

/** The user's overlay switches from the panel's settings; everything is on until they say otherwise. */
interface Switches {
	enabled: boolean;
	arrow: boolean;
	edge: boolean;
}

/** Read the overlay switches out of whatever is stored under {@link SETTINGS_KEY}. */
function readSwitches(settings: unknown): Switches {
	const stored: unknown =
		typeof settings === "object" && settings !== null && "overlay" in settings ? settings.overlay : null;
	const overlay = typeof stored === "object" && stored !== null ? stored : {};
	return {
		enabled: !("enabled" in overlay && overlay.enabled === false),
		arrow: !("arrow" in overlay && overlay.arrow === false),
		edge: !("edge" in overlay && overlay.edge === false),
	};
}

/** Everything that exists only while the overlay is mounted. */
interface Mounted {
	host: HTMLElement;
	stage: HTMLElement;
	pickerLayer: HTMLElement;
	pointer: Pointer;
	presence: Presence;
	picker: Picker;
	favicon: Favicon;
	listeners: AbortController;
}

/** What a command answers through `sendResponse`. */
export type OverlayAnswer = true | PickResult | null;

/** The overlay controller; one per document, living as long as the content script's context does. */
export class Overlay {
	#mounted: Mounted | null = null;
	#switches: Switches = { enabled: true, arrow: true, edge: true };
	#activity: TabActivity = { state: "idle" };
	#role: "main" | "secondary" = "main";
	/** Captures in flight that asked for an invisible overlay. */
	#conceals = 0;
	#concealTimer: number | undefined;
	readonly #storageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
		if (area === "local" && SETTINGS_KEY in changes) this.#applySwitches(readSwitches(changes[SETTINGS_KEY].newValue));
	};

	constructor() {
		chrome.storage.onChanged.addListener(this.#storageListener);
		void chrome.storage.local.get(SETTINGS_KEY).then(
			stored => this.#applySwitches(readSwitches(stored[SETTINGS_KEY])),
			() => {
				// No settings to read (the extension is going away): the defaults stand.
			},
		);
	}

	/** Run one worker command and produce its answer. */
	async handle(command: OverlayCommand): Promise<OverlayAnswer> {
		switch (command.op) {
			case "mount":
				this.#mount();
				return true;
			case "unmount":
				this.#unmount();
				return true;
			case "input":
				if (this.#switches.enabled && this.#switches.arrow) this.#mount().pointer.input(command.input);
				return true;
			case "activity":
				this.#activity = command.activity;
				this.#role = command.role;
				// An idle tab that never had an overlay doesn't need one to show nothing.
				if (command.activity.state !== "idle" || this.#mounted) this.#showActivity(this.#mount());
				return true;
			case "hide":
				this.#conceals++;
				clearTimeout(this.#concealTimer);
				this.#concealTimer = window.setTimeout(() => {
					this.#conceals = 0;
					this.#syncConcealed();
				}, CONCEAL_LIMIT_MS);
				if (!this.#mounted) return true;
				this.#syncConcealed();
				// One frame to commit the style, one for the compositor to present it.
				await afterFrames(2);
				return true;
			case "show":
				this.#conceals = Math.max(0, this.#conceals - 1);
				if (this.#conceals === 0) clearTimeout(this.#concealTimer);
				this.#syncConcealed();
				return true;
			case "pick":
				return await this.#mount().picker.pick(command.mode);
			case "cancelPick":
				this.#mounted?.picker.cancel();
				return true;
			case "stopAck":
				this.#mounted?.presence.stopAck(command.delivered);
				return true;
		}
	}

	/** Remove everything from the page; the extension context behind this overlay is gone or going. */
	dispose(): void {
		this.#unmount();
		try {
			chrome.storage.onChanged.removeListener(this.#storageListener);
		} catch {
			// An invalidated extension context has no listeners left to remove.
		}
	}

	#mount(): Mounted {
		if (this.#mounted) return this.#mounted;
		// A host left by a content script whose extension context died can't be reused: its shadow root is closed.
		for (const stale of document.querySelectorAll(OVERLAY_HOST_TAG)) stale.remove();

		const host = document.createElement(OVERLAY_HOST_TAG);
		const shadow = host.attachShadow({ mode: "closed" });
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(OVERLAY_CSS);
		shadow.adoptedStyleSheets = [sheet];

		const presence = new Presence(op => {
			const event: OverlayEvent = { omp: "overlay-event", op };
			try {
				// The worker answers `true`; a Stop it can't deliver comes back as `stopAck`, or as silence.
				chrome.runtime.sendMessage(event).catch(() => {});
			} catch {
				// The extension context is gone; `main.ts` notices and removes this overlay.
			}
		});
		const pointer = new Pointer(point => presence.aim(point));
		const stage = el("div", "stage", ...presence.layers, pointer.layer);
		const pickerLayer = el("div", "picker");
		shadow.append(stage, pickerLayer);

		const listeners = new AbortController();
		const { signal } = listeners;
		window.addEventListener("resize", () => pointer.relayout(), { passive: true, signal });
		// A page kept in the back/forward cache must not come back still claiming omp is working.
		window.addEventListener("pagehide", () => this.#quiet(), { signal });

		const mounted: Mounted = {
			host,
			stage,
			pickerLayer,
			pointer,
			presence,
			picker: new Picker(pickerLayer, host, () => presence.occupied()),
			favicon: new Favicon(),
			listeners,
		};
		this.#mounted = mounted;
		this.#syncConcealed();
		this.#applySwitches(this.#switches);
		document.documentElement.append(host);
		return mounted;
	}

	#unmount(): void {
		const mounted = this.#mounted;
		if (!mounted) return;
		this.#mounted = null;
		this.#activity = { state: "idle" };
		mounted.listeners.abort();
		mounted.picker.cancel();
		mounted.favicon.dispose();
		mounted.host.remove();
	}

	/** Drop to idle without unmounting: the page is leaving, and the worker restores state if it comes back. */
	#quiet(): void {
		const mounted = this.#mounted;
		if (!mounted) return;
		this.#activity = { state: "idle" };
		mounted.picker.cancel();
		this.#showActivity(mounted);
	}

	#showActivity(mounted: Mounted): void {
		const activity = this.#activity;
		const working = activity.state === "working" && this.#role === "main";
		mounted.presence.setActivity(activity, this.#role);
		mounted.favicon.set(working && this.#switches.enabled);
		mounted.pointer.setPersistent(working);
		// The arrow belongs to a turn: it leaves when the turn ends or waits on the user.
		if (activity.state !== "working") mounted.pointer.clear();
	}

	#applySwitches(switches: Switches): void {
		this.#switches = switches;
		const mounted = this.#mounted;
		if (!mounted) return;
		mounted.stage.classList.toggle("off", !switches.enabled);
		mounted.presence.setEdgeEnabled(switches.edge);
		mounted.favicon.set(switches.enabled && this.#role === "main" && this.#activity.state === "working");
		if (!switches.enabled || !switches.arrow) mounted.pointer.clear();
	}

	#syncConcealed(): void {
		const mounted = this.#mounted;
		if (!mounted) return;
		const concealed = this.#conceals > 0;
		mounted.stage.classList.toggle("concealed", concealed);
		mounted.pickerLayer.classList.toggle("concealed", concealed);
	}
}
