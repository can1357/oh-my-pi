/**
 * Speculative state for the next launch's first frame, kept in one SQLite store
 * (`~/.omp/agent/cache/composer.db`): the resolved theme inputs and the
 * composer preferences the prepaint frame is built with before settings load
 * (kind `ui`), the background the terminal last reported (kind `terminal`), and
 * the status bar a fresh session will show (kind `status`, see
 * {@link StatusPrediction}).
 *
 * Each row is one JSON payload keyed by project (the resolved cwd) and kind;
 * it is also written under the empty project, so a folder that never ran omp
 * still paints with the user's theme and composer.
 *
 * ```text
 * entries (project TEXT, kind TEXT, value TEXT JSON, PRIMARY KEY (project, kind))
 * ```
 *
 * Payload formats are versioned by `PRAGMA user_version`; a mismatch clears the
 * store, which only ever holds speculation.
 */
import type { Database, Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ResizeScrollback } from "@oh-my-pi/pi-tui/driver/index";
import type { ScreenMode } from "@oh-my-pi/pi-tui/term/backend";
import { isRecord } from "@oh-my-pi/pi-utils";
import { getComposerCacheDbPath } from "@oh-my-pi/pi-utils/dirs";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { openSqliteDatabaseSync } from "@oh-my-pi/pi-utils/sqlite";
import type { ComposerThemePreferences } from "../view-model/prompt/composer-cache";
import { parseStatusPrediction, type StatusPrediction } from "./status-prediction";

/** Bump whenever a payload format changes; older stores are cleared on open. */
const FORMAT_VERSION = 3;
/** Project key of rows that serve every project lacking its own. */
const ANY_PROJECT = "";

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS entries (
	project TEXT NOT NULL,
	kind TEXT NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (project, kind)
) WITHOUT ROWID;
`;

/** The settings the first frame is built from. */
export interface StartupPreferences {
	/** `startup.quiet`: no welcome card. */
	readonly quiet: boolean;
	readonly composerShape: string;
	readonly resizeScrollback: ResizeScrollback;
	readonly autocompleteMaxVisible: number;
	readonly vim: boolean;
	readonly imeSafeCursor: boolean;
	/** `tui.screen`: the first frame draws inline or on the alternate screen. */
	readonly screen: ScreenMode;
}

/** What the cache knows for a project. */
export interface StartupCacheEntry {
	readonly preferences?: StartupPreferences;
	readonly theme?: ComposerThemePreferences;
	/** The background the terminal last reported: the theme's guess until it answers again. */
	readonly appearance?: "dark" | "light";
	readonly status?: StatusPrediction;
}

/** Payload kinds, one row each per project. */
type EntryKind = "ui" | "terminal" | "status";

function parseAppearance(value: unknown): "dark" | "light" | undefined {
	if (!isRecord(value) || typeof value.dark !== "boolean") return undefined;
	return value.dark ? "dark" : "light";
}

const RESIZE_SCROLLBACK: Record<string, ResizeScrollback> = {
	append: "append",
	rebuild: "rebuild",
	preserve: "preserve",
};

const SYMBOL_PRESETS: Record<string, true> = { unicode: true, nerd: true, ascii: true };

const SCREEN_MODES: Record<string, ScreenMode> = { inline: "inline", fullscreen: "fullscreen" };

function parseJson(value: string | undefined): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function parseUi(
	value: unknown,
): { readonly preferences: StartupPreferences; readonly theme: ComposerThemePreferences } | undefined {
	if (!isRecord(value) || !isRecord(value.preferences) || !isRecord(value.theme)) return undefined;
	const { quiet, composerShape, resizeScrollback, autocompleteMaxVisible, vim, imeSafeCursor, screen } =
		value.preferences;
	const scrollback = typeof resizeScrollback === "string" ? RESIZE_SCROLLBACK[resizeScrollback] : undefined;
	if (
		typeof quiet !== "boolean" ||
		typeof composerShape !== "string" ||
		!scrollback ||
		typeof autocompleteMaxVisible !== "number" ||
		typeof vim !== "boolean" ||
		(typeof imeSafeCursor !== "boolean" && imeSafeCursor !== undefined)
	) {
		return undefined;
	}
	const { symbolPreset, colorBlindMode, darkTheme, lightTheme } = value.theme;
	if (
		(symbolPreset !== undefined && (typeof symbolPreset !== "string" || !SYMBOL_PRESETS[symbolPreset])) ||
		(colorBlindMode !== undefined && typeof colorBlindMode !== "boolean") ||
		(darkTheme !== undefined && typeof darkTheme !== "string") ||
		(lightTheme !== undefined && typeof lightTheme !== "string")
	) {
		return undefined;
	}
	return {
		preferences: {
			quiet,
			composerShape,
			resizeScrollback: scrollback,
			autocompleteMaxVisible,
			vim,
			imeSafeCursor: imeSafeCursor === true,
			// Caches written before the setting existed start inline.
			screen: (typeof screen === "string" ? SCREEN_MODES[screen] : undefined) ?? "inline",
		},
		theme: { symbolPreset, colorBlindMode, darkTheme, lightTheme } as ComposerThemePreferences,
	};
}

/** {@link StartupCache} `#known` key. */
function knownKey(kind: string, project: string): string {
	return `${kind}\0${project}`;
}

let shared: StartupCache | null | undefined;

/**
 * Process-wide store, opened on first use and closed at exit. `undefined` when it cannot be
 * opened (logged once; startup paints without speculation) and under the test runner, so tests
 * never read or clobber the user's cache; tests use {@link StartupCache.open}.
 */
export function sharedStartupCache(): StartupCache | undefined {
	if (isBunTestRuntime()) return undefined;
	if (shared === undefined) {
		try {
			const cache = StartupCache.open();
			postmortem.register("composer-cache", () => cache.close(), { exitOnly: true });
			shared = cache;
		} catch (error) {
			logger.debug("startup cache unavailable", { error: String(error) });
			shared = null;
		}
	}
	return shared ?? undefined;
}

/** SQLite store of what the next launch paints before its settings load. */
export class StartupCache {
	readonly #db: Database;
	readonly #select: Statement<{ project: string; kind: string; value: string }, [string, string]>;
	readonly #upsert: Statement<unknown, [string, EntryKind, string]>;
	/** Payload this connection last read or wrote per kind and project; identical writes skip the transaction. */
	readonly #known = new Map<string, string>();

	private constructor(db: Database) {
		this.#db = db;
		db.run(SCHEMA);
		const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
		if (version !== FORMAT_VERSION) {
			db.run("DELETE FROM entries");
			db.run(`PRAGMA user_version = ${FORMAT_VERSION}`);
		}
		this.#select = db.prepare("SELECT project, kind, value FROM entries WHERE project IN (?, ?)");
		// The WHERE turns a byte-identical upsert into a no-op instead of a page rewrite.
		this.#upsert = db.prepare(
			"INSERT INTO entries (project, kind, value) VALUES (?, ?, ?) ON CONFLICT (project, kind) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value",
		);
	}

	/**
	 * Open (creating if needed) the store at `dbPath`, quarantining a corrupt one once.
	 * @throws when the directory or database cannot be created.
	 */
	static open(dbPath: string = getComposerCacheDbPath()): StartupCache {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		return openSqliteDatabaseSync(dbPath, db => new StartupCache(db), { recoverCorruption: true });
	}

	/** What is cached for `cwd`, each kind falling back to its any-project row. Never throws. */
	read(cwd: string): StartupCacheEntry {
		const project = path.resolve(cwd);
		const own = new Map<string, string>();
		const anyProject = new Map<string, string>();
		try {
			for (const row of this.#select.all(project, ANY_PROJECT)) {
				(row.project === project ? own : anyProject).set(row.kind, row.value);
				this.#known.set(knownKey(row.kind, row.project), row.value);
			}
		} catch (error) {
			logger.debug("startup cache read failed", { error: String(error) });
		}
		const parsed = <T>(kind: EntryKind, parse: (value: unknown) => T | undefined): T | undefined =>
			parse(parseJson(own.get(kind))) ?? parse(parseJson(anyProject.get(kind)));
		const appearance = parsed("terminal", parseAppearance);
		const status = parsed("status", parseStatusPrediction);
		return { ...parsed("ui", parseUi), ...(appearance ? { appearance } : {}), ...(status ? { status } : {}) };
	}

	/** The resolved preferences and theme for the next prepaint; a failed write only costs that speculation. */
	write(cwd: string, preferences: StartupPreferences, theme: ComposerThemePreferences): void {
		this.#put("ui", cwd, JSON.stringify({ preferences, theme }));
	}

	/** The background the terminal reported, for the next prepaint's theme. */
	writeAppearance(cwd: string, appearance: "dark" | "light"): void {
		this.#put("terminal", cwd, JSON.stringify({ dark: appearance === "dark" }));
	}

	/** The status bar the next prepaint draws; a failed write only costs that speculation. */
	writeStatus(cwd: string, status: StatusPrediction): void {
		this.#put("status", cwd, JSON.stringify(status));
	}

	#put(kind: EntryKind, cwd: string, json: string): void {
		const projects = [path.resolve(cwd), ANY_PROJECT];
		if (projects.every(project => this.#known.get(knownKey(kind, project)) === json)) return;
		try {
			this.#db.transaction(() => {
				for (const project of projects) this.#upsert.run(project, kind, json);
			})();
			for (const project of projects) this.#known.set(knownKey(kind, project), json);
		} catch (error) {
			logger.debug("startup cache write failed", { error: String(error) });
		}
	}

	close(): void {
		// Unfinalized statements keep the file handle open on Windows.
		this.#select.finalize();
		this.#upsert.finalize();
		this.#db.close();
	}
}
