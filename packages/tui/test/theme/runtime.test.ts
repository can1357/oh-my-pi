import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createRoot, effect } from "@oh-my-pi/pi-tui";
import {
	builtinThemes,
	CONSERVATIVE_EMOJI,
	currentTheme,
	loadThemeSync,
	type ResolvedTheme,
	setCurrentTheme,
	ThemeController,
} from "@oh-my-pi/pi-tui/theme/index";

const TRUECOLOR_DARK = { truecolor: true, colors: 16_777_216, dark: true, emoji: CONSERVATIVE_EMOJI } as const;
const TRUECOLOR_LIGHT = { truecolor: true, colors: 16_777_216, dark: false, emoji: CONSERVATIVE_EMOJI } as const;
const PALETTE_DARK = { truecolor: false, colors: 256, dark: true, emoji: CONSERVATIVE_EMOJI } as const;

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
let tempAgentDir: string;
let published: ResolvedTheme[];
let onPublish: ((theme: ResolvedTheme) => void) | undefined;

function controller(settings?: ConstructorParameters<typeof ThemeController>[0]): ThemeController {
	return new ThemeController(settings, theme => {
		published.push(theme);
		onPublish?.(theme);
	});
}

beforeEach(async () => {
	published = [];
	onPublish = undefined;
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ui-theme-runtime-"));
	setAgentDir(tempAgentDir);
});

afterEach(async () => {
	if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
	__resetDirsFromEnvForTests();
	await removeWithRetries(tempAgentDir);
});

describe("current theme signal", () => {
	it("re-runs readers on every switch", () => {
		const seen: string[] = [];
		const dispose = createRoot(dispose => {
			effect(() => {
				seen.push(currentTheme().name);
			});
			return dispose;
		});
		const before = currentTheme();
		setCurrentTheme(loadThemeSync("light"));
		setCurrentTheme(loadThemeSync("titanium"));
		dispose();
		setCurrentTheme(before);
		expect(seen).toEqual([before.name, "light", "titanium"]);
	});
});

describe("ThemeController", () => {
	it("picks the auto slot from the terminal appearance", async () => {
		const themes = controller({ dark: "titanium", light: "light" });
		themes.initSync(TRUECOLOR_DARK);
		expect(themes.name).toBe("titanium");
		await themes.applyCapabilities(TRUECOLOR_LIGHT);
		expect(themes.name).toBe("light");
		expect(published.map(theme => theme.name)).toEqual(["titanium", "light"]);
	});

	it("re-resolves at the terminal's color depth", async () => {
		const themes = controller();
		themes.initSync(TRUECOLOR_DARK);
		await themes.applyCapabilities(PALETTE_DARK);
		expect(published.at(-1)!.depth).toBe("256");
		expect(published.at(-1)!.fg("accent", "x")).toStartWith("\x1b[38;5;");
		// Unchanged capabilities publish nothing.
		await themes.applyCapabilities(PALETTE_DARK);
		expect(published).toHaveLength(2);
	});

	it("re-resolves symbols when the terminal's emoji support changes", async () => {
		const themes = controller();
		themes.initSync(TRUECOLOR_DARK);
		expect(published.at(-1)!.symbols.symbol("status.warning")).toBe("▲");
		await themes.applyCapabilities({ ...TRUECOLOR_DARK, emoji: { vs16Wide: true, bareFits: true } });
		expect(published.at(-1)!.symbols.symbol("status.warning")).toBe("⚠");
		expect(published.at(-1)!.symbols.symbol("tool.irc")).toBe("✉\uFE0F");
		// An equal support value publishes nothing.
		await themes.applyCapabilities({ ...TRUECOLOR_DARK, emoji: { vs16Wide: true, bareFits: true } });
		expect(published).toHaveLength(2);
	});

	it("leaves auto mode on an explicit switch and returns on enableAuto", async () => {
		const themes = controller();
		themes.initSync(TRUECOLOR_DARK);
		expect(await themes.setTheme("titanium")).toEqual({ success: true });
		await themes.applyCapabilities(TRUECOLOR_LIGHT);
		expect(themes.name).toBe("titanium");
		await themes.enableAuto();
		expect(themes.name).toBe("light");
	});

	it("falls back to dark when an explicit switch fails", async () => {
		const themes = controller();
		themes.initSync(TRUECOLOR_DARK);
		await themes.setTheme("titanium");
		const result = await themes.setTheme("__missing__");
		expect(result.success).toBe(false);
		expect(result.error).toContain("Theme not found");
		expect(themes.name).toBe("dark");
		expect(published.at(-1)!.name).toBe("dark");
	});

	it("previews without changing the remembered theme and keeps it on failure", async () => {
		const themes = controller();
		themes.initSync(TRUECOLOR_DARK);
		expect(await themes.preview("titanium")).toEqual({ success: true });
		expect(published.at(-1)!.name).toBe("titanium");
		expect(themes.name).toBe("dark");
		const count = published.length;
		expect((await themes.preview("__missing__")).success).toBe(false);
		expect(published).toHaveLength(count);
		await themes.restore();
		expect(published.at(-1)!.name).toBe("dark");
	});

	it("applies symbol preset and color-blind settings", async () => {
		const themes = controller();
		themes.initSync(TRUECOLOR_DARK);
		await themes.setSymbolPreset("ascii");
		expect(published.at(-1)!.symbols.preset).toBe("ascii");
		await themes.setColorBlindMode(true);
		expect(published.at(-1)!.fgSgr("toolDiffAdded")).not.toBe(published[0]!.fgSgr("toolDiffAdded"));
	});

	it("falls back to dark at startup when the configured theme cannot load", () => {
		const themes = controller({ dark: "__missing__" });
		themes.initSync(TRUECOLOR_DARK);
		expect(themes.name).toBe("dark");
		expect(published[0]!.name).toBe("dark");
	});

	// Real stat polls: they run on real timers, which fake timers cannot drive.
	it("reloads a watched custom theme file", async () => {
		const file = path.join(getCustomThemesDir(), "live.json");
		await fs.mkdir(getCustomThemesDir(), { recursive: true });
		const json = structuredClone(builtinThemes().dark!);
		json.name = "live";
		await Bun.write(file, JSON.stringify(json));
		const themes = controller();
		themes.initSync(TRUECOLOR_DARK);
		await themes.setTheme("live");
		themes.watch();
		try {
			const reloaded = Promise.withResolvers<ResolvedTheme>();
			onPublish = reloaded.resolve;
			json.colors.accent = "#010203";
			// A write that lands before the poll's first stat becomes its baseline:
			// rewrite until the poll reports the change, as an editor saving again would.
			let published: ResolvedTheme | undefined;
			void reloaded.promise.then(theme => {
				published = theme;
			});
			for (let attempt = 0; attempt < 8 && !published; attempt++) {
				await Bun.write(file, JSON.stringify(json));
				await Promise.race([reloaded.promise, Bun.sleep(500)]);
			}
			expect((await reloaded.promise).fg("accent", "x")).toBe("\x1b[38;2;1;2;3mx\x1b[39m");
		} finally {
			themes.dispose();
		}
	});
});
