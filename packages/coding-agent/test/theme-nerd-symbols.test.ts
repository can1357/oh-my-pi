import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getAgentDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "modes", "theme", "dark.json");

let tempAgentDir: string | undefined;
let originalAgentDir = "";
let originalAgentDirEnv: string | undefined;

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

it("uses the Nerd Fonts v3 session and C# icons", async () => {
	originalAgentDir = getAgentDir();
	originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-nerd-symbols-"));
	setAgentDir(tempAgentDir);

	const dark = await Bun.file(DARK_THEME_PATH).json();
	const customThemeName = "nerd-symbols";
	await Bun.write(
		path.join(getCustomThemesDir(), `${customThemeName}.json`),
		JSON.stringify({ ...dark, name: customThemeName, symbols: { ...dark.symbols, preset: "nerd" } }),
	);

	const theme = await getThemeByName(customThemeName);
	expect(theme?.symbol("icon.session")).toBe("\u{f0051}");
	expect(theme?.getLangIcon("csharp")).toBe("\u{e7b2}");
});

it("resolves subscription and advisor icons in Nerd Font mode", async () => {
	originalAgentDir = getAgentDir();
	originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-nerd-symbols-"));
	setAgentDir(tempAgentDir);

	const dark = await Bun.file(DARK_THEME_PATH).json();
	const customThemeName = "nerd-annotation-symbols";
	await Bun.write(
		path.join(getCustomThemesDir(), `${customThemeName}.json`),
		JSON.stringify({ ...dark, name: customThemeName, symbols: { ...dark.symbols, preset: "nerd" } }),
	);

	const theme = await getThemeByName(customThemeName);
	expect(theme?.symbol("icon.subscription")).toBe("\u{f067a}");
	expect(theme?.symbol("icon.advisor")).toBe("\uea70");
	expect(theme?.symbol("icon.advisorClosed")).toBe("\ueae7");
	expect(theme?.icon.subscription).toBe("\u{f067a}");
	expect(theme?.icon.advisor).toBe("\uea70");
	expect(theme?.icon.advisorClosed).toBe("\ueae7");
});
