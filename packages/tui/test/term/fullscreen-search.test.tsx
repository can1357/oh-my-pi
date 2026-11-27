/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, expect, it } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import type { ScreenMode } from "@oh-my-pi/pi-tui/term/backend";
import { cellGrid } from "@oh-my-pi/pi-tui/testing/cells";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";

let term: TestTerminal | undefined;
afterEach(() => {
	term?.dispose();
	term = undefined;
});

it("finds rendered phrases across rows, cycles and rescans as output arrives, then restores the draft and anchor", () => {
	const lines = signal(["top", "before", "前 \x1b[31mFOX\x1b[0m", "界", "fox 界", "after", "6", "7", "8", "9", "10"]);
	const draft = signal("query stays here");
	const cursor = signal(5);
	const intercepted: string[] = [];
	const t = (term = createTestTerminal(
		() => ({
			main: <rows lines={lines} />,
			dock: (
				<input
					text={draft}
					cursor={cursor}
					onEdit={edit => {
						draft.update(text => text.slice(0, edit.from) + edit.text + text.slice(edit.to));
						cursor.set(edit.cursor);
					}}
				/>
			),
		}),
		{
			screen: () => "fullscreen",
			columns: 44,
			rows: 7,
			intercept: event => {
				intercepted.push(event.type);
				return false;
			},
		},
	));
	const composer = t.surface.dock()[0]!;
	t.focus(composer);
	t.backend.scroll("start");
	t.backend.scroll(1);
	t.render();
	const before = t.screen()[0];
	const caret = t.cursor();
	expect(t.backend.openSearch()).toBe(true);
	t.type("fOx");
	t.paste("\n界");
	expect(t.screen().at(-1)).toContain("1/2");
	const grid = cellGrid(t.rows().slice(0, -1));
	expect(grid.flat().find(cell => cell.ch === "F")).toMatchObject({ fg: "p1", inverse: true });
	expect(grid.flat().find(cell => cell.ch === "界")?.inverse).toBe(true);
	expect(grid.find(row => row[0]?.ch === "f" && row[1]?.ch === "o")?.[0]?.underline).toBe(1);
	t.press("shift+enter");
	expect(t.screen().at(-1)).toContain("2/2");
	lines.update(rows => [...rows, "far fox 界"]);
	t.render();
	expect(t.screen().at(-1)).toContain("2/3");
	t.press("enter");
	expect(t.screen().at(-1)).toContain("3/3");
	expect(t.screen().some(row => row.includes("far fox 界"))).toBe(true);
	t.type("!");
	expect(t.screen().at(-1)).toContain("No matches");
	t.press("backspace");
	expect(t.screen().at(-1)).toContain("3/3");
	t.press("escape");
	expect(t.screen()[0]).toBe(before);
	expect(t.cursor()).toEqual(caret);
	expect(t.surface.focused()).toBe(composer);
	expect(intercepted).toEqual([]);
	t.type("!");
	expect(draft()).toBe("query! stays here");
});

it("accepts an offscreen match without leaking its shortcut, but never captures inline or a modal sheet's input", () => {
	const modal = signal(false);
	const mode = signal<ScreenMode>("inline");
	const routed: string[] = [];
	const t = (term = createTestTerminal(
		() => ({
			main: <rows lines={["found", "1", "2", "3", "4", "5", "6", "7", "last"]} />,
			dock: <rows lines={["draft"]} />,
			layer: () =>
				modal() ? (
					<overlay modal>
						<rows lines={["modal"]} />
					</overlay>
				) : null,
		}),
		{
			screen: mode,
			columns: 30,
			rows: 5,
			onKey: key => {
				routed.push(key.id);
				return true;
			},
		},
	));
	expect(t.backend.openSearch()).toBe(false);
	mode.set("fullscreen");
	t.render();
	expect(t.backend.openSearch()).toBe(true);
	t.paste("found");
	t.press("ctrl+enter");
	expect(t.screen()[0]).toContain("found");
	expect(t.screen().at(-1)).toBe("draft");
	expect(routed).toEqual([]);
	t.backend.scroll("end");
	t.render();
	expect(t.backend.openSearch()).toBe(true);
	t.paste("found");
	// The modal is already live even though its first frame has not painted yet.
	modal.set(true);
	t.press("escape");
	expect(t.backend.openSearch()).toBe(false);
	expect(routed).toEqual(["escape"]);
	modal.set(false);
	t.render();
	expect(t.backend.following).toBe(true);
});
