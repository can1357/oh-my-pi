import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { SettingsWindow } from "../../src/ui/overlays/settings/settings";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

import { cfgTuiMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgTaskPerCallModelAllow } from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgSearxngEndpoint } from "@oh-my-pi/pi-coding-agent/web/settings";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

let state: SettingsTestState | undefined;
let tempDir: TempDir;
let agentDir: string;
let projectDir: string;

beforeEach(() => {
	state = beginSettingsTest();
	tempDir = TempDir.createSync("@pi-settings-panel-clear-");
	agentDir = tempDir.join("agent");
	projectDir = tempDir.join("project");
	for (const dir of [agentDir, projectDir]) fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
	restoreSettingsTestState(state);
	state = undefined;
	AgentStorage.close();
	tempDir.removeSync();
});

it("shows and edits the saved TUI mode without mistaking a launch override for the environment", async () => {
	const configPath = path.join(agentDir, "config.yml");
	await Bun.write(configPath, "tui:\n  mode: inline\n");
	Bun.env.PI_TUI_MODE = "inline";
	const store = await Settings.init({ cwd: projectDir, agentDir });
	cfgTuiMode.override(store, "fullscreen");
	const panel = createSettingsHost();
	expect(cfgTuiMode.get(store)).toBe("fullscreen");
	expect(panel.get("tui.mode")).toBe("inline");
	const description = panel.entries.find(entry => entry.path === "tui.mode")?.ui?.description;
	expect(description).toContain("This session uses fullscreen.");
	expect(description).not.toContain("$PI_TUI_MODE overrides");
	await store.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toMatchObject({ tui: { mode: "inline" } });
	panel.set("tui.mode", "fullscreen");
	await store.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toMatchObject({ tui: { mode: "fullscreen" } });
	panel.set("tui.mode", "inline");
	await store.flush();
	expect(cfgTuiMode.get(store)).toBe("fullscreen");
	expect(panel.get("tui.mode")).toBe("inline");
});

it("clearing a settings-panel text field removes the key from config.yml so its env fallback applies again", async () => {
	Bun.env.SEARXNG_ENDPOINT = "https://env.example";
	Bun.env.HINDSIGHT_API_TOKEN = "env-secret";
	const configPath = path.join(agentDir, "config.yml");
	await Bun.write(configPath, YAML.stringify({ searxng: { endpoint: "https://cfg.example" }, temperature: 0.4 }));
	await Settings.init({ cwd: projectDir, agentDir });
	const host = createSettingsHost();
	// The panel edits the configured layers: env values are never shown or pre-filled.
	expect(host.get("hindsight.apiToken")).toBeUndefined();

	const term = createTestTerminal(
		() => ({
			layer: SettingsWindow({
				context: {
					availableThinkingLevels: [],
					availableThemes: ["dark"],
					providers: [],
					settings: host,
					plugins: createPluginSettingsHost(projectDir),
				},
				callbacks: { onChange: () => {}, onCancel: () => {} },
			}),
		}),
		{ columns: 120, rows: 40 },
	);
	try {
		term.focus(term.surface.layer()[0] ?? null);
		term.type("searxng endpoint");
		term.press("enter"); // open the text field
		term.press("ctrl+u"); // clear it
		term.press("enter"); // submit
	} finally {
		term.dispose();
	}

	expect(cfgSearxngEndpoint.get(settings)).toBe("https://env.example");
	await settings.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ temperature: 0.4 });
});

it("hides the per-call allowlist editor for a project-supplied list so it cannot be promoted to global", async () => {
	const projectConfig = path.join(projectDir, ".omp", "settings.json");
	fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
	await Bun.write(projectConfig, JSON.stringify({ task: { perCallModelAllow: ["mock/target"] } }));
	const settings = await Settings.init({ cwd: projectDir, agentDir });
	expect(cfgTaskPerCallModelAllow.provenance(settings)).toBe("project");
	const entry = createSettingsHost().entries.find(candidate => candidate.path === "task.perCallModelAllow");
	expect(entry?.condition?.()).toBe(false);
});

it("keeps the per-call allowlist editor when only the global layer supplies it", async () => {
	await Settings.init({ cwd: projectDir, agentDir });
	const entry = createSettingsHost().entries.find(candidate => candidate.path === "task.perCallModelAllow");
	expect(entry?.condition?.()).toBe(true);
});
