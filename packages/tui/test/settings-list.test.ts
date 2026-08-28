import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SettingsList, type SettingsListTheme } from "@oh-my-pi/pi-tui/components/settings-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";

const testTheme: SettingsListTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "→ ",
	hint: (text: string) => text,
};

describe("SettingsList", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("cycles the selected value when Enter arrives as LF", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			[
				{
					id: "mode",
					label: "Mode",
					currentValue: "off",
					values: ["off", "on"],
				},
			],
			5,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {
				throw new Error("cancel should not be called");
			},
		);

		list.handleInput("\n");

		expect(changes).toEqual([["mode", "on"]]);
	});

	it("passes changed state to item label and value renderers", () => {
		const themed: SettingsListTheme = {
			label: (text: string, _selected: boolean, changed: boolean) => (changed ? `[changed-label]${text}` : text),
			value: (text: string, _selected: boolean, changed: boolean) => (changed ? `[changed-value]${text}` : text),
			description: (text: string) => text,
			cursor: "→ ",
			hint: (text: string) => text,
		};
		const list = new SettingsList(
			[
				{ id: "default", label: "Default", currentValue: "off", values: ["off", "on"] },
				{ id: "changed", label: "Changed", currentValue: "on", values: ["off", "on"], changed: true },
			],
			5,
			themed,
			() => {},
			() => {},
		);

		const output = list.render(80).join("\n");

		expect(output).toContain("[changed-label]Changed");
		expect(output).toContain("[changed-value]on");
		expect(output).not.toContain("[changed-label]Default");
	});

	it("marks a warned row with the glyph and leads the note area with the risk note", () => {
		const themed: SettingsListTheme = {
			...testTheme,
			warning: (text: string) => `[warn]${text}`,
			warningMark: "!",
		};
		const list = new SettingsList(
			[
				{ id: "safe", label: "Safe", currentValue: "off", values: ["off", "on"] },
				{
					id: "risky",
					label: "Risky",
					description: "x".repeat(400),
					warning: "may get you banned",
					currentValue: "off",
					values: ["off", "on"],
				},
			],
			5,
			themed,
			() => {},
			() => {},
		);
		// Marker rides the row itself, so the risk is visible before selecting it.
		const unselected = list.render(80).join("\n");
		expect(unselected).toContain("Risky[warn] !");
		expect(unselected).not.toContain("Safe[warn] !");
		expect(unselected).not.toContain("may get you banned");

		list.selectItem("risky");
		const selected = list.render(80).join("\n");

		// The note leads the 3-row note area, so a long description cannot clamp it away.
		expect(selected).toContain("[warn]  ! may get you banned");
		expect(selected).toContain("x".repeat(10));
	});

	it("renders long settings tabs through a scrollbar viewport", () => {
		const list = new SettingsList(
			Array.from({ length: 6 }, (_, i) => ({
				id: `item-${i}`,
				label: `Item ${i}`,
				currentValue: `value-${i}`,
				values: [`value-${i}`],
			})),
			3,
			{
				...testTheme,
				label: (text: string, selected: boolean) => (selected ? `[selected]${text}` : text),
				hint: (text: string) => `[dim]${text}`,
			},
			() => {},
			() => {},
		);

		const output = list.render(32);

		expect(output.slice(0, 3).join("\n")).toContain("[selected]");
		expect(output.slice(0, 3).join("\n")).toContain("[dim]");
		expect(output).not.toContain("(1/6)");
	});

	it("does not reserve a scrollbar column when all settings fit", () => {
		const list = new SettingsList(
			[{ id: "mode", label: "Mode", currentValue: "123456", values: ["123456"] }],
			3,
			testTheme,
			() => {},
			() => {},
		);

		expect(list.render(16)[0]).toBe("→ Mode  123456");
	});

	it("renders a non-string currentValue without crashing the row", () => {
		const list = new SettingsList(
			[
				{
					id: "advisor.syncBacklog",
					label: "Advisor Sync Backlog",
					currentValue: JSON.parse("1"),
					values: ["off", "1", "3", "5"],
				},
			],
			3,
			testTheme,
			() => {},
			() => {},
		);

		expect(list.render(40)[0]).toBe("→ Advisor Sync Backlog  1");
	});

	it("filters settings with printable search text", () => {
		const list = new SettingsList(
			[
				{ id: "mode", label: "Mode", currentValue: "off", values: ["off", "on"] },
				{ id: "theme.dark", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
				{
					id: "browser.path",
					label: "Browser Path",
					description: "Executable used for browser launches",
					currentValue: "",
				},
			],
			5,
			testTheme,
			() => {},
			() => {},
		);

		list.handleInput("b");

		const output = list.render(80).join("\n");
		expect(output).toContain("Search: b");
		expect(output).toContain("Browser Path");
		expect(output).not.toContain("Theme");
		expect(output).not.toContain("Mode");
	});

	it("clears active search on Escape before canceling", () => {
		let cancelCount = 0;
		const list = new SettingsList(
			[
				{ id: "mode", label: "Mode", currentValue: "off", values: ["off", "on"] },
				{ id: "browser.path", label: "Browser Path", currentValue: "" },
			],
			5,
			testTheme,
			() => {},
			() => {
				cancelCount++;
			},
		);

		list.handleInput("b");
		expect(list.hasSearchQuery()).toBe(true);

		list.handleInput("\x1b");
		expect(list.hasSearchQuery()).toBe(false);
		expect(cancelCount).toBe(0);

		list.handleInput("\x1b");
		expect(cancelCount).toBe(1);
	});
	it("skips heading rows during navigation and starts on the first selectable item", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			[
				{ id: "__heading:a", label: "Group A", currentValue: "", heading: true },
				{ id: "alpha", label: "Alpha", currentValue: "off", values: ["off", "on"] },
				{ id: "__heading:b", label: "Group B", currentValue: "", heading: true },
				{ id: "beta", label: "Beta", currentValue: "off", values: ["off", "on"] },
			],
			10,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {},
		);

		// Initial selection lands past the leading heading
		list.handleInput("\n");
		expect(changes).toEqual([["alpha", "on"]]);

		// Down crosses the Group B heading directly to Beta
		list.handleInput("\x1b[B");
		list.handleInput("\n");
		expect(changes).toEqual([
			["alpha", "on"],
			["beta", "on"],
		]);

		// Down from the last item wraps past the leading heading back to Alpha
		list.handleInput("\x1b[B");
		list.handleInput("\n");
		expect(changes).toEqual([
			["alpha", "on"],
			["beta", "on"],
			["alpha", "off"],
		]);
	});

	it("excludes heading rows from search results", () => {
		const list = new SettingsList(
			[
				{ id: "__heading:group", label: "Group Alpha", currentValue: "", heading: true },
				{ id: "alpha", label: "Alpha Mode", currentValue: "off", values: ["off", "on"] },
				{ id: "beta", label: "Beta Mode", currentValue: "off", values: ["off", "on"] },
			],
			5,
			testTheme,
			() => {},
			() => {},
		);

		// "group" fuzzy-matches the heading label but headings are not searchable
		for (const ch of "group") list.handleInput(ch);

		const output = list.render(80).join("\n");
		expect(output).not.toContain("Group Alpha");
		expect(output).toContain("No matching settings");
	});
	function sectionedItems() {
		return [
			{ id: "__heading:a", label: "Group A", currentValue: "", heading: true },
			{ id: "alpha", label: "Alpha", currentValue: "off", values: ["off", "on"] },
			{ id: "alpha2", label: "Alpha Two", currentValue: "off", values: ["off", "on"] },
			{ id: "__heading:b", label: "Group B", currentValue: "", heading: true },
			{ id: "beta", label: "Beta", currentValue: "off", values: ["off", "on"] },
			{ id: "__heading:c", label: "Group C", currentValue: "", heading: true },
			{ id: "gamma", label: "Gamma", currentValue: "off", values: ["off", "on"] },
		];
	}

	it("jumps between sections with PgDn/PgUp, wrapping at the ends", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {},
		);

		// PgDn from Alpha jumps to the first item of Group B
		list.handleInput("\x1b[6~");
		list.handleInput("\n");
		expect(changes).toEqual([["beta", "on"]]);

		// PgUp twice wraps from Group A to Group C
		list.handleInput("\x1b[5~");
		list.handleInput("\x1b[5~");
		list.handleInput("\n");
		expect(changes).toEqual([
			["beta", "on"],
			["gamma", "on"],
		]);
	});

	it("renders a section sidebar at wide widths with the whole list in the pane", () => {
		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			() => {},
			() => {},
		);

		const output = list.render(120).join("\n");
		// Sidebar lists every section beside the pane separator
		expect(output).toMatch(/Group A\s+│/);
		expect(output).toMatch(/Group B\s+│/);
		expect(output).toMatch(/Group C\s+│/);
		// Pane shows every item — sections outside the active one stay visible
		expect(output).toContain("Alpha");
		expect(output).toContain("Beta");
		expect(output).toContain("Gamma");
	});

	it("styles heading rows through theme.heading with the dimmed flag for out-of-section headings", () => {
		const themed: SettingsListTheme = {
			...testTheme,
			heading: (text: string, dimmed: boolean) => (dimmed ? `[dim-heading]${text}` : `[heading]${text}`),
		};
		const list = new SettingsList(
			sectionedItems(),
			10,
			themed,
			() => {},
			() => {},
		);

		// Split layout: the active section's heading is bright, the rest dim.
		const split = list.render(120).join("\n");
		expect(split).toContain("[heading]Group A");
		expect(split).toContain("[dim-heading]Group B");
		expect(split).toContain("[dim-heading]Group C");

		// Flat layout has no active section: every heading renders undimmed.
		const flat = list.render(60).join("\n");
		expect(flat).toContain("[heading]Group A");
		expect(flat).toContain("[heading]Group B");
		expect(flat).not.toContain("[dim-heading]");
	});

	it("section focus routes arrows to section jumps, Enter drops into items, Esc exits without cancelling", () => {
		const changes: Array<[string, string]> = [];
		let cancelled = 0;
		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {
				cancelled++;
			},
		);

		expect(list.hasSectionFocusTargets()).toBe(true);
		expect(list.toggleSectionFocus()).toBe(true);

		// Down jumps a whole section (Group A → Group B), not one row.
		list.handleInput("\x1b[B");
		expect(list.getSelectedItem()?.id).toBe("beta");

		// Enter returns focus to the rows without activating the setting…
		list.handleInput("\n");
		expect(list.sectionFocused).toBe(false);
		expect(changes).toEqual([]);

		// …after which Enter cycles the value again.
		list.handleInput("\n");
		expect(changes).toEqual([["beta", "on"]]);

		// Esc exits section focus instead of cancelling the list.
		list.toggleSectionFocus();
		list.handleInput("\x1b");
		expect(list.sectionFocused).toBe(false);
		expect(cancelled).toBe(0);
	});

	it("section focus cannot engage without sections and drops when a filter removes them", () => {
		const flat = new SettingsList(
			[{ id: "only", label: "Only", currentValue: "off", values: ["off", "on"] }],
			5,
			testTheme,
			() => {},
			() => {},
		);
		expect(flat.hasSectionFocusTargets()).toBe(false);
		expect(flat.toggleSectionFocus()).toBe(false);

		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			() => {},
			() => {},
		);
		list.toggleSectionFocus();
		for (const ch of "alpha") list.handleInput(ch);
		expect(list.sectionFocused).toBe(false);
	});

	it("moves the cursor glyph to the active section while section-focused", () => {
		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			() => {},
			() => {},
		);

		const unfocused = list.render(120).join("\n");
		expect(unfocused).not.toContain("→ Group A");
		expect(unfocused).toContain("→ Alpha");

		list.toggleSectionFocus();
		// Split layout: the sidebar entry carries the cursor and the row cursor hides.
		const split = list.render(120).join("\n");
		expect(split).toContain("→ Group A");
		expect(split).not.toContain("→ Alpha");

		// Flat layout: the active heading row carries the cursor instead.
		const flat = list.render(60).join("\n");
		expect(flat).toContain("→ Group A");
		expect(flat).not.toContain("→ Alpha");
	});

	it("falls back to inline heading rows when the width cannot fit the sidebar", () => {
		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			() => {},
			() => {},
		);

		const output = list.render(60);
		const joined = output.join("\n");
		// No split separator; headings render as standalone rows and every item is inline
		expect(joined).not.toContain("│");
		expect(joined).toContain("Group A");
		expect(joined).toContain("Group C");
		expect(joined).toContain("Alpha");
		expect(joined).toContain("Gamma");
	});

	it("pages through items with PgDn when the list has no sections", () => {
		const changes: Array<[string, string]> = [];
		const items = Array.from({ length: 12 }, (_, i) => ({
			id: `item${i}`,
			label: `Item ${i}`,
			currentValue: "off",
			values: ["off", "on"] as string[],
		}));
		const list = new SettingsList(
			items,
			5,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {},
		);

		// PgDn advances by one viewport (5); PgDn again clamps to the last item.
		list.handleInput("\x1b[6~");
		list.handleInput("\n");
		expect(changes).toEqual([["item5", "on"]]);

		list.handleInput("\x1b[6~");
		list.handleInput("\x1b[6~");
		list.handleInput("\n");
		expect(changes).toEqual([
			["item5", "on"],
			["item11", "on"],
		]);
	});

	it("moves the selection with wheel events and reports it via onSelectionChange", () => {
		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			() => {},
			() => {},
		);
		const seen: Array<string | undefined> = [];
		list.onSelectionChange = item => seen.push(item?.id);

		expect(list.getSelectedItem()?.id).toBe("alpha");
		list.handleWheel(1);
		expect(list.getSelectedItem()?.id).toBe("alpha2");
		list.handleWheel(-1);
		expect(list.getSelectedItem()?.id).toBe("alpha");
		expect(seen).toEqual(["alpha2", "alpha"]);
	});

	it("verifies handleWheelAt ignores wheel on sidebar but succeeds on settings pane", () => {
		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			() => {},
			() => {},
		);
		// Before render, sidebar Hit columns are not set
		expect(list.handleWheelAt(1, 0, 0)).toBe(true);
		expect(list.getSelectedItem()?.id).toBe("alpha2");
		// Reset back to alpha
		list.selectItem("alpha");

		// Render in split layout (wide width, e.g. 120 cols) so sidebar hit areas are mapped
		list.render(120);
		expect(list.getSelectedItem()?.id).toBe("alpha");

		// Scrolling on sidebar (e.g. col 0) should be ignored (returns false, selection unchanged)
		expect(list.handleWheelAt(1, 0, 0)).toBe(false);
		expect(list.getSelectedItem()?.id).toBe("alpha");

		// Scrolling in the settings list pane (e.g. col 40 >= sidebar width) should move selection
		expect(list.handleWheelAt(1, 0, 40)).toBe(true);
		expect(list.getSelectedItem()?.id).toBe("alpha2");

		// Scrolling up (delta -1) from 'alpha' (the first item) should clamp (no wrap)
		list.selectItem("alpha");
		expect(list.handleWheelAt(-1, 0, 40)).toBe(true);
		expect(list.getSelectedItem()?.id).toBe("alpha");

		// Scrolling down (delta 1) from 'gamma' (the last item) should clamp (no wrap)
		list.selectItem("gamma");
		expect(list.handleWheelAt(1, 0, 40)).toBe(true);
		expect(list.getSelectedItem()?.id).toBe("gamma");
	});

	it("hit-tests pane rows to items and sidebar rows to section jump targets", () => {
		const list = new SettingsList(
			sectionedItems(),
			10,
			testTheme,
			() => {},
			() => {},
		);

		// Split layout (wide): line 0 col 0 is the "Group A" sidebar row →
		// resolves to that section's first item for clicks, but never for hover.
		list.render(120);
		expect(list.hitTest(0, 0)).toBe("alpha");
		expect(list.hoverTest(0, 0)).toBeUndefined();
		// Sidebar row 1 (Group B) resolves to its first item.
		expect(list.hitTest(1, 0)).toBe("beta");
		// Pane rows resolve to the item they render: row 0 is the Group A
		// heading (not clickable), row 1 is Alpha.
		const paneCol = 40;
		expect(list.hitTest(0, paneCol)).toBeUndefined();
		expect(list.hitTest(1, paneCol)).toBe("alpha");
		expect(list.hoverTest(1, paneCol)).toBe("alpha");

		// Flat layout (narrow): same rows, no sidebar region.
		list.render(60);
		expect(list.hitTest(0, 0)).toBeUndefined(); // heading row
		expect(list.hitTest(1, 0)).toBe("alpha");
	});

	it("selects an item by id and resizes its viewport via setMaxVisible", () => {
		const items = Array.from({ length: 12 }, (_, i) => ({
			id: `item${i}`,
			label: `Item ${i}`,
			currentValue: "off",
			values: ["off", "on"] as string[],
		}));
		const list = new SettingsList(
			items,
			5,
			testTheme,
			() => {},
			() => {},
		);

		expect(list.selectItem("item9")).toBe(true);
		expect(list.getSelectedItem()?.id).toBe("item9");
		expect(list.selectItem("missing")).toBe(false);

		// A taller viewport renders more item rows (flat list, no sections).
		const before = list.render(60).join("\n");
		expect(before).not.toContain("Item 0\u0020");
		list.setMaxVisible(12);
		const after = list.render(60).join("\n");
		expect(after).toContain("Item 0");
		expect(after).toContain("Item 11");
	});

	it("routes mouse events into an open submenu", () => {
		const routed: Array<[number, number, boolean]> = [];
		const submenu = {
			render: () => ["submenu line"],
			routeMouse: (event: { leftClick: boolean }, line: number, col: number) => {
				routed.push([line, col, event.leftClick]);
			},
		};
		const list = new SettingsList(
			[
				{
					id: "picker",
					label: "Picker",
					currentValue: "x",
					submenu: () => submenu,
				},
			],
			5,
			testTheme,
			() => {},
			() => {},
		);

		// No submenu open yet: nothing to route to.
		expect(list.routeSubmenuMouse({ leftClick: true } as never, 0, 0)).toBe(false);

		list.handleInput("\n"); // open the submenu
		expect(list.hasOpenSubmenu()).toBe(true);
		// Open submenu swallows hit-testing for the outer rows.
		list.render(60);
		expect(list.hitTest(0, 0)).toBeUndefined();

		expect(list.routeSubmenuMouse({ leftClick: true } as never, 2, 7)).toBe(true);
		expect(routed).toEqual([[2, 7, true]]);
	});
});
