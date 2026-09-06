import type { Terminal } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { getRecentSessions } from "../session/session-listing";
import { computeDefaultSessionDir } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";
import type { LspServerInfo, RecentSession } from "./components/welcome";
import { COMPOSER_DEFAULTS, Composer, type ComposerPreferences, type ComposerWelcomeUpdate } from "./composer";
import {
	type ComposerThemePreferences,
	readComposerStartupCache,
	writeComposerLspCache,
	writeComposerRecentSessionsCache,
	writeComposerUiCache,
} from "./composer-cache";
import { initThemeSync } from "./theme/theme";

/** Inputs available at the CLI prepaint boundary before command modules load. */
export interface PrepaintComposerOptions {
	readonly terminal?: Terminal;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
	readonly version?: string;
	readonly cwd?: string;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly theme?: ComposerThemePreferences;
	readonly recentSessions?: () => Promise<RecentSession[]>;
	readonly cache?: boolean;
}

/** Final settings pushed into the live composer after Settings and the theme resolve. */
export interface PrepaintComposerPreferences extends ComposerPreferences {
	readonly theme: ComposerThemePreferences;
}

interface PendingComposer {
	readonly composer: Composer;
	readonly cwd: string;
	readonly cache: boolean;
	recentSessions?: Promise<RecentSession[] | undefined>;
}

let pendingComposer: PendingComposer | undefined;

/** Ownership token that transfers one already-started Composer to InteractiveMode. */
export class ComposerLease {
	readonly composer: Composer;
	/** Recent-session rows already loading in parallel with the runtime module graph. */
	readonly recentSessions?: Promise<RecentSession[] | undefined>;
	#adopted = false;

	constructor(composer: Composer, recentSessions?: Promise<RecentSession[] | undefined>) {
		this.composer = composer;
		this.recentSessions = recentSessions;
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

/** Start the canonical Composer with speculative cached state, then refresh recent sessions. */
export function beginStartupComposer(options: PrepaintComposerOptions = {}): void {
	if (pendingComposer) throw new Error("A prepaint composer is already active");
	const cwd = options.cwd ?? process.cwd();
	const useCache = options.cache !== false;
	const cached = useCache
		? readComposerStartupCache(cwd)
		: {
				preferences: undefined,
				theme: undefined,
				welcome: undefined,
				recentSessions: [],
				lspServers: [],
			};
	const theme = { ...cached.theme, ...options.theme };
	initThemeSync(theme.symbolPreset, theme.colorBlindMode, theme.darkTheme, theme.lightTheme);
	const preferences = { ...COMPOSER_DEFAULTS, ...cached.preferences, ...options.preferences };
	const welcome: ComposerWelcomeUpdate = {
		version: options.version ?? "",
		modelName: cached.welcome?.modelName,
		providerName: cached.welcome?.providerName,
		recentSessions: cached.recentSessions,
		lspServers: cached.lspServers,
	};
	const composer = new Composer({
		terminal: options.terminal,
		exit: options.exit,
		now: options.now,
		preferences,
		welcome,
	});
	try {
		composer.start({ clearScrollback: true, deferInput: true });
	} catch (error) {
		try {
			composer.stop();
		} catch {}
		throw error;
	}
	const pending: PendingComposer = { composer, cwd, cache: useCache };
	pendingComposer = pending;
	pending.recentSessions = refreshRecentSessions(pending, options.recentSessions);
}

/** Take the live prepaint composer away from the module-level startup owner. */
export function takeStartupComposerLease(): ComposerLease | undefined {
	const pending = pendingComposer;
	pendingComposer = undefined;
	return pending ? new ComposerLease(pending.composer, pending.recentSessions) : undefined;
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
	if (pending.cache) {
		void writeComposerUiCache(pending.cwd, preferences, update.theme).catch(error => {
			logger.debug("composer UI cache write failed", { error });
		});
	}
}

/** Apply discovered project LSP rows and cache them for the next first frame. */
export function setStartupComposerLspServers(servers: LspServerInfo[]): void {
	const pending = pendingComposer;
	if (!pending) return;
	pending.composer.updateWelcome({ lspServers: servers });
	if (pending.cache) {
		void writeComposerLspCache(pending.cwd, servers).catch(error => {
			logger.debug("composer LSP cache write failed", { error });
		});
	}
}

async function refreshRecentSessions(
	pending: PendingComposer,
	loadOverride: (() => Promise<RecentSession[]>) | undefined,
): Promise<RecentSession[] | undefined> {
	try {
		const sessions = loadOverride ? await loadOverride() : await loadRecentSessions(pending.cwd);
		if (pending.cache) {
			void writeComposerRecentSessionsCache(pending.cwd, sessions).catch(error => {
				logger.debug("composer recent sessions cache write failed", { error });
			});
		}
		if (pendingComposer === pending) {
			pending.composer.updateWelcome({ recentSessions: sessions });
		}
		return sessions;
	} catch (error) {
		logger.debug("composer recent sessions load failed", { error });
		return undefined;
	}
}

async function loadRecentSessions(cwd: string): Promise<RecentSession[]> {
	const storage = new FileSessionStorage();
	const dir = computeDefaultSessionDir(cwd, storage);
	const list = await getRecentSessions(dir, 4, storage);
	return list.map(session => ({ name: session.name, timeAgo: session.timeAgo }));
}
