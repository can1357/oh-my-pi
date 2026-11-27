/** The lifecycle of an already-started prepaint frame, without loading the interactive UI. */
import type { AppFrame } from "./interactive/frame";
import type { StartupCache, StartupPreferences } from "./interactive/startup-cache";
import type { ComposerThemePreferences } from "./view-model/prompt/composer-cache";

/** Final settings pushed into the live frame after Settings and the theme resolve. */
export interface PrepaintComposerPreferences extends StartupPreferences {
	readonly theme: ComposerThemePreferences;
}

interface PendingFrame {
	readonly frame: AppFrame;
	/** Settles once the frame drew its first frame. */
	readonly started: Promise<void>;
	readonly cwd: string;
	/** Speculation store to refresh; `undefined` when caching is off or unavailable. */
	readonly cache: StartupCache | undefined;
	/** Drops the prepaint key handler (emergency Ctrl+C / Ctrl+D). */
	readonly releaseKeys: () => void;
}

let pending: PendingFrame | undefined;

/** Start and hold the one prepaint frame until the interactive mode takes it. */
export function ownStartupFrame(start: () => PendingFrame): void {
	if (pending) throw new Error("A prepaint composer is already active");
	pending = start();
}

/** Ownership token that transfers one started frame to InteractiveMode. */
export class ComposerLease {
	readonly frame: AppFrame;
	/** Settles once the frame drew its first frame (the interactive mode adopts a started frame). */
	readonly ready: Promise<void>;
	readonly #releaseKeys: () => void;
	#adopted = false;

	constructor(frame: AppFrame, ready: Promise<void>, releaseKeys: () => void) {
		this.frame = frame;
		this.ready = ready;
		this.#releaseKeys = releaseKeys;
	}

	/**
	 * The interactive mode owns the frame from now on. The emergency keys stay live until its own key
	 * handlers are installed ({@link AppFrame.releaseStartupKeys}): a stalled startup still exits.
	 */
	adopt(): void {
		if (this.#adopted) return;
		this.frame.holdStartupKeys(this.#releaseKeys);
		this.#adopted = true;
	}

	/** Stop an unadopted frame when startup exits before InteractiveMode. */
	dispose(): void {
		if (this.#adopted) return;
		this.#releaseKeys();
		void this.frame.shell.stop();
	}
}

/** Take the prepaint frame away from the module-level startup owner. */
export function takeStartupComposerLease(): ComposerLease | undefined {
	const current = pending;
	pending = undefined;
	return current ? new ComposerLease(current.frame, current.started, current.releaseKeys) : undefined;
}

/** Stop and forget a prepaint frame that never reached InteractiveMode. */
export function stopPendingStartupComposer(): void {
	const current = pending;
	if (!current) return;
	pending = undefined;
	current.releaseKeys();
	void current.frame.shell.stop();
}

/** Apply the resolved settings to the pending frame and cache them for the next first frame. */
export function applyStartupComposerPreferences(update: PrepaintComposerPreferences): void {
	const current = pending;
	if (!current) return;
	const { theme, ...preferences } = update;
	const { frame } = current;
	frame.setShape(preferences.composerShape);
	frame.setQuiet(preferences.quiet);
	frame.composer.setVim(preferences.vim);
	frame.composer.setAutocompleteMaxVisible(preferences.autocompleteMaxVisible);
	frame.setImeSafeCursor(preferences.imeSafeCursor);
	// A stale cached mode switches live: the commit frontier keeps every block written once.
	frame.screen.set(preferences.screen);
	current.cache?.write(current.cwd, preferences, theme);
}
