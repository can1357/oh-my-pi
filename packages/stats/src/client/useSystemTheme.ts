import { useSyncExternalStore } from "react";

export type SystemTheme = "light" | "dark";
export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "omp-stats-theme";
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

function readStoredPreference(): ThemePreference {
	if (typeof localStorage === "undefined") return "system";
	const stored = localStorage.getItem(STORAGE_KEY);
	return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function getSystemTheme(): SystemTheme {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

// Module-level store shared by the toggle (writer) and every chart (reader) so
// an explicit override and the system default resolve through one source.
let preference: ThemePreference = readStoredPreference();
let resolved: SystemTheme = preference === "system" ? getSystemTheme() : preference;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function applyResolvedTheme(): void {
	resolved = preference === "system" ? getSystemTheme() : preference;
	if (typeof document !== "undefined") {
		document.documentElement.dataset.theme = resolved;
		document.documentElement.style.colorScheme = resolved;
	}
}

if (typeof window !== "undefined") {
	applyResolvedTheme();
	window.matchMedia(DARK_SCHEME_QUERY).addEventListener("change", () => {
		// System changes only move the needle while following the system.
		if (preference === "system") {
			applyResolvedTheme();
			emit();
		}
	});
}

export function setThemePreference(next: ThemePreference): void {
	preference = next;
	if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
	applyResolvedTheme();
	emit();
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

/** Reader for the active resolved theme. Reflects system default and overrides. */
export function useSystemTheme(): SystemTheme {
	return useSyncExternalStore(
		subscribe,
		() => resolved,
		() => "dark" as SystemTheme,
	);
}

/** Reader + writer for the theme preference (powers the toggle). */
export function useThemePreference(): {
	preference: ThemePreference;
	resolved: SystemTheme;
	setPreference: (next: ThemePreference) => void;
} {
	const pref = useSyncExternalStore(
		subscribe,
		() => preference,
		() => "system" as ThemePreference,
	);
	const res = useSyncExternalStore(
		subscribe,
		() => resolved,
		() => "dark" as SystemTheme,
	);
	return { preference: pref, resolved: res, setPreference: setThemePreference };
}
