/**
 * The prepaint frame: the interactive UI started before the command modules
 * load, built from the preferences the last launch cached, so the first frame
 * (welcome card, composer) shows at once and typing lands in the composer.
 * Submitting waits for the interactive mode, which adopts the started frame.
 */
import { untrack } from "@oh-my-pi/pi-tui";
import type { TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import type { TerminalDriverOptions } from "@oh-my-pi/pi-tui/driver/index";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { exitProcess } from "@oh-my-pi/pi-utils/postmortem";
import { initTheme } from "../ui/theme/service";
import { composerBorderColor } from "./interactive/border-color";
import { AppFrame } from "./interactive/frame";
import { type StartupCache, type StartupPreferences, sharedStartupCache } from "./interactive/startup-cache";
import { predictedStatusLine, type StatusPrediction } from "./interactive/status-prediction";
import { ownStartupFrame } from "./startup-frame";
import type { ComposerThemePreferences } from "./view-model/prompt/composer-cache";

/** The preferences a frame starts with when nothing is cached. */
const STARTUP_DEFAULTS: StartupPreferences = {
	quiet: false,
	composerShape: "band",
	resizeScrollback: "rebuild",
	autocompleteMaxVisible: 5,
	vim: false,
	imeSafeCursor: false,
	screen: "inline",
};

/** Inputs available at the CLI prepaint boundary before command modules load. */
export interface PrepaintComposerOptions {
	/** Driver options (test streams). */
	readonly driver?: TerminalDriverOptions;
	/** Override the host's emergency exit before interactive keybindings take over. */
	readonly exit?: (code: number) => void;
	readonly version?: string;
	readonly cwd?: string;
	readonly preferences?: Partial<StartupPreferences>;
	readonly theme?: ComposerThemePreferences;
	/** The background to paint for until the terminal reports it; the last report by default. */
	readonly appearance?: "dark" | "light";
	/** The status bar to draw; the cached prediction by default. */
	readonly status?: StatusPrediction;
	readonly cache?: boolean;
}

/** Start the frame with the cached preferences. */
export function beginStartupComposer(options: PrepaintComposerOptions = {}): void {
	ownStartupFrame(() => startFrame(options));
}

function startFrame(options: PrepaintComposerOptions) {
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
	frame.screen.set(preferences.screen);
	// Nothing would submit yet: the interactive mode lifts this once its pipeline exists.
	frame.composer.setDisableSubmit(true);
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
	// The keyboard belongs to the host even while a tool factory has guarded process.exit.
	const exit = options.exit ?? ((code: number) => exitProcess(code, { emitExitEvent: true }));
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
		...(options.driver ? { driver: options.driver } : {}),
	});
	// Remember the background the terminal reports (OSC 11), so the next launch paints for it.
	if (cache) void started.then(() => rememberAppearance(frame, cache, cwd));
	return { frame, started, cwd, cache, releaseKeys };
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
