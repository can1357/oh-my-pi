import { afterAll, describe, expect, it } from "bun:test";
import type { SessionSelectorEntry } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/session-selector";
import { mountSessionSelector, sessionEntry } from "../../helpers/session-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

function createSession(id: string, title: string, cwd: string, parentSessionPath?: string): SessionSelectorEntry {
	return sessionEntry(id, title, "2024-01-02T00:00:00Z", {
		path: `${cwd}/${id}.jsonl`,
		cwd,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
		...(parentSessionPath ? { parentSessionPath } : {}),
	});
}

/** Let a scope switch's listing land. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("session selector scope toggle", () => {
	it("loads the all-projects list on Tab and surfaces each session's directory", async () => {
		const folder = [createSession("local", "Local", "/work/current")];
		const global = [
			createSession("local", "Local", "/work/current"),
			createSession("remote", "Remote", "/work/other-project"),
		];
		let loads = 0;
		const picker = mountSessionSelector({
			sessions: folder,
			loadAllSessions: async () => {
				loads++;
				return { sessions: global };
			},
		});
		try {
			// Folder scope: header says current folder, no foreign cwd column.
			expect(picker.screen()).toContain("(current folder)");
			expect(picker.screen()).not.toContain("other-project");

			picker.press("tab");
			await settle();
			const rendered = picker.screen();
			expect(rendered).toContain("(all projects)");
			expect(rendered).toContain("other-project");
			expect(loads).toBe(1);

			// Toggling back returns to folder scope without reloading.
			picker.press("tab");
			await settle();
			expect(picker.screen()).toContain("(current folder)");
			expect(loads).toBe(1);

			// Re-entering all scope reuses the cached global list.
			picker.press("tab");
			await settle();
			expect(loads).toBe(1);
		} finally {
			picker.term.dispose();
		}
	});

	it("shows directories in folder scope only when the list spans worktrees, across a Tab round-trip", async () => {
		const single = mountSessionSelector({
			sessions: [createSession("a", "Alpha", "/work/repo"), createSession("b", "Beta", "/work/repo")],
		});
		expect(single.screen()).not.toContain("/work/repo");
		single.term.dispose();

		const folder = [createSession("main", "Main", "/work/repo"), createSession("wt", "Moved", "/work/repo-wt")];
		const picker = mountSessionSelector({ sessions: folder, loadAllSessions: async () => ({ sessions: folder }) });
		try {
			expect(picker.screen()).toContain("/work/repo-wt");
			picker.press("tab");
			await settle();
			expect(picker.screen()).toContain("(all projects)");
			picker.press("tab");
			await settle();
			const rendered = picker.screen();
			expect(rendered).toContain("(current folder)");
			expect(rendered).toContain("/work/repo-wt");
		} finally {
			picker.term.dispose();
		}
	});

	it("applies the completed all-projects listing, including a query typed before it settles", async () => {
		const preliminary = [createSession("local", "Local", "/work/current")];
		const completed = [
			createSession("local", "Local", "/work/current"),
			sessionEntry("remote", "Remote", "2024-01-02T00:00:00Z", { model: "openai/gpt-5.2" }),
		];
		let resolveListing!: (sessions: SessionSelectorEntry[]) => void;
		const complete = new Promise<SessionSelectorEntry[]>(resolve => {
			resolveListing = resolve;
		});
		const picker = mountSessionSelector({
			sessions: preliminary,
			loadAllSessions: async () => ({ sessions: preliminary, complete }),
		});
		try {
			picker.press("tab");
			await settle();
			// The preliminary rows show at once, but carry no model facts.
			expect(picker.screen()).toContain("Local");
			expect(picker.screen()).not.toContain("openai/gpt-5.2");

			picker.press("g");
			picker.press("p");
			picker.press("t");
			await settle();
			// A query entered before the full scan resolves matches nothing yet.
			expect(picker.screen()).not.toContain("openai/gpt-5.2");

			resolveListing(completed);
			await settle();
			const rendered = picker.screen();
			// The completed rows replace the indexed ones and the query already
			// in place now finds the session by its model.
			expect(rendered).toContain("openai/gpt-5.2");
			expect(rendered).not.toContain("first message local");
		} finally {
			picker.term.dispose();
		}
	});

	it("returns the full selected session, including its cwd", async () => {
		const remote = createSession("remote", "Remote", "/work/other-project");
		const picker = mountSessionSelector({
			sessions: [createSession("local", "Local", "/work/current")],
			loadAllSessions: async () => ({ sessions: [remote] }),
		});
		try {
			picker.press("tab");
			await settle();
			const picked = picker.enter();
			expect(picked?.path).toBe(remote.path);
			expect(picked?.cwd).toBe("/work/other-project");
		} finally {
			picker.term.dispose();
		}
	});

	it("starts in current-folder scope even when the cwd is empty (#3099)", () => {
		const global = [createSession("remote", "Remote", "/work/other-project")];
		const picker = mountSessionSelector({ sessions: [], loadAllSessions: async () => ({ sessions: global }) });
		try {
			const rendered = picker.screen();
			// The header stays scoped to the cwd so the user is never silently shown
			// other projects' sessions just because the current folder is empty.
			expect(rendered).toContain("(current folder)");
			expect(rendered).not.toContain("(all projects)");
			expect(rendered).not.toContain("other-project");
		} finally {
			picker.term.dispose();
		}
	});

	it("marks forked child sessions", () => {
		const parent = createSession("root", "Incident", "/work/current");
		const child = createSession("child", "Incident", "/work/current", parent.path);
		const picker = mountSessionSelector({ sessions: [parent, child] });
		try {
			const forkLines = picker
				.screen()
				.split("\n")
				.filter(line => line.includes("fork"));
			expect(forkLines).toHaveLength(1);
		} finally {
			picker.term.dispose();
		}
	});
});
