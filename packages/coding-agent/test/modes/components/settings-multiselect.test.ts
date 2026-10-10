import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { getProjectAgentDir, removeWithRetries } from "@oh-my-pi/pi-utils";

import { cfgDevAutoqa } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgContextFilesExtra } from "@oh-my-pi/pi-coding-agent/session/context-settings";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(process.cwd()),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

function optionRow(component: SettingsSelectorComponent, label: string): number {
	const lines = Bun.stripANSI(component.render(120).join("\n")).split("\n");
	const row = lines.findIndex(line => line.includes(label));
	if (row === -1) throw new Error(`Missing settings option: ${label}`);
	return row + 1;
}

function sendMouse(component: SettingsSelectorComponent, button: number, row: number, suffix: "M" | "m"): void {
	component.handleInput(`\x1b[<${button};3;${row}${suffix}`);
}

function clickOption(component: SettingsSelectorComponent, label: string): void {
	const row = optionRow(component, label);
	sendMouse(component, 0, row, "M");
	sendMouse(component, 0, row, "m");
}

describe("settings section sidebar", () => {
	it("does not toggle the selected section's first setting", () => {
		const comp = createSelector();
		for (let i = 0; i < 7; i++) comp.handleInput("\x1b[C");
		expect(cfgDevAutoqa.get(settings)).toBe(true);

		clickOption(comp, "Developer");
		expect(cfgDevAutoqa.get(settings)).toBe(true);

		clickOption(comp, "Developer");
		expect(cfgDevAutoqa.get(settings)).toBe(true);
	});
});

function openExtraContextFiles(): SettingsSelectorComponent {
	const component = createSelector();
	component.handleNativeEvent({ type: "action", key: "", act: "page", value: "context", mods: [] });
	component.handleNativeEvent({ type: "activate", key: "", item: "contextFiles.extra" });
	return component;
}

async function submitText(component: SettingsSelectorComponent, value: string): Promise<void> {
	component.handleInput("\x01");
	component.handleInput("\x0b");
	for (const character of value) component.handleInput(character);
	component.handleInput("\r");
	await Promise.resolve();
}

function nativeErrorText(node: TspNode): string {
	const text = node.k === "text" ? (node.p?.spans ?? []).filter(span => span.s === "error").map(span => span.t) : [];
	for (const child of node.c ?? []) text.push(nativeErrorText(child));
	return text.join("\n");
}

describe("extra context filenames editor", () => {
	it("saves multiple filenames as an array and lets users disable extras", async () => {
		const component = openExtraContextFiles();
		await submitText(component, '["AGENTS.local.md","TEAM.md"]');
		expect(cfgContextFilesExtra.get(settings)).toEqual(["AGENTS.local.md", "TEAM.md"]);

		component.handleInput("\r");
		await submitText(component, "[]");
		expect(cfgContextFilesExtra.get(settings)).toEqual([]);
	});

	it.each([
		["[", /Invalid array JSON/],
		['{"file":"TEAM.md"}', /Invalid array JSON/],
		['["../TEAM.md"]', /file names, not paths/],
	])("keeps the saved filenames when input %s is rejected", async (input, error) => {
		cfgContextFilesExtra.set(settings, ["TEAM.md"]);
		const component = openExtraContextFiles();
		await submitText(component, input);
		expect(cfgContextFilesExtra.get(settings)).toEqual(["TEAM.md"]);
		expect(Bun.stripANSI(component.render(120).join("\n"))).toMatch(error);
		const document = new TspDocument("settings");
		const reconciler = new Reconciler("settings");
		const ops = reconciler.reconcile(
			{ main: [], dock: [], layer: [component] },
			{ cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true },
		);
		expect(document.applyFrame({ sf: "settings", s: 1, ops })).toEqual([]);
		expect(nativeErrorText(document.snapshot())).toMatch(error);
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

			const component = openExtraContextFiles();
			component.handleInput("\r");
			await settings.flush();

			expect(Bun.stripANSI(component.render(120).join("\n"))).not.toContain("Extra Context Files");
			const globalConfig = Bun.file(path.join(agentDir, "config.yml"));
			expect((await globalConfig.exists()) ? await globalConfig.text() : "").not.toContain("TEAM.md");
		} finally {
			resetSettingsForTest();
			AgentStorage.close();
			await removeWithRetries(root);
		}
	});
});
