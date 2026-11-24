/**
 * The theme file format: the JSON users write under the custom themes
 * directory and the built-in palettes ship in. Unchanged from the format omp
 * has always read, so existing custom themes keep loading.
 */

/** A color as a theme file writes it: `#rrggbb` (or any CSS color), a 256-color index, a `vars` name, or `""` for the terminal default. */
export type ColorValue = string | number;

/** Foreground color tokens a theme file declares. */
export const FOREGROUND_KEYS = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"assistantMessageText",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdExtensionLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
	"bashMode",
	"pythonMode",
	"btwMode",
	"statusLineSep",
	"statusLineModel",
	"statusLinePath",
	"statusLineGitClean",
	"statusLineGitDirty",
	"statusLineContext",
	"statusLineSpend",
	"statusLineStaged",
	"statusLineDirty",
	"statusLineUntracked",
	"statusLineOutput",
	"statusLineCost",
	"statusLineSubagents",
	"subagent1",
	"subagent2",
	"subagent3",
	"subagent4",
	"subagent5",
	"subagent6",
] as const;

/** Background color tokens a theme file declares. */
export const BACKGROUND_KEYS = [
	"selectedBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"statusLineBg",
] as const;

export type ForegroundKey = (typeof FOREGROUND_KEYS)[number];
export type BackgroundKey = (typeof BACKGROUND_KEYS)[number];

const FOREGROUND_KEY_SET: ReadonlySet<string> = new Set(FOREGROUND_KEYS);
const BACKGROUND_KEY_SET: ReadonlySet<string> = new Set(BACKGROUND_KEYS);

/** Whether `key` names a foreground color (config values that pick a theme color, e.g. a role's badge color). */
export function isForegroundKey(key: string): key is ForegroundKey {
	return FOREGROUND_KEY_SET.has(key);
}

/** Whether `key` names a background color. */
export function isBackgroundKey(key: string): key is BackgroundKey {
	return BACKGROUND_KEY_SET.has(key);
}

/**
 * Tokens a theme may leave out. `thinkingMax` falls back to `thinkingXhigh`,
 * `mdExtensionLink` is derived from `mdLink` and `text`, the rest paint in the
 * terminal default.
 */
export const OPTIONAL_KEYS: Readonly<Record<string, true>> = {
	assistantMessageText: true,
	mdExtensionLink: true,
	thinkingMax: true,
	subagent1: true,
	subagent2: true,
	subagent3: true,
	subagent4: true,
	subagent5: true,
	subagent6: true,
};

export type SymbolPreset = "unicode" | "nerd" | "ascii";

export const SYMBOL_PRESET_NAMES: readonly SymbolPreset[] = ["unicode", "nerd", "ascii"];

/** `symbols.spinnerFrames`: one list for both spinners, or per spinner. */
export type SpinnerFramesOverride = string[] | { status?: string[]; activity?: string[] };

/** A theme file. */
export interface ThemeJson {
	$schema?: string;
	name: string;
	vars?: Record<string, ColorValue>;
	colors: Partial<Record<ForegroundKey | BackgroundKey, ColorValue>>;
	export?: { pageBg?: ColorValue; cardBg?: ColorValue; infoBg?: ColorValue };
	/** The terminal the theme was made for; `ansi` (16 entries) is the palette colorful markdown paints from. */
	terminal?: {
		background?: ColorValue;
		foreground?: ColorValue;
		chrome?: ColorValue;
		widget?: ColorValue;
		ansi?: ColorValue[];
	};
	symbols?: {
		preset?: SymbolPreset;
		overrides?: Record<string, string>;
		spinnerFrames?: SpinnerFramesOverride;
	};
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColor(value: unknown): value is ColorValue {
	return typeof value === "string" || typeof value === "number";
}

function isFrameList(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(frame => typeof frame === "string");
}

function checkColorRecord(value: unknown, path: string, errors: string[]): void {
	if (value === undefined) return;
	if (!isObject(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	for (const key in value) {
		if (!isColor(value[key])) errors.push(`${path}.${key} must be a string or number`);
	}
}

function checkSymbols(value: unknown, errors: string[]): void {
	if (value === undefined) return;
	if (!isObject(value)) {
		errors.push("symbols must be an object");
		return;
	}
	const { preset, overrides, spinnerFrames } = value;
	if (preset !== undefined && !SYMBOL_PRESET_NAMES.includes(preset as SymbolPreset)) {
		errors.push(`symbols.preset must be one of ${SYMBOL_PRESET_NAMES.join(", ")}`);
	}
	if (overrides !== undefined) {
		if (!isObject(overrides)) errors.push("symbols.overrides must be an object");
		else {
			for (const key in overrides) {
				if (typeof overrides[key] !== "string") errors.push(`symbols.overrides.${key} must be a string`);
			}
		}
	}
	if (spinnerFrames === undefined || isFrameList(spinnerFrames)) return;
	if (!isObject(spinnerFrames)) {
		errors.push("symbols.spinnerFrames must be a non-empty string array or { status?, activity? }");
		return;
	}
	const { status, activity } = spinnerFrames;
	if (status === undefined && activity === undefined) {
		errors.push("symbols.spinnerFrames must set status or activity");
	}
	if (status !== undefined && !isFrameList(status))
		errors.push("symbols.spinnerFrames.status must be a non-empty string array");
	if (activity !== undefined && !isFrameList(activity)) {
		errors.push("symbols.spinnerFrames.activity must be a non-empty string array");
	}
}

/**
 * Check a parsed custom theme file. Throws one error naming the theme, every
 * missing required color (grouped) and every malformed field.
 */
export function validateThemeJson(name: string, value: unknown): ThemeJson {
	if (!isObject(value)) throw new Error(`Invalid theme "${name}": the file must hold a JSON object`);
	const errors: string[] = [];
	const missing: string[] = [];
	if (typeof value.name !== "string") errors.push("name must be a string");
	if (value.$schema !== undefined && typeof value.$schema !== "string") errors.push("$schema must be a string");
	checkColorRecord(value.vars, "vars", errors);
	const colors = value.colors;
	if (!isObject(colors)) errors.push("colors must be an object");
	else {
		for (const key of [...FOREGROUND_KEYS, ...BACKGROUND_KEYS]) {
			const color = colors[key];
			if (color === undefined) {
				if (OPTIONAL_KEYS[key] !== true) missing.push(key);
			} else if (!isColor(color)) errors.push(`colors.${key} must be a string or number`);
		}
	}
	checkColorRecord(value.export, "export", errors);
	const terminal = value.terminal;
	if (terminal !== undefined) {
		if (!isObject(terminal)) errors.push("terminal must be an object");
		else {
			const { ansi, ...rest } = terminal;
			checkColorRecord(rest, "terminal", errors);
			if (ansi !== undefined && (!Array.isArray(ansi) || ansi.length !== 16 || !ansi.every(isColor))) {
				errors.push("terminal.ansi must hold exactly 16 colors");
			}
		}
	}
	checkSymbols(value.symbols, errors);
	if (missing.length === 0 && errors.length === 0) return value as unknown as ThemeJson;
	let message = `Invalid theme "${name}":`;
	if (missing.length > 0) {
		message += `\n\nMissing required color tokens:\n${missing.map(key => `  - ${key}`).join("\n")}`;
		message += `\n\nPlease add these colors to your theme's "colors" object.`;
		message += `\nSee the built-in themes (dark.json, light.json) for reference values.`;
	}
	if (errors.length > 0) message += `\n\nValidation error:\n${errors.map(error => `  - ${error}`).join("\n")}`;
	throw new Error(message);
}

const THINKING_COLORS: Readonly<Record<string, ForegroundKey>> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/** Color of a thinking/effort level (`off`…`max`: borders, badges); unknown levels take `thinkingOff`. */
export function thinkingColor(level: string): ForegroundKey {
	return THINKING_COLORS[level] ?? "thinkingOff";
}
