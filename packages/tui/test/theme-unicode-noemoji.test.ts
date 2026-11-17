import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SETTING_TABS, TAB_METADATA } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { getAvailableSymbolPresets, isValidSymbolPreset, SYMBOL_PRESETS } from "@oh-my-pi/pi-tui/theme/symbols";
import {
	getSymbolPresetOverride,
	initThemeSync,
	setNativeSymbolPreset,
	setThemeInstance,
	type SymbolPreset,
	theme,
	type Theme,
} from "@oh-my-pi/pi-tui/theme/theme";
import { getSlashCommandIndicator } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { getAgentDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "theme", "dark.json");
const EMOJI = /\p{Emoji_Presentation}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

/**
 * Every key the preset must swap to its ascii value. Pinned rather than
 * re-derived, so a rule change has to edit this list: BMP marks (`cmd.share`
 * "↗") must not appear, every color emoji and supplementary pictograph must.
 */
const SWAPPED = [
	"chip.image",
	"chip.paste",
	"chip.video",
	"cmd.broadcast",
	"cmd.bug",
	"cmd.cart",
	"cmd.clipboard",
	"cmd.compass",
	"cmd.compress",
	"cmd.computer",
	"cmd.eraser",
	"cmd.export",
	"cmd.extension",
	"cmd.eye",
	"cmd.folderMinus",
	"cmd.folderMove",
	"cmd.folderPlus",
	"cmd.globe",
	"cmd.hammer",
	"cmd.history",
	"cmd.inbox",
	"cmd.memory",
	"cmd.news",
	"cmd.question",
	"cmd.redo",
	"cmd.rocket",
	"cmd.settings",
	"cmd.shield",
	"cmd.stats",
	"cmd.stethoscope",
	"cmd.trash",
	"cmd.vibrate",
	"icon.advisor",
	"icon.advisorClosed",
	"icon.agents",
	"icon.cache",
	"icon.camera",
	"icon.cost",
	"icon.extensionContextFile",
	"icon.extensionHook",
	"icon.extensionInstruction",
	"icon.extensionMcp",
	"icon.extensionTool",
	"icon.fast",
	"icon.file",
	"icon.folder",
	"icon.ghost",
	"icon.goal",
	"icon.host",
	"icon.intelligence",
	"icon.mic",
	"icon.package",
	"icon.pin",
	"icon.plan",
	"icon.prewalk",
	"icon.scratchFolder",
	"icon.search",
	"icon.session",
	"icon.throughput",
	"icon.tokens",
	"icon.worktree",
	"lang.archive",
	"lang.cpp",
	"lang.css",
	"lang.csv",
	"lang.docker",
	"lang.env",
	"lang.go",
	"lang.html",
	"lang.image",
	"lang.java",
	"lang.javascript",
	"lang.json",
	"lang.log",
	"lang.lua",
	"lang.markdown",
	"lang.pdf",
	"lang.php",
	"lang.python",
	"lang.ruby",
	"lang.rust",
	"lang.shell",
	"lang.sql",
	"lang.swift",
	"lang.text",
	"lang.toml",
	"lang.tsv",
	"lang.typescript",
	"lang.yaml",
	"status.pending",
	"tab.appearance",
	"tab.context",
	"tab.files",
	"tab.interaction",
	"tab.memory",
	"tab.model",
	"tab.providers",
	"tab.shell",
	"tab.tasks",
	"tab.tools",
	"tool.browser",
	"tool.debug",
	"tool.delete",
	"tool.exa",
	"tool.launch",
	"tool.lsp",
	"tool.mcp",
	"tool.memory",
] as const;

/**
 * Symbols that must keep their unicode glyph: BMP marks and pictographs that
 * take the terminal's foreground color (arrows, checks, the pause marker),
 * never color emoji.
 */
const KEPT_TEXT_SYMBOLS: Readonly<Record<string, string>> = {
	"checkbox.checked": "☑",
	"cmd.action": "❯",
	"cmd.gear": "⚙",
	"cmd.keyboard": "⌨",
	"cmd.pencil": "✏",
	"cmd.share": "↗",
	"icon.extensionRule": "⚖",
	"icon.input": "⤵",
	"icon.output": "⤴",
	"icon.pause": "⏸",
	"icon.pr": "⤴",
	"icon.time": "⏱",
	"icon.warning": "⚠",
	"sep.powerlineLeft": "▶",
	"status.aborted": "⏹",
	"status.success": "✔",
	"status.warning": "⚠",
	"tool.eval": "▶",
	"tool.irc": "✉",
};

describe("unicode-noemoji symbol preset", () => {
	it("swaps exactly the emoji and supplementary pictograph keys to their ascii counterparts", () => {
		const unicode = SYMBOL_PRESETS.unicode;
		const ascii = SYMBOL_PRESETS.ascii;
		const noEmoji = SYMBOL_PRESETS["unicode-noemoji"];

		const swappedKeys = Object.keys(noEmoji)
			.filter(key => noEmoji[key as keyof typeof noEmoji] !== unicode[key as keyof typeof unicode])
			.sort();
		expect(swappedKeys).toEqual([...SWAPPED]);
		for (const key of SWAPPED) {
			expect({ key, counterpart: typeof ascii[key] }).toEqual({ key, counterpart: "string" });
			expect({ key, glyph: noEmoji[key] }).toEqual({ key, glyph: ascii[key] });
		}
		for (const key of Object.keys(unicode) as (keyof typeof unicode)[]) {
			if ((SWAPPED as readonly string[]).includes(key)) continue;
			expect({ key, glyph: noEmoji[key] }).toEqual({ key, glyph: unicode[key] });
		}
	});

	it("leaves no glyph that can render in color", () => {
		for (const [key, value] of Object.entries(SYMBOL_PRESETS["unicode-noemoji"])) {
			const colorEmoji = EMOJI.test(value);
			const suppPictograph = [...value].some(ch => (ch.codePointAt(0) ?? 0) >= 0x1f000 && PICTOGRAPH.test(ch));
			expect({ key, colorEmoji, suppPictograph }).toEqual({ key, colorEmoji: false, suppPictograph: false });
		}
	});

	it("keeps Unicode geometry and BMP text-presentation marks", () => {
		const symbols = SYMBOL_PRESETS["unicode-noemoji"];
		expect(symbols["boxRound.topLeft"]).toBe("╭");
		expect(symbols["boxSharp.cross"]).toBe("┼");
		expect(symbols["tree.branch"]).toBe("├─");
		expect(symbols["progress.filled"]).toBe("━");
		for (const [key, glyph] of Object.entries(KEPT_TEXT_SYMBOLS)) {
			expect({ key, glyph: symbols[key as keyof typeof symbols] }).toEqual({ key, glyph });
		}
	});

	it("drops every color emoji and supplementary pictograph in favor of ascii labels", () => {
		const symbols = SYMBOL_PRESETS["unicode-noemoji"];
		expect(symbols["status.pending"]).toBe("[ ]");
		expect(symbols["icon.folder"]).toBe("[D]");
		expect(symbols["icon.file"]).toBe("[F]");
		expect(symbols["icon.cache"]).toBe("cache");
		expect(symbols["icon.intelligence"]).toBe("IQ");
		expect(symbols["icon.plan"]).toBe("");
		expect(symbols["icon.scratchFolder"]).toBe("[T]");
		expect(symbols["icon.host"]).toBe("host");
		expect(symbols["chip.image"]).toBe("img");
		expect(symbols["chip.video"]).toBe("vid");
		expect(symbols["chip.paste"]).toBe("txt");
		expect(symbols["tab.context"]).toBe("[X]");
		expect(symbols["tab.model"]).toBe("[M]");
		expect(symbols["tab.interaction"]).toBe("[I]");
		expect(symbols["lang.python"]).toBe("py");
		expect(symbols["lang.rust"]).toBe("rs");
		expect(symbols["lang.swift"]).toBe("swift");
		expect(symbols["lang.image"]).toBe("img");
		expect(symbols["tool.debug"]).toBe("dbg");
		expect(symbols["tool.delete"]).toBe("rm");
		expect(symbols["tool.mcp"]).toBe("<>");
	});

	it("covers every declared tab icon and falls back the settings tab row together", () => {
		const unicode = SYMBOL_PRESETS.unicode;
		const ascii = SYMBOL_PRESETS.ascii;
		const noEmoji = SYMBOL_PRESETS["unicode-noemoji"];

		const tabIcons = SETTING_TABS.map(id => TAB_METADATA[id].icon);
		for (const icon of tabIcons) {
			// A tab declared without symbol entries would render `undefined` as its icon.
			expect({ icon, type: typeof unicode[icon] }).toEqual({ icon, type: "string" });
			expect({ icon, type: typeof ascii[icon] }).toEqual({ icon, type: "string" });
			expect({ icon, type: typeof noEmoji[icon] }).toEqual({ icon, type: "string" });
		}
		// Row coherence: uniformly unicode (no member needed the fallback) or
		// uniformly ascii (one member did, so every member did); never mixed.
		const allUnicode = tabIcons.every(icon => noEmoji[icon] === unicode[icon]);
		const allAscii = tabIcons.every(icon => noEmoji[icon] === ascii[icon]);
		expect({ glyphs: tabIcons.map(icon => noEmoji[icon]), coherent: allUnicode || allAscii }).toEqual({
			glyphs: tabIcons.map(icon => noEmoji[icon]),
			coherent: true,
		});
	});

	it("is advertised and accepted by the preset predicates", () => {
		expect(isValidSymbolPreset("unicode-noemoji")).toBe(true);
		expect(getAvailableSymbolPresets()).toContain("unicode-noemoji");
	});
});

describe("unicode-noemoji theme loading", () => {
	let tempAgentDir: string | undefined;
	let originalAgentDir = "";
	let originalAgentDirEnv: string | undefined;
	let priorTheme: Theme | undefined;
	let priorPreset: SymbolPreset | undefined;

	beforeAll(() => {
		priorTheme = theme;
		priorPreset = getSymbolPresetOverride();
	});

	afterAll(() => {
		setNativeSymbolPreset(undefined);
		initThemeSync(priorPreset);
		if (priorTheme) setThemeInstance(priorTheme);
	});

	afterEach(async () => {
		if (tempAgentDir === undefined) return;
		setAgentDir(originalAgentDir);
		if (originalAgentDirEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		}
		await removeWithRetries(tempAgentDir);
		tempAgentDir = undefined;
	});

	it("accepts symbols.preset in a custom theme", async () => {
		originalAgentDir = getAgentDir();
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-unicode-noemoji-"));
		setAgentDir(tempAgentDir);

		const dark = await Bun.file(DARK_THEME_PATH).json();
		const customThemeName = "unicode-noemoji";
		await Bun.write(
			path.join(getCustomThemesDir(), `${customThemeName}.json`),
			JSON.stringify({ ...dark, name: customThemeName, symbols: { ...dark.symbols, preset: "unicode-noemoji" } }),
		);

		const theme = await getThemeByName(customThemeName);
		expect(theme?.getSymbolPreset()).toBe("unicode-noemoji");
		expect(theme?.symbol("icon.folder")).toBe("[D]");
		expect(theme?.getSpinnerFrames("activity")).toHaveLength(10);
	});

	it("resolves the slash-command icon column per preset", async () => {
		originalAgentDir = getAgentDir();
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-unicode-noemoji-icons-"));
		setAgentDir(tempAgentDir);

		const dark = await Bun.file(DARK_THEME_PATH).json();
		const cases: ReadonlyArray<{
			label: string;
			symbols: Record<string, unknown>;
			expected: { icon: string | undefined; iconName: string | undefined };
		}> = [
			{ label: "unicode", symbols: { preset: "unicode" }, expected: { icon: "🛡", iconName: "shield" } },
			{
				label: "unicode-noemoji",
				symbols: { preset: "unicode-noemoji" },
				expected: { icon: undefined, iconName: undefined },
			},
			{ label: "ascii", symbols: { preset: "ascii" }, expected: { icon: undefined, iconName: "shield" } },
			{
				label: "nerd",
				symbols: { preset: "nerd" },
				expected: { icon: SYMBOL_PRESETS.nerd["cmd.shield"], iconName: "shield" },
			},
			{
				label: "empty-glyph",
				symbols: { preset: "unicode", overrides: { "cmd.shield": "" } },
				expected: { icon: undefined, iconName: "shield" },
			},
		];
		for (const { label, symbols, expected } of cases) {
			const customThemeName = `slash-icons-${label}`;
			await Bun.write(
				path.join(getCustomThemesDir(), `${customThemeName}.json`),
				JSON.stringify({ ...dark, name: customThemeName, symbols: { ...dark.symbols, ...symbols } }),
			);
			const theme = await getThemeByName(customThemeName);
			expect({ label, theme: theme !== undefined }).toEqual({ label, theme: true });
			setThemeInstance(theme!);
			const indicator = getSlashCommandIndicator("shield");
			expect({ label, indicator }).toEqual({ label, indicator: expected });
			// Both keys are always defined, so spreading the indicator over a
			// builtin command (whose `icon` is a name, not a glyph) clobbers the
			// name instead of leaking it into the icon column.
			expect(Object.keys(indicator).sort()).toEqual(["icon", "iconName"]);
			const builtin = { icon: "shield", iconName: "shield" };
			expect({ label, composed: { ...builtin, ...indicator } }).toEqual({ label, composed: expected });
		}
	});

	it("keeps the no-emoji preset while native rendering forces nerd symbols", () => {
		setNativeSymbolPreset(undefined);
		initThemeSync("unicode-noemoji");
		// TSP opens with `setNativeSymbolPreset("nerd")`; the explicit no-emoji
		// choice must survive it instead of restoring emoji and the icon column.
		expect(setNativeSymbolPreset("nerd")).toBe(true);
		expect(theme.getSymbolPreset()).toBe("unicode-noemoji");
		expect(getSlashCommandIndicator("shield")).toEqual({ icon: undefined, iconName: undefined });
	});
});
