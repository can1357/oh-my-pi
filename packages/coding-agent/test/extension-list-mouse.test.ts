import { beforeAll, describe, expect, test } from "bun:test";
import { buildTabBarTabs } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-dashboard";
import { ExtensionList } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-list";
import type { Extension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

function skill(name: string, state: Extension["state"] = "active"): Extension {
	return {
		id: `skill:${name}`,
		kind: "skill",
		name,
		displayName: name,
		path: `/tmp/skill-${name}`,
		source: { provider: "native", providerName: "Native", level: "native" },
		state,
		raw: {},
	};
}

/**
 * ALL view layout (no master switch): the list renders a search banner, a blank
 * separator, one kind header ("Skills"), then one row per extension. Rendered
 * line indices therefore are: 0 search, 1 blank, 2 header, 3 alpha, 4 beta,
 * 5 gamma. `hitTest` maps those lines to absolute list-item indices.
 */
function buildList(onToggle: (id: string, enabled: boolean) => void, onSelect: (ext: Extension | null) => void) {
	const list = new ExtensionList([skill("alpha"), skill("beta"), skill("gamma")], {
		masterSwitchProvider: null,
		onSelectionChange: onSelect,
		onToggle,
	});
	list.setFocused(true);
	list.render(40); // populate hit rows + visible-count window
	return list;
}

describe("ExtensionList mouse routing", () => {
	test("hitTest skips the search banner and blank row, mapping item rows by offset", () => {
		const list = buildList(
			() => {},
			() => {},
		);
		expect(list.hitTest(0)).toBeNull(); // search banner
		expect(list.hitTest(1)).toBeNull(); // blank separator
		expect(list.hitTest(2)).toBe(0); // kind header
		expect(list.hitTest(3)).toBe(1); // alpha
		expect(list.hitTest(5)).toBe(3); // gamma
		expect(list.hitTest(6)).toBeNull(); // past the last rendered row
	});

	test("clicking a row selects its extension; clicking the selected row toggles it", () => {
		const toggles: Array<{ id: string; enabled: boolean }> = [];
		let selected: Extension | null = null;
		const list = buildList(
			(id, enabled) => toggles.push({ id, enabled }),
			ext => {
				selected = ext;
			},
		);

		// First click on alpha's row (line 3) selects it — no toggle yet.
		list.handleClick(3);
		expect(list.getSelectedExtension()?.id).toBe("skill:alpha");
		expect(selected).not.toBeNull();
		expect(toggles).toHaveLength(0);

		// Clicking the already-selected row activates it; an active skill toggles off.
		list.handleClick(3);
		expect(toggles).toEqual([{ id: "skill:alpha", enabled: false }]);
	});

	test("clicking the search banner or a padding row is a no-op", () => {
		const toggles: string[] = [];
		const list = buildList(
			id => toggles.push(id),
			() => {},
		);
		list.handleClick(0); // search banner
		list.handleClick(9); // below the last row
		expect(list.getSelectedExtension()).toBeNull(); // selection still on the header
		expect(toggles).toHaveLength(0);
	});

	test("wheel notches move the selection like j/k", () => {
		const seen: Array<string | null> = [];
		const list = buildList(
			() => {},
			ext => seen.push(ext?.id ?? null),
		);
		list.handleClick(3); // select alpha (index 1)
		list.handleWheel(1); // down -> beta
		expect(list.getSelectedExtension()?.id).toBe("skill:beta");
		list.handleWheel(-1); // up -> alpha
		expect(list.getSelectedExtension()?.id).toBe("skill:alpha");
		expect(seen).toEqual(["skill:alpha", "skill:beta", "skill:alpha"]);
	});
});

describe("buildProviderTabs", () => {
	test("mutes empty enabled providers but keeps disabled providers selectable", () => {
		const tabs = buildTabBarTabs([
			{ id: "all", label: "ALL", enabled: true, count: 5 },
			{ id: "skills", label: "Skills", enabled: true, count: 3 },
			{ id: "empty", label: "Empty", enabled: true, count: 0 },
			{ id: "off", label: "Off", enabled: false, count: 2 },
		]);

		const all = tabs.find(t => t.id === "all");
		const skills = tabs.find(t => t.id === "skills");
		const empty = tabs.find(t => t.id === "empty");
		const off = tabs.find(t => t.id === "off");

		// The "all" tab is never muted or marked; it still shows its total count.
		expect(all?.muted).toBe(false);
		expect(all?.label).toBe("ALL (5)");
		// A populated enabled provider shows its count and stays selectable.
		expect(skills?.muted).toBe(false);
		expect(skills?.label).toBe("Skills (3)");
		// Empty *enabled* provider is muted (unselectable).
		expect(empty?.muted).toBe(true);
		// Disabled provider stays selectable (not muted) so it can be re-enabled.
		expect(off?.muted).toBe(false);
		expect(off?.label).toContain("Off (2)");
	});
});

describe("ExtensionList list hints", () => {
	test("collapses newlines in rule triggers to one physical row", () => {
		const list = new ExtensionList(
			[
				{
					id: "rule:dirty",
					kind: "rule",
					name: "dirty",
					displayName: "dirty",
					path: "/tmp/dirty.md",
					trigger: "src/**/*.ts\nextra",
					source: { provider: "native", providerName: "Native", level: "native" },
					state: "active",
					raw: {},
				},
			],
			{ masterSwitchProvider: null },
		);
		list.setFocused(true);
		const lines = list.render(80);
		expect(lines.some(line => line.includes("\n"))).toBe(false);
		expect(lines.join("\n").split("\n")).toHaveLength(lines.length);
	});
});
