import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { all } from "@oh-my-pi/pi-coding-agent/config/registry";

import { getSettingsForTab, SETTING_TABS, TAB_GROUPS } from "@oh-my-pi/pi-coding-agent/config/settings-defs";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { mountSettingsWindow, settingsScreen } from "../../helpers/settings-window";
import { cfgRetryUsageAwareFallback } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { cfgPythonKernelIdleShutdownSeconds } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

describe("settings layout", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("every UI setting declares a group registered in TAB_GROUPS for its tab", () => {
		const violations: string[] = [];
		for (const setting of all()) {
			const ui = setting.ui;
			if (!ui) continue;
			if (!ui.group) {
				violations.push(`${setting.id}: missing ui.group`);
			} else if (!TAB_GROUPS[ui.tab].includes(ui.group)) {
				violations.push(`${setting.id}: group "${ui.group}" not in TAB_GROUPS["${ui.tab}"]`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("getSettingsForTab returns contiguous groups in TAB_GROUPS order", () => {
		for (const tab of SETTING_TABS) {
			const defs = getSettingsForTab(createSettingsHost().entries, tab);
			expect(defs.length).toBeGreaterThan(0);

			// Collapse the def sequence into the order groups first appear.
			const sequence: string[] = [];
			for (const def of defs) {
				const group = def.group ?? "";
				if (sequence[sequence.length - 1] !== group) sequence.push(group);
			}

			// Contiguous: no group appears twice in the collapsed sequence.
			expect(new Set(sequence).size).toBe(sequence.length);

			// Ordered: grouped sections follow the TAB_GROUPS declaration order.
			const grouped = sequence.filter(group => group !== "");
			const expected = TAB_GROUPS[tab].filter(group => grouped.includes(group));
			expect(grouped).toEqual(expected);
		}
	});

	it("hides advisor dependent settings when advisor is disabled", () => {
		const advisorDependentPaths = ["advisor.syncBacklog", "advisor.immuneTurns"];
		const advisorDependentPathSet = new Set<string>(advisorDependentPaths);
		const defs = getSettingsForTab(createSettingsHost().entries, "model").filter(def =>
			advisorDependentPathSet.has(def.path),
		);

		expect(defs.map(def => def.path)).toEqual(advisorDependentPaths);
		for (const def of defs) {
			expect(def.condition?.()).toBe(false);
		}

		cfgAdvisorEnabled.set(Settings.instance, true);

		for (const def of defs) {
			expect(def.condition?.()).toBe(true);
		}
	});

	it("exposes usage-aware fallback as an opt-in advanced policy", () => {
		const defs = getSettingsForTab(createSettingsHost().entries, "model").filter(def =>
			def.path.startsWith("retry.usage"),
		);
		expect(defs.map(def => def.path)).toEqual([
			"retry.usageAwareFallback",
			"retry.usageReservePct",
			"retry.usageReservePolicy",
		]);
		expect(defs[0]).toMatchObject({ type: "boolean", label: "Usage-Aware Fallback" });
		expect(defs[1]?.condition?.()).toBe(false);
		expect(defs[2]?.condition?.()).toBe(false);
		cfgRetryUsageAwareFallback.set(Settings.instance, true);
		expect(defs[1]?.condition?.()).toBe(true);
		expect(defs[2]?.condition?.()).toBe(true);
	});

	it("lets the settings panel enable and disable Python idle shutdown", () => {
		const term = mountSettingsWindow();
		try {
			term.type("python kernel idle shutdown");
			expect(settingsScreen(term)).toContain("Python Kernel Idle Shutdown");
			term.press("enter");
			const menu = settingsScreen(term);
			for (const label of ["Off", "5 minutes", "15 minutes", "30 minutes", "1 hour"]) {
				expect(menu).toContain(label);
			}
			term.press("down");
			term.press("enter");
			expect(cfgPythonKernelIdleShutdownSeconds.get(Settings.instance)).toBe(300);
			term.press("enter");
			term.press("up");
			term.press("enter");
			expect(cfgPythonKernelIdleShutdownSeconds.get(Settings.instance)).toBe(0);
		} finally {
			term.dispose();
		}
	});

	it("offers every composer shape in the composer.shape menu", () => {
		const term = mountSettingsWindow();
		try {
			term.type("composer shape");
			// Open the composer.shape menu
			term.press("enter");
			const rendered = settingsScreen(term);
			expect(rendered).toContain("Composer Shape");
			expect(rendered).toContain("Rounded Box");
			expect(rendered).toContain("Claude Code");
		} finally {
			term.dispose();
		}
	});
});
