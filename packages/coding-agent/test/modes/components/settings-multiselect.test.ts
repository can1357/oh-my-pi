import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgContextFilesExtra } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgDevAutoqa } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { getProjectAgentDir, removeWithRetries } from "@oh-my-pi/pi-utils";
import { settingsScreen, setupSettingsWindow } from "../../helpers/settings-window";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const mountSettingsWindow = setupSettingsWindow();

/** Left press and release on the first cell row showing `label`. */
function clickLabel(term: TestTerminal, label: string): void {
	const rows = settingsScreen(term).split("\n");
	const row = rows.findIndex(line => line.includes(label));
	if (row === -1) throw new Error(`Missing settings label: ${label}`);
	const col = rows[row]!.indexOf(label) + 1;
	term.mouse({ row, col, button: "left", action: "press", mods: [] });
	term.mouse({ row, col, button: "left", action: "release", mods: [] });
}

describe("settings section sidebar", () => {
	it("does not toggle the selected section's first setting", () => {
		const term = mountSettingsWindow();
		for (let i = 0; i < 7; i++) term.press("right");
		expect(cfgDevAutoqa.get(settings)).toBe(true);
		clickLabel(term, "Developer");
		expect(cfgDevAutoqa.get(settings)).toBe(true);
		clickLabel(term, "Developer");
		expect(cfgDevAutoqa.get(settings)).toBe(true);
	});
});

/** Open the extra-context-files text editor. */
function openExtraContextFiles(term: TestTerminal): void {
	term.type("extra context files");
	term.press("enter");
}

/** Replace the open editor's text with `value` and submit it. */
async function submitText(term: TestTerminal, value: string): Promise<void> {
	term.press("ctrl+a");
	term.press("ctrl+k");
	term.type(value);
	term.press("enter");
	await Promise.resolve();
}

describe("extra context filenames editor", () => {
	it("saves multiple filenames as an array and lets users disable extras", async () => {
		const term = mountSettingsWindow();
		openExtraContextFiles(term);
		await submitText(term, '["AGENTS.local.md","TEAM.md"]');
		expect(cfgContextFilesExtra.get(settings)).toEqual(["AGENTS.local.md", "TEAM.md"]);

		term.press("enter");
		await submitText(term, "[]");
		expect(cfgContextFilesExtra.get(settings)).toEqual([]);
	});

	it.each([
		["[", /Invalid array JSON/],
		['{"file":"TEAM.md"}', /Invalid array JSON/],
		['["../TEAM.md"]', /file names, not paths/],
	])("keeps the saved filenames when input %s is rejected", async (input, error) => {
		cfgContextFilesExtra.set(settings, ["TEAM.md"]);
		const term = mountSettingsWindow();
		openExtraContextFiles(term);
		await submitText(term, input);
		expect(cfgContextFilesExtra.get(settings)).toEqual(["TEAM.md"]);
		expect(settingsScreen(term)).toMatch(error);
	});

	it("is not offered when the project config sets the list, so it cannot be copied to global", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extra-ctx-"));
		try {
			const cwd = path.join(root, "repo");
			const agentDir = path.join(root, "agent");
			await fs.mkdir(agentDir, { recursive: true });
			await Bun.write(path.join(getProjectAgentDir(cwd), "config.yml"), "contextFiles:\n  extra:\n    - TEAM.md\n");
			resetSettingsForTest();
			await Settings.init({ cwd, agentDir });

			const term = mountSettingsWindow();
			try {
				openExtraContextFiles(term);
				term.press("enter");
				await settings.flush();
				expect(settingsScreen(term)).not.toContain("Extra Context Files");
			} finally {
				term.dispose();
			}
			const globalConfig = Bun.file(path.join(agentDir, "config.yml"));
			expect((await globalConfig.exists()) ? await globalConfig.text() : "").not.toContain("TEAM.md");
		} finally {
			resetSettingsForTest();
			AgentStorage.close();
			await removeWithRetries(root);
		}
	});
});
