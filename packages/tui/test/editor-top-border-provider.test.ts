/**
 * Regression for oh-my-pi#4145 (TUI busy loop during long-running eval).
 *
 * The pre-fix hot path rebuilt the editor's top border synchronously on every
 * session event, even though renders are throttled to ~30 fps. On a busy
 * streaming turn that meant dozens of `getTopBorder` calls per painted frame.
 *
 * The fix installs a lazy provider on the editor: the host mutates status-line
 * state as much as it wants, and the provider is invoked exactly once per
 * editor render — bounded by the TUI's render throttle, not by event rate.
 *
 * Contract this test defends:
 * 1. Provider takes precedence over any eager `setTopBorder` content.
 * 2. Provider runs once per render (2 renders = 2 calls, no more).
 * 3. Provider observes the CURRENT status-line state at render time, so
 *    state mutations landing between renders coalesce into one rebuild.
 * 4. Clearing the provider falls back to the eager slot.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Editor, type EditorTopBorder } from "@oh-my-pi/pi-tui/components/editor";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { defaultEditorTheme } from "./test-themes";

function stubTopBorder(label: string): EditorTopBorder {
	return { content: label, width: label.length };
}

describe("Editor lazy top-border provider (#4145)", () => {
	it("invokes the provider once per render regardless of intervening state changes", () => {
		const editor = new Editor(defaultEditorTheme);
		let observedCounter = 0;
		let counter = 0;
		const calls: number[] = [];

		editor.setTopBorderProvider(availableWidth => {
			calls.push(availableWidth);
			observedCounter = counter;
			return stubTopBorder(`counter=${counter}`);
		});

		// Simulate a burst of "events" mutating upstream state between two
		// painted frames. Under the old eager rebuild path this would have
		// been 25 rebuilds; under the lazy provider it should be zero here…
		for (let i = 0; i < 25; i++) counter += 1;
		expect(calls).toHaveLength(0);

		// …and exactly one per painted frame.
		editor.render(80);
		expect(calls).toHaveLength(1);
		expect(observedCounter).toBe(25);

		for (let i = 0; i < 25; i++) counter += 1;
		editor.render(80);
		expect(calls).toHaveLength(2);
		expect(observedCounter).toBe(50);
	});

	it("prefers the provider over any eager setTopBorder content", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setTopBorder(stubTopBorder("eager"));
		editor.setTopBorderProvider(() => stubTopBorder("lazy"));

		const frame = editor.render(80).join("\n");
		expect(frame).toContain("lazy");
		expect(frame).not.toContain("eager");
	});

	it("falls back to eager content when the provider is cleared", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setTopBorder(stubTopBorder("eager"));
		editor.setTopBorderProvider(() => stubTopBorder("lazy"));
		editor.setTopBorderProvider(undefined);

		const frame = editor.render(80).join("\n");
		expect(frame).toContain("eager");
		expect(frame).not.toContain("lazy");
	});

	it("passes the visually-available width (terminal width minus border chrome) to the provider", () => {
		const editor = new Editor(defaultEditorTheme);
		const widths: number[] = [];
		editor.setTopBorderProvider(availableWidth => {
			widths.push(availableWidth);
			return undefined;
		});

		editor.render(80);
		editor.render(120);

		expect(widths).toHaveLength(2);
		expect(widths[0]).toBe(editor.getTopBorderAvailableWidth(80));
		expect(widths[1]).toBe(editor.getTopBorderAvailableWidth(120));
	});

	it("renders content with one newline as two framed, width-filled border rows", () => {
		const editor = new Editor(defaultEditorTheme);
		const primary = "primary-status";
		const overlay = "overflow-segments";
		editor.setTopBorderProvider(() => ({
			content: `${primary}\n${overlay}`,
			// Contract: for multi-line content `width` is the MAX visibleWidth.
			width: Math.max(primary.length, overlay.length),
		}));

		const frame = editor.render(40).map(line => stripVTControlCharacters(line));
		expect(frame[0]).toContain(primary);
		expect(frame[1]).toContain(overlay);
		// Both rows are full-width rows of the content area; the first keeps the
		// cornered top row and the second uses vertical sides, so the corner
		// columns line up as one box.
		expect(visibleWidth(frame[0])).toBe(40);
		expect(visibleWidth(frame[1])).toBe(40);
		expect(frame[0]).toMatch(/^\+.*\+$/);
		expect(frame[1]).toMatch(/^\|.*\|$/);
		// The second row's sides occupy the same columns as the top row's corners.
		expect(frame[1][0]).toBe("|");
		expect(frame[1][frame[1].length - 1]).toBe("|");
		expect(frame[0][0]).toBe("+");
		expect(frame[0][frame[0].length - 1]).toBe("+");
		// The frame grows exactly one row taller than the single-line frame.
		const single = new Editor(defaultEditorTheme);
		single.setTopBorderProvider(() => ({ content: primary, width: primary.length }));
		const singleFrame = single.render(40).map(line => stripVTControlCharacters(line));
		expect(frame.length).toBe(singleFrame.length + 1);
	});

	it("truncates an overflowing second row to the fill width", () => {
		const editor = new Editor(defaultEditorTheme);
		const long = "x".repeat(100);
		editor.setTopBorderProvider(() => ({ content: `short\n${long}`, width: long.length }));

		const frame = editor.render(40).map(line => stripVTControlCharacters(line));
		expect(frame[0]).toContain("short");
		expect(visibleWidth(frame[0])).toBe(40);
		// The oversized second row is truncated (with fill) to the full width.
		expect(frame[1]).toMatch(/^\|.*\|$/);
		expect(visibleWidth(frame[1])).toBe(40);
		expect(frame[1]).not.toContain(long);
	});
});
