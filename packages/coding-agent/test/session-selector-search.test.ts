import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	rankSessionSearchMatches,
	SessionSelectorComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

/**
 * Contracts of the session picker's incremental search engine: a keystroke
 * synchronously surfaces literal matches, background fuzzy chunks converge to
 * exactly the synchronous reference ranking, stale scans are orphaned by a
 * query change, and the prompt-history SQLite lookup is debounced off the
 * keystroke path.
 */

function makeSession(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: `${id}.jsonl`,
		id,
		cwd: "/repo",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		size: 100,
		firstMessage: "",
		allMessagesText: "",
		...overrides,
	};
}

/**
 * 400 sessions, newest last; every fifth carries the "zzmarker" token. Large
 * enough that the non-literal remainder (320) overflows the inline fuzzy
 * budget (100) and must complete through async chunks.
 */
function makeCorpus(): SessionInfo[] {
	const sessions: SessionInfo[] = [];
	for (let i = 0; i < 400; i++) {
		sessions.push(
			makeSession(`s-${i}`, {
				firstMessage: i % 5 === 0 ? `zzmarker topic ${i}` : `unrelated filler text ${i}`,
				modified: new Date(1700000000000 + i * 1000),
			}),
		);
	}
	return sessions;
}

interface Harness {
	selector: SessionSelectorComponent;
	type: (text: string) => void;
	/** Sessions currently in the filtered list, probed through the public selection surface. */
	filtered: () => SessionInfo[];
	renders: () => number;
}

function makeHarness(sessions: SessionInfo[], historyMatcher?: (query: string) => string[]): Harness {
	let renders = 0;
	const selector = new SessionSelectorComponent(
		sessions,
		() => {},
		() => {},
		() => {},
		historyMatcher ? { historyMatcher } : {},
	);
	selector.setOnRequestRender(() => renders++);
	const list = selector.getSessionList();
	const filtered = (): SessionInfo[] => {
		const out: SessionInfo[] = [];
		list.onSelect = session => {
			out.push(session);
		};
		for (let i = 0; ; i++) {
			const before = out.length;
			list.selectAndConfirm(i);
			if (out.length === before) break;
		}
		list.onSelect = undefined;
		return out;
	};
	return {
		selector,
		type: text => {
			for (const ch of text) list.handleInput(ch);
		},
		filtered,
		renders: () => renders,
	};
}

const ids = (sessions: SessionInfo[]): string[] => sessions.map(s => s.id);

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("session picker incremental search", () => {
	it("surfaces literal matches synchronously and converges async fuzzy chunks to the reference ranking", () => {
		const sessions = makeCorpus();
		const harness = makeHarness(sessions);

		// Literal query: complete and recency-ranked within the keystroke itself.
		harness.type("zzmarker");
		const literalReference = rankSessionSearchMatches(sessions, "zzmarker");
		expect(literalReference.length).toBe(80);
		expect(ids(harness.filtered())).toEqual(ids(literalReference));
		expect(harness.filtered()[0]!.id).toBe("s-395");

		// Typo query: no literal hits, so results accumulate through fuzzy chunks.
		harness.type("\x7f\x7f"); // "zzmarker" -> "zzmark"
		harness.type("r"); // "zzmarkr"
		const reference = rankSessionSearchMatches(sessions, "zzmarkr");
		expect(reference.length).toBe(80);
		// The inline slice covers only part of the corpus; the rest is pending.
		expect(harness.filtered().length).toBeLessThan(reference.length);

		vi.runAllTimers(); // drain the zero-delay chunk chain
		expect(ids(harness.filtered())).toEqual(ids(reference));
	});

	it("orphans in-flight fuzzy chunks when the query changes mid-scan", () => {
		const sessions = makeCorpus();
		const harness = makeHarness(sessions);

		harness.type("zzmarkr"); // schedules chunks for the typo query
		harness.type("\x7f"); // "zzmark" — new scan generation while chunks are pending
		harness.type("er"); // "zzmarker"
		vi.runAllTimers();

		// A leaked stale chunk would append fuzzy duplicates of sessions already
		// ranked literally, so exact equality proves the generation guard held.
		expect(ids(harness.filtered())).toEqual(ids(rankSessionSearchMatches(sessions, "zzmarker")));
	});

	it("debounces the prompt-history lookup off the keystroke path and promotes its matches once typing pauses", () => {
		const sessions = makeCorpus();
		const calls: string[] = [];
		const harness = makeHarness(sessions, query => {
			calls.push(query);
			return ["s-105"];
		});

		harness.type("zzmarker");
		// The SQLite-backed matcher must never run inside a keystroke.
		expect(calls).toEqual([]);
		const rendersBefore = harness.renders();

		vi.advanceTimersByTime(149);
		expect(calls).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(calls).toEqual(["zzmarker"]);

		// History match leads the ranking and the merge requested a re-render.
		expect(harness.filtered()[0]!.id).toBe("s-105");
		expect(harness.renders()).toBeGreaterThan(rendersBefore);
	});

	it("keeps title matches in canonical order before and after history arrives", () => {
		const sessions = [
			makeSession("body", { firstMessage: "dashboard", modified: new Date(5) }),
			makeSession("partial-new", { title: "Dashboard notes", modified: new Date(4) }),
			makeSession("partial-old", { title: "Old dashboard", modified: new Date(3) }),
			makeSession("exact-c", { title: "dashboard", modified: new Date(2), created: new Date(2) }),
			makeSession("exact-a", { title: "  DASHBOARD  ", modified: new Date(2), created: new Date(2) }),
			makeSession("exact-b", { title: "dashboard", modified: new Date(2), created: new Date(1) }),
			makeSession("history"),
		];
		const harness = makeHarness(sessions, () => ["history", "exact-a", "body"]);
		harness.type("dashboard");
		const before = ids(harness.filtered());
		expect(before).toEqual(["exact-c", "exact-a", "exact-b", "partial-new", "partial-old", "body"]);
		expect(ids(rankSessionSearchMatches(sessions, "dashboard"))).toEqual(before);
		vi.runAllTimers();
		expect(ids(harness.filtered())).toEqual([...before.slice(0, 5), "history", "body"]);
		harness.selector.dispose();
	});

	it("preserves imported exact and partial title ties in source order", () => {
		const sessions = [
			makeSession("a-partial", { title: "Dashboard notes", created: new Date(1) }),
			makeSession("b-exact", { title: "dashboard", created: new Date(1) }),
			makeSession("c-partial", { title: "Old dashboard", created: new Date(2) }),
			makeSession("d-exact", { title: "dashboard", created: new Date(2) }),
		];
		// Codex lists equal-mtime sessions by ID ascending, regardless of creation time.
		const harness = makeHarness(sessions);
		harness.type("dashboard");
		const expected = ["b-exact", "d-exact", "a-partial", "c-partial"];
		expect(ids(harness.filtered())).toEqual(expected);
		expect(ids(rankSessionSearchMatches(sessions, "dashboard"))).toEqual(expected);
		harness.selector.dispose();
	});

	it("prioritizes titles containing every query token even without a full-title match", () => {
		const sessions = [
			makeSession("body", { title: "textcom", firstMessage: "dashboard", modified: new Date(3) }),
			makeSession("title", { title: "Textcom-dashboard", modified: new Date(1) }),
			makeSession("history"),
		];
		const harness = makeHarness(sessions, () => ["history", "body"]);
		harness.type("  TEXTCOM   dashb ");
		expect(ids(harness.filtered())).toEqual(["title", "body"]);
		vi.runAllTimers();
		expect(ids(harness.filtered())).toEqual(["title", "history", "body"]);
		harness.selector.dispose();
	});

	it("skips the history merge after the user moves the selection", () => {
		const sessions = makeCorpus();
		const calls: string[] = [];
		const harness = makeHarness(sessions, query => {
			calls.push(query);
			return ["s-105"];
		});

		harness.type("zzmarker");
		const before = ids(harness.filtered());
		harness.selector.getSessionList().handleInput("\x1b[B"); // arrow down
		vi.runAllTimers();

		expect(calls).toEqual([]);
		expect(ids(harness.filtered())).toEqual(before);
	});

	it("dispose cancels pending fuzzy chunks and the history merge", () => {
		const sessions = makeCorpus();
		const calls: string[] = [];
		const harness = makeHarness(sessions, query => {
			calls.push(query);
			return ["s-105"];
		});

		harness.type("zzmarkr"); // partial fuzzy scan + scheduled history merge
		const partial = harness.filtered().length;
		harness.selector.dispose();
		vi.runAllTimers();

		expect(calls).toEqual([]);
		expect(harness.filtered().length).toBe(partial);
	});
});
