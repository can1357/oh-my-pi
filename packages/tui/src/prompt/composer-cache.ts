/**
 * Speculative composer state for the next first frame, kept in one SQLite store
 * (`~/.omp/agent/cache/composer.db`).
 *
 * Each row is one JSON payload keyed by project (the resolved cwd) and kind.
 * Settings-derived kinds (theme/composer preferences, status-bar inputs) are
 * also written under the empty project, so a folder that never ran omp still
 * paints with the user's theme and status bar: those are rarely
 * project-specific, and path/branch render live.
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
import { getComposerCacheDbPath } from "@oh-my-pi/pi-utils/dirs";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { openSqliteDatabaseSync } from "@oh-my-pi/pi-utils/sqlite";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { ComposerPreferences, ComposerStatusCache } from "./composer";
import { readStatusLineStartupData } from "../status-line/startup";
import type { SymbolPreset } from "../theme/theme";
import { isWordCompletionMethod } from "./word-completion";

/** Bump whenever any payload format changes; older stores are cleared on open. */
const FORMAT_VERSION = 9;
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

/** Speculative composer cache payload kinds. */
type EntryKind = "auto-resume" | "ui" | "status";

interface CachedAutoResume {
	readonly value: boolean;
	readonly projectScoped: boolean;
	readonly sources?: readonly CachedSourceSnapshot[];
}

interface CachedSourceSnapshot {
	readonly path: string;
	readonly kind: "file" | "missing" | "unreadable";
	readonly mtimeNs?: string;
	readonly ctimeNs?: string;
	readonly inode?: string;
	readonly size?: string;
}

/** Theme inputs cached from the last resolved settings load for stable prepaint colors. */
export interface ComposerThemePreferences {
	readonly symbolPreset?: SymbolPreset;
	readonly colorBlindMode?: boolean;
	readonly darkTheme?: string;
	readonly lightTheme?: string;
}

/** Speculative composer state read before the settings/session graph is available. */
export interface ComposerStartupCache {
	readonly preferences?: ComposerPreferences;
	readonly theme?: ComposerThemePreferences;
	readonly status?: ComposerStatusCache;
}

export interface ComposerCacheReadOptions {
	/** Permit reuse of layout hints when cached settings will auto-resume the producing session. */
	readonly allowSessionUsage?: boolean;
	/** Session file the current terminal breadcrumb will resume, when known. */
	readonly sessionFile?: string;
}

function parseJson(value: string | undefined): unknown {
	if (value === undefined) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function parseStatus(value: unknown): ComposerStatusCache | undefined {
	if (!isRecord(value)) return undefined;
	const statusLine = readStatusLineStartupData(value.statusLine);
	if (!statusLine) return undefined;
	const rawBorderColor = value.borderColor;
	if (rawBorderColor === undefined) return { statusLine };
	if (!isRecord(rawBorderColor)) return undefined;
	const { prefix, suffix } = rawBorderColor;
	if (typeof prefix !== "string" || typeof suffix !== "string") return undefined;
	return { borderColor: { prefix, suffix }, statusLine };
}

function parseCachedStatus(
	value: unknown,
): { status: ComposerStatusCache; sessionFile: string | undefined } | undefined {
	if (!isRecord(value)) return undefined;
	const status = parseStatus(value.status);
	if (!status || (value.sessionFile !== undefined && typeof value.sessionFile !== "string")) return undefined;
	return { status, sessionFile: value.sessionFile };
}

function parseCachedAutoResume(value: unknown): CachedAutoResume | undefined {
	if (!isRecord(value) || typeof value.value !== "boolean" || typeof value.projectScoped !== "boolean") {
		return undefined;
	}
	if (value.sources !== undefined) {
		if (!Array.isArray(value.sources) || !value.sources.every(isCachedSourceSnapshot)) return undefined;
		return { value: value.value, projectScoped: value.projectScoped, sources: value.sources };
	}
	return { value: value.value, projectScoped: value.projectScoped };
}

function isCachedSourceSnapshot(value: unknown): value is CachedSourceSnapshot {
	if (!isRecord(value) || typeof value.path !== "string") return false;
	if (value.kind === "missing" || value.kind === "unreadable") return true;
	return (
		value.kind === "file" &&
		typeof value.mtimeNs === "string" &&
		typeof value.ctimeNs === "string" &&
		typeof value.inode === "string" &&
		typeof value.size === "string"
	);
}

function snapshotSource(sourcePath: string): CachedSourceSnapshot {
	const resolved = path.resolve(sourcePath);
	try {
		const stat = fs.statSync(resolved, { bigint: true, throwIfNoEntry: false });
		if (!stat?.isFile()) return { path: resolved, kind: "missing" };
		return {
			path: resolved,
			kind: "file",
			mtimeNs: stat.mtimeNs.toString(),
			ctimeNs: stat.ctimeNs.toString(),
			inode: stat.ino.toString(),
			size: stat.size.toString(),
		};
	} catch {
		return { path: resolved, kind: "unreadable" };
	}
}

function snapshotSources(sourcePaths: readonly string[]): CachedSourceSnapshot[] {
	return [...new Set(sourcePaths.map(sourcePath => path.resolve(sourcePath)))].sort().map(snapshotSource);
}

function cachedAutoResumeIsFresh(value: CachedAutoResume | undefined): value is CachedAutoResume {
	if (!value) return false;
	if (!value.sources) return true;
	return value.sources.every(source => JSON.stringify(snapshotSource(source.path)) === JSON.stringify(source));
}

function rebaseMovedProjectSource(
	source: CachedSourceSnapshot,
	previousCwd: string,
	currentCwd: string,
): CachedSourceSnapshot {
	const relative = path.relative(previousCwd, source.path);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return source;
	return { ...source, path: path.resolve(currentCwd, relative) };
}

function parseUiState(
	value: unknown,
): { preferences: ComposerPreferences; theme: ComposerThemePreferences } | undefined {
	if (!isRecord(value) || !isRecord(value.preferences) || !isRecord(value.theme)) return undefined;
	const {
		quiet,
		composerShape,
		showHardwareCursor,
		maxInlineImages,
		resizeScrollback,
		imeSafeCursor,
		autocompleteMaxVisible,
		spellingTypoDetection,
		spellingAutocomplete,
		spellingAutocorrect,
	} = value.preferences;
	if (
		typeof quiet !== "boolean" ||
		typeof composerShape !== "string" ||
		typeof showHardwareCursor !== "boolean" ||
		typeof maxInlineImages !== "number" ||
		(resizeScrollback !== undefined &&
			resizeScrollback !== "append" &&
			resizeScrollback !== "rebuild" &&
			resizeScrollback !== "preserve") ||
		typeof imeSafeCursor !== "boolean" ||
		typeof autocompleteMaxVisible !== "number" ||
		typeof spellingTypoDetection !== "boolean" ||
		!isWordCompletionMethod(spellingAutocomplete) ||
		typeof spellingAutocorrect !== "boolean"
	) {
		return undefined;
	}
	const { symbolPreset, colorBlindMode, darkTheme, lightTheme } = value.theme;
	if (
		(symbolPreset !== undefined &&
			symbolPreset !== "unicode" &&
			symbolPreset !== "nerd" &&
			symbolPreset !== "ascii") ||
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
			showHardwareCursor,
			maxInlineImages,
			resizeScrollback: resizeScrollback ?? "rebuild",
			imeSafeCursor,
			autocompleteMaxVisible,
			spellingTypoDetection,
			spellingAutocomplete,
			spellingAutocorrect,
		},
		theme: { symbolPreset, colorBlindMode, darkTheme, lightTheme },
	};
}

let shared: ComposerCache | null | undefined;

/**
 * Process-wide store at {@link getComposerCacheDbPath}, opened on first use and
 * closed at exit. `undefined` when it cannot be opened (logged once; startup
 * paints without speculation) and under the test runner, so tests never read
 * or clobber the user's cache; tests open {@link ComposerCache.open} explicitly.
 */
export function sharedComposerCache(): ComposerCache | undefined {
	if (isBunTestRuntime()) return undefined;
	if (shared === undefined) {
		try {
			const cache = ComposerCache.open();
			postmortem.register("composer-cache", () => cache.close(), { exitOnly: true });
			shared = cache;
		} catch (error) {
			logger.debug("composer cache unavailable", { error: String(error) });
			shared = null;
		}
	}
	return shared ?? undefined;
}

/** SQLite store of the composer state the next launch paints before its session exists. */
export class ComposerCache {
	readonly #db: Database;
	readonly #select: Statement<{ project: string; kind: EntryKind; value: string }, [string, string]>;
	readonly #upsert: Statement<unknown, [string, EntryKind, string]>;
	/**
	 * Value this connection last read or wrote per `project\0kind`. Startup and
	 * model/status events re-send identical payloads; matching ones skip the
	 * write transaction entirely. Another process may have replaced a row since;
	 * that only lets its (equally speculative) value win until ours changes.
	 */
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
	static open(dbPath: string = getComposerCacheDbPath()): ComposerCache {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		return openSqliteDatabaseSync(dbPath, db => new ComposerCache(db), { recoverCorruption: true });
	}

	/**
	 * Everything cached for `cwd`, with any-project rows as fallback for shared kinds. Never throws.
	 * Fresh sessions omit the previous session's usage so their first frame does not reserve stale segments.
	 */
	read(cwd: string, options: ComposerCacheReadOptions = {}): ComposerStartupCache {
		const project = path.resolve(cwd);
		const own: Partial<Record<EntryKind, string>> = {};
		const anyProject: Partial<Record<EntryKind, string>> = {};
		try {
			for (const row of this.#select.all(project, ANY_PROJECT)) {
				(row.project === project ? own : anyProject)[row.kind] = row.value;
				this.#known.set(`${row.project}\0${row.kind}`, row.value);
			}
		} catch (error) {
			logger.debug("composer cache read failed", { error: String(error) });
		}
		const ui = parseUiState(parseJson(own.ui)) ?? parseUiState(parseJson(anyProject.ui));
		const ownAutoResume = parseCachedAutoResume(parseJson(own["auto-resume"]));
		const globalAutoResume = parseCachedAutoResume(parseJson(anyProject["auto-resume"]));
		const autoResume = ownAutoResume
			? cachedAutoResumeIsFresh(ownAutoResume)
				? ownAutoResume.value
				: undefined
			: cachedAutoResumeIsFresh(globalAutoResume)
				? globalAutoResume.value
				: undefined;
		const cachedStatus = parseCachedStatus(parseJson(own.status)) ?? parseCachedStatus(parseJson(anyProject.status));
		const canReuseSessionUsage =
			options.allowSessionUsage &&
			autoResume === true &&
			options.sessionFile !== undefined &&
			cachedStatus?.sessionFile === options.sessionFile;
		const status =
			cachedStatus && !canReuseSessionUsage
				? {
						...cachedStatus.status,
						statusLine: {
							...cachedStatus.status.statusLine,
							contextPercent: undefined,
							tokenBreakdown: undefined,
						},
					}
				: cachedStatus?.status;
		return {
			preferences: ui?.preferences,
			theme: ui?.theme,
			status,
		};
	}

	/** Exact session identity most recently cached for this project; shared fallback rows never qualify. */
	cachedSessionFile(cwd: string): string | undefined {
		const project = path.resolve(cwd);
		try {
			const row = this.#select
				.all(project, project)
				.find(entry => entry.project === project && entry.kind === "status");
			if (!row) return undefined;
			this.#known.set(`${row.project}\0${row.kind}`, row.value);
			return parseCachedStatus(parseJson(row.value))?.sessionFile;
		} catch (error) {
			logger.debug("composer cache session identity read failed", { error: String(error) });
			return undefined;
		}
	}

	/** Persisted auto-resume intent applicable to this project, before the settings graph loads. */
	cachedAutoResume(cwd: string): boolean | undefined {
		const project = path.resolve(cwd);
		let own: CachedAutoResume | undefined;
		let global: CachedAutoResume | undefined;
		try {
			for (const row of this.#select.all(project, ANY_PROJECT)) {
				this.#known.set(`${row.project}\0${row.kind}`, row.value);
				if (row.kind !== "auto-resume") continue;
				const parsed = parseCachedAutoResume(parseJson(row.value));
				if (row.project === project) own = parsed;
				else global = parsed;
			}
		} catch (error) {
			logger.debug("composer cache auto-resume read failed", { error: String(error) });
			return undefined;
		}
		if (own) return cachedAutoResumeIsFresh(own) ? own.value : undefined;
		return cachedAutoResumeIsFresh(global) ? global.value : undefined;
	}

	/** Rebase a proven moved project's source identities so its prior cache row remains usable. */
	rebaseMovedProjectAutoResume(previousCwd: string, currentCwd: string): boolean | undefined {
		const previousProject = path.resolve(previousCwd);
		const currentProject = path.resolve(currentCwd);
		let own: CachedAutoResume | undefined;
		let global: CachedAutoResume | undefined;
		try {
			for (const row of this.#select.all(previousProject, ANY_PROJECT)) {
				this.#known.set(`${row.project}\0${row.kind}`, row.value);
				if (row.kind !== "auto-resume") continue;
				const parsed = parseCachedAutoResume(parseJson(row.value));
				if (row.project === previousProject) own = parsed;
				else global = parsed;
			}
		} catch (error) {
			logger.debug("composer cache moved-project auto-resume read failed", { error: String(error) });
			return undefined;
		}
		if (!own) return cachedAutoResumeIsFresh(global) ? global.value : undefined;
		const rebased: CachedAutoResume = own.sources
			? {
					...own,
					sources: own.sources.map(source => rebaseMovedProjectSource(source, previousProject, currentProject)),
				}
			: own;
		if (!cachedAutoResumeIsFresh(rebased)) return undefined;
		const json = JSON.stringify(rebased);
		try {
			this.#upsert.run(previousProject, "auto-resume", json);
			this.#known.set(`${previousProject}\0auto-resume`, json);
			return rebased.value;
		} catch (error) {
			logger.debug("composer cache moved-project auto-resume write failed", { error: String(error) });
			return undefined;
		}
	}

	/** Resolved theme and composer settings for the next prepaint. */
	writeUi(
		cwd: string,
		preferences: ComposerPreferences,
		theme: ComposerThemePreferences,
		autoResume?: boolean,
		autoResumeProjectScoped = false,
	): void {
		this.#putShared(cwd, "ui", { preferences, theme });
		if (autoResume !== undefined) this.writeAutoResume(cwd, autoResume, autoResumeProjectScoped);
	}

	/** Refresh the live auto-resume setting without replacing the cached UI snapshot. */
	writeAutoResume(
		cwd: string,
		autoResume: boolean,
		projectScoped = false,
		sourcePaths: readonly string[] = [],
		projectSourcePaths: readonly string[] = [],
	): void {
		const project = path.resolve(cwd);
		const globalValue: CachedAutoResume = {
			value: autoResume,
			projectScoped: false,
			sources: sourcePaths.length > 0 ? snapshotSources(sourcePaths) : undefined,
		};
		const ownValue: CachedAutoResume = projectScoped
			? { ...globalValue, projectScoped: true }
			: {
					...globalValue,
					sources:
						sourcePaths.length + projectSourcePaths.length > 0
							? snapshotSources([...sourcePaths, ...projectSourcePaths])
							: undefined,
				};
		const ownJson = JSON.stringify(ownValue);
		const globalJson = JSON.stringify(globalValue);
		const ownKey = `${project}\0auto-resume`;
		const globalKey = `${ANY_PROJECT}\0auto-resume`;
		try {
			if (projectScoped) {
				if (this.#known.get(ownKey) === ownJson) return;
				this.#upsert.run(project, "auto-resume", ownJson);
				this.#known.set(ownKey, ownJson);
				return;
			}
			// Keep a project-specific inherited snapshot so creating the first local
			// override invalidates speculation. Its global source snapshots also make
			// it stale when inherited intent changes, so it cannot mask the shared row.
			this.#db.transaction(() => {
				this.#upsert.run(project, "auto-resume", ownJson);
				this.#upsert.run(ANY_PROJECT, "auto-resume", globalJson);
			})();
			this.#known.set(ownKey, ownJson);
			this.#known.set(globalKey, globalJson);
		} catch (error) {
			logger.debug("composer cache write failed", { kind: "auto-resume", error: String(error) });
		}
	}

	/** Refresh inherited intent without deleting a project's explicit override row. */
	writeGlobalAutoResume(autoResume: boolean, sourcePaths: readonly string[] = []): void {
		const value: CachedAutoResume = {
			value: autoResume,
			projectScoped: false,
			sources: sourcePaths.length > 0 ? snapshotSources(sourcePaths) : undefined,
		};
		const json = JSON.stringify(value);
		const globalKey = `${ANY_PROJECT}\0auto-resume`;
		if (this.#known.get(globalKey) === json) return;
		try {
			this.#upsert.run(ANY_PROJECT, "auto-resume", json);
			this.#known.set(globalKey, json);
		} catch (error) {
			logger.debug("composer cache write failed", { kind: "auto-resume", error: String(error) });
		}
	}

	/** Status-bar inputs for the next prepaint's startup status line. */
	writeStatus(cwd: string, status: ComposerStatusCache, sessionFile?: string): void {
		this.#putShared(
			cwd,
			"status",
			{ status, sessionFile: sessionFile === undefined ? undefined : path.resolve(cwd, sessionFile) },
			{
				status: {
					...status,
					statusLine: {
						...status.statusLine,
						// Usage belongs to one session. The shared fallback must never
						// make another project reserve its usage-only segments.
						contextPercent: undefined,
						tokenBreakdown: undefined,
					},
				},
			},
		);
	}

	/** Refresh global layout inputs while retaining all facts owned by the last resumable session. */
	writeStatusPreservingSession(cwd: string, status: ComposerStatusCache): void {
		const project = path.resolve(cwd);
		let previous: { status: ComposerStatusCache; sessionFile: string | undefined } | undefined;
		try {
			const row = this.#select
				.all(project, project)
				.find(entry => entry.project === project && entry.kind === "status");
			if (row) {
				this.#known.set(`${row.project}\0${row.kind}`, row.value);
				previous = parseCachedStatus(parseJson(row.value));
			}
		} catch (error) {
			logger.debug("composer cache session status read failed", { error: String(error) });
		}
		const next = previous
			? {
					...previous.status,
					statusLine: {
						...previous.status.statusLine,
						settings: status.statusLine.settings,
						gitEnabled: status.statusLine.gitEnabled,
					},
				}
			: status;
		this.writeStatus(cwd, next, previous?.sessionFile);
	}

	close(): void {
		// Unfinalized statements keep the file handle open on Windows.
		this.#select.finalize();
		this.#upsert.finalize();
		this.#db.close();
	}

	/**
	 * Best-effort upsert of this project's row plus the any-project fallback row,
	 * atomically. Callers may omit project-local data from the fallback value. A
	 * failed write only costs the next launch its speculation.
	 */
	#putShared(cwd: string, kind: EntryKind, value: unknown, fallbackValue: unknown = value): void {
		const project = path.resolve(cwd);
		const json = JSON.stringify(value);
		const fallbackJson = JSON.stringify(fallbackValue);
		const ownKey = `${project}\0${kind}`;
		const anyKey = `${ANY_PROJECT}\0${kind}`;
		if (this.#known.get(ownKey) === json && this.#known.get(anyKey) === fallbackJson) return;
		try {
			this.#db.transaction(() => {
				this.#upsert.run(project, kind, json);
				this.#upsert.run(ANY_PROJECT, kind, fallbackJson);
			})();
			this.#known.set(ownKey, json);
			this.#known.set(anyKey, fallbackJson);
		} catch (error) {
			logger.debug("composer cache write failed", { kind, error: String(error) });
		}
	}
}
