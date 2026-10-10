import type { Terminal } from "@oh-my-pi/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
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
import {
	hasPositiveMovedProjectEvidence,
	readTerminalBreadcrumbEntrySync,
	resolveBreadcrumbToInteractiveRoot,
	sessionDirForCwd,
} from "../session/session-paths";
import { MAGIC_KEYWORDS } from "./magic-keywords";
import { findMostRecentNonEmptySessionSync } from "../session/recent-session-sync";

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
	/** Exact session file this launch will resume; inferred from the terminal breadcrumb by default. */
	readonly sessionFile?: string;
}

/** Final settings pushed into the live composer after Settings and the theme resolve. */
export interface PrepaintComposerPreferences extends ComposerPreferences {
	readonly theme: ComposerThemePreferences;
	readonly autoResume: boolean;
	/** Persisted settings layer that may safely seed the next launch. */
	readonly autoResumeCacheScope?: "global" | "project";
}

interface PendingComposer {
	readonly composer: Composer;
	readonly cwd: string;
	/** Speculation store to refresh; `undefined` when caching is off or unavailable. */
	readonly cache: ComposerCache | undefined;
}

let pendingComposer: PendingComposer | undefined;

export interface TerminalSessionPrepaint {
	readonly cacheCwd: string;
	readonly sessionFile: string;
}

/** Resolve the newest canonical project-local target `continueRecent()` will choose. */
function resolveCurrentProjectSession(cwd: string): string | undefined {
	return findMostRecentNonEmptySessionSync(sessionDirForCwd(cwd));
}

/** Cached usage is unsafe when process-local settings can override the persisted auto-resume intent. */
export function canReusePrepaintSessionUsage(
	allowSessionUsage: boolean | undefined,
	configFiles?: string,
	sessionDirOverride?: string,
): boolean {
	return (
		allowSessionUsage === true && !(configFiles?.split(path.delimiter).some(Boolean) ?? false) && !sessionDirOverride
	);
}

/** Resolve the session identity needed by prepaint, without loading the session graph. */
export function resolveTerminalSessionPrepaint(
	cwd: string,
	_currentSessionFile?: string,
): TerminalSessionPrepaint | undefined {
	const breadcrumb = readTerminalBreadcrumbEntrySync();
	const resolvedCwd = path.resolve(cwd);
	// A terminal without a breadcrumb follows continueRecent()'s project-local
	// fallback. Resolve it from the same canonical session directory as the live
	// selector, rather than the last cache writer's possibly custom directory. The
	// matching cache identity lets the
	// first frame reserve its usage widths before the session graph loads.
	if (!breadcrumb) {
		const currentSessionFile = resolveCurrentProjectSession(resolvedCwd);
		return currentSessionFile ? { cacheCwd: resolvedCwd, sessionFile: currentSessionFile } : undefined;
	}
	const breadcrumbCwd = path.resolve(breadcrumb.cwd);
	const breadcrumbSessionFile = resolveBreadcrumbToInteractiveRoot(breadcrumb.sessionFile);
	if (breadcrumbCwd === resolvedCwd) return { cacheCwd: resolvedCwd, sessionFile: breadcrumbSessionFile };
	if (fs.existsSync(breadcrumbCwd)) return undefined;
	if (!hasPositiveMovedProjectEvidence(breadcrumb.cwdIdentity, resolvedCwd)) return undefined;
	// Only the moved-project branch needs the fallback scan. Same-cwd breadcrumbs
	// above are authoritative and must not pay a synchronous directory walk.
	const currentSessionFile = resolveCurrentProjectSession(resolvedCwd);
	if (currentSessionFile) return { cacheCwd: resolvedCwd, sessionFile: currentSessionFile };
	return { cacheCwd: breadcrumbCwd, sessionFile: breadcrumbSessionFile };
}

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
	const terminalSession = options.sessionFile
		? { cacheCwd: cwd, sessionFile: options.sessionFile }
		: resolveTerminalSessionPrepaint(cwd, cache?.cachedSessionFile(cwd));
	const cached = cache
		? cache.read(terminalSession?.cacheCwd ?? cwd, {
				allowSessionUsage: canReusePrepaintSessionUsage(
					options.allowSessionUsage,
					process.env.PI_CONFIG_FILES,
					process.env.PI_CODING_AGENT_SESSION_DIR,
				),
				sessionFile: terminalSession?.sessionFile,
			})
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
	pending.cache?.writeUi(pending.cwd, preferences, update.theme);
	if (update.autoResumeCacheScope) {
		pending.cache?.writeAutoResume(pending.cwd, update.autoResume, update.autoResumeCacheScope === "project");
	}
}
