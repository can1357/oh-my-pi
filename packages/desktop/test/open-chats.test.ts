import { describe, expect, test } from "bun:test";
import {
	adoptSessionIn,
	buildProjects,
	findOpenTab,
	mergeOpenChats,
	type OpenChat,
	type SessionNode,
} from "../src/projects/discover";

function session(over: Partial<SessionNode>): SessionNode {
	return {
		id: over.id ?? "s1",
		path: over.path ?? `/sessions/${over.id ?? "s1"}.jsonl`,
		title: over.title ?? "A session",
		cwd: over.cwd ?? "/repos/kena",
		projectRoot: over.projectRoot ?? "/repos/kena",
		projectName: over.projectName ?? "kena",
		isWorktree: over.isWorktree ?? false,
		modified: over.modified ?? "2026-08-27T10:00:00.000Z",
	} as SessionNode;
}

const KENA = () => buildProjects([session({ id: "s1" })]);

describe("findOpenTab", () => {
	test("matches the tab that adopted the session, whatever its tab id", () => {
		// This is the one that stops a second sidecar: a chat started in the app
		// keeps `new:0:/repos/kena` as its tab id forever.
		const tabs: OpenChat[] = [{ tabId: "new:0:/repos/kena", title: "kena", sessionId: "s1" }];
		expect(findOpenTab(tabs, session({ id: "s1" }))?.tabId).toBe("new:0:/repos/kena");
	});

	test("matches by session file too, before any state frame has arrived", () => {
		const tabs: OpenChat[] = [{ tabId: "t", title: "kena", sessionPath: "/sessions/s1.jsonl" }];
		expect(findOpenTab(tabs, session({ id: "s1" }))).toBeDefined();
	});

	test("matches the old shape, where the tab was named after the session", () => {
		const tabs: OpenChat[] = [{ tabId: "s1", title: "kena" }];
		expect(findOpenTab(tabs, session({ id: "s1" }))).toBeDefined();
	});

	test("does not match a different session", () => {
		const tabs: OpenChat[] = [{ tabId: "new:0:/repos/kena", title: "kena", sessionId: "s1" }];
		expect(findOpenTab(tabs, session({ id: "other", path: "/sessions/other.jsonl" }))).toBeUndefined();
	});

	test("an undefined id on the tab never matches an undefined field on the session", () => {
		const tabs: OpenChat[] = [{ tabId: "new:0:/x", title: "x" }];
		expect(findOpenTab(tabs, session({ id: "s1" }))).toBeUndefined();
	});
});

describe("mergeOpenChats", () => {
	test("a chat in a folder that already has sessions joins that group", () => {
		const merged = mergeOpenChats(KENA(), [{ tabId: "new:0", title: "kena", cwd: "/repos/kena" }]);

		expect(merged.length).toBe(1);
		expect(merged[0].openChats?.map(c => c.tabId)).toEqual(["new:0"]);
		expect(merged[0].total).toBe(2); // the badge counts it
	});

	test("a folder omp has never run in gets a group of its own, first", () => {
		const merged = mergeOpenChats(KENA(), [{ tabId: "new:0", title: "atenea", cwd: "/repos/atenea" }]);

		expect(merged.map(p => p.name)).toEqual(["atenea", "kena"]);
		expect(merged[0].sessions).toEqual([]);
	});

	test("the chat keeps its row while the session is written but still untitled", () => {
		// The window that makes this a function rather than a filter: omp has
		// written the file, so it exists, but `isWorthListing` hides it until the
		// title lands. Testing "is on disk" would make the row flicker away.
		const merged = mergeOpenChats(KENA(), [
			{ tabId: "new:0", title: "kena", cwd: "/repos/kena", sessionId: "not-listed-yet" },
		]);

		expect(merged[0].openChats?.length).toBe(1);
	});

	test("the row disappears once its session is actually shown", () => {
		const merged = mergeOpenChats(KENA(), [{ tabId: "new:0", title: "kena", cwd: "/repos/kena", sessionId: "s1" }]);

		expect(merged[0].openChats).toEqual([]);
		expect(merged[0].total).toBe(1);
	});

	test("a session inside a worktree of the project joins the project's group", () => {
		const projects = buildProjects([
			session({ id: "s1" }),
			session({ id: "s2", cwd: "/repos/kena/.wt/x", isWorktree: true, path: "/sessions/s2.jsonl" }),
		]);
		const merged = mergeOpenChats(projects, [{ tabId: "new:0", title: "x", cwd: "/repos/kena/.wt/x" }]);

		expect(merged.length).toBe(1);
		expect(merged[0].openChats?.length).toBe(1);
	});

	test("the launch tab, which has no folder, is left out", () => {
		const merged = mergeOpenChats(KENA(), [{ tabId: "scratch", title: "New session" }]);

		expect(merged.every(p => (p.openChats ?? []).length === 0)).toBe(true);
		expect(merged.length).toBe(1);
	});

	test("two chats in the same new folder share one group", () => {
		const merged = mergeOpenChats(KENA(), [
			{ tabId: "new:0", title: "atenea", cwd: "/repos/atenea" },
			{ tabId: "new:1", title: "atenea", cwd: "/repos/atenea" },
		]);

		expect(merged.length).toBe(2);
		expect(merged[0].openChats?.length).toBe(2);
		expect(merged[0].total).toBe(2);
	});
});

describe("adoptSessionIn", () => {
	const TABS: OpenChat[] = [
		{ tabId: "new:0", title: "kena", cwd: "/repos/kena", sessionPath: undefined },
		{ tabId: "other", title: "atenea", sessionPath: "/sessions/a.jsonl", sessionId: "a" },
	];

	test("records the id and nothing else — never the replay path", () => {
		// `sessionPath` boots `useBridge`, whose last step is `switch_session`, and
		// that aborts the session. Writing it here would kill the running turn.
		const next = adoptSessionIn(TABS, "new:0", "s1");

		expect(next[0]).toEqual({
			tabId: "new:0",
			title: "kena",
			cwd: "/repos/kena",
			sessionPath: undefined,
			sessionId: "s1",
		});
	});

	test("returns the same array when nothing changed", () => {
		// Called on every state frame: a fresh array would re-render every tab.
		const settled = adoptSessionIn(TABS, "other", "a");

		expect(settled).toBe(TABS);
	});

	test("an unknown tab changes nothing", () => {
		expect(adoptSessionIn(TABS, "gone", "s1")).toBe(TABS);
	});

	test("leaves the other tabs untouched by identity", () => {
		const next = adoptSessionIn(TABS, "new:0", "s1");

		expect(next[1]).toBe(TABS[1]);
	});
});
