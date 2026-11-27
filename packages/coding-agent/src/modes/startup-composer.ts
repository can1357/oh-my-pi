/**
 * Start the real interactive frame and its input driver before the command modules load.
 * Cached preferences can predict the welcome card and composer, but cannot authorize writing
 * over the shell. Until the terminal presentation is known, only native or alternate-screen
 * frames may paint. The interactive mode adopts the same composer, draft and input handlers.
 */
import { batch, untrack } from "@oh-my-pi/pi-tui";
import type { TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import type { TerminalDriverOptions } from "@oh-my-pi/pi-tui/driver/index";
import type { TermPresentation, TranscriptPointer } from "@oh-my-pi/pi-tui/term/backend";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { initTheme } from "../ui/theme/service";
import { composerBorderColor } from "./interactive/border-color";
import { AppFrame } from "./interactive/frame";
import { type StartupCache, type StartupPreferences, sharedStartupCache } from "./interactive/startup-cache";
import { predictedStatusLine, type StatusPrediction } from "./interactive/status-prediction";
import { PRESENTATION_ENV, parsePresentationEnv } from "./presentation-env";
import type { ComposerThemePreferences } from "./view-model/prompt/composer-cache";

/** The preferences a frame starts with when nothing is cached. */
const STARTUP_DEFAULTS: StartupPreferences = {
	quiet: false,
	composerShape: "band",
	resizeScrollback: "rebuild",
	autocompleteMaxVisible: 5,
	vim: false,
	imeSafeCursor: false,
	mode: "inline",
};

/** Inputs available at the CLI prepaint boundary before command modules load. */
export interface PrepaintComposerOptions {
	/** Driver options (test streams). */
	readonly driver?: TerminalDriverOptions;
	/** Emergency exit before the interactive mode's keys take over (default: `process.exit`). */
	readonly exit?: (code: number) => void;
	readonly version?: string;
	readonly cwd?: string;
	/** Authoritative `--tui-mode` for this launch only. */
	readonly tuiMode?: TermPresentation;
	readonly preferences?: Partial<StartupPreferences>;
	readonly theme?: ComposerThemePreferences;
	/** The background to paint for until the terminal reports it; the last report by default. */
	readonly appearance?: "dark" | "light";
	/** The status bar to draw; the cached prediction by default. */
	readonly status?: StatusPrediction;
	readonly cache?: boolean;
}

/**
 * Final settings pushed into the live frame after Settings and the theme resolve. `mode` is the
 * saved `tui.mode` the cache keeps for the next first frame; `presentation` is this launch's.
 */
export interface PrepaintComposerPreferences extends StartupPreferences {
	/** Presentation after applying CLI and environment overrides. */
	readonly presentation: TermPresentation;
	/** `tui.fullscreenMouse`. */
	readonly pointer: TranscriptPointer;
	/** `tui.copyOnRelease`. */
	readonly copyOnRelease: boolean;
	readonly theme: ComposerThemePreferences;
}

interface PendingFrame {
	readonly frame: AppFrame;
	/** Settles once the host is running and can be adopted. */
	readonly started: Promise<void>;
	readonly cwd: string;
	/** Speculation store to refresh; `undefined` when caching is off or unavailable. */
	readonly cache: StartupCache | undefined;
	/** Drops the prepaint key handler (emergency Ctrl+C / Ctrl+D). */
	readonly releaseKeys: () => void;
}

let pending: PendingFrame | undefined;

/** Ownership token that transfers one started frame to InteractiveMode. */
export class ComposerLease {
	readonly frame: AppFrame;
	/** Settles once the host is running and can be adopted. */
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
		stopStartupFrame(this.frame, this.ready);
	}
}

/** Start the frame with the cached preferences. */
export function beginStartupComposer(options: PrepaintComposerOptions = {}): void {
	if (pending) throw new Error("A prepaint composer is already active");
	// The project dir the session will report (macOS `/private/tmp` → `/tmp`): the cache key the
	// live bar writes under, and the path the predicted bar shows.
	const cwd = options.cwd ?? getProjectDir();
	const cache = options.cache === false ? undefined : sharedStartupCache();
	const cached = cache?.read(cwd) ?? {};
	const theme = { ...cached.theme, ...options.theme };
	initTheme({
		symbolPreset: theme.symbolPreset,
		colorBlindMode: theme.colorBlindMode,
		dark: theme.darkTheme,
		light: theme.lightTheme,
		appearance: options.appearance ?? cached.appearance,
	});
	const preferences = { ...STARTUP_DEFAULTS, ...cached.preferences, ...options.preferences };
	const frame = new AppFrame({
		version: options.version ?? "",
		shape: preferences.composerShape,
		quiet: preferences.quiet,
		intro: true,
		vim: preferences.vim,
		autocompleteMaxVisible: preferences.autocompleteMaxVisible,
		imeSafeCursor: preferences.imeSafeCursor,
	});
	// Nothing would submit yet: the interactive mode lifts this once its pipeline exists.
	frame.composer.setDisableSubmit(true);
	// The cache predicts layout, not which buffer we own: a hand-edited fullscreen setting
	// must still find the shell exactly as it was, even after an inline preview.
	const override = options.tuiMode ?? parsePresentationEnv(Bun.env[PRESENTATION_ENV] ?? "");
	frame.presentation.set(override ?? { preview: preferences.mode });
	// The bar and border a fresh session here will show; the interactive mode swaps in the live ones.
	const status = options.status ?? cached.status;
	if (status) frame.setStatusLine(predictedStatusLine(status, cwd), null);
	frame.composer.setBorderColor(
		composerBorderColor({
			inputMode: undefined,
			vimMode: untrack(() => frame.composer.vimMode()),
			sessionName: undefined,
			thinkingLevel: status?.facts.thinkingLevel ?? "off",
		}),
	);
	const exit = options.exit ?? ((code: number) => process.exit(code));
	// Until the interactive mode's keys exist: Ctrl+C clears a draft, then exits (130); Ctrl+D
	// forward-deletes in a draft and exits (0) on an empty one, so a raw-mode user can always abort.
	// Ahead of the focused composer, which takes both keys for its own editing.
	const releaseKeys = frame.shell.interceptInput(event => {
		if (event.type !== "key" || event.key.kind === "release") return false;
		const draft = untrack(frame.composer.text) !== "";
		if (event.key.id === "ctrl+c") {
			if (draft) frame.composer.setText("");
			else exit(130);
			return true;
		}
		if (event.key.id !== "ctrl+d" || draft) return false;
		exit(0);
		return true;
	});
	const started = frame.start({
		clearHistory: true,
		resizeScrollback: preferences.resizeScrollback,
		driver: options.driver,
	});
	pending = {
		frame,
		cwd,
		cache,
		releaseKeys,
		started: cache ? started.then(() => rememberAppearance(frame, cache, cwd)) : started,
	};
}

function stopStartupFrame(frame: AppFrame, started: Promise<void>): void {
	if (frame.shell.host) {
		void frame.shell.stop();
	} else {
		// The handshake may still be in flight. Do not let a late renderer paint or keep stdin.
		frame.presentation.set(null);
		void started.then(
			() => frame.shell.stop(),
			() => {},
		);
	}
}

/** Cache each appearance the terminal reports for the frame's lifetime (its driver's). */
function rememberAppearance(frame: AppFrame, cache: StartupCache, cwd: string): void {
	const driver = frame.shell.host?.driver;
	if (!driver) return;
	const record = (capabilities: TerminalCapabilities): void => {
		// Only a reported background: the driver's own default is no better than the cached guess.
		if (capabilities.background) cache.writeAppearance(cwd, capabilities.dark ? "dark" : "light");
	};
	record(driver.capabilities);
	driver.onCapabilities(record);
}

/** Take the prepaint frame away from the module-level startup owner. */
export function takeStartupComposerLease(): ComposerLease | undefined {
	const current = pending;
	pending = undefined;
	return current ? new ComposerLease(current.frame, current.started, current.releaseKeys) : undefined;
}

/** Stop and forget a prepaint frame that never reached InteractiveMode. */
export function stopPendingStartupComposer(): void {
	if (!pending) return;
	pending.releaseKeys();
	stopStartupFrame(pending.frame, pending.started);
	pending = undefined;
}

/**
 * Apply the resolved settings to the pending frame and cache them for the next first frame: the
 * saved `tui.mode`, never this launch's override.
 */
export function applyStartupComposerPreferences(update: PrepaintComposerPreferences): void {
	const current = pending;
	if (!current) return;
	const { theme, presentation, pointer, copyOnRelease, ...preferences } = update;
	const { frame } = current;
	frame.setShape(preferences.composerShape);
	frame.setQuiet(preferences.quiet);
	frame.composer.setVim(preferences.vim);
	frame.composer.setAutocompleteMaxVisible(preferences.autocompleteMaxVisible);
	frame.setImeSafeCursor(preferences.imeSafeCursor);
	batch(() => {
		frame.presentation.set(presentation);
		frame.pointer.set(pointer);
		frame.copyOnRelease.set(copyOnRelease);
	});
	current.cache?.write(current.cwd, preferences, theme);
}
