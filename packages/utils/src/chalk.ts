/** Behavior-compatible reimplementation of chalk's used surface. */

import { hexToRgb } from "./color";

/** ANSI color capability level. */
export type ColorLevel = 0 | 1 | 2 | 3;

/** Details about a terminal's supported color depth. */
export interface ColorSupport {
	/** Highest supported ANSI color level. */
	level: ColorLevel;
	/** Whether the terminal supports the basic 16 colors. */
	hasBasic: boolean;
	/** Whether the terminal supports the 256-color palette. */
	has256: boolean;
	/** Whether the terminal supports 24-bit color. */
	has16m: boolean;
}

interface ChalkOptions {
	level?: ColorLevel;
}

interface Style {
	open: string;
	close: string;
}

interface ChalkContext {
	level: number;
}

/** A callable, chainable ANSI text formatter. */
export interface ChalkInstance {
	(...text: unknown[]): string;
	/** Active color capability level. */
	level: ColorLevel;
	/** Reset every active terminal style. */
	readonly reset: ChalkInstance;
	/** Render bold text. */
	readonly bold: ChalkInstance;
	/** Render faint text. */
	readonly dim: ChalkInstance;
	/** Render italic text. */
	readonly italic: ChalkInstance;
	/** Render underlined text. */
	readonly underline: ChalkInstance;
	/** Swap foreground and background colors. */
	readonly inverse: ChalkInstance;
	/** Render struck-through text. */
	readonly strikethrough: ChalkInstance;
	/** Render black text. */
	readonly black: ChalkInstance;
	/** Render red text. */
	readonly red: ChalkInstance;
	/** Render green text. */
	readonly green: ChalkInstance;
	/** Render yellow text. */
	readonly yellow: ChalkInstance;
	/** Render blue text. */
	readonly blue: ChalkInstance;
	/** Render magenta text. */
	readonly magenta: ChalkInstance;
	/** Render cyan text. */
	readonly cyan: ChalkInstance;
	/** Render white text. */
	readonly white: ChalkInstance;
	/** Render gray text. */
	readonly gray: ChalkInstance;
	/** Alias for gray text. */
	readonly grey: ChalkInstance;
	/** Render bright black text. */
	readonly blackBright: ChalkInstance;
	/** Render bright red text. */
	readonly redBright: ChalkInstance;
	/** Render bright green text. */
	readonly greenBright: ChalkInstance;
	/** Render bright yellow text. */
	readonly yellowBright: ChalkInstance;
	/** Render bright blue text. */
	readonly blueBright: ChalkInstance;
	/** Render bright magenta text. */
	readonly magentaBright: ChalkInstance;
	/** Render bright cyan text. */
	readonly cyanBright: ChalkInstance;
	/** Render bright white text. */
	readonly whiteBright: ChalkInstance;
	/** Render text on a black background. */
	readonly bgBlack: ChalkInstance;
	/** Render text on a red background. */
	readonly bgRed: ChalkInstance;
	/** Render text on a green background. */
	readonly bgGreen: ChalkInstance;
	/** Render text on a yellow background. */
	readonly bgYellow: ChalkInstance;
	/** Render text on a blue background. */
	readonly bgBlue: ChalkInstance;
	/** Render text on a magenta background. */
	readonly bgMagenta: ChalkInstance;
	/** Render text on a cyan background. */
	readonly bgCyan: ChalkInstance;
	/** Render text on a white background. */
	readonly bgWhite: ChalkInstance;
	/** Render text on a gray background. */
	readonly bgGray: ChalkInstance;
	/** Alias for a gray background. */
	readonly bgGrey: ChalkInstance;
	/** Render text on a bright black background. */
	readonly bgBlackBright: ChalkInstance;
	/** Render text on a bright red background. */
	readonly bgRedBright: ChalkInstance;
	/** Render text on a bright green background. */
	readonly bgGreenBright: ChalkInstance;
	/** Render text on a bright yellow background. */
	readonly bgYellowBright: ChalkInstance;
	/** Render text on a bright blue background. */
	readonly bgBlueBright: ChalkInstance;
	/** Render text on a bright magenta background. */
	readonly bgMagentaBright: ChalkInstance;
	/** Render text on a bright cyan background. */
	readonly bgCyanBright: ChalkInstance;
	/** Render text on a bright white background. */
	readonly bgWhiteBright: ChalkInstance;
	/** Render text with an arbitrary hexadecimal foreground color. */
	hex(color: string): ChalkInstance;
}

/** Constructor for an independently configured chalk formatter. */
export interface ChalkConstructor {
	new (options?: ChalkOptions): ChalkInstance;
}

const ESC = "\u001B[";
const STYLES: Readonly<Record<string, Style>> = {
	reset: { open: `${ESC}0m`, close: `${ESC}0m` },
	bold: { open: `${ESC}1m`, close: `${ESC}22m` },
	dim: { open: `${ESC}2m`, close: `${ESC}22m` },
	italic: { open: `${ESC}3m`, close: `${ESC}23m` },
	underline: { open: `${ESC}4m`, close: `${ESC}24m` },
	inverse: { open: `${ESC}7m`, close: `${ESC}27m` },
	strikethrough: { open: `${ESC}9m`, close: `${ESC}29m` },
	black: { open: `${ESC}30m`, close: `${ESC}39m` },
	red: { open: `${ESC}31m`, close: `${ESC}39m` },
	green: { open: `${ESC}32m`, close: `${ESC}39m` },
	yellow: { open: `${ESC}33m`, close: `${ESC}39m` },
	blue: { open: `${ESC}34m`, close: `${ESC}39m` },
	magenta: { open: `${ESC}35m`, close: `${ESC}39m` },
	cyan: { open: `${ESC}36m`, close: `${ESC}39m` },
	white: { open: `${ESC}37m`, close: `${ESC}39m` },
	gray: { open: `${ESC}90m`, close: `${ESC}39m` },
	blackBright: { open: `${ESC}90m`, close: `${ESC}39m` },
	redBright: { open: `${ESC}91m`, close: `${ESC}39m` },
	greenBright: { open: `${ESC}92m`, close: `${ESC}39m` },
	yellowBright: { open: `${ESC}93m`, close: `${ESC}39m` },
	blueBright: { open: `${ESC}94m`, close: `${ESC}39m` },
	magentaBright: { open: `${ESC}95m`, close: `${ESC}39m` },
	cyanBright: { open: `${ESC}96m`, close: `${ESC}39m` },
	whiteBright: { open: `${ESC}97m`, close: `${ESC}39m` },
	bgBlack: { open: `${ESC}40m`, close: `${ESC}49m` },
	bgRed: { open: `${ESC}41m`, close: `${ESC}49m` },
	bgGreen: { open: `${ESC}42m`, close: `${ESC}49m` },
	bgYellow: { open: `${ESC}43m`, close: `${ESC}49m` },
	bgBlue: { open: `${ESC}44m`, close: `${ESC}49m` },
	bgMagenta: { open: `${ESC}45m`, close: `${ESC}49m` },
	bgCyan: { open: `${ESC}46m`, close: `${ESC}49m` },
	bgWhite: { open: `${ESC}47m`, close: `${ESC}49m` },
	bgBlackBright: { open: `${ESC}100m`, close: `${ESC}49m` },
	bgRedBright: { open: `${ESC}101m`, close: `${ESC}49m` },
	bgGreenBright: { open: `${ESC}102m`, close: `${ESC}49m` },
	bgYellowBright: { open: `${ESC}103m`, close: `${ESC}49m` },
	bgBlueBright: { open: `${ESC}104m`, close: `${ESC}49m` },
	bgMagentaBright: { open: `${ESC}105m`, close: `${ESC}49m` },
	bgCyanBright: { open: `${ESC}106m`, close: `${ESC}49m` },
	bgWhiteBright: { open: `${ESC}107m`, close: `${ESC}49m` },
};

function parseForcedLevel(value: string | undefined): ColorLevel | undefined {
	if (value === undefined) return undefined;
	if (value === "" || value === "true") return 1;
	if (value === "false") return 0;
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed)) return 1;
	return Math.max(0, Math.min(3, parsed)) as ColorLevel;
}

/** Detect an ANSI color level from terminal environment and TTY state. */
export function detectColorLevel(environment: NodeJS.ProcessEnv, isTTY: boolean): ColorLevel {
	const forced = parseForcedLevel(environment.FORCE_COLOR);
	if (forced !== undefined) return forced;
	if ("NO_COLOR" in environment || environment.TERM === "dumb") return 0;
	if (!isTTY) return 0;
	if (environment.COLORTERM === "truecolor" || environment.COLORTERM === "24bit") return 3;
	if (environment.TERM?.endsWith("-256color")) return 2;
	if (environment.CI) {
		if (environment.GITHUB_ACTIONS || environment.GITEA_ACTIONS) return 3;
		if (
			environment.TRAVIS ||
			environment.CIRCLECI ||
			environment.APPVEYOR ||
			environment.GITLAB_CI ||
			environment.BUILDKITE
		) {
			return 1;
		}
		return 0;
	}
	if (environment.TERM_PROGRAM === "iTerm.app") {
		return Number.parseInt(environment.TERM_PROGRAM_VERSION ?? "0", 10) >= 3 ? 3 : 2;
	}
	if (environment.TERM_PROGRAM === "Apple_Terminal") return 2;
	return 1;
}

function colorSupport(level: ColorLevel): ColorSupport | false {
	if (level === 0) return false;
	return { level, hasBasic: true, has256: level >= 2, has16m: level >= 3 };
}

/** Color support detected for standard output. */
export const supportsColor = colorSupport(detectColorLevel(process.env, Boolean(process.stdout.isTTY)));

/** Color support detected for standard error. */
export const supportsColorStderr = colorSupport(detectColorLevel(process.env, Boolean(process.stderr.isTTY)));

function ansi256(r: number, g: number, b: number): number {
	if (r === g && g === b) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return Math.round(((r - 8) / 247) * 24) + 232;
	}
	return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}

function ansi16(r: number, g: number, b: number): number {
	const value = Math.max(r, g, b);
	if (value < 50) return 30;
	let code = 30 + ((Math.round(b / 255) << 2) | (Math.round(g / 255) << 1) | Math.round(r / 255));
	if (value > 191) code += 60;
	return code;
}

function hexStyle(color: string, level: number): Style {
	const { r, g, b } = hexToRgb(color);
	const open =
		level >= 3
			? `${ESC}38;2;${r};${g};${b}m`
			: level === 2
				? `${ESC}38;5;${ansi256(r, g, b)}m`
				: `${ESC}${ansi16(r, g, b)}m`;
	return { open, close: `${ESC}39m` };
}

function applyStyles(input: string, styles: readonly Style[]): string {
	let output = input;
	let opening = "";
	let closing = "";
	for (let index = styles.length - 1; index >= 0; index--) {
		const style = styles[index];
		if (!style) continue;
		output = output.split(style.close).join(style.close + style.open);
		opening = style.open + opening;
		closing += style.close;
	}
	output = output.replace(/\r?\n/g, match => `${closing}${match}${opening}`);
	return opening + output + closing;
}

function createBuilder(context: ChalkContext, styles: readonly Style[]): ChalkInstance {
	const builder = ((...values: unknown[]) => {
		let text = "";
		for (let index = 0; index < values.length; index++) {
			if (index > 0) text += " ";
			text += String(values[index]);
		}
		if (text.length === 0 || context.level === 0) return text;
		return applyStyles(text, styles);
	}) as ChalkInstance;
	Object.defineProperty(builder, "level", {
		get: () => context.level,
		set: (level: number) => {
			context.level = level;
		},
	});
	for (const name in STYLES) {
		const style = STYLES[name];
		if (style) Object.defineProperty(builder, name, { get: () => createBuilder(context, [...styles, style]) });
	}
	Object.defineProperty(builder, "grey", { get: () => createBuilder(context, [...styles, STYLES.gray!]) });
	Object.defineProperty(builder, "bgGray", {
		get: () => createBuilder(context, [...styles, STYLES.bgBlackBright!]),
	});
	Object.defineProperty(builder, "bgGrey", {
		get: () => createBuilder(context, [...styles, STYLES.bgBlackBright!]),
	});
	Object.defineProperty(builder, "hex", {
		value: (color: string) => createBuilder(context, [...styles, hexStyle(color, context.level)]),
	});
	return builder;
}

function ChalkImplementation(this: unknown, options: ChalkOptions = {}): ChalkInstance {
	const detectedLevel = supportsColor === false ? 0 : supportsColor.level;
	return createBuilder({ level: options.level ?? detectedLevel }, []);
}

/** Construct an independently configured chalk formatter. */
export const Chalk = ChalkImplementation as unknown as ChalkConstructor;

const defaultLevel = supportsColor === false ? 0 : supportsColor.level;
const chalk = new Chalk({ level: defaultLevel });

export default chalk;
