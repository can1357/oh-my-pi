import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { all } from "@oh-my-pi/pi-coding-agent/config/registry";

import { getSettingsForTab, SETTING_TABS, TAB_GROUPS } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import {
	type SettingsNavigationTab,
	SettingsSelectorComponent,
	type SettingsTabContent,
} from "@oh-my-pi/pi-tui/overlays/settings-selector";
import type { SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { initTheme, setTheme } from "@oh-my-pi/pi-tui/theme";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgRetryUsageAwareFallback } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";

beforeAll(async () => {
	await initTheme();
});

interface SelectorOptions {
	profiles?: SettingsTabContent;
	initialTab?: SettingsNavigationTab;
	terminalHeight?: number;
	onProfilesSelected?: () => void;
	onCancel?: () => void;
}

function createSelector(options: SelectorOptions = {}): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark", "light"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(process.cwd()),
		},
		{
			onChange: () => {},
			onCancel: options.onCancel ?? (() => {}),
			onProfilesSelected: options.onProfilesSelected,
		},
		{
			profiles: options.profiles,
			initialTab: options.initialTab,
			terminalHeight: options.terminalHeight,
		},
	);
}

class InteractiveProfilesContent implements SettingsTabContent {
	width = -1;
	height = -1;
	inputs: string[] = [];
	mouse: Array<{ event: SgrMouseEvent; line: number; col: number }> = [];
	value = 0;

	render(width: number, height = 0): readonly string[] {
		this.width = width;
		this.height = height;
		return Array.from({ length: height }, (_, index) =>
			index === 0 ? `Profiles content ${this.value}` : `Profiles row ${index}`,
		);
	}

	handleInput(data: string): void {
		this.inputs.push(data);
		if (data === "x") this.value++;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.mouse.push({ event, line, col });
	}
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

	it("renders Profiles as a first-class tab with the child's allocated bounds", () => {
		expect(Bun.stripANSI(createSelector().render(240).join("\n"))).not.toContain("Profiles");

		const loading: SettingsTabContent = {
			render: (_width, height = 0) => Array.from({ length: height }, () => "Loading profiles…"),
		};
		const profiles = new InteractiveProfilesContent();
		let selectedCount = 0;
		const selector = createSelector({
			profiles: loading,
			initialTab: "profiles",
			terminalHeight: 18,
			onProfilesSelected: () => {
				selectedCount++;
			},
		});
		selector.setProfilesContent(profiles);
		const rendered = Bun.stripANSI(selector.render(80).join("\n"));

		expect(rendered).toContain("Profiles");
		expect(rendered).toContain("Profiles content 0");
		expect(profiles.width).toBe(76);
		expect(rendered).toContain(`Profiles row ${profiles.height - 1}`);
		expect(rendered.split("\n")).toHaveLength(18);
		expect(selectedCount).toBe(1);
	});

	it("keeps Profiles content alive and delegates pane keys while arrows navigate Settings tabs", () => {
		const profiles = new InteractiveProfilesContent();
		let selectedCount = 0;
		const selector = createSelector({
			profiles,
			onProfilesSelected: () => {
				selectedCount++;
			},
		});

		selector.selectTab("profiles");
		selector.handleInput("\t");
		selector.handleInput("x");
		expect(profiles.inputs).toEqual(["\t", "x"]);
		expect(selectedCount).toBe(1);

		selector.handleInput("\x1b[C");
		expect(profiles.inputs).toEqual(["\t", "x"]);
		expect(Bun.stripANSI(selector.render(120).join("\n"))).not.toContain("Profiles content");
		selector.selectTab("profiles");
		expect(Bun.stripANSI(selector.render(120).join("\n"))).toContain("Profiles content 1");
		expect(selectedCount).toBe(2);
	});

	it("routes every Profiles pointer report at child-local coordinates", () => {
		const profiles = new InteractiveProfilesContent();
		const selector = createSelector({ profiles, initialTab: "profiles", terminalHeight: 18 });
		const lines = Bun.stripANSI(selector.render(80).join("\n")).split("\n");
		const contentStart = lines.findIndex(line => line.includes("Profiles content"));
		expect(contentStart).toBeGreaterThan(0);

		const screenCol = 2 + 4;
		const screenRow = contentStart + 2;
		for (const [button, suffix] of [
			[0, "M"],
			[0, "m"],
			[64, "M"],
			[32, "M"],
			[35, "M"],
		] as const) {
			selector.handleInput(`\x1b[<${button};${screenCol + 1};${screenRow + 1}${suffix}`);
		}

		expect(profiles.mouse.map(({ event }) => [event.button, event.release, event.wheel, event.motion])).toEqual([
			[0, false, null, false],
			[0, true, null, false],
			[64, false, -1, false],
			[32, false, null, true],
			[35, false, null, true],
		]);
		expect(profiles.mouse.map(({ line, col }) => [line, col])).toEqual([
			[2, 4],
			[2, 4],
			[2, 4],
			[2, 4],
			[2, 4],
		]);
	});

	it("lets Escape close Settings while Profiles is still a non-interactive loading view", () => {
		let cancelCount = 0;
		const loading: SettingsTabContent = {
			render: (_width, height = 0) => Array.from({ length: height }, () => "Loading profiles…"),
		};
		const selector = createSelector({
			profiles: loading,
			initialTab: "profiles",
			onCancel: () => {
				cancelCount++;
			},
		});

		selector.handleInput("\x1b");
		expect(cancelCount).toBe(1);
	});

	it("limits isolated selectors to explicit schema tabs without live settings or plugin surfaces", () => {
		const values = new Map<string, unknown>();
		const liveBefore = cfgCompactionEnabled.get(Settings.instance);
		const host = createSettingsHost({
			source: {
				get: setting => values.get(setting.id),
				set: (setting, value) => values.set(setting.id, value),
				unset: setting => values.delete(setting.id),
			},
		});
		const selector = new SettingsSelectorComponent(
			{
				settings: host,
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: [],
				providers: [],
			},
			{ onChange: () => {}, onCancel: () => {} },
			{ availableTabs: ["context"], initialTab: "context", includePlugins: false, title: "Profile · Context" },
		);

		const rendered = Bun.stripANSI(selector.render(120).join("\n"));
		expect(rendered).toContain("Profile · Context");
		expect(rendered).toContain("Context");
		expect(rendered).not.toContain("Appearance");
		expect(rendered).not.toContain("Plugins");
		host.set("compaction.enabled", !liveBefore);
		expect(host.get("compaction.enabled")).toBe(!liveBefore);
		expect(cfgCompactionEnabled.get(Settings.instance)).toBe(liveBefore);
	});

	it("renders preview inside SettingsSelectorComponent submenu without crashing", async () => {
		await setTheme("dark");
		const selector = createSelector();

		for (const ch of "composer shape") selector.handleInput(ch);
		// Open the composer.shape submenu
		selector.handleInput("\n");

		const rendered = selector.render(80).join("\n");
		expect(rendered).toContain("Composer Shape");
		expect(rendered).toContain("Preview:");
		expect(rendered).toContain("Ask anything");

		// Cycle down to claude
		selector.handleInput("\x1b[B");
		const nextRendered = selector.render(80).join("\n");
		expect(nextRendered).toContain("Claude Code");
		expect(nextRendered).toContain("Preview:");
	});
});
