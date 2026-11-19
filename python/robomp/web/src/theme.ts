import { createSignal } from "solid-js";

// Theme preference + resolved-theme store for robomp. Ports the stats dashboard
// `useSystemTheme` module-store logic onto SolidJS signals so the toggle (writer)
// and every consumer (reader) resolve through one source. The anti-flash script
// in index.html applies the persisted/system theme before first paint; this
// module re-reads the same key so the toggle stays in sync across reloads.

export type SystemTheme = "light" | "dark";
export type ThemePreference = "system" | "light" | "dark";

export const STORAGE_KEY = "omp-robomp-theme";
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

const initialPreference: ThemePreference = readStoredPreference();
const initialResolved: SystemTheme =
  initialPreference === "system" ? getSystemTheme() : initialPreference;

const [preference, setPreferenceSignal] =
  createSignal<ThemePreference>(initialPreference);
const [resolved, setResolvedSignal] = createSignal<SystemTheme>(initialResolved);

function applyResolvedTheme(): void {
  const pref = preference();
  const next: SystemTheme = pref === "system" ? getSystemTheme() : pref;
  setResolvedSignal(next);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
  }
}

// Re-resolve when the OS theme flips while following the system default.
if (typeof window !== "undefined") {
  applyResolvedTheme();
  window.matchMedia(DARK_SCHEME_QUERY).addEventListener("change", () => {
    if (preference() === "system") {
      applyResolvedTheme();
    }
  });
}

export function setPreference(next: ThemePreference): void {
  setPreferenceSignal(next);
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
  applyResolvedTheme();
}

export { preference, resolved };
