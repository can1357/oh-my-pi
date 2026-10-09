import type { Terminal } from "@oh-my-pi/pi-tui";
import {
	COMPOSER_DEFAULTS,
	Composer,
	type ComposerPreferences,
	type ComposerWelcomeUpdate,
} from "@oh-my-pi/pi-tui/prompt/composer";
import {
	type ComposerCache,
	type ComposerThemePreferences,
	sharedComposerCache,
} from "@oh-my-pi/pi-tui/prompt/composer-cache";
import { setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { initThemeSync } from "@oh-my-pi/pi-tui/theme";
import { MAGIC_KEYWORDS } from "./magic-keywords";

/** Inputs available at the CLI prepaint boundary before command modules load. */
export interface PrepaintComposerOptions {
	readonly terminal?: Terminal;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
	readonly version?: string;
	readonly cwd?: string;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly theme?: ComposerThemePreferences;
	readonly cache?: boolean;
	/** Whether this launch shape can auto-resume the cached session. */
	readonly allowSessionUsage?: boolean;
}

/** Final settings pushed into the live composer after Settings and the theme resolve. */
export interface PrepaintComposerPreferences extends ComposerPreferences {
	readonly theme: ComposerThemePreferences;
	readonly autoResume: boolean;
}

interface PendingComposer {
	readonly composer: Composer;
	readonly cwd: string;
	/** Speculation store to refresh; `undefined` when caching is off or unavailable. */
	readonly cache: ComposerCache | undefined;
}

let pendingComposer: PendingComposer | undefined;

/** Ownership token that transfers one already-started Composer to InteractiveMode. */
export class ComposerLease {
	readonly composer: Composer;
	#adopted = false;

	constructor(composer: Composer) {
		this.composer = composer;
	}

	/** Transfer terminal ownership exactly once. */
	adopt(): void {
		if (this.#adopted) return;
		// Safety net: startup paths that never applied resolved settings must
		// still hand InteractiveMode a raw-input terminal.
		this.composer.enableInput();
		this.composer.transfer();
		this.#adopted = true;
	}

	/** Stop an unadopted composer when startup exits before InteractiveMode. */
	dispose(): void {
		if (!this.#adopted) this.composer.stop();
	}
}

/** Start the canonical Composer with speculative cached state. */
export function beginStartupComposer(options: PrepaintComposerOptions = {}): void {
	if (pendingComposer) throw new Error("A prepaint composer is already active");
	const cwd = options.cwd ?? process.cwd();
	const cache = options.cache === false ? undefined : sharedComposerCache();
	const cached = cache
		? cache.read(cwd, { allowSessionUsage: options.allowSessionUsage })
		: { preferences: undefined, theme: undefined, status: undefined };
	const theme = { ...cached.theme, ...options.theme };
	initThemeSync(theme.symbolPreset, theme.colorBlindMode, theme.darkTheme, theme.lightTheme);
	setMagicKeywords(MAGIC_KEYWORDS);
	const preferences = { ...COMPOSER_DEFAULTS, ...cached.preferences, ...options.preferences };
	const welcome: ComposerWelcomeUpdate = { version: options.version ?? "" };
	const composer = new Composer({
		terminal: options.terminal,
		exit: options.exit,
		now: options.now,
		preferences,
		welcome,
		status: cached.status,
	});
	try {
		composer.start({ clearScrollback: true, deferInput: true });
	} catch (error) {
		try {
			composer.stop();
		} catch {}
		throw error;
	}
	pendingComposer = { composer, cwd, cache };
}

/** Take the live prepaint composer away from the module-level startup owner. */
export function takeStartupComposerLease(): ComposerLease | undefined {
	const pending = pendingComposer;
	pendingComposer = undefined;
	return pending ? new ComposerLease(pending.composer) : undefined;
}

/** Stop and forget any prepaint composer that never reached InteractiveMode. */
export function stopPendingStartupComposer(): void {
	pendingComposer?.composer.stop();
	pendingComposer = undefined;
}

/** Apply final settings to the pending Composer and cache them for the next first frame. */
export function applyStartupComposerPreferences(update: PrepaintComposerPreferences): void {
	const pending = pendingComposer;
	if (!pending) return;
	const preferences: ComposerPreferences = {
		quiet: update.quiet,
		composerShape: update.composerShape,
		showHardwareCursor: update.showHardwareCursor,
		maxInlineImages: update.maxInlineImages,
		resizeScrollback: update.resizeScrollback,
		imeSafeCursor: update.imeSafeCursor,
		autocompleteMaxVisible: update.autocompleteMaxVisible,
		spellingTypoDetection: update.spellingTypoDetection,
		spellingAutocomplete: update.spellingAutocomplete,
		spellingAutocorrect: update.spellingAutocorrect,
	};
	pending.composer.setPreferences(preferences);
	// Settings resolved means the module graph is loaded and the event loop is
	// responsive again: take raw-input ownership now. The kernel echoed (and
	// buffered) everything typed during the load; the editor replays it here.
	pending.composer.enableInput();
	pending.cache?.writeUi(pending.cwd, preferences, update.theme, update.autoResume);
}
