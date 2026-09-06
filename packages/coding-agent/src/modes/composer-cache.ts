import * as fs from "node:fs";
import * as path from "node:path";
import "@oh-my-pi/pi-utils/env";
import { getComposerCacheDir } from "@oh-my-pi/pi-utils/dirs";
import type { LspServerInfo, RecentSession } from "./components/welcome";
import type { ComposerPreferences } from "./composer";
import type { SymbolPreset } from "./theme/theme";

const CACHE_VERSION = 1;
/** Theme inputs cached from the last resolved settings load for stable prepaint colors. */
export interface ComposerThemePreferences {
	readonly symbolPreset?: SymbolPreset;
	readonly colorBlindMode?: boolean;
	readonly darkTheme?: string;
	readonly lightTheme?: string;
}

/** Last authoritative model labels shown in the welcome component. */
export interface ComposerWelcomeCache {
	readonly modelName: string;
	readonly providerName: string;
}

/** Speculative composer state read before the settings/session graph is available. */
export interface ComposerStartupCache {
	readonly preferences?: ComposerPreferences;
	readonly theme?: ComposerThemePreferences;
	readonly welcome?: ComposerWelcomeCache;
	readonly recentSessions: RecentSession[];
	readonly lspServers: LspServerInfo[];
}

function projectCacheDir(cwd: string): string {
	const key = Bun.hash.wyhash(path.resolve(cwd)).toString(16).padStart(16, "0");
	return path.join(getComposerCacheDir(), key);
}

function readFile(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function field(value: object, key: string): unknown {
	return Reflect.get(value, key);
}

function readRecentSessions(file: string): RecentSession[] {
	const content = readFile(file);
	if (!content) return [];
	let parsed: unknown;
	try {
		parsed = Bun.JSONL.parse(content);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const sessions: RecentSession[] = [];
	for (const value of parsed) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const name = field(value, "name");
		const timeAgo = field(value, "timeAgo");
		if (typeof name === "string" && typeof timeAgo === "string") sessions.push({ name, timeAgo });
		if (sessions.length === 4) break;
	}
	return sessions;
}

function readLspServers(file: string): LspServerInfo[] {
	const content = readFile(file);
	if (!content) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
	if (field(parsed, "version") !== CACHE_VERSION) return [];
	const values = field(parsed, "servers");
	if (!Array.isArray(values)) return [];
	const servers: LspServerInfo[] = [];
	for (const value of values) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const name = field(value, "name");
		const status = field(value, "status");
		const fileTypes = field(value, "fileTypes");
		if (
			typeof name !== "string" ||
			(status !== "ready" && status !== "error" && status !== "connecting" && status !== "available") ||
			!Array.isArray(fileTypes) ||
			!fileTypes.every(item => typeof item === "string")
		) {
			continue;
		}
		servers.push({ name, status, fileTypes });
	}
	return servers;
}

function readWelcome(file: string): ComposerWelcomeCache | undefined {
	const content = readFile(file);
	if (!content) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	if (field(parsed, "version") !== CACHE_VERSION) return undefined;
	const modelName = field(parsed, "modelName");
	const providerName = field(parsed, "providerName");
	return typeof modelName === "string" && typeof providerName === "string" ? { modelName, providerName } : undefined;
}

function readUiState(file: string): { preferences: ComposerPreferences; theme: ComposerThemePreferences } | undefined {
	const content = readFile(file);
	if (!content) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	if (field(parsed, "version") !== CACHE_VERSION) return undefined;
	const rawPreferences = field(parsed, "preferences");
	const rawTheme = field(parsed, "theme");
	if (
		typeof rawPreferences !== "object" ||
		rawPreferences === null ||
		Array.isArray(rawPreferences) ||
		typeof rawTheme !== "object" ||
		rawTheme === null ||
		Array.isArray(rawTheme)
	) {
		return undefined;
	}
	const quiet = field(rawPreferences, "quiet");
	const composerShape = field(rawPreferences, "composerShape");
	const showHardwareCursor = field(rawPreferences, "showHardwareCursor");
	const maxInlineImages = field(rawPreferences, "maxInlineImages");
	const resizeScrollback = field(rawPreferences, "resizeScrollback");
	const imeSafeCursor = field(rawPreferences, "imeSafeCursor");
	const autocompleteMaxVisible = field(rawPreferences, "autocompleteMaxVisible");
	const spellingTypoDetection = field(rawPreferences, "spellingTypoDetection");
	const spellingAutocomplete = field(rawPreferences, "spellingAutocomplete");
	const spellingAutocorrect = field(rawPreferences, "spellingAutocorrect");
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
		typeof spellingAutocomplete !== "boolean" ||
		typeof spellingAutocorrect !== "boolean"
	) {
		return undefined;
	}
	const symbolPreset = field(rawTheme, "symbolPreset");
	const colorBlindMode = field(rawTheme, "colorBlindMode");
	const darkTheme = field(rawTheme, "darkTheme");
	const lightTheme = field(rawTheme, "lightTheme");
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
			resizeScrollback:
				resizeScrollback === "append" || resizeScrollback === "rebuild" || resizeScrollback === "preserve"
					? resizeScrollback
					: "rebuild",
			imeSafeCursor,
			autocompleteMaxVisible,
			spellingTypoDetection,
			spellingAutocomplete,
			spellingAutocorrect,
		},
		theme: { symbolPreset, colorBlindMode, darkTheme, lightTheme },
	};
}

/** Read all speculative composer caches synchronously before the first terminal paint. */
export function readComposerStartupCache(cwd: string): ComposerStartupCache {
	const dir = projectCacheDir(cwd);
	const ui = readUiState(path.join(dir, "ui.json"));
	return {
		preferences: ui?.preferences,
		theme: ui?.theme,
		welcome: readWelcome(path.join(dir, "welcome.json")),
		recentSessions: readRecentSessions(path.join(dir, "recent-sessions.jsonl")),
		lspServers: readLspServers(path.join(dir, "lsp-servers.json")),
	};
}

/** Persist resolved theme and composer settings for the next prepaint. */
export async function writeComposerUiCache(
	cwd: string,
	preferences: ComposerPreferences,
	theme: ComposerThemePreferences,
): Promise<void> {
	await Bun.write(
		path.join(projectCacheDir(cwd), "ui.json"),
		JSON.stringify({ version: CACHE_VERSION, preferences, theme }),
	);
}

/** Persist authoritative model/provider labels for the next welcome prepaint. */
export async function writeComposerWelcomeCache(cwd: string, welcome: ComposerWelcomeCache): Promise<void> {
	await Bun.write(
		path.join(projectCacheDir(cwd), "welcome.json"),
		JSON.stringify({ version: CACHE_VERSION, ...welcome }),
	);
}

/** Persist the latest recent-session rows as a compact JSONL speculation cache. */
export async function writeComposerRecentSessionsCache(cwd: string, sessions: readonly RecentSession[]): Promise<void> {
	const content = sessions
		.slice(0, 4)
		.map(session => JSON.stringify(session))
		.join("\n");
	await Bun.write(path.join(projectCacheDir(cwd), "recent-sessions.jsonl"), content ? `${content}\n` : "");
}

/** Persist the latest detected project LSP rows for the next prepaint. */
export async function writeComposerLspCache(cwd: string, servers: readonly LspServerInfo[]): Promise<void> {
	await Bun.write(
		path.join(projectCacheDir(cwd), "lsp-servers.json"),
		JSON.stringify({ version: CACHE_VERSION, servers }),
	);
}
