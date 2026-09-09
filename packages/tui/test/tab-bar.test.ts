import { describe, expect, it } from "bun:test";
import { TabBar, type TabBarTheme } from "@oh-my-pi/pi-tui/components/tab-bar";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

const ansiTheme: TabBarTheme = {
	label: text => text,
	activeTab: text => `\x1b[30;46m${text}\x1b[0m`,
	inactiveTab: text => `\x1b[37m${text}\x1b[0m`,
	hint: text => text,
};

describe("TabBar", () => {
	it("wraps without producing style-only lines or duplicate active highlights", () => {
		const tabs = [
			{ id: "display", label: "Display" },
			{ id: "agent", label: "Agent" },
			{ id: "input", label: "Input" },
			{ id: "tools", label: "Tools" },
			{ id: "config", label: "Config" },
			{ id: "services", label: "Services" },
			{ id: "bash", label: "Bash" },
			{ id: "lsp", label: "LSP" },
			{ id: "ttsr", label: "TTSR" },
			{ id: "plugins", label: "Plugins" },
		];
		const tabBar = new TabBar("Settings", tabs, ansiTheme, 8);

		const lines = tabBar.render(55);
		expect(lines.length > 1).toBeTruthy();

		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(55);
			expect(visibleWidth(line)).toBeGreaterThan(0);
			expect(/^\x1b\[[0-9;]*m+$/.test(line)).toBe(false);
		}

		const rendered = lines.join("\n");
		const activeHighlights = rendered.match(/\x1b\[30;46m/g) ?? [];
		expect(activeHighlights.length).toBe(1);
	});

	it("collapses distant tabs to their short form before wrapping", () => {
		const tabs = Array.from({ length: 8 }, (_, i) => ({
			id: `tab${i}`,
			label: `⊕ Section ${i}`,
			short: "⊕",
		}));
		const tabBar = new TabBar("", tabs, ansiTheme, 0);
		tabBar.showHint = false;

		const lines = tabBar.render(60);
		// One line: distant tabs gave up their labels for icons.
		expect(lines.length).toBe(1);
		const text = lines[0];
		// The active tab always keeps its full label.
		expect(text).toContain("Section 0");
		// The farthest tab collapsed to its icon-only form.
		expect(text).not.toContain("Section 7");
	});

	it("skips muted tabs during keyboard cycling and click selection", () => {
		const tabs = [
			{ id: "a", label: "A" },
			{ id: "b", label: "B", muted: true },
			{ id: "c", label: "C" },
		];
		const tabBar = new TabBar("", tabs, ansiTheme, 0);
		const changes: string[] = [];
		tabBar.onTabChange = tab => changes.push(tab.id);

		tabBar.nextTab();
		expect(changes).toEqual(["c"]);

		tabBar.prevTab();
		expect(changes).toEqual(["c", "a"]);

		// Click selection refuses muted tabs but accepts normal ones.
		expect(tabBar.selectTab("b")).toBe(false);
		expect(tabBar.selectTab("c")).toBe(true);
		expect(changes).toEqual(["c", "a", "c"]);
	});

	it("setTabs preserves the active tab by id without firing onTabChange", () => {
		const tabBar = new TabBar(
			"",
			[
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			],
			ansiTheme,
			1,
		);
		const changes: string[] = [];
		tabBar.onTabChange = tab => changes.push(tab.id);

		// Reordered set: "b" moves to the front and must stay active.
		tabBar.setTabs([
			{ id: "b", label: "B (2)" },
			{ id: "a", label: "A", muted: true },
		]);
		expect(tabBar.getActiveTab().id).toBe("b");
		expect(changes).toEqual([]);
	});

	it("resolves tabs from pointer positions via per-render hit zones", () => {
		const tabs = [
			{ id: "first", label: "First" },
			{ id: "second", label: "Second" },
		];
		const tabBar = new TabBar("", tabs, ansiTheme, 0);
		const line = tabBar.render(80)[0];
		expect(visibleWidth(line)).toBeGreaterThan(0);

		// ` First `  +  "  "  +  ` Second `  → col 0 is inside First,
		// col 9 (after the 7-wide button and 2-space gap) inside Second.
		expect(tabBar.tabAt(0, 1)?.id).toBe("first");
		expect(tabBar.tabAt(0, 10)?.id).toBe("second");
		expect(tabBar.tabAt(1, 1)).toBeUndefined();
	});
});
