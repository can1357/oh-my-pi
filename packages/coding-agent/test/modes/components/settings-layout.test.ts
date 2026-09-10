import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingTab,
	TAB_GROUPS,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getSettingsForTab } from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";

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

	it("exposes every accepted snapcompact shape in the settings submenu", () => {
		const def = getSettingsForTab("context").find(def => def.path === "snapcompact.shape");

		expect(def?.type).toBe("submenu");
		if (def?.type !== "submenu") throw new Error("snapcompact.shape should render as a submenu");
		const values = def.options.map(option => option.value);
		expect(values).toContain("silver16-bw");
		expect(values).toEqual([...SETTINGS_SCHEMA["snapcompact.shape"].values]);
	});

	it("hides advisor dependent settings when advisor is disabled", () => {
		const advisorDependentPaths: SettingPath[] = [
			"advisor.syncBacklog",
			"advisor.immuneTurns",
			"advisor.lateConcern",
		];
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

	it("shows the unexpected-stop classifier setting only in smart mode", () => {
		const def = getSettingsForTab("providers").find(item => item.path === "providers.unexpectedStopModel");
		if (!def?.condition) throw new Error("Unexpected Stop Model should be smart-mode only");

		expect(def.condition()).toBe(false);
		Settings.instance.set("features.unexpectedStopDetection", "smart");
		expect(def.condition()).toBe(true);
		Settings.instance.set("features.unexpectedStopDetection", "none");
		expect(def.condition()).toBe(false);
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

	it("exposes retry fallback chains as editable JSON in the model settings", () => {
		const def = getSettingsForTab("model").find(item => item.path === "retry.fallbackChains");

		expect(def).toMatchObject({
			path: "retry.fallbackChains",
			type: "text",
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Fallback Chains",
		});
		if (!def) throw new Error("retry.fallbackChains setting definition missing");

		const description = def.description.toLowerCase();
		expect(description).toContain("json");
		expect(description).toContain("fallback");
		expect(description).toContain("selector");
	});

	it("exposes usage-aware fallback as an opt-in advanced policy", () => {
		const defs = getSettingsForTab("model").filter(def => def.path.startsWith("retry.usage"));
		expect(defs.map(def => def.path)).toEqual([
			"retry.usageAwareFallback",
			"retry.usageReservePct",
			"retry.usageReservePolicy",
		]);
		expect(defs[0]).toMatchObject({ type: "boolean", label: "Usage-Aware Fallback" });
		expect(defs[1]?.condition?.()).toBe(false);
		expect(defs[2]?.condition?.()).toBe(false);
		Settings.instance.set("retry.usageAwareFallback", true);
		expect(defs[1]?.condition?.()).toBe(true);
		expect(defs[2]?.condition?.()).toBe(true);
	});

	it("exposes ask.enabled as a boolean under Available Tools", () => {
		const def = getSettingsForTab("tools").find(def => def.path === "ask.enabled");

		expect(def).toMatchObject({
			type: "boolean",
			label: "Ask",
			group: "Available Tools",
		});
	});
});
