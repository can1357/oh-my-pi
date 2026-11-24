/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The session picker scrolls at the edge (the old selector's `nearest`
 * window): ↓ walks the selection down to the last shown session before the
 * list moves, then the list moves one session per step; ↑ walks back up
 * inside the window; a new search opens the list centred again.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { SessionSelectorEntry } from "../../../../src/modes/view-model/overlays/session-selector";
import { SessionSelector } from "../../../../src/ui/overlays/pickers/session-selector";
import "../../../../src/ui/styles/pickers/sessions";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const NOW = Date.parse("2026-11-23T12:00:00Z");

const sessions: SessionSelectorEntry[] = Array.from({ length: 30 }, (_, i) => ({
	path: `/w/a/s${i}.jsonl`,
	id: `id${i}`,
	cwd: "/w/a",
	title: `Session ${String(i).padStart(2, "0")}`,
	modified: new Date(NOW - (i + 1) * 60_000),
	size: 1000,
	firstMessage: `first ${i}`,
	allMessagesText: `first ${i}`,
}));

function findPicker(node: UiNode): UiNode | undefined {
	if (node.kind === "picker") return node;
	for (const child of node.children()) {
		const found = findPicker(child);
		if (found) return found;
	}
	return undefined;
}

function mount() {
	const theme = loadThemeSync("dark");
	setCurrentTheme(theme);
	const term = createTestTerminal(
		() => ({
			layer: (
				<SessionSelector
					sessions={sessions}
					onSelect={() => {}}
					onCancel={() => {}}
					terminalRows={30}
					projectName="ui"
					now={() => NOW}
				/>
			),
		}),
		{ columns: 80, rows: 30, theme },
	);
	term.render();
	const layer = term.surface.layer()[0];
	term.focus(layer ? (findPicker(layer) ?? null) : null);
	/** The session titles shown, top to bottom. */
	const shown = (): number[] => {
		term.render();
		return term.screen().flatMap(row => [...row.matchAll(/Session (\d\d)/g)].map(match => Number(match[1])));
	};
	/** The selected session (behind `❯`). */
	const selected = (): number => {
		term.render();
		const row = term.screen().find(line => line.includes("❯ Session"));
		return Number(row?.match(/❯ Session (\d\d)/)?.[1] ?? -1);
	};
	return { term, shown, selected };
}

describe("session picker scrolling", () => {
	test("moves the selection to the window's edge before the list scrolls", () => {
		const { term, shown, selected } = mount();
		const first = shown();
		expect(selected()).toBe(0);
		expect(first[0]).toBe(0);
		const page = first.length;
		expect(page).toBeGreaterThan(2);
		expect(page).toBeLessThan(sessions.length);

		// Down to the last session shown: the list stays put.
		for (let i = 1; i < page; i++) {
			term.press("down");
			expect(selected()).toBe(i);
			expect(shown()).toEqual(first);
		}
		// Past the edge: the list moves one session per step, the selection stays on its last row.
		for (let i = page; i < page + 3; i++) {
			term.press("down");
			expect(selected()).toBe(i);
			expect(shown()).toEqual(first.map(at => at + i - page + 1));
		}
		// Back up inside the window: the list stays put until the top edge.
		const window = shown();
		for (let i = page + 1; i >= window[0]!; i--) {
			term.press("up");
			expect(selected()).toBe(i);
			expect(shown()).toEqual(window);
		}
		term.press("up");
		expect(shown()).toEqual(window.map(at => at - 1));
	});
});
