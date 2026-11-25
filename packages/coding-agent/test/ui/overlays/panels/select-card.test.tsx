/** @jsxImportSource @oh-my-pi/pi-tui */
/** The select card in terminal rows: the framed list an inline selector draws in the composer's place. */
import { describe, expect, it, vi } from "bun:test";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { SelectCard } from "../../../../src/ui/overlays/panels/select-card";
import { findKind } from "../../../helpers/overlay-terminal";

const ITEMS = Array.from({ length: 9 }, (_, i) => ({
	value: `v${i + 1}`,
	label: `Tool ${i + 1}`,
	description: i === 5 ? "Show the logs" : `Does thing ${i + 1}`,
}));

function mount(items = ITEMS) {
	const onPick = vi.fn();
	const onCancel = vi.fn();
	const term = createTestTerminal(
		() => ({
			main: <SelectCard title="Debug Tools" items={items} maxVisible={7} onPick={onPick} onCancel={onCancel} />,
		}),
		{ columns: 60, rows: 30, theme: loadThemeSync("dark") },
	);
	term.focus(findKind(term.surface.main()[0]!, "list") ?? null);
	/** The rows between the frame's borders, without the frame. */
	const body = (): string[] =>
		term
			.screen()
			.slice(1, -1)
			.map(row => row.slice(1, -1).trimEnd());
	/** The option the pointer is on. */
	const pointed = (): string | undefined =>
		body()
			.map(row => /^ \S+ (Tool \d+)/.exec(row)?.[1])
			.find(label => label !== undefined);
	return { term, onPick, onCancel, body, pointed };
}

describe("select card in terminal rows", () => {
	it("frames a blank row, the visible options and the search status under the title", () => {
		const { term, body, pointed } = mount();
		const screen = term.screen();
		expect(screen[0]).toMatch(/^╭─ Debug Tools ─+╮$/);
		expect(screen.at(-1)).toMatch(/^╰─+╯$/);
		expect(screen.every(row => row.length === 60)).toBe(true);
		// Blank row, seven of the nine options, then the status.
		expect(body()).toHaveLength(9);
		expect(body()[0]).toBe("");
		expect(body().filter(row => row.includes("Tool "))).toHaveLength(7);
		expect(body()[1]).toContain("Does thing 1");
		expect(body().at(-1)).toBe("   Type to search");
		expect(pointed()).toBe("Tool 1");
		term.dispose();
	});

	it("moves with the list keys, wrapping at the ends and paging by the visible rows", () => {
		const { term, pointed } = mount();
		term.press("down");
		expect(pointed()).toBe("Tool 2");
		term.press("up");
		term.press("up");
		expect(pointed()).toBe("Tool 9");
		term.press("down");
		expect(pointed()).toBe("Tool 1");
		term.press("pageDown");
		expect(pointed()).toBe("Tool 8");
		term.press("pageDown");
		expect(pointed()).toBe("Tool 9");
		term.press("home");
		expect(pointed()).toBe("Tool 1");
		term.press("end");
		expect(pointed()).toBe("Tool 9");
		term.dispose();
	});

	it("filters as you type once the options outgrow the rows, and says so when nothing matches", () => {
		const { term, body, pointed, onPick } = mount();
		term.type("logs");
		expect(body().filter(row => row.includes("Tool "))).toHaveLength(1);
		expect(pointed()).toBe("Tool 6");
		expect(body().at(-1)).toMatch(/^ {3}Search: logs/);
		term.type("zzz");
		expect(
			body()
				.slice(1)
				.map(row => row.trim()),
		).toEqual(["Search: logszzz", "No matching items"]);
		for (let i = 0; i < 3; i++) term.press("backspace");
		term.press("enter");
		expect(onPick).toHaveBeenCalledWith("v6");
		term.dispose();
	});

	it("does not search a list that fits: letters are not taken as a query", () => {
		const { term, body } = mount(ITEMS.slice(0, 3));
		term.type("x");
		expect(body().filter(row => row.includes("Tool "))).toHaveLength(3);
		expect(body().some(row => row.includes("Search"))).toBe(false);
		term.dispose();
	});

	it("picks the option a press lands on and cancels on Escape", () => {
		const { term, onPick, onCancel } = mount();
		// Row 0 is the top border, row 1 the blank row: the third option is on row 4.
		term.mouse({ row: 4, col: 10, button: "left", action: "press", mods: [] });
		expect(onPick).toHaveBeenCalledWith("v3");
		term.press("escape");
		expect(onCancel).toHaveBeenCalledTimes(1);
		term.dispose();
	});
});
