import { describe, expect, test } from "bun:test";
import { isWorthListing, type SessionNode } from "../src/projects/discover";

/**
 * The sidebar listed nine sessions, six of which were throwaway: three "hola"
 * and three protocol probes. They were not omp's internal sessions — those are
 * subagents, written one directory deeper than the agent's single-level session
 * glob reaches, and already invisible.
 *
 * What separates the six from the three is that omp never named them:
 * `isLowSignalTitleInput` refuses to title a message with nothing in it, and an
 * empty name arrives here as an absent `title`.
 */
function session(overrides: Partial<SessionNode>): SessionNode {
	return {
		path: "/s/a.jsonl",
		id: "a",
		cwd: "/work",
		created: "2026-08-27T00:00:00.000Z",
		modified: "2026-08-27T00:00:00.000Z",
		messageCount: 2,
		size: 100,
		firstMessage: "hola",
		projectRoot: "/work",
		isWorktree: false,
		projectName: "work",
		...overrides,
	} as SessionNode;
}

describe("what reaches the sidebar", () => {
	test("a named session is listed", () => {
		expect(isWorthListing(session({ title: "Migrate services to new architecture" }))).toBe(true);
	});

	test("an unnamed one is not — omp declined to name it", () => {
		expect(isWorthListing(session({ title: undefined }))).toBe(false);
	});

	test("an empty or blank name counts as unnamed", () => {
		// The agent writes an empty title placeholder at session start and fills
		// it later; `normalizeTitleOverride` maps blank to absent, but a stray
		// whitespace-only title must not slip a session back into the list.
		expect(isWorthListing(session({ title: "" }))).toBe(false);
		expect(isWorthListing(session({ title: "   " }))).toBe(false);
	});

	test("a long throwaway session is still throwaway", () => {
		// messageCount is deliberately not the signal: a chatty session that never
		// said anything nameable is still not worth a row.
		expect(isWorthListing(session({ title: undefined, messageCount: 400 }))).toBe(false);
	});

	test("a short named session survives", () => {
		// The mirror of the above, and the reason a count threshold was rejected.
		expect(isWorthListing(session({ title: "Fix the flaky tokenizer test", messageCount: 2 }))).toBe(true);
	});

	test("a temp directory does not disqualify real work", () => {
		// Filtering by cwd would have hidden this; the six throwaway sessions
		// happened to live in /tmp, which made cwd look like a signal.
		expect(isWorthListing(session({ title: "Debug the installer", cwd: "/tmp" }))).toBe(true);
	});
});
