import { createSignal } from "solid-js";
export const STORAGE_KEY = "omp-robomp-theme";
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";
function readStoredPreference() {
    if (typeof localStorage === "undefined")
        return "system";
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}
function getSystemTheme() {
    if (typeof window === "undefined")
        return "dark";
    return window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}
const initialPreference = readStoredPreference();
const initialResolved = initialPreference === "system" ? getSystemTheme() : initialPreference;
const [preference, setPreferenceSignal] = createSignal(initialPreference);
const [resolved, setResolvedSignal] = createSignal(initialResolved);
function applyResolvedTheme() {
    const pref = preference();
    const next = pref === "system" ? getSystemTheme() : pref;
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
export function setPreference(next) {
    setPreferenceSignal(next);
    if (typeof localStorage !== "undefined")
        localStorage.setItem(STORAGE_KEY, next);
    applyResolvedTheme();
}
export { preference, resolved };
