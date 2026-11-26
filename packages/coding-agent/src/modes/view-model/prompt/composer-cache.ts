import type { SymbolPreset } from "../theme/symbols";

/** Theme inputs cached from the last resolved settings load for stable prepaint colors. */
export interface ComposerThemePreferences {
	readonly symbolPreset?: SymbolPreset;
	readonly colorBlindMode?: boolean;
	readonly darkTheme?: string;
	readonly lightTheme?: string;
}
