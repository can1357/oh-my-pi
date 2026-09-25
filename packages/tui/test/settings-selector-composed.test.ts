import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SettingsDisplayEntry, SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { SettingsSelectorComponent, type SettingsSelectorSection } from "@oh-my-pi/pi-tui/overlays/settings-selector";

beforeAll(async () => {
	await initTheme(false);
});

function createHost(entries: readonly SettingsDisplayEntry[], values: Record<string, unknown>): SettingsHost {
	return {
		entries,
		get: path => values[path],
		set: (path, value) => {
			values[path] = value;
		},
		unset: path => {
			delete values[path];
		},
		normalizeProviderLimits: () => ({}),
		validateProviderLimits: () => ({}),
	};
}

function createSelector(
	host: SettingsHost,
	sections: () => readonly SettingsSelectorSection[],
	callbacks: { onSave?: () => void; onCancel?: () => void } = {},
): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			settings: host,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: [],
			providers: [],
		},
		{
			onChange: () => {},
			onSave: callbacks.onSave,
			onCancel: callbacks.onCancel ?? (() => {}),
		},
		{ sections, terminalHeight: 24 },
	);
}

describe("SettingsSelectorComponent composed sections", () => {
	it("re-evaluates condition-gated native fields after a value changes", () => {
		const values: Record<string, unknown> = { "feature.enabled": false, "feature.detail": false };
		const host = createHost(
			[
				{
					path: "feature.enabled",
					type: "boolean",
					defaultValue: false,
					ui: { tab: "tools", label: "Feature", description: "Enable the feature" },
				},
				{
					path: "feature.detail",
					type: "boolean",
					defaultValue: false,
					ui: { tab: "tools", label: "Feature Detail", description: "Configure the feature" },
					condition: () => values["feature.enabled"] === true,
				},
			],
			values,
		);
		const selector = createSelector(host, () => [
			{ id: "feature", label: "Feature", items: [{ setting: "feature.enabled" }, { setting: "feature.detail" }] },
		]);

		expect(Bun.stripANSI(selector.render(100).join("\n"))).not.toContain("Feature Detail");
		selector.handleInput("\n");

		expect(host.get("feature.enabled")).toBe(true);
		expect(Bun.stripANSI(selector.render(100).join("\n"))).toContain("Feature Detail");
	});

	it("keeps disabled native fields inert while retaining them in the composed list", () => {
		const host = createHost(
			[
				{
					path: "feature.enabled",
					type: "boolean",
					defaultValue: false,
					ui: { tab: "tools", label: "Feature", description: "Enable the feature" },
				},
			],
			{ "feature.enabled": false },
		);
		const selector = createSelector(host, () => [
			{
				id: "feature",
				label: "Feature",
				items: [{ setting: "feature.enabled", disabled: true, descriptionSuffix: "Include this group first" }],
			},
		]);

		selector.handleInput("\n");

		expect(host.get("feature.enabled")).toBe(false);
		expect(Bun.stripANSI(selector.render(100).join("\n"))).toContain("Include this group first");
	});

	it("routes cancel and save chords to an open field before the embedding surface", () => {
		const host = createHost(
			[
				{
					path: "feature.mode",
					type: "enum",
					defaultValue: "one",
					enumValues: ["one", "two"],
					ui: {
						tab: "tools",
						label: "Feature Mode",
						description: "Select a feature mode",
						options: [
							{ value: "one", label: "One" },
							{ value: "two", label: "Two" },
						],
					},
				},
			],
			{ "feature.mode": "one" },
		);
		let saves = 0;
		let cancels = 0;
		const selector = createSelector(
			host,
			() => [{ id: "feature", label: "Feature", items: [{ setting: "feature.mode" }] }],
			{
				onSave: () => saves++,
				onCancel: () => cancels++,
			},
		);

		selector.handleInput("\n");
		expect(selector.hasOpenSubmenu()).toBe(true);
		selector.handleInput("\x13");
		expect(saves).toBe(0);
		expect(selector.hasOpenSubmenu()).toBe(true);

		selector.handleInput("\x1b");
		expect(selector.hasOpenSubmenu()).toBe(false);
		expect(cancels).toBe(0);

		selector.handleInput("\x13");
		expect(saves).toBe(1);
		expect(cancels).toBe(0);
	});
});
