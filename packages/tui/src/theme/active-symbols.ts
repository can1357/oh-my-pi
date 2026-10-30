/**
 * Active theme's symbol lookup without importing `./theme` (which pulls the
 * native addon through `@oh-my-pi/pi-natives`). Key-hint formatting runs on
 * CLI paths that must stay addon-free (`omp --version`, help), so it reads the
 * active theme through this mirror; `./theme` publishes every assignment here.
 */
import { SYMBOL_PRESETS, type SymbolKey } from "./symbols";
import type { Theme } from "./theme-class";

let active: Theme | undefined;

/** @internal Called by `./theme` whenever the active theme changes. */
export function setActiveSymbolTheme(value: Theme | undefined): void {
	active = value;
}

/** Symbol from the active theme, or the ascii preset before any theme loads. */
export function activeThemeSymbol(key: SymbolKey): string {
	return active ? active.symbol(key) : SYMBOL_PRESETS.ascii[key];
}
