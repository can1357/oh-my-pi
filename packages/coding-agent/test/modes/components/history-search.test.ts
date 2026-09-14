import { beforeAll, describe, expect, it } from "bun:test";
import { HistorySearchComponent } from "@oh-my-pi/pi-coding-agent/modes/components/history-search";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type {
	HistoryEntry,
	HistoryScope,
	HistoryScopeKind,
	HistoryStorage,
} from "@oh-my-pi/pi-coding-agent/session/history-storage";

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

/** Stand-in whose result set depends on the scope the component asks for. */
function scopedStorage(byKind: Partial<Record<HistoryScopeKind, HistoryEntry[]>>): HistoryStorage {
	return {
		getRecent: (_limit: number, scope?: HistoryScope) => byKind[scope?.kind ?? "global"] ?? [],
		search: (_query: string, _limit: number, scope?: HistoryScope) => byKind[scope?.kind ?? "global"] ?? [],
	} as unknown as HistoryStorage;
}

const GLOBAL_ONLY: HistoryScope[] = [{ kind: "global" }];
const ALL_SCOPES: HistoryScope[] = [{ kind: "session" }, { kind: "cwd" }, { kind: "global" }];

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
			GLOBAL_ONLY,
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
			GLOBAL_ONLY,
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
			GLOBAL_ONLY,
			() => {},
			() => {},
		);
		expect(render(empty).plain).toContain("No history in all projects");

		const unmatched = new HistorySearchComponent(
			fakeStorage([makeEntry(1, "deploy the release")]),
			GLOBAL_ONLY,
			() => {},
			() => {},
		);
		type(unmatched, "zzzz");
		expect(render(unmatched).plain).toContain("No matching history");
	});

	it("cycles the recall scope with Tab and Shift+Tab", () => {
		const component = new HistorySearchComponent(
			scopedStorage({
				session: [makeEntry(1, "in this conversation")],
				cwd: [makeEntry(2, "in this folder")],
				global: [makeEntry(3, "everywhere")],
			}),
			ALL_SCOPES,
			() => {},
			() => {},
		);

		expect(render(component).plain).toContain("in this conversation");
		expect(render(component).plain).toContain("History (this session)");

		component.handleInput("\t");
		const widened = render(component).plain;
		expect(widened).toContain("in this folder");
		expect(widened).toContain("History (current folder)");
		expect(widened).not.toContain("in this conversation");

		component.handleInput("\x1b[Z");
		expect(render(component).plain).toContain("in this conversation");
		expect(render(component).plain).toContain("History (this session)");
	});

	it("drops the Tab hint when the ring has a single scope", () => {
		const component = new HistorySearchComponent(
			scopedStorage({}),
			GLOBAL_ONLY,
			() => {},
			() => {},
		);

		const { plain } = render(component);
		// Advertising a Tab that cannot change anything would promise a no-op. Scope the check to
		// the footer so a title or prompt containing "tab" cannot mask a stray hint.
		const footer = plain.split("\n").find(line => line.includes("navigate"));
		expect(footer).toBeDefined();
		expect(footer).not.toContain("tab");
		expect(plain).not.toContain("Press Tab for");
	});
});
