import { afterAll, describe, expect, it } from "bun:test";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import {
	HistorySearch,
	type HistorySearchEntry,
	type HistorySource,
} from "../../../src/ui/overlays/pickers/history-search";
import { mountOverlay } from "../../helpers/overlay-terminal";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function makeEntry(id: number, prompt: string, ageSeconds = 0): HistorySearchEntry {
	return { id, prompt, created_at: NOW_SECONDS - ageSeconds };
}

/** In-memory history that records every search it runs. */
function fakeSource(entries: HistorySearchEntry[]): HistorySource & { searches: string[] } {
	const tokenize = (q: string) =>
		q
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean);
	const searches: string[] = [];
	return {
		searches,
		getRecent: limit => entries.slice(0, limit),
		delete: id => {
			const index = entries.findIndex(entry => entry.id === id);
			if (index >= 0) entries.splice(index, 1);
		},
		search: (query, limit) => {
			searches.push(query);
			const tokens = tokenize(query);
			return entries.filter(e => tokens.every(t => e.prompt.toLowerCase().includes(t))).slice(0, limit);
		},
	};
}

/** A debounce the test fires by hand. */
function manualSchedule(): { schedule: (run: () => void) => () => void; fire(): void; pending(): boolean } {
	let queued: (() => void) | undefined;
	return {
		schedule: run => {
			queued = run;
			return () => {
				if (queued === run) queued = undefined;
			};
		},
		fire() {
			const run = queued;
			queued = undefined;
			run?.();
		},
		pending: () => queued !== undefined,
	};
}

function mount(
	source: HistorySource,
	options: { onSelect?: (prompt: string) => void; schedule?: (run: () => void) => () => void } = {},
): TestTerminal {
	return mountOverlay(
		() =>
			HistorySearch({
				source,
				onSelect: options.onSelect ?? (() => {}),
				onCancel: () => {},
				...(options.schedule ? { schedule: options.schedule } : {}),
			}),
		{ columns: 80, rows: 30 },
	);
}

const screen = (term: TestTerminal): string => {
	term.render();
	return term.screen().join("\n");
};

describe("history search", () => {
	it("deletes the selected result only when Delete is at the end of the query", () => {
		const source = fakeSource([makeEntry(1, "alpha one"), makeEntry(2, "alpha two")]);
		const term = mount(source);
		try {
			term.type("alpha");
			term.press("left");
			term.press("delete");
			expect(source.getRecent(10).map(entry => entry.prompt)).toEqual(["alpha one", "alpha two"]);
			term.type("a");
			term.press("down");
			term.press("delete");
			expect(source.getRecent(10).map(entry => entry.prompt)).toEqual(["alpha one"]);
			expect(screen(term)).not.toContain("alpha two");
		} finally {
			term.dispose();
		}
	});

	it("distinguishes an empty history from an unmatched query", () => {
		const empty = mount(fakeSource([]));
		expect(screen(empty)).toContain("No history yet");
		empty.dispose();

		const unmatched = mount(fakeSource([makeEntry(1, "deploy the release")]));
		unmatched.type("zzzz");
		expect(screen(unmatched)).toContain("No matching history");
		unmatched.dispose();
	});
});

describe("history search debounce", () => {
	it("searches once after the quiet period", () => {
		const source = fakeSource([makeEntry(1, "deploy the needle rollback"), makeEntry(2, "routine status update")]);
		const debounce = manualSchedule();
		const term = mount(source, { schedule: debounce.schedule });
		try {
			const recent = source.searches.length;
			term.type("needle");
			expect(source.searches.slice(recent)).toEqual([]);
			expect(screen(term)).toContain("routine status update");

			debounce.fire();
			expect(source.searches.slice(recent)).toEqual(["needle"]);
			expect(screen(term)).not.toContain("routine status update");
		} finally {
			term.dispose();
		}
	});

	it("skips the search when only the cursor moves", () => {
		const source = fakeSource([makeEntry(1, "deploy the needle rollback")]);
		const debounce = manualSchedule();
		const term = mount(source, { schedule: debounce.schedule });
		try {
			term.type("needle");
			debounce.fire();
			const searched = source.searches.length;
			term.press("left");
			term.press("right");
			term.type(" ");
			debounce.fire();
			expect(source.searches.length).toBe(searched);
		} finally {
			term.dispose();
		}
	});

	it("uses fresh results when Enter arrives before the debounce fires", () => {
		const source = fakeSource([makeEntry(1, "routine status update"), makeEntry(2, "needle in a haystack")]);
		const debounce = manualSchedule();
		const selected: string[] = [];
		const term = mount(source, { schedule: debounce.schedule, onSelect: prompt => selected.push(prompt) });
		try {
			term.type("needle");
			term.press("enter");
			expect(selected).toEqual(["needle in a haystack"]);
			// The pending search was dropped with the pick.
			expect(debounce.pending()).toBe(false);
		} finally {
			term.dispose();
		}
	});

	it("shows recent history immediately when the query is cleared", () => {
		const source = fakeSource([makeEntry(1, "routine status update"), makeEntry(2, "needle in a haystack")]);
		const debounce = manualSchedule();
		const term = mount(source, { schedule: debounce.schedule });
		try {
			term.type("h");
			debounce.fire();
			expect(screen(term)).not.toContain("routine status update");
			term.press("backspace");
			expect(screen(term)).toContain("routine status update");
		} finally {
			term.dispose();
		}
	});
});
