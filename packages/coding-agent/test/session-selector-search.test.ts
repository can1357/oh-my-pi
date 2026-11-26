import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { rankSessionSearchMatches } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/session-selector";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionSelector } from "../src/ui/overlays/pickers/session-selector";
import { firstOfKind, type LayerTerminal, mountLayer } from "./helpers/layer-terminal";

/**
 * Contracts of the session picker's search: a keystroke ranks every session
 * exactly like the reference ranking, and the prompt-history SQLite lookup is
 * debounced off the keystroke path, merged once typing pauses, skipped once the
 * user moves the selection, and cancelled when the picker closes.
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

/** 400 sessions, newest last; every fifth carries the "zzmarker" token. */
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
	selector: LayerTerminal;
	type: (text: string) => void;
	/** Session ids in the picker's list, in order. */
	filtered: () => string[];
}

const open: LayerTerminal[] = [];

function makeHarness(sessions: SessionInfo[], historyMatcher?: (query: string) => string[]): Harness {
	const selector = mountLayer(() =>
		SessionSelector({
			sessions,
			onSelect: () => {},
			onCancel: () => {},
			...(historyMatcher ? { historyMatcher } : {}),
		}),
	);
	open.push(selector);
	const filtered = (): string[] => {
		const layer = selector.term.surface.layer()[0];
		const picker = layer ? firstOfKind(layer, "picker") : null;
		const order = (picker?.props() as { order?: readonly string[] } | undefined)?.order ?? [];
		return order.map(path => path.replace(/\.jsonl$/, ""));
	};
	return {
		selector,
		type: text => {
			for (const ch of text) selector.handleInput(ch);
		},
		filtered,
	};
}

const ids = (sessions: SessionInfo[]): string[] => sessions.map(s => s.id);

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const selector of open.splice(0)) selector.dispose();
	vi.useRealTimers();
});

describe("session picker search", () => {
	it("ranks literal and typo queries exactly like the reference ranking within the keystroke", () => {
		const sessions = makeCorpus();
		const harness = makeHarness(sessions);

		harness.type("zzmarker");
		const literalReference = rankSessionSearchMatches(sessions, "zzmarker");
		expect(literalReference.length).toBe(80);
		expect(harness.filtered()).toEqual(ids(literalReference));
		expect(harness.filtered()[0]).toBe("s-395");

		harness.type("\x7f\x7f"); // "zzmarker" -> "zzmark"
		harness.type("r"); // "zzmarkr"
		const reference = rankSessionSearchMatches(sessions, "zzmarkr");
		expect(reference.length).toBe(80);
		expect(harness.filtered()).toEqual(ids(reference));
	});

	it("shows each session's model on its row and finds the session by it", () => {
		const sessions = [
			makeSession("a", { firstMessage: "fix the parser", model: "anthropic/claude-sonnet-4-5" }),
			makeSession("b", { firstMessage: "fix the parser again", model: "openai/gpt-5.2" }),
			makeSession("c", { firstMessage: "fix the parser thrice" }),
		];
		const harness = makeHarness(sessions);

		// A regression drops the model from the row, so a session cannot be told apart by it.
		const text = harness.selector.text(120);
		expect(text).toContain("anthropic/claude-sonnet-4-5");
		expect(text).toContain("openai/gpt-5.2");

		harness.type("gpt-5");
		expect(harness.filtered()).toEqual(["b"]);
	});

	it("keeps the folder on the row when a long model truncates at a narrow width", () => {
		const sessions = [
			makeSession("a", {
				path: "/work/project-a/a.jsonl",
				model: "anthropic/claude-sonnet-4-5-20261015-very-long-name",
				cwd: "/work/project-a",
			}),
			makeSession("b", { path: "/work/project-b/b.jsonl", model: "openai/gpt-5.2", cwd: "/work/project-b" }),
		];
		const harness = makeHarness(sessions);

		// A truncation from the right of the combined facts lets a long model
		// push the folder off the row, hiding what tells same-title sessions apart.
		const text = harness.selector.text(80);
		// The short model leaves the folder whole; the long one truncates on its
		// own and the folder keeps its place, truncated only by the row's own end.
		expect(text).toContain("/work/project-b");
		expect(text).toContain("/work/projec");
		expect(text).toContain("…");
		expect(text).not.toContain("claude-sonnet-4-5-20261015-very-long-name");
	});

	it("follows the latest query when it changes mid-typing", () => {
		const sessions = makeCorpus();
		const harness = makeHarness(sessions);

		harness.type("zzmarkr");
		harness.type("\x7f"); // "zzmark"
		harness.type("er"); // "zzmarker"
		vi.runAllTimers();

		expect(harness.filtered()).toEqual(ids(rankSessionSearchMatches(sessions, "zzmarker")));
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

		vi.advanceTimersByTime(149);
		expect(calls).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(calls).toEqual(["zzmarker"]);

		// The history match leads the ranking.
		expect(harness.filtered()[0]).toBe("s-105");
	});

	it("keeps title matches in canonical order before and after history arrives", () => {
		const sessions = [
			makeSession("body", { firstMessage: "dashboard", modified: new Date(5) }),
			makeSession("partial-new", {
				title: "Dashboard notes",
				modified: new Date(4),
			}),
			makeSession("partial-old", {
				title: "Old dashboard",
				modified: new Date(3),
			}),
			makeSession("exact-c", {
				title: "dashboard",
				modified: new Date(2),
				created: new Date(2),
			}),
			makeSession("exact-a", {
				title: "  DASHBOARD  ",
				modified: new Date(2),
				created: new Date(2),
			}),
			makeSession("exact-b", {
				title: "dashboard",
				modified: new Date(2),
				created: new Date(1),
			}),
			makeSession("history"),
		];
		const harness = makeHarness(sessions, () => ["history", "exact-a", "body"]);
		harness.type("dashboard");
		const before = harness.filtered();
		expect(before).toEqual(["exact-c", "exact-a", "exact-b", "partial-new", "partial-old", "body"]);
		expect(ids(rankSessionSearchMatches(sessions, "dashboard"))).toEqual(before);
		vi.runAllTimers();
		expect(harness.filtered()).toEqual([...before.slice(0, 5), "history", "body"]);
	});

	it("preserves imported exact and partial title ties in source order", () => {
		const sessions = [
			makeSession("a-partial", {
				title: "Dashboard notes",
				created: new Date(1),
			}),
			makeSession("b-exact", { title: "dashboard", created: new Date(1) }),
			makeSession("c-partial", {
				title: "Old dashboard",
				created: new Date(2),
			}),
			makeSession("d-exact", { title: "dashboard", created: new Date(2) }),
		];
		// Codex lists equal-mtime sessions by ID ascending, regardless of creation time.
		const harness = makeHarness(sessions);
		harness.type("dashboard");
		const expected = ["b-exact", "d-exact", "a-partial", "c-partial"];
		expect(harness.filtered()).toEqual(expected);
		expect(ids(rankSessionSearchMatches(sessions, "dashboard"))).toEqual(expected);
	});

	it("prioritizes titles containing every query token even without a full-title match", () => {
		const sessions = [
			makeSession("body", {
				title: "textcom",
				firstMessage: "dashboard",
				modified: new Date(3),
			}),
			makeSession("title", {
				title: "Textcom-dashboard",
				modified: new Date(1),
			}),
			makeSession("history"),
		];
		const harness = makeHarness(sessions, () => ["history", "body"]);
		harness.type("  TEXTCOM   dashb ");
		expect(harness.filtered()).toEqual(["title", "body"]);
		vi.runAllTimers();
		expect(harness.filtered()).toEqual(["title", "history", "body"]);
	});

	it("skips the history merge after the user moves the selection", () => {
		const sessions = makeCorpus();
		const calls: string[] = [];
		const harness = makeHarness(sessions, query => {
			calls.push(query);
			return ["s-105"];
		});

		harness.type("zzmarker");
		const before = harness.filtered();
		harness.selector.handleInput("\x1b[B"); // arrow down
		vi.runAllTimers();

		expect(calls).toEqual([]);
		expect(harness.filtered()).toEqual(before);
	});

	it("closing the picker cancels the pending history merge", () => {
		const calls: string[] = [];
		const harness = makeHarness(makeCorpus(), query => {
			calls.push(query);
			return ["s-105"];
		});

		harness.type("zzmarkr");
		harness.selector.dispose();
		vi.runAllTimers();

		expect(calls).toEqual([]);
	});
});
