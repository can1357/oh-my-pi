/** `chrome.storage.local` as React state: the panel's settings, shortcuts and per-host suggestions. */
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { useCallback, useEffect, useRef, useState } from "react";
import { type PanelSettings, SETTINGS_KEY, SHORTCUTS_KEY, type Shortcut, SUGGESTIONS_KEY } from "../messages";

/** Settings a fresh install starts with. */
export const DEFAULT_SETTINGS: PanelSettings = {
	theme: "system",
	defaultCwd: "~",
	newChat: "attach",
	overlay: { enabled: true, arrow: true, edge: true },
};

/** Starter prompts shown on the empty state when the tab's host has no override. */
export const DEFAULT_SUGGESTIONS: readonly string[] = [
	"Summarize this page",
	"What changed since I last looked?",
	"Fill this form with my usual details",
];

/** localStorage mirror of the theme, read synchronously at boot so the panel never flashes the wrong theme. */
const THEME_MIRROR_KEY = "omp.theme";

/** Stored settings with every missing or malformed field replaced by its default. */
export function normalizeSettings(raw: unknown): PanelSettings {
	if (!isRecord(raw)) return DEFAULT_SETTINGS;
	const overlay = isRecord(raw.overlay) ? raw.overlay : {};
	return {
		theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : "system",
		defaultCwd:
			typeof raw.defaultCwd === "string" && raw.defaultCwd.trim() !== ""
				? raw.defaultCwd
				: DEFAULT_SETTINGS.defaultCwd,
		newChat: raw.newChat === "panel" ? "panel" : "attach",
		overlay: {
			enabled: overlay.enabled !== false,
			arrow: overlay.arrow !== false,
			edge: overlay.edge !== false,
		},
	};
}

function isShortcut(value: unknown): value is Shortcut {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.prompt === "string" &&
		typeof value.uses === "number" &&
		typeof value.createdAt === "number"
	);
}

/** Stored shortcut list, dropping entries that are not shortcuts. */
export function normalizeShortcuts(raw: unknown): Shortcut[] {
	return Array.isArray(raw) ? raw.filter(isShortcut) : [];
}

/** Stored per-host suggestions: `hostname → prompts`, dropping anything else. */
export function normalizeSuggestions(raw: unknown): Record<string, string[]> {
	if (!isRecord(raw)) return {};
	const out: Record<string, string[]> = {};
	for (const host in raw) {
		const prompts = raw[host];
		if (!Array.isArray(prompts)) continue;
		const kept = prompts.filter((p): p is string => typeof p === "string" && p.trim() !== "");
		if (kept.length > 0) out[host] = kept;
	}
	return out;
}

/**
 * One `chrome.storage.local` key as state. `value` is `fallback` until the first read lands; `ready` says when.
 * Writes are optimistic and every other extension context's writes arrive through `storage.onChanged`.
 */
export function useStored<T>(key: string, normalize: (raw: unknown) => T): Stored<T> {
	const [state, setState] = useState<{ value: T; ready: boolean }>(() => ({
		value: normalize(undefined),
		ready: false,
	}));
	const latest = useRef(state.value);
	latest.current = state.value;

	useEffect(() => {
		let alive = true;
		void chrome.storage.local.get(key).then(stored => {
			if (alive) setState({ value: normalize(stored[key]), ready: true });
		});
		const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
			if (area !== "local" || !(key in changes)) return;
			setState({ value: normalize(changes[key].newValue), ready: true });
		};
		chrome.storage.onChanged.addListener(onChanged);
		return () => {
			alive = false;
			chrome.storage.onChanged.removeListener(onChanged);
		};
	}, [key, normalize]);

	const set = useCallback(
		(next: T | ((prev: T) => T)): void => {
			// `T` is never a function here (settings, lists, records), so a function is always an updater.
			const value = typeof next === "function" ? (next as (prev: T) => T)(latest.current) : next;
			latest.current = value;
			setState({ value, ready: true });
			void chrome.storage.local.set({ [key]: value });
		},
		[key],
	);

	return { value: state.value, ready: state.ready, set };
}

/** A stored value, whether its first read landed, and its optimistic setter. */
export interface Stored<T> {
	value: T;
	ready: boolean;
	set(next: T | ((prev: T) => T)): void;
}

/** {@link PanelSettings} from storage. */
export function useSettings(): Stored<PanelSettings> {
	return useStored(SETTINGS_KEY, normalizeSettings);
}

/** Saved {@link Shortcut}s from storage. */
export function useShortcuts(): Stored<Shortcut[]> {
	return useStored(SHORTCUTS_KEY, normalizeShortcuts);
}

/** Per-host starter prompts from storage. */
export function useSuggestions(): Stored<Record<string, string[]>> {
	return useStored(SUGGESTIONS_KEY, normalizeSuggestions);
}

/** Apply a theme preference to the document: `system` removes the attribute so the tokens' media query decides. */
export function applyTheme(theme: PanelSettings["theme"]): void {
	const root = document.documentElement;
	if (theme === "system") root.removeAttribute("data-theme");
	else root.setAttribute("data-theme", theme);
	try {
		localStorage.setItem(THEME_MIRROR_KEY, theme);
	} catch {
		// Storage can be unavailable (blocked site data); the theme then applies once settings load.
	}
}

/** Apply the theme mirrored by the last {@link applyTheme}, before React and `chrome.storage` are up. */
export function applyMirroredTheme(): void {
	let mirrored: string | null = null;
	try {
		mirrored = localStorage.getItem(THEME_MIRROR_KEY);
	} catch {
		// See applyTheme.
	}
	if (mirrored === "light" || mirrored === "dark") document.documentElement.setAttribute("data-theme", mirrored);
}

/** Slash name from free text: lowercase, spaces to hyphens, only `a–z 0–9 - _`. */
export function sanitizeShortcutName(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/^\/+/, "")
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9_-]/g, "");
}

/** Shortcuts in slash-menu order: most used first, then newest. */
export function sortShortcuts(shortcuts: readonly Shortcut[]): Shortcut[] {
	return [...shortcuts].sort((a, b) => b.uses - a.uses || b.createdAt - a.createdAt);
}
