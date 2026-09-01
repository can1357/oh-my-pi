import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort } from "@oh-my-pi/pi-ai";
import { colorLuma, logger, relativeLuminance } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { SessionAccentTheme } from "../../utils/session-color";
import { bgAnsi, colorToAnsi, fgAnsi, resolveToHex } from "./color";
import { type ColorMode, isValidThemeColor, type ThemeBg, type ThemeColor } from "./schema";
import {
	type SlashCommandIconName,
	SPINNER_FRAMES,
	type SpinnerType,
	SYMBOL_PRESETS,
	type SymbolKey,
	type SymbolMap,
	type SymbolPreset,
} from "./symbols";

// ============================================================================
// Theme Class
// ============================================================================

const langMap: Record<string, SymbolKey> = {
	typescript: "lang.typescript",
	ts: "lang.typescript",
	tsx: "lang.typescript",
	javascript: "lang.javascript",
	js: "lang.javascript",
	jsx: "lang.javascript",
	mjs: "lang.javascript",
	cjs: "lang.javascript",
	python: "lang.python",
	py: "lang.python",
	rust: "lang.rust",
	rs: "lang.rust",
	go: "lang.go",
	java: "lang.java",
	c: "lang.c",
	cpp: "lang.cpp",
	"c++": "lang.cpp",
	cc: "lang.cpp",
	cxx: "lang.cpp",
	csharp: "lang.csharp",
	cs: "lang.csharp",
	ruby: "lang.ruby",
	rb: "lang.ruby",
	julia: "lang.julia",
	jl: "lang.julia",
	php: "lang.php",
	swift: "lang.swift",
	kotlin: "lang.kotlin",
	kt: "lang.kotlin",
	bash: "lang.shell",
	sh: "lang.shell",
	zsh: "lang.shell",
	fish: "lang.shell",
	powershell: "lang.shell",
	just: "lang.shell",
	shell: "lang.shell",
	html: "lang.html",
	htm: "lang.html",
	astro: "lang.html",
	vue: "lang.html",
	svelte: "lang.html",
	css: "lang.css",
	scss: "lang.css",
	sass: "lang.css",
	less: "lang.css",
	json: "lang.json",
	yaml: "lang.yaml",
	yml: "lang.yaml",
	markdown: "lang.markdown",
	md: "lang.markdown",
	sql: "lang.sql",
	dockerfile: "lang.docker",
	docker: "lang.docker",
	lua: "lang.lua",
	text: "lang.text",
	txt: "lang.text",
	plain: "lang.text",
	log: "lang.log",
	env: "lang.env",
	dotenv: "lang.env",
	toml: "lang.toml",
	xml: "lang.xml",
	ini: "lang.ini",
	conf: "lang.conf",
	cfg: "lang.conf",
	config: "lang.conf",
	properties: "lang.conf",
	csv: "lang.csv",
	tsv: "lang.tsv",
	image: "lang.image",
	img: "lang.image",
	png: "lang.image",
	jpg: "lang.image",
	jpeg: "lang.image",
	gif: "lang.image",
	webp: "lang.image",
	svg: "lang.image",
	ico: "lang.image",
	bmp: "lang.image",
	tiff: "lang.image",
	pdf: "lang.pdf",
	zip: "lang.archive",
	tar: "lang.archive",
	gz: "lang.archive",
	tgz: "lang.archive",
	bz2: "lang.archive",
	xz: "lang.archive",
	"7z": "lang.archive",
	exe: "lang.binary",
	dll: "lang.binary",
	so: "lang.binary",
	dylib: "lang.binary",
	wasm: "lang.binary",
	bin: "lang.binary",
};

/**
 * Brand colors for language icons, keyed by the resolved `lang.*` SymbolKey.
 * Used by {@link Theme.getLangIconStyled} so eval-kernel cell headers tint each
 * language with its recognizable hue (JS yellow, Ruby red, Julia purple, Python
 * blue) instead of a flat muted gray. Applied as truecolor/256 per the active
 * color mode; languages without an entry fall back to the muted theme color.
 */
const LANG_BRAND_COLORS: Partial<Record<SymbolKey, string>> = {
	"lang.javascript": "#f7df1e",
	"lang.python": "#3776ab",
	"lang.ruby": "#cc342d",
	"lang.julia": "#9558b2",
};

const BACKGROUND_RESET_PATTERN = /\x1b\[(?:0|49)m/g;
const FOREGROUND_RESET_PATTERN = /\x1b\[(?:0|39)m/g;

export class Theme {
	#fgColors: Record<ThemeColor, string>;
	#bgColors: Record<ThemeBg, string>;
	/** Resolved hex strings for foreground colors — populated at construction. */
	readonly #hexFgColors: Record<ThemeColor, string>;
	/** Resolved hex strings for background colors — populated at construction. */
	readonly #hexBgColors: Record<ThemeBg, string>;
	#symbols: SymbolMap;
	#spinnerFramesOverrides: Partial<Record<SpinnerType, string[]>>;
	/**
	 * Perceptual luma (0..1) of the status-line background — used to classify the
	 * theme light/dark. Undefined when it can't be resolved. Classified against the
	 * status line (the surface session accents render on) rather than the chat bubble
	 * (`userMessageBg`), which some themes (e.g. `porcelain`) style dark on an
	 * otherwise-light theme.
	 */
	readonly statusLineLuminance: number | undefined;
	/** WCAG relative luminance of the status-line background — basis for accent contrast. */
	readonly #statusLineContrastLuminance: number | undefined;
	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		private readonly mode: ColorMode,
		private readonly symbolPreset: SymbolPreset,
		symbolOverrides: Partial<Record<SymbolKey, string>>,
		spinnerFramesOverrides: Partial<Record<SpinnerType, string[]>> = {},
	) {
		this.statusLineLuminance = colorLuma(bgColors.statusLineBg);
		this.#statusLineContrastLuminance = relativeLuminance(bgColors.statusLineBg);
		const slIsLight = this.statusLineLuminance !== undefined && this.statusLineLuminance > 0.5;

		this.#fgColors = {} as Record<ThemeColor, string>;
		this.#hexFgColors = {} as Record<ThemeColor, string>;
		for (const key in fgColors) {
			if (!isValidThemeColor(key)) continue;
			const value = fgColors[key];
			const hex = resolveToHex(value, slIsLight);
			this.#fgColors[key] = fgAnsi(value, mode);
			this.#hexFgColors[key] = hex;
		}
		this.#bgColors = {} as Record<ThemeBg, string>;
		this.#hexBgColors = {} as Record<ThemeBg, string>;
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.#bgColors[key] = bgAnsi(value, mode);
			this.#hexBgColors[key] = resolveToHex(value, slIsLight);
		}
		// Build symbol map from preset + overrides
		const baseSymbols = SYMBOL_PRESETS[symbolPreset];
		this.#symbols = { ...baseSymbols };
		for (const [key, value] of Object.entries(symbolOverrides)) {
			if (key in this.#symbols) {
				this.#symbols[key as SymbolKey] = value;
			} else {
				logger.debug("Invalid symbol key in override", { key, availableKeys: Object.keys(this.#symbols) });
			}
		}
		this.#spinnerFramesOverrides = spinnerFramesOverrides;
	}

	/** True when the active theme has a light status-line background. */
	get isLight(): boolean {
		return this.statusLineLuminance !== undefined && this.statusLineLuminance > 0.5;
	}

	/**
	 * Surface luminance to size session accents against on light themes; undefined on
	 * dark themes so accents stay vivid. Pass straight to `getSessionAccentHex`.
	 */
	get accentSurfaceLuminance(): number | undefined {
		return this.isLight ? this.#statusLineContrastLuminance : undefined;
	}

	/**
	 * Get the resolved CSS hex string for a foreground theme color.
	 */
	getColorHex(color: ThemeColor): string {
		const hex = this.#hexFgColors[color];
		if (hex === undefined) throw new Error(`Unknown theme color: ${color}`);
		return hex || (this.isLight ? "#000000" : "#e5e5e7");
	}
	/**
	 * Get the resolved CSS hex string for a background theme color.
	 */
	getBgHex(color: ThemeBg): string {
		const hex = this.#hexBgColors[color];
		if (hex === undefined) throw new Error(`Unknown theme background color: ${color}`);
		return hex || (this.isLight ? "#ffffff" : "#000000");
	}

	/**
	 * Get all foreground and background theme colors as CSS hex strings.
	 * Skips colors resolved to the default terminal color (unstyled).
	 */
	getAllThemeColorHexes(): string[] {
		const hexes: string[] = [];
		for (const hex of Object.values(this.#hexFgColors)) {
			if (hex) hexes.push(hex);
		}
		for (const hex of Object.values(this.#hexBgColors)) {
			if (hex) hexes.push(hex);
		}
		return hexes;
	}

	/**
	 * Get the most visually dominant theme colors as CSS hex strings — accent,
	 * border, success, error, warning, heading, link, diff markers, etc.
	 * These are the colors the session accent could visually clash with.
	 * Skips colors resolved to the default terminal color (unstyled).
	 */
	getMajorThemeColorHexes(): string[] {
		const majors: ThemeColor[] = [
			"accent",
			"border",
			"borderAccent",
			"borderMuted",
			"success",
			"error",
			"warning",
			"mdHeading",
			"mdLink",
			"mdCode",
			"mdCodeBlock",
			"mdQuoteBorder",
			"mdListBullet",
			"toolDiffAdded",
			"toolDiffRemoved",
			"customMessageLabel",
			"thinkingText",
		];
		const hexes: string[] = [];
		for (const key of majors) {
			const hex = this.#hexFgColors[key];
			if (hex) hexes.push(hex);
		}
		return hexes;
	}
	/**
	 * Get the resolved CSS hex string for the theme's accent color.
	 */
	getAccentColorHex(): string {
		return this.getColorHex("accent");
	}
	/**
	 * Theme-derived inputs for `getSessionAccentHex`: the accent hex whose
	 * OKLCH weight session accents adopt, the major colors they must not
	 * hue-collide with, and the light-theme surface luminance to contrast
	 * against.
	 */
	get sessionAccentInputs(): SessionAccentTheme {
		return {
			accentHex: this.getAccentColorHex(),
			colorHexes: this.getMajorThemeColorHexes(),
			surfaceLuminance: this.accentSurfaceLuminance,
		};
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	/** Apply a foreground, replacing terminal-default tokens with the theme's contrast-safe fallback. */
	fgResolved(color: ThemeColor, text: string): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		const resolved = ansi === "\x1b[39m" ? colorToAnsi(this.getColorHex(color), this.mode) : ansi;
		return `${resolved}${text.replace(FOREGROUND_RESET_PATTERN, `$&${resolved}`)}\x1b[39m`;
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	/**
	 * Apply a background fill that resumes after nested full/background resets.
	 *
	 * Composer rows contain styled text and cursor escapes; a normal background
	 * wrapper would otherwise stop at the first nested reset.
	 */
	bgFill(color: ThemeBg, text: string): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text.replace(BACKGROUND_RESET_PATTERN, `$&${ansi}`)}\x1b[49m`;
	}

	/**
	 * Apply a foreground over a controlled background, choosing a contrast-safe
	 * fallback only when the theme token requests the terminal default and
	 * reapplying it after nested full/foreground resets.
	 */
	fgOnBg(color: ThemeColor, background: ThemeBg, text: string): string {
		const ansi = this.getFgOnBgAnsi(color, background);
		return `${ansi}${text.replace(FOREGROUND_RESET_PATTERN, `$&${ansi}`)}\x1b[39m`;
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.#bgColors[color];
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	/**
	 * Foreground ANSI for text rendered over a controlled theme background.
	 * Explicit theme colors win; terminal-default tokens become black or near-white.
	 */
	getFgOnBgAnsi(color: ThemeColor, background: ThemeBg): string {
		const ansi = this.#fgColors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		if (ansi !== "\x1b[39m") return ansi;
		const backgroundAnsi = this.#bgColors[background];
		if (!backgroundAnsi) throw new Error(`Unknown theme background color: ${background}`);
		if (backgroundAnsi === "\x1b[49m") return ansi;
		const backgroundLuma = colorLuma(this.getBgHex(background));
		return colorToAnsi(backgroundLuma !== undefined && backgroundLuma > 0.5 ? "#000000" : "#e5e5e7", this.mode);
	}

	/**
	 * Foreground ANSI for text drawn **on top of** `fillColor` used as a solid
	 * background (e.g. a powerline chip). Picks near-black or near-white by the
	 * fill's perceived luminance (Rec. 601 luma) so the label stays legible on
	 * both bright and dark fills, across light and dark themes.
	 *
	 * Reads the RGB out of the already-resolved truecolor escape; when the fill
	 * is encoded as a 256-palette index (limited terminals) the RGB is
	 * unavailable, so it falls back to the theme `text` color.
	 */
	getContrastFgAnsi(fillColor: ThemeColor): string {
		const ansi = this.#fgColors[fillColor];
		const match = ansi ? /38;2;(\d+);(\d+);(\d+)/.exec(ansi) : null;
		if (!match) return this.#fgColors.text;
		const luma = 0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3]);
		return luma > 140 ? "\x1b[38;2;0;0;0m" : "\x1b[38;2;255;255;255m";
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: ThinkingLevel | Effort): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			case "max":
				// thinkingMax is optional; themes without it resolve to the xhigh color.
				return (str: string) => this.fg(this.#fgColors.thinkingMax ? "thinkingMax" : "thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}

	getPythonModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("pythonMode", str);
	}

	// ============================================================================
	// Symbol Methods
	// ============================================================================

	/**
	 * Get a symbol by key.
	 */
	symbol(key: SymbolKey): string {
		return this.#symbols[key];
	}

	/**
	 * Get a symbol styled with a color.
	 */
	styledSymbol(key: SymbolKey, color: ThemeColor): string {
		return this.fg(color, this.#symbols[key]);
	}

	/**
	 * Get the current symbol preset.
	 */
	getSymbolPreset(): SymbolPreset {
		return this.symbolPreset;
	}

	// ============================================================================
	// Symbol Category Accessors
	// ============================================================================

	get status() {
		return {
			success: this.#symbols["status.success"],
			error: this.#symbols["status.error"],
			warning: this.#symbols["status.warning"],
			info: this.#symbols["status.info"],
			pending: this.#symbols["status.pending"],
			disabled: this.#symbols["status.disabled"],
			enabled: this.#symbols["status.enabled"],
			running: this.#symbols["status.running"],
			shadowed: this.#symbols["status.shadowed"],
			aborted: this.#symbols["status.aborted"],
			done: this.#symbols["status.done"],
		};
	}

	get nav() {
		return {
			cursor: this.#symbols["nav.cursor"],
			selected: this.#symbols["nav.selected"],
			expand: this.#symbols["nav.expand"],
			collapse: this.#symbols["nav.collapse"],
			back: this.#symbols["nav.back"],
		};
	}

	get tree() {
		return {
			branch: this.#symbols["tree.branch"],
			last: this.#symbols["tree.last"],
			vertical: this.#symbols["tree.vertical"],
			horizontal: this.#symbols["tree.horizontal"],
			hook: this.#symbols["tree.hook"],
		};
	}

	get progress() {
		return {
			filled: this.#symbols["progress.filled"],
			empty: this.#symbols["progress.empty"],
		};
	}

	get boxRound() {
		return {
			topLeft: this.#symbols["boxRound.topLeft"],
			topRight: this.#symbols["boxRound.topRight"],
			bottomLeft: this.#symbols["boxRound.bottomLeft"],
			bottomRight: this.#symbols["boxRound.bottomRight"],
			horizontal: this.#symbols["boxRound.horizontal"],
			vertical: this.#symbols["boxRound.vertical"],
			// Junctions have no rounded Unicode variant, so a rounded box reuses the
			// sharp tee/cross glyphs. Sourcing them from the boxSharp.* tokens keeps a
			// theme's `boxSharp.tee*` overrides effective for rounded-box dividers.
			cross: this.#symbols["boxSharp.cross"],
			teeDown: this.#symbols["boxSharp.teeDown"],
			teeUp: this.#symbols["boxSharp.teeUp"],
			teeRight: this.#symbols["boxSharp.teeRight"],
			teeLeft: this.#symbols["boxSharp.teeLeft"],
		};
	}

	/**
	 * Dotted rules/verticals for transient selection outlines. Corners come from
	 * {@link boxRound} — Unicode has no rounded dotted corner glyphs.
	 */
	get boxDotted() {
		return {
			horizontal: this.#symbols["boxDotted.horizontal"],
			vertical: this.#symbols["boxDotted.vertical"],
		};
	}

	get boxSharp() {
		return {
			topLeft: this.#symbols["boxSharp.topLeft"],
			topRight: this.#symbols["boxSharp.topRight"],
			bottomLeft: this.#symbols["boxSharp.bottomLeft"],
			bottomRight: this.#symbols["boxSharp.bottomRight"],
			horizontal: this.#symbols["boxSharp.horizontal"],
			vertical: this.#symbols["boxSharp.vertical"],
			cross: this.#symbols["boxSharp.cross"],
			teeDown: this.#symbols["boxSharp.teeDown"],
			teeUp: this.#symbols["boxSharp.teeUp"],
			teeRight: this.#symbols["boxSharp.teeRight"],
			teeLeft: this.#symbols["boxSharp.teeLeft"],
		};
	}

	get sep() {
		return {
			powerline: this.#symbols["sep.powerline"],
			powerlineThin: this.#symbols["sep.powerlineThin"],
			powerlineLeft: this.#symbols["sep.powerlineLeft"],
			powerlineRight: this.#symbols["sep.powerlineRight"],
			powerlineThinLeft: this.#symbols["sep.powerlineThinLeft"],
			powerlineThinRight: this.#symbols["sep.powerlineThinRight"],
			powerlineCapLeft: this.#symbols["sep.powerlineCapLeft"],
			block: this.#symbols["sep.block"],
			space: this.#symbols["sep.space"],
			asciiLeft: this.#symbols["sep.asciiLeft"],
			asciiRight: this.#symbols["sep.asciiRight"],
			dot: this.#symbols["sep.dot"],
			slash: this.#symbols["sep.slash"],
			pipe: this.#symbols["sep.pipe"],
		};
	}

	get icon() {
		return {
			model: this.#symbols["icon.model"],
			plan: this.#symbols["icon.plan"],
			prewalk: this.#symbols["icon.prewalk"],
			goal: this.#symbols["icon.goal"],
			pause: this.#symbols["icon.pause"],
			loop: this.#symbols["icon.loop"],
			folder: this.#symbols["icon.folder"],
			worktree: this.#symbols["icon.worktree"],
			scratchFolder: this.#symbols["icon.scratchFolder"],
			file: this.#symbols["icon.file"],
			git: this.#symbols["icon.git"],
			branch: this.#symbols["icon.branch"],
			pr: this.#symbols["icon.pr"],
			pin: this.#symbols["icon.pin"],
			tokens: this.#symbols["icon.tokens"],
			context: this.#symbols["icon.context"],
			cost: this.#symbols["icon.cost"],
			subscription: this.#symbols["icon.subscription"],
			advisor: this.#symbols["icon.advisor"],
			time: this.#symbols["icon.time"],
			omp: this.#symbols["icon.omp"],
			esc: this.#symbols["icon.esc"],
			ghost: this.#symbols["icon.ghost"],
			agents: this.#symbols["icon.agents"],
			job: this.#symbols["icon.job"],
			cache: this.#symbols["icon.cache"],
			cacheMiss: this.#symbols["icon.cacheMiss"],
			input: this.#symbols["icon.input"],
			output: this.#symbols["icon.output"],
			throughput: this.#symbols["icon.throughput"],
			host: this.#symbols["icon.host"],
			session: this.#symbols["icon.session"],
			package: this.#symbols["icon.package"],
			warning: this.#symbols["icon.warning"],
			rewind: this.#symbols["icon.rewind"],
			auto: this.#symbols["icon.auto"],
			fast: this.#symbols["icon.fast"],
			extensionSkill: this.#symbols["icon.extensionSkill"],
			extensionTool: this.#symbols["icon.extensionTool"],
			extensionSlashCommand: this.#symbols["icon.extensionSlashCommand"],
			extensionMcp: this.#symbols["icon.extensionMcp"],
			extensionRule: this.#symbols["icon.extensionRule"],
			extensionHook: this.#symbols["icon.extensionHook"],
			extensionPrompt: this.#symbols["icon.extensionPrompt"],
			extensionContextFile: this.#symbols["icon.extensionContextFile"],
			extensionInstruction: this.#symbols["icon.extensionInstruction"],
			mic: this.#symbols["icon.mic"],
			camera: this.#symbols["icon.camera"],
		};
	}

	/** Slash-command type-indicator glyphs for the autocomplete icon column. */
	get cmd(): Record<SlashCommandIconName, string> {
		return {
			action: this.#symbols["cmd.action"],
			prompt: this.#symbols["cmd.prompt"],
			extension: this.#symbols["cmd.extension"],
			settings: this.#symbols["cmd.settings"],
			gear: this.#symbols["cmd.gear"],
			shield: this.#symbols["cmd.shield"],
			wave: this.#symbols["cmd.wave"],
			compass: this.#symbols["cmd.compass"],
			inbox: this.#symbols["cmd.inbox"],
			swap: this.#symbols["cmd.swap"],
			expand: this.#symbols["cmd.expand"],
			computer: this.#symbols["cmd.computer"],
			eye: this.#symbols["cmd.eye"],
			todo: this.#symbols["cmd.todo"],
			stats: this.#symbols["cmd.stats"],
			news: this.#symbols["cmd.news"],
			keyboard: this.#symbols["cmd.keyboard"],
			export: this.#symbols["cmd.export"],
			clipboard: this.#symbols["cmd.clipboard"],
			share: this.#symbols["cmd.share"],
			broadcast: this.#symbols["cmd.broadcast"],
			globe: this.#symbols["cmd.globe"],
			copy: this.#symbols["cmd.copy"],
			plus: this.#symbols["cmd.plus"],
			restart: this.#symbols["cmd.restart"],
			eraser: this.#symbols["cmd.eraser"],
			trash: this.#symbols["cmd.trash"],
			compress: this.#symbols["cmd.compress"],
			vibrate: this.#symbols["cmd.vibrate"],
			handoff: this.#symbols["cmd.handoff"],
			history: this.#symbols["cmd.history"],
			question: this.#symbols["cmd.question"],
			rocket: this.#symbols["cmd.rocket"],
			stethoscope: this.#symbols["cmd.stethoscope"],
			redo: this.#symbols["cmd.redo"],
			bug: this.#symbols["cmd.bug"],
			memory: this.#symbols["cmd.memory"],
			pencil: this.#symbols["cmd.pencil"],
			folderMove: this.#symbols["cmd.folderMove"],
			folderPlus: this.#symbols["cmd.folderPlus"],
			folderMinus: this.#symbols["cmd.folderMinus"],
			hammer: this.#symbols["cmd.hammer"],
			power: this.#symbols["cmd.power"],
			cart: this.#symbols["cmd.cart"],
			model: this.#symbols["icon.model"],
			plan: this.#symbols["icon.plan"],
			prewalk: this.#symbols["icon.prewalk"],
			goal: this.#symbols["icon.goal"],
			pause: this.#symbols["icon.pause"],
			loop: this.#symbols["icon.loop"],
			session: this.#symbols["icon.session"],
			jobs: this.#symbols["icon.job"],
			gauge: this.#symbols["icon.throughput"],
			context: this.#symbols["icon.context"],
			agents: this.#symbols["icon.agents"],
			branch: this.#symbols["icon.branch"],
			tree: this.#symbols["icon.worktree"],
			signIn: this.#symbols["icon.input"],
			signOut: this.#symbols["icon.output"],
			advisor: this.#symbols["icon.advisor"],
			host: this.#symbols["icon.host"],
			package: this.#symbols["icon.package"],
			fast: this.#symbols["icon.fast"],
			voice: this.#symbols["icon.mic"],
			tools: this.#symbols["icon.extensionTool"],
			rule: this.#symbols["icon.extensionRule"],
			skill: this.#symbols["icon.extensionSkill"],
			mcp: this.#symbols["icon.extensionMcp"],
			pin: this.#symbols["icon.pin"],
		};
	}

	get thinking() {
		return {
			minimal: this.#symbols["thinking.minimal"],
			low: this.#symbols["thinking.low"],
			medium: this.#symbols["thinking.medium"],
			high: this.#symbols["thinking.high"],
			xhigh: this.#symbols["thinking.xhigh"],
			max: this.#symbols["thinking.max"],
			autoPending: this.#symbols["thinking.autoPending"],
		};
	}

	get checkbox() {
		return {
			checked: this.#symbols["checkbox.checked"],
			unchecked: this.#symbols["checkbox.unchecked"],
		};
	}

	get radio() {
		return {
			selected: this.#symbols["radio.selected"],
			unselected: this.#symbols["radio.unselected"],
		};
	}

	get format() {
		return {
			bullet: this.#symbols["format.bullet"],
			dash: this.#symbols["format.dash"],
			bracketLeft: this.#symbols["format.bracketLeft"],
			bracketRight: this.#symbols["format.bracketRight"],
		};
	}

	get md() {
		return {
			quoteBorder: this.#symbols["md.quoteBorder"],
			hrChar: this.#symbols["md.hrChar"],
			bullet: this.#symbols["md.bullet"],
			colorSwatch: this.#symbols["md.colorSwatch"],
		};
	}

	/**
	 * Default spinner frames (status spinner).
	 */
	get spinnerFrames(): string[] {
		return this.getSpinnerFrames();
	}

	/**
	 * Get spinner frames by type.
	 */
	getSpinnerFrames(type: SpinnerType = "status"): string[] {
		return this.#spinnerFramesOverrides[type] ?? SPINNER_FRAMES[this.symbolPreset][type];
	}

	/**
	 * Get language icon for a language name.
	 * Maps common language names to their corresponding symbol keys.
	 */
	getLangIcon(lang: string | undefined): string {
		if (!lang) return this.#symbols["lang.default"];
		const normalized = lang.toLowerCase();
		const key = langMap[normalized];
		return key ? this.#symbols[key] : this.#symbols["lang.default"];
	}

	/**
	 * Language icon tinted with the language's brand color (see
	 * {@link LANG_BRAND_COLORS}). Falls back to the muted theme color for
	 * languages without a brand entry, and returns the bare (possibly empty)
	 * icon when the active symbol preset has none.
	 */
	getLangIconStyled(lang: string | undefined): string {
		const icon = this.getLangIcon(lang);
		if (!icon) return icon;
		const key = lang ? langMap[lang.toLowerCase()] : undefined;
		const hex = key ? LANG_BRAND_COLORS[key] : undefined;
		if (!hex) return this.fg("muted", icon);
		return `${colorToAnsi(hex, this.mode)}${icon}\x1b[39m`;
	}
}
