import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import {
	builtinThemes,
	createTheme,
	listThemes,
	loadTheme,
	loadThemeSync,
	presetSymbols,
	type ThemeJson,
} from "@oh-my-pi/pi-tui/theme/index";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
let tempAgentDir: string;

beforeEach(async () => {
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ui-themes-"));
	setAgentDir(tempAgentDir);
});

afterEach(async () => {
	if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
	__resetDirsFromEnvForTests();
	await removeWithRetries(tempAgentDir);
});

function darkJson(): ThemeJson {
	return structuredClone(builtinThemes().dark!);
}

async function writeCustom(name: string, json: unknown): Promise<void> {
	await fs.mkdir(getCustomThemesDir(), { recursive: true });
	await Bun.write(path.join(getCustomThemesDir(), `${name}.json`), JSON.stringify(json));
}

describe("built-in themes", () => {
	it("ships dark, light and the bundled palettes", async () => {
		const names = await listThemes();
		expect(names).toContain("dark");
		expect(names).toContain("light");
		expect(names).toContain("titanium");
		expect(names.length).toBeGreaterThan(100);
		expect(names).toEqual([...names].sort());
	});

	it("resolves dark and light with their appearance", async () => {
		const dark = await loadTheme("dark");
		const light = loadThemeSync("light");
		expect(dark.name).toBe("dark");
		expect(dark.dark).toBe(true);
		expect(light.dark).toBe(false);
		expect(dark.fg("accent", "x")).toBe("\x1b[38;2;254;188;56mx\x1b[39m");
		expect(light.fg("muted", "x")).toBe("\x1b[38;2;108;108;108mx\x1b[39m");
	});

	it("resolves every bundled palette", () => {
		const themes = builtinThemes();
		for (const name in themes) {
			const theme = createTheme(themes[name]!);
			expect(theme.name).toBe(name);
			expect(theme.fg("accent", "x")).toStartWith("\x1b[");
		}
	});
});

describe("custom themes", () => {
	it("loads a theme file from the custom themes directory", async () => {
		const json = darkJson();
		json.name = "mine";
		json.vars = { ...json.vars, brand: "#123456", alias: "brand" };
		json.colors.accent = "alias";
		json.colors.muted = 244;
		json.colors.text = "";
		await writeCustom("mine", json);

		expect(await listThemes()).toContain("mine");
		const theme = await loadTheme("mine");
		expect(theme.name).toBe("mine");
		expect(theme.fg("accent", "x")).toBe("\x1b[38;2;18;52;86mx\x1b[39m");
		expect(theme.fg("muted", "x")).toBe("\x1b[38;5;244mx\x1b[39m");
		expect(theme.fg("text", "x")).toBe("\x1b[39mx\x1b[39m");
		expect(theme.has("text")).toBe(false);
		expect(theme.has("accent")).toBe(true);
		expect(loadThemeSync("mine").fg("accent", "x")).toBe(theme.fg("accent", "x"));
	});

	it("lets built-ins win over a custom file of the same name", async () => {
		const json = darkJson();
		json.colors.accent = "#010203";
		await writeCustom("dark", json);
		expect((await loadTheme("dark")).fg("accent", "x")).toBe("\x1b[38;2;254;188;56mx\x1b[39m");
	});

	it("reports unknown themes", async () => {
		await expect(loadTheme("__nope__")).rejects.toThrow("Theme not found: __nope__");
	});

	it("does not load a file outside the themes directory through a path-like name", async () => {
		await Bun.write(path.join(getCustomThemesDir(), "..", "escape.json"), JSON.stringify(darkJson()));
		await expect(loadTheme("../escape")).rejects.toThrow("Theme not found: ../escape");
		expect(() => loadThemeSync("../escape")).toThrow("Theme not found: ../escape");
	});

	it("names every missing required color", async () => {
		const json = darkJson();
		delete json.colors.accent;
		delete json.colors.statusLineBg;
		delete json.colors.thinkingMax;
		await writeCustom("partial", json);
		const error = await loadTheme("partial").then(
			() => undefined,
			(caught: unknown) => caught,
		);
		if (!(error instanceof Error)) throw new Error("expected a validation error");
		expect(error.message).toContain("Missing required color tokens");
		expect(error.message).toContain("  - accent");
		expect(error.message).toContain("  - statusLineBg");
		expect(error.message).not.toContain("thinkingMax");
	});

	it("rejects missing and circular variable references", async () => {
		const missing = darkJson();
		missing.colors.accent = "nowhere";
		await writeCustom("missing-var", missing);
		await expect(loadTheme("missing-var")).rejects.toThrow("Variable reference not found: nowhere");

		const circular = darkJson();
		circular.vars = { a: "b", b: "a" };
		circular.colors.accent = "a";
		await writeCustom("circular-var", circular);
		await expect(loadTheme("circular-var")).rejects.toThrow("Circular variable reference");
	});

	it("rejects empty spinner frame overrides", async () => {
		await writeCustom("empty-array", { ...darkJson(), symbols: { spinnerFrames: [] } });
		await expect(loadTheme("empty-array")).rejects.toThrow("spinnerFrames");
		await writeCustom("empty-object", { ...darkJson(), symbols: { spinnerFrames: {} } });
		await expect(loadTheme("empty-object")).rejects.toThrow("spinnerFrames");
	});

	it("applies symbol preset, overrides and spinner frames from the file", async () => {
		await writeCustom("nerdy", {
			...darkJson(),
			symbols: {
				preset: "nerd",
				overrides: { "boxRound.topLeft": "+", "nope.key": "?" },
				spinnerFrames: ["a", "b"],
			},
		});
		const theme = await loadTheme("nerdy");
		expect(theme.symbols.preset).toBe("nerd");
		expect(theme.symbols.symbol("icon.session")).toBe("\u{f0051}");
		expect(theme.symbols.langIcon("csharp")).toBe("\u{e7b2}");
		expect(theme.symbols.box.topLeft).toBe("+");
		expect(theme.symbols.symbol("nope.key")).toBe("");
		expect(theme.symbols.spinnerFrames).toEqual(["a", "b"]);
		expect(theme.symbols.activityFrames).toEqual(["a", "b"]);

		await writeCustom("status-only", { ...darkJson(), symbols: { spinnerFrames: { status: ["A", "B", "C"] } } });
		const statusOnly = await loadTheme("status-only");
		expect(statusOnly.symbols.spinnerFrames).toEqual(["A", "B", "C"]);
		expect(statusOnly.symbols.activityFrames).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
	});

	it("lets the settings preset win over the file's", async () => {
		await writeCustom("nerd-file", { ...darkJson(), symbols: { preset: "nerd" } });
		const theme = await loadTheme("nerd-file", { symbolPreset: "ascii" });
		expect(theme.symbols.preset).toBe("ascii");
		expect(theme.symbols.symbol("status.success")).toBe(presetSymbols("ascii")["status.success"]!);
	});
});
