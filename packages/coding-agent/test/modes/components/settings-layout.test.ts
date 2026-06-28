import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingTab,
	TAB_GROUPS,
} from "@pk-nerdsaver-ai/pi-coding-agent/config/settings-schema";
import { getSettingsForTab } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/settings-defs";

interface UiShape {
	tab: SettingTab;
	group?: string;
}

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
		for (const path in SETTINGS_SCHEMA) {
			const ui = (SETTINGS_SCHEMA[path as keyof typeof SETTINGS_SCHEMA] as { ui?: UiShape }).ui;
			if (!ui) continue;
			if (!ui.group) {
				violations.push(`${path}: missing ui.group`);
			} else if (!TAB_GROUPS[ui.tab].includes(ui.group)) {
				violations.push(`${path}: group "${ui.group}" not in TAB_GROUPS["${ui.tab}"]`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("getSettingsForTab returns contiguous groups in TAB_GROUPS order", () => {
		for (const tab of SETTING_TABS) {
			const defs = getSettingsForTab(tab);
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

	it("exposes native terminal progress in the appearance settings menu", () => {
		const def = getSettingsForTab("appearance").find(def => def.path === "terminal.showProgress");

		expect(def).toMatchObject({
			type: "boolean",
			label: "Native Terminal Progress",
			group: "Display",
		});
	});

	it("hides advisor dependent settings when advisor is disabled", () => {
		const advisorDependentPaths: SettingPath[] = ["advisor.subagents", "advisor.syncBacklog", "advisor.immuneTurns"];
		const advisorDependentPathSet = new Set(advisorDependentPaths);
		const defs = getSettingsForTab("model").filter(def => advisorDependentPathSet.has(def.path));

		expect(defs.map(def => def.path)).toEqual(advisorDependentPaths);
		for (const def of defs) {
			expect(def.condition?.()).toBe(false);
		}

		Settings.instance.set("advisor.enabled", true);

		for (const def of defs) {
			expect(def.condition?.()).toBe(true);
		}
	});

	it("shows provider request limits as a providers services submenu setting", () => {
		const [def] = getSettingsForTab("providers").filter(item => item.path === "providers.maxInFlightRequests");

		expect(def).toMatchObject({
			path: "providers.maxInFlightRequests",
			type: "providerLimits",
			tab: "providers",
			group: "Services",
		});
	});
});
