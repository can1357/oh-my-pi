import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { HistorySearchComponent } from "@oh-my-pi/pi-tui/overlays/history-search";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { HistoryEntry, HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";

beforeAll(async () => {
	await initTheme();
});

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function makeEntry(id: number, prompt: string, ageSeconds = 0): HistoryEntry {
	return { id, prompt, created_at: NOW_SECONDS - ageSeconds, useCount: 1 };
}

/** Minimal in-memory stand-in matching the two methods the component touches. */
function fakeStorage(entries: HistoryEntry[]): HistoryStorage {
	const tokenize = (q: string) =>
		q
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean);
	return {
		getRecent: (limit: number) => entries.slice(0, limit),
		search: (query: string, limit: number) => {
			const tokens = tokenize(query);
			return entries.filter(e => tokens.every(t => e.prompt.toLowerCase().includes(t))).slice(0, limit);
		},
	} as unknown as HistoryStorage;
}

function render(component: HistorySearchComponent, width = 80): { raw: string; plain: string } {
	const lines = component.render(width);
	const raw = lines.join("\n");
	return { raw, plain: Bun.stripANSI(raw) };
}

function type(component: HistorySearchComponent, text: string): void {
	for (const char of text) component.handleInput(char);
}

describe("HistorySearchComponent", () => {
	it("paints the selected row with the selectedBg highlight bar and a relative timestamp", () => {
		const component = new HistorySearchComponent(
			fakeStorage([makeEntry(1, "deploy the release"), makeEntry(2, "older prompt", 7200)]),
			() => {},
			() => {},
		);

		const { raw, plain } = render(component);

		expect(plain).toContain("deploy the release");
		// First (default-selected) row carries the selection background.
		const selectedRow = raw.split("\n").find(line => line.includes("deploy the release"));
		expect(selectedRow).toContain(theme.getBgAnsi("selectedBg"));
		// Fresh entry renders the compact "now" age marker.
		expect(plain).toContain("now");
	});

	it("highlights the matched query tokens within results", () => {
		const component = new HistorySearchComponent(
			fakeStorage([makeEntry(1, "deploy the needle rollback"), makeEntry(2, "routine status update")]),
			() => {},
			() => {},
		);

		type(component, "needle");

		const { raw, plain } = render(component);
		expect(plain).toContain("deploy the needle rollback");
		expect(plain).not.toContain("routine status update");
		// The matched substring is wrapped in the accent color.
		expect(raw).toContain(theme.fg("accent", "needle"));
	});

	it("distinguishes an empty query from an unmatched query", () => {
		const empty = new HistorySearchComponent(
			fakeStorage([]),
			() => {},
			() => {},
		);
		expect(render(empty).plain).toContain("No history yet");

		const unmatched = new HistorySearchComponent(
			fakeStorage([makeEntry(1, "deploy the release")]),
			() => {},
			() => {},
		);
		type(unmatched, "zzzz");
		expect(render(unmatched).plain).toContain("No matching history");
	});
});

describe("HistorySearchComponent debounced search", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function countingStorage(entries: HistoryEntry[]): { storage: HistoryStorage; searches: string[] } {
		const base = fakeStorage(entries);
		const searches: string[] = [];
		const storage = {
			getRecent: (limit: number) => base.getRecent(limit),
			search: (query: string, limit: number) => {
				searches.push(query);
				return base.search(query, limit);
			},
		} as unknown as HistoryStorage;
		return { storage, searches };
	}

	it("searches once after the quiet period and requests a repaint", () => {
		vi.useFakeTimers();
		const { storage, searches } = countingStorage([
			makeEntry(1, "deploy the needle rollback"),
			makeEntry(2, "routine status update"),
		]);
		const component = new HistorySearchComponent(
			storage,
			() => {},
			() => {},
		);
		let renders = 0;
		component.setOnRequestRender(() => renders++);

		type(component, "needle");
		expect(searches).toEqual([]);
		expect(render(component).plain).toContain("routine status update");

		vi.advanceTimersByTime(150);
		expect(searches).toEqual(["needle"]);
		expect(renders).toBe(1);
		expect(render(component).plain).not.toContain("routine status update");
	});

	it("skips the search when only the cursor moves", () => {
		vi.useFakeTimers();
		const { storage, searches } = countingStorage([makeEntry(1, "deploy the needle rollback")]);
		const component = new HistorySearchComponent(
			storage,
			() => {},
			() => {},
		);
		component.setOnRequestRender(() => {});
		type(component, "needle");
		vi.advanceTimersByTime(150);
		component.handleInput("\x1b[D");
		component.handleInput("\x1b[C");
		component.handleInput(" ");
		vi.advanceTimersByTime(150);
		expect(searches).toEqual(["needle"]);
	});

	it("uses fresh results when Enter arrives before the debounce fires", () => {
		vi.useFakeTimers();
		const { storage } = countingStorage([
			makeEntry(1, "routine status update"),
			makeEntry(2, "needle in a haystack"),
		]);
		const selected: string[] = [];
		const component = new HistorySearchComponent(
			storage,
			prompt => selected.push(prompt),
			() => {},
		);
		let renders = 0;
		component.setOnRequestRender(() => renders++);
		type(component, "needle");
		component.handleInput("\n");
		expect(selected).toEqual(["needle in a haystack"]);
		vi.advanceTimersByTime(150);
		expect(renders).toBe(0);
	});

	it("ignores a list pick of a row from the previous query while the search is pending", () => {
		vi.useFakeTimers();
		const stale = makeEntry(1, "routine status update");
		const { storage } = countingStorage([stale, makeEntry(2, "needle in a haystack")]);
		const selected: string[] = [];
		const component = new HistorySearchComponent(
			storage,
			prompt => selected.push(prompt),
			() => {},
		);
		component.setOnRequestRender(() => {});
		type(component, "needle");
		// The row is still on screen: the debounce has not refreshed results yet.
		const staleKey = `${stale.created_at}-${Bun.hash(stale.prompt).toString(36)}`;
		component.handleNativeEvent({ type: "activate", key: "list", item: staleKey });
		expect(selected).toEqual([]);
		expect(render(component).plain).not.toContain("routine status update");
	});

	it("shows recent history immediately when the query is cleared", () => {
		vi.useFakeTimers();
		const { storage } = countingStorage([
			makeEntry(1, "routine status update"),
			makeEntry(2, "needle in a haystack"),
		]);
		const component = new HistorySearchComponent(
			storage,
			() => {},
			() => {},
		);
		component.setOnRequestRender(() => {});
		type(component, "h");
		vi.advanceTimersByTime(150);
		expect(render(component).plain).not.toContain("routine status update");
		component.handleInput("\x7f");
		expect(render(component).plain).toContain("routine status update");
	});
});
