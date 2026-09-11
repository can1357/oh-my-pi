import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import {
	normalizeProviderMaxInFlightRequests,
	resetSettingsForTest,
	Settings,
	settings,
} from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import {
	getColorBlindMode,
	getCurrentThemeName,
	initTheme,
	onTerminalAppearanceChange,
	previewTheme,
	setTheme,
	stopThemeWatcher,
	theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

beforeAll(async () => {
	await initTheme();
});

describe("SettingsSelectorComponent persistence scope", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let projectDir: string;
	let agentDir: string;
	let projectConfigPath: string;
	let changes: Array<{ path: string; value: unknown }>;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-scope-test-");
		projectDir = tempDir.join("project");
		agentDir = tempDir.join("agent");
		projectConfigPath = path.join(projectDir, ".omp", "config.yml");
		// Global fallback disagrees with the project override so a shadowed
		// global edit is observable: effective (project) stays true.
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ ask: { enabled: false } }, null, 2));
		await Bun.write(projectConfigPath, YAML.stringify({ ask: { enabled: true }, custom: { keep: true } }, null, 2));
		await Settings.init({ cwd: projectDir, agentDir });
		changes = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		stopThemeWatcher();
		await initTheme();
		resetSettingsForTest();
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir.remove();
	});

	function createSelector(): SettingsSelectorComponent {
		return new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onCancel: () => {},
			},
		);
	}

	it("writes the global layer without live callbacks when the project value still wins", async () => {
		// Start both layers at true, then toggle only the global fallback to
		// false. The persisted scope and active effective value must diverge,
		// and session side effects must not rerun for an unchanged merge.
		settings.set("ask.enabled", true, "global");
		const selector = createSelector();
		expect(selector.render(120).join("\n")).toContain(`Settings · ${path.basename(projectDir)}`);
		expect(settings.getGlobalValue("ask.enabled")).toBe(true);
		expect(settings.get("ask.enabled")).toBe(true);

		// Alt+S switches to global scope; the row reflects the global layer
		// (true), so Enter writes false even though project remains true.
		selector.handleInput("\x1bs");
		expect(selector.render(120).join("\n")).toContain("Settings · global");
		for (const char of "ask tool interactive") selector.handleInput(char);
		selector.handleInput("\n");

		expect(settings.getGlobalValue("ask.enabled")).toBe(false);
		expect(settings.get("ask.enabled")).toBe(true);
		expect(changes).toEqual([]);

		await settings.flush();
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({ ask: { enabled: false } });
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
			ask: { enabled: true },
			custom: { keep: true },
		});
	});

	it("inherits the global fallback when removing a project override", async () => {
		const selector = createSelector();
		// Locate the Ask row via search, then Esc lands on its tab with the row
		// selected so Delete can remove the project override in list mode.
		for (const char of "ask tool interactive") selector.handleInput(char);
		selector.handleInput("\x1b");
		selector.handleInput("\x1b[3~");

		expect(settings.get("ask.enabled")).toBe(false);
		expect(changes.at(-1)).toEqual({ path: "ask.enabled", value: false });

		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({ custom: { keep: true } });
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toEqual({ ask: { enabled: false } });
	});

	it("labels project scope with the directory name", () => {
		const selector = createSelector();
		expect(selector.render(120).join("\n")).toContain(`Settings · ${path.basename(projectDir)}`);
		selector.handleInput("\x1bs");
		expect(selector.render(120).join("\n")).toContain("Settings · global");
	});

	it("computes the project label once instead of rediscovering the repo on each render", () => {
		const repoSpy = vi.spyOn(vcs, "repo");
		const selector = createSelector();
		const discoveries = repoSpy.mock.calls.length;
		expect(discoveries).toBeGreaterThan(0);
		selector.render(120);
		selector.render(80);
		expect(repoSpy).toHaveBeenCalledTimes(discoveries);
	});

	it("sanitizes the project label before rendering the settings border", async () => {
		resetSettingsForTest();
		AgentStorage.close();
		const hostileDir = tempDir.join("proj\tname\nwith\x1b[31mansi");
		await Bun.write(path.join(hostileDir, ".omp", "config.yml"), YAML.stringify({ ask: { enabled: true } }, null, 2));
		await Settings.init({ cwd: hostileDir, agentDir });
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: hostileDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onCancel: () => {},
			},
		);
		const [title] = selector.render(120);
		expect(title).toBeDefined();
		expect(title).not.toMatch(/\t|\r|\n/);
		expect(title).not.toContain("[31m");
		const printable = Bun.stripANSI(title ?? "");
		expect(printable).toContain("Settings · proj");
		expect(printable).toContain("name withansi");
	});

	it("previews the selected scope's appearance when the selector opens", () => {
		const previews: string[] = [];
		settings.set("theme.dark", "dark-one", "project");
		settings.set("theme.dark", "titanium", "global");
		new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: themeName => {
					previews.push(themeName);
				},
				onCancel: () => {},
			},
		);
		expect(previews.at(-1)).toBe("dark-one");
		expect(settings.get("theme.dark")).toBe("dark-one");
	});

	it("previews the selected scope's theme without persisting", () => {
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: themeName => {
					previews.push(themeName);
				},
				onCancel: () => {},
			},
		);
		settings.set("theme.dark", "dark-one", "project");
		settings.set("theme.dark", "titanium", "global");
		selector.handleInput("\x1bs");
		expect(previews.at(-1)).toBe("titanium");
		expect(settings.get("theme.dark")).toBe("dark-one");
		selector.handleInput("\x1bs");
		expect(previews.at(-1)).toBe("dark-one");
	});
	it("falls back when switching to a scope whose theme cannot load", async () => {
		settings.set("theme.dark", "titanium", "project");
		settings.set("theme.light", "titanium", "project");
		settings.set("theme.dark", "missing-custom", "global");
		settings.set("theme.light", "missing-custom", "global");
		await setTheme("titanium");
		expect(getCurrentThemeName()).toBe("titanium");
		const titaniumAccent = theme.fg("accent", "*");

		const previewed: string[] = [];
		const pendingPreviews: Array<Promise<unknown>> = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: async themeName => {
					previewed.push(themeName);
					const preview = previewTheme(themeName);
					pendingPreviews.push(preview);
					await preview;
				},
				onCancel: () => {},
			},
		);
		await Promise.all(pendingPreviews);
		expect(previewed.at(-1)).toBe("titanium");
		expect(theme.fg("accent", "*")).toBe(titaniumAccent);

		selector.handleInput("\x1bs");
		await Promise.all(pendingPreviews);
		expect(previewed.at(-1)).toBe("dark");
		expect(previewed).not.toContain("missing-custom");
		expect(theme.fg("accent", "*")).not.toBe(titaniumAccent);
		expect(settings.get("theme.dark")).toBe("titanium");
	});

	it("restores the live fallback when the effective theme cannot load", async () => {
		resetSettingsForTest();
		AgentStorage.close();
		const overlayPath = tempDir.join("overlay.yml");
		await Bun.write(
			overlayPath,
			YAML.stringify({ theme: { dark: "missing-custom", light: "missing-custom" } }, null, 2),
		);
		await Settings.init({ cwd: projectDir, agentDir, configFiles: [overlayPath] });
		settings.set("theme.dark", "titanium", "project");
		settings.set("theme.light", "titanium", "project");
		await setTheme("dark");
		expect(getCurrentThemeName()).toBe("dark");
		expect(settings.get("theme.dark")).toBe("missing-custom");
		const fallbackAccent = theme.fg("accent", "*");

		const previewed: string[] = [];
		const pendingPreviews: Array<Promise<unknown>> = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: async themeName => {
					previewed.push(themeName);
					const preview = previewTheme(themeName);
					pendingPreviews.push(preview);
					await preview;
				},
				onCancel: () => {},
			},
		);
		await Promise.all(pendingPreviews);
		expect(previewed.at(-1)).toBe("titanium");
		expect(theme.fg("accent", "*")).not.toBe(fallbackAccent);

		selector.handleInput("\x1b");
		await Promise.all(pendingPreviews);
		expect(previewed.at(-1)).toBe("dark");
		expect(previewed).not.toContain("missing-custom");
		expect(theme.fg("accent", "*")).toBe(fallbackAccent);
	});

	it("shows hindsight settings in global scope when only the global backend is hindsight", () => {
		settings.set("memory.backend", "hindsight", "global");
		settings.set("memory.backend", "off", "project");
		const selector = createSelector();
		expect(selector.render(120).join("\n")).not.toContain("Hindsight API URL");
		selector.handleInput("\x1bs");
		for (const char of "hindsight api") selector.handleInput(char);
		expect(selector.render(120).join("\n")).toContain("Hindsight API URL");
	});

	it("hides hindsight rows in project scope when only an overlay enables hindsight", async () => {
		resetSettingsForTest();
		AgentStorage.close();
		const overlayPath = tempDir.join("overlay.yml");
		await Bun.write(overlayPath, YAML.stringify({ memory: { backend: "hindsight" } }, null, 2));
		await Settings.init({ cwd: projectDir, agentDir, configFiles: [overlayPath] });
		settings.set("memory.backend", "off", "project");
		const selector = createSelector();
		expect(selector.render(120).join("\n")).not.toContain("Hindsight API URL");
	});

	it("restores the effective theme when closing after a scope preview", () => {
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: themeName => {
					previews.push(themeName);
				},
				onCancel: () => {},
			},
		);
		settings.set("theme.dark", "dark-one", "project");
		settings.set("theme.dark", "titanium", "global");
		// Alt+S previews the global layer's theme...
		selector.handleInput("\x1bs");
		expect(previews.at(-1)).toBe("titanium");
		// ...closing restores the effective (project) theme without persisting.
		selector.handleInput("\x1b");
		expect(previews.at(-1)).toBe("dark-one");
		expect(settings.get("theme.dark")).toBe("dark-one");
	});

	it("restores the effective status line when closing after a scope preview", () => {
		settings.set("statusLine.preset", "minimal", "project");
		settings.set("statusLine.preset", "full", "global");
		settings.set("statusLine.showHookStatus", false, "project");
		settings.set("statusLine.showHookStatus", true, "global");
		const previews: Array<{ preset?: string; showHookStatus?: boolean }> = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onStatusLinePreview: payload => {
					previews.push(payload);
				},
				onCancel: () => {},
			},
		);
		selector.handleInput("\x1bs");
		expect(previews.at(-1)?.preset).toBe("full");
		expect(previews.at(-1)?.showHookStatus).toBe(true);
		selector.handleInput("\x1b");
		expect(previews.at(-1)?.preset).toBe("minimal");
		expect(previews.at(-1)?.showHookStatus).toBe(false);
		expect(settings.get("statusLine.preset")).toBe("minimal");
	});

	it("previews the selected scope's status-line segment options", () => {
		settings.set("statusLine.preset", "minimal", "project");
		settings.set("statusLine.preset", "full", "global");
		settings.set("statusLine.segmentOptions", { path: { abbreviate: true } }, "project");
		settings.set("statusLine.segmentOptions", { path: { abbreviate: false } }, "global");
		const previews: Array<{ segmentOptions?: Record<string, unknown> }> = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onStatusLinePreview: payload => {
					previews.push(payload);
				},
				onCancel: () => {},
			},
		);
		selector.handleInput("\x1bs");
		expect(previews.at(-1)?.segmentOptions).toEqual({ path: { abbreviate: false } });
		selector.handleInput("\x1b");
		expect(previews.at(-1)?.segmentOptions).toEqual({ path: { abbreviate: true } });
	});

	it("previews the selected scope's symbol and color-blind options", async () => {
		settings.set("symbolPreset", "nerd", "project");
		settings.set("symbolPreset", "ascii", "global");
		settings.set("colorBlindMode", true, "project");
		settings.set("colorBlindMode", false, "global");
		const previews: Array<{ theme?: string; symbolPreset?: string; colorBlindMode?: boolean }> = [];
		const pendingPreviews: Array<Promise<unknown>> = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: (themeName, options) => {
					previews.push({ theme: themeName, ...options });
					const preview = previewTheme(themeName, {
						ephemeral: true,
						symbolPreset: options?.symbolPreset,
						colorBlindMode: options?.colorBlindMode,
					});
					pendingPreviews.push(preview);
					void preview;
				},
				onCancel: () => {},
			},
		);
		await Promise.all(pendingPreviews);
		expect(previews.at(-1)).toMatchObject({ symbolPreset: "nerd", colorBlindMode: true });
		expect(theme.getSymbolPreset()).toBe("nerd");
		expect(getColorBlindMode()).toBe(true);
		selector.handleInput("\x1bs");
		await Promise.all(pendingPreviews);
		expect(previews.at(-1)).toMatchObject({ symbolPreset: "ascii", colorBlindMode: false });
		expect(theme.getSymbolPreset()).toBe("ascii");
		expect(getColorBlindMode()).toBe(false);
		expect(settings.get("symbolPreset")).toBe("nerd");
		expect(settings.get("colorBlindMode")).toBe(true);
		selector.handleInput("\x1b");
		await Promise.all(pendingPreviews);
		expect(previews.at(-1)).toMatchObject({ symbolPreset: "nerd", colorBlindMode: true });
		expect(theme.getSymbolPreset()).toBe("nerd");
		expect(getColorBlindMode()).toBe(true);
	});

	it("restores the scoped theme when canceling a theme submenu", () => {
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: themeName => {
					previews.push(themeName);
				},
				onCancel: () => {},
			},
		);
		settings.set("theme.dark", "dark-one", "project");
		settings.set("theme.dark", "titanium", "global");
		// Alt+S previews the global layer. Opening then canceling the Dark
		// Theme submenu must restore that scoped preview, not the stale
		// effective (project) theme that getCurrentThemeName still reports.
		selector.handleInput("\x1bs");
		expect(previews.at(-1)).toBe("titanium");
		for (const ch of "dark theme") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\x1b");
		expect(previews.at(-1)).toBe("titanium");
		expect(settings.get("theme.dark")).toBe("dark-one");
	});

	it("restores the live fallback when canceling an unloadable theme submenu", async () => {
		resetSettingsForTest();
		AgentStorage.close();
		await Bun.write(
			projectConfigPath,
			YAML.stringify({ theme: { dark: "missing-custom", light: "missing-custom" } }, null, 2),
		);
		await Settings.init({ cwd: projectDir, agentDir });
		await setTheme("dark");
		expect(getCurrentThemeName()).toBe("dark");
		expect(settings.get("theme.dark")).toBe("missing-custom");
		const fallbackAccent = theme.fg("accent", "*");

		const previewed: string[] = [];
		const pendingPreviews: Array<Promise<unknown>> = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: async themeName => {
					previewed.push(themeName);
					const preview = previewTheme(themeName);
					pendingPreviews.push(preview);
					await preview;
				},
				onCancel: () => {},
			},
		);
		await Promise.all(pendingPreviews);
		expect(theme.fg("accent", "*")).toBe(fallbackAccent);

		for (const ch of "dark theme") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		await Promise.all(pendingPreviews);
		expect(previewed.at(-1)).toBe("titanium");
		expect(theme.fg("accent", "*")).not.toBe(fallbackAccent);

		selector.handleInput("\x1b");
		await Promise.all(pendingPreviews);
		expect(previewed.at(-1)).toBe("dark");
		expect(theme.fg("accent", "*")).toBe(fallbackAccent);
		expect(settings.get("theme.dark")).toBe("missing-custom");
	});

	it("reapplies the scoped theme after a shadowed global theme submenu commit", () => {
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium", "alabaster"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: themeName => {
					previews.push(themeName);
				},
				onCancel: () => {},
			},
		);
		settings.set("theme.dark", "dark-one", "project");
		settings.set("theme.dark", "titanium", "global");
		// Alt+S previews the global layer. Confirming a different global dark
		// theme persists only that layer; the live preview must stay on the
		// scoped (global) value instead of snapping back to the still-winning
		// project mapping that Settings.set() re-evaluates.
		selector.handleInput("\x1bs");
		expect(previews.at(-1)).toBe("titanium");
		for (const ch of "dark theme") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(settings.getGlobalValue("theme.dark")).toBe("alabaster");
		expect(settings.get("theme.dark")).toBe("dark-one");
		expect(previews.at(-1)).toBe("alabaster");
	});

	it("keeps the dark/light theme slot of the terminal when closing after a preview", async () => {
		// This terminal is dark (test env). The project layer sets the dark
		// slot; Alt+S previews the global layer, which maps the DARK slot to a
		// LIGHT theme (alabaster) and the LIGHT slot to a dark theme
		// (titanium). The runtime swaps the exported theme and re-derives the
		// active theme name (setTheme). Closing must restore the effective
		// theme from the terminal's DARK slot (dark-one) — the dark/light
		// decision is captured once, not recomputed from the previewed theme.
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium", "alabaster"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: async themeName => {
					previews.push(themeName);
					await previewTheme(themeName);
				},
				onCancel: () => {},
			},
		);
		settings.set("theme.dark", "dark-one", "project");
		settings.set("theme.dark", "alabaster", "global");
		settings.set("theme.light", "titanium", "global");
		// Alt+S previews the global layer and the exported theme swaps to the
		// light theme; the active theme name now resolves to that light theme.
		selector.handleInput("\x1bs");
		await setTheme("alabaster");
		expect(previews.at(-1)).toBe("alabaster");
		expect(theme.isLight).toBe(true);
		// Closing restores the effective project theme (dark slot) — the
		// dark/light decision stays captured at the terminal's original mode
		// and must NOT pick the light slot despite the previewed theme.
		selector.handleInput("\x1b");
		expect(previews.at(-1)).toBe("dark-one");
		expect(settings.get("theme.dark")).toBe("dark-one");
	});

	it("follows a live terminal appearance change when closing", () => {
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: themeName => {
					previews.push(themeName);
				},
				onCancel: () => {},
			},
		);
		settings.set("theme.dark", "dark-one", "project");
		settings.set("theme.light", "titanium", "project");
		onTerminalAppearanceChange("light");
		selector.handleInput("\x1b");
		expect(previews.at(-1)).toBe("titanium");
	});

	it("restores from the dark slot when the dark slot itself holds a light theme", () => {
		// Terminal is dark (test env). The dark slot maps to a LIGHT theme
		// (alabaster), so the loaded theme/currentThemeName are light — but the
		// terminal's actual appearance is dark. Closing must restore the
		// effective theme from the terminal's own dark/light mode, read via
		// the reported appearance, not from the loaded theme's luminance.
		onTerminalAppearanceChange("dark");
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium", "alabaster"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: themeName => {
					previews.push(themeName);
				},
				onCancel: () => {},
			},
		);
		settings.set("theme.dark", "alabaster", "project");
		settings.set("theme.light", "titanium", "project");
		settings.set("theme.dark", "titanium", "global");
		settings.set("theme.light", "alabaster", "global");
		// Alt+S previews the global layer: the dark terminal picks the dark
		// slot, which is the dark theme titanium.
		selector.handleInput("\x1bs");
		expect(previews.at(-1)).toBe("titanium");
		// Closing restores the effective project theme. The terminal is dark,
		// so it must come from the dark slot (alabaster) — even though the
		// loaded theme is light and currentThemeName reports a light theme.
		selector.handleInput("\x1b");
		expect(previews.at(-1)).toBe("alabaster");
		expect(settings.get("theme.dark")).toBe("alabaster");
	});

	it("keeps the selected scope's status-line baseline when canceling a submenu", () => {
		settings.set("statusLine.preset", "minimal", "project");
		settings.set("statusLine.preset", "full", "global");
		settings.set("statusLine.showHookStatus", false, "project");
		settings.set("statusLine.showHookStatus", true, "global");
		const previews: Array<{ preset?: string; showHookStatus?: boolean }> = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: [],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onStatusLinePreview: payload => {
					previews.push(payload);
				},
				onCancel: () => {},
			},
		);
		// Global scope previews the global baseline (preset "full", hooks on).
		selector.handleInput("\x1bs");
		expect(previews.at(-1)?.showHookStatus).toBe(true);
		// Open the Status Line Separator submenu and cancel it: the preview must
		// fall back to the full scoped baseline, not the effective project layer.
		for (const ch of "status line separator") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\x1b");
		expect(previews.at(-1)?.preset).toBe("full");
		expect(previews.at(-1)?.showHookStatus).toBe(true);
	});

	it("keeps the selected scope's status-line preview after committing a submenu", () => {
		settings.set("statusLine.preset", "minimal", "project");
		settings.set("statusLine.preset", "full", "global");
		const previews: Array<{ preset?: string }> = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: [],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onStatusLinePreview: payload => {
					previews.push(payload);
				},
				onCancel: () => {},
			},
		);
		selector.handleInput("\x1bs");
		expect(previews.at(-1)?.preset).toBe("full");
		for (const ch of "status line preset") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		expect(settings.getGlobalValue("statusLine.preset")).toBe("nerd");
		expect(settings.get("statusLine.preset")).toBe("minimal");
		expect(previews.at(-1)?.preset).toBe("nerd");
	});
	it("clears a provider limit inherited from the global layer when editing in project scope", () => {
		// Global caps "anthropic"; the project layer has no override. A project
		// edit must be able to clear that cap without a leftover global record
		// key re-inheriting the cap through the record deep-merge.
		settings.set("providers.maxInFlightRequests", { anthropic: 3 }, "global");
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: [],
				providers: ["anthropic"],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onCancel: () => {},
			},
		);
		// Switch to global scope, then back to project scope; open the
		// Max In-Flight Requests submenu and pick "Clear all limits".
		selector.handleInput("\x1bs");
		selector.handleInput("\x1bs");
		for (const ch of "max in flight requests") selector.handleInput(ch);
		selector.handleInput("\n");
		// "Clear all limits" is the second item in the submenu.
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\x1b");
		// Clear-all produced an empty map; the project scope must tombstone the
		// global provider so the effective limits are empty, not the global cap.
		expect(normalizeProviderMaxInFlightRequests(settings.get("providers.maxInFlightRequests"))).toEqual({});
		expect(settings.get("providers.maxInFlightRequests")).toEqual({});
		// The global layer itself is untouched.
		expect(settings.getGlobalValue("providers.maxInFlightRequests")).toEqual({ anthropic: 3 });
	});

	it("does not copy unchanged inherited provider limits into the project layer", async () => {
		settings.set("providers.maxInFlightRequests", { anthropic: 3, openai: 5 }, "global");
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: [],
				providers: ["anthropic", "openai"],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onCancel: () => {},
			},
		);
		selector.handleInput("\x1bs");
		selector.handleInput("\x1bs");
		for (const ch of "max in flight requests") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\n");
		selector.handleInput("\x15");
		selector.handleInput("7");
		selector.handleInput("\n");
		expect(settings.get("providers.maxInFlightRequests")).toEqual({ anthropic: 7, openai: 5 });
		expect(settings.getGlobalValue("providers.maxInFlightRequests")).toEqual({ anthropic: 3, openai: 5 });
		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
			ask: { enabled: true },
			custom: { keep: true },
			providers: { maxInFlightRequests: { anthropic: 7 } },
		});
	});

	it("keeps an existing native provider override when editing a sibling", async () => {
		settings.set("providers.maxInFlightRequests", { anthropic: 3, openai: 5 }, "global");
		settings.set("providers.maxInFlightRequests", { anthropic: 7 }, "project");
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: [],
				providers: ["anthropic", "openai"],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onCancel: () => {},
			},
		);
		selector.handleInput("\x1bs");
		selector.handleInput("\x1bs");
		for (const ch of "max in flight requests") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");
		selector.handleInput("\x15");
		selector.handleInput("9");
		selector.handleInput("\n");
		expect(settings.get("providers.maxInFlightRequests")).toEqual({ anthropic: 7, openai: 9 });
		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
			ask: { enabled: true },
			custom: { keep: true },
			providers: { maxInFlightRequests: { anthropic: 7, openai: 9 } },
		});
	});

	it("does not copy unchanged inherited record keys into the project layer", async () => {
		settings.set("tools.approval", { bash: "allow", read: "prompt" }, "global");
		const selector = createSelector();
		for (const ch of "tool approval policies") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\x15");
		selector.handleInput('{"bash":"deny","read":"prompt"}');
		selector.handleInput("\n");
		expect(settings.get("tools.approval")).toEqual({ bash: "deny", read: "prompt" });
		expect(settings.getGlobalValue("tools.approval")).toEqual({ bash: "allow", read: "prompt" });
		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
			ask: { enabled: true },
			custom: { keep: true },
			tools: { approval: { bash: "deny" } },
		});
	});

	it("treats a project record tombstone as an absent key", async () => {
		settings.set(
			"retry.fallbackChains",
			{ default: ["openai/gpt-4o-mini"], slow: ["google/gemini-2.5-flash"] },
			"global",
		);
		const selector = createSelector();
		for (const ch of "retry fallback chains") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\x15");
		selector.handleInput('{"default":["openai/gpt-4o-mini"]}');
		selector.handleInput("\n");
		expect(settings.get("retry.fallbackChains")).toEqual({ default: ["openai/gpt-4o-mini"] });
		expect(settings.getGlobalValue("retry.fallbackChains")).toEqual({
			default: ["openai/gpt-4o-mini"],
			slow: ["google/gemini-2.5-flash"],
		});
		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
			ask: { enabled: true },
			custom: { keep: true },
			retry: { fallbackChains: { slow: null } },
		});
	});

	it("does not copy an unchanged inherited credential into the project layer", async () => {
		settings.set("memory.backend", "hindsight", "global");
		settings.set("hindsight.apiToken", "global-secret-token", "global");
		const selector = createSelector();
		for (const ch of "hindsight api token") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\n");
		expect(settings.get("hindsight.apiToken")).toBe("global-secret-token");
		expect(settings.getGlobalValue("hindsight.apiToken")).toBe("global-secret-token");
		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
			ask: { enabled: true },
			custom: { keep: true },
		});
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toMatchObject({
			hindsight: { apiToken: "global-secret-token" },
		});
	});

	it("persists a changed project credential without rewriting the global secret", async () => {
		settings.set("memory.backend", "hindsight", "global");
		settings.set("hindsight.apiToken", "global-secret-token", "global");
		const selector = createSelector();
		for (const ch of "hindsight api token") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\x15");
		selector.handleInput("project-secret-token");
		selector.handleInput("\n");
		expect(settings.get("hindsight.apiToken")).toBe("project-secret-token");
		expect(settings.getGlobalValue("hindsight.apiToken")).toBe("global-secret-token");
		await settings.flush();
		expect(YAML.parse(await Bun.file(projectConfigPath).text())).toEqual({
			ask: { enabled: true },
			custom: { keep: true },
			hindsight: { apiToken: "project-secret-token" },
		});
		expect(YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text())).toMatchObject({
			hindsight: { apiToken: "global-secret-token" },
		});
	});
	it("reapplies appearance after adopting a search-mode theme submenu", async () => {
		settings.set("theme.dark", "dark-one", "project");
		await settings.flush();
		const previews: string[] = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium", "alabaster"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: themeName => {
					previews.push(themeName);
				},
				onCancel: () => {},
			},
		);
		expect(previews.at(-1)).toBe("dark-one");

		settings.set("ask.enabled", false, "project");
		for (const ch of "dark theme") selector.handleInput(ch);
		selector.handleInput("\n");
		selector.handleInput("\x1b[B");
		expect(previews.at(-1)).toBe("titanium");

		await Bun.write(
			projectConfigPath,
			YAML.stringify({ ask: { enabled: true }, custom: { keep: true }, theme: { dark: "alabaster" } }, null, 2),
		);
		await settings.flush();

		expect(settings.get("theme.dark")).toBe("alabaster");
		expect(previews.at(-1)).toBe("alabaster");
		expect(Bun.stripANSI(selector.render(120).join("\n"))).toContain("alabaster");
	});

	it("reapplies scoped appearance after adopting a theme on a non-appearance tab", async () => {
		settings.set("theme.dark", "dark-one", "project");
		settings.set("theme.dark", "titanium", "global");
		await settings.flush();
		const previews: string[] = [];
		const pendingPreviews: Array<Promise<unknown>> = [];
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark-one", "titanium", "alabaster"],
				providers: [],
				cwd: projectDir,
			},
			{
				onChange: (settingPath, value) => changes.push({ path: settingPath, value }),
				onThemePreview: async themeName => {
					previews.push(themeName);
					const preview = previewTheme(themeName);
					pendingPreviews.push(preview);
					await preview;
				},
				onCancel: () => {},
			},
		);
		await Promise.all(pendingPreviews);
		selector.handleInput("\x1bs");
		await Promise.all(pendingPreviews);
		expect(previews.at(-1)).toBe("titanium");
		const titaniumAccent = theme.fg("accent", "*");
		const previewCountBeforeAdopt = previews.length;
		selector.handleInput("\x1b[C");
		expect(Bun.stripANSI(selector.render(120).join("\n"))).toContain("Settings · global");
		expect(Bun.stripANSI(selector.render(120).join("\n"))).not.toContain("Preview:");

		settings.set("ask.enabled", false, "project");
		await Bun.write(
			projectConfigPath,
			YAML.stringify({ ask: { enabled: true }, custom: { keep: true }, theme: { dark: "alabaster" } }, null, 2),
		);
		await settings.flush();
		await Promise.all(pendingPreviews);

		expect(settings.get("theme.dark")).toBe("alabaster");
		expect(settings.getGlobalValue("theme.dark")).toBe("titanium");
		expect(previews.length).toBeGreaterThan(previewCountBeforeAdopt);
		expect(previews.at(-1)).toBe("titanium");
		expect(theme.fg("accent", "*")).toBe(titaniumAccent);
		expect(Bun.stripANSI(selector.render(120).join("\n"))).toContain("Settings · global");
	});

	it("rebuilds open rows after a skipped same-key project save", async () => {
		settings.set("defaultThinkingLevel", Effort.Low, "project");
		await settings.flush();
		const selector = createSelector();
		for (const char of "thinking level") selector.handleInput(char);
		const thinkingRow = (text: string) =>
			Bun.stripANSI(text)
				.split("\n")
				.find(line => line.includes("Thinking Level") && !line.includes("Compact"));
		expect(thinkingRow(selector.render(120).join("\n"))).toContain("low");

		settings.set("defaultThinkingLevel", Effort.High, "project");
		expect(thinkingRow(selector.render(120).join("\n"))).toContain("low");

		await Bun.write(
			projectConfigPath,
			YAML.stringify(
				{ ask: { enabled: true }, custom: { keep: true }, defaultThinkingLevel: Effort.Medium },
				null,
				2,
			),
		);
		await settings.flush();

		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Medium);
		expect(thinkingRow(selector.render(120).join("\n"))).toContain("medium");
		selector.handleInput("\x1b");
	});
});
