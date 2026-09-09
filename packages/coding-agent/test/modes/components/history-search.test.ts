import { beforeAll, describe, expect, it } from "bun:test";
import { HistorySearchComponent } from "@oh-my-pi/pi-coding-agent/modes/components/history-search";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { HistoryEntry, HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";

beforeAll(async () => {
	await initTheme();
});

const NOW_SECONDS = Math.floor(Date.now() / 1000);

function makeEntry(id: number, prompt: string, ageSeconds = 0): HistoryEntry {
	return { id, prompt, created_at: NOW_SECONDS - ageSeconds };
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
