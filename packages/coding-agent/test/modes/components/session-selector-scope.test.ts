import { beforeAll, describe, expect, it } from "bun:test";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

beforeAll(async () => {
	await initTheme();
});

function createSession(id: string, title: string, cwd: string, parentSessionPath?: string): SessionInfo {
	return {
		path: `${cwd}/${id}.jsonl`,
		id,
		cwd,
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
		...(parentSessionPath ? { parentSessionPath } : {}),
	};
}

const TAB = "\t";

describe("SessionSelectorComponent scope toggle", () => {
	it("loads the all-projects list on Tab and surfaces each session's directory", async () => {
		const folder = [createSession("local", "Local", "/work/current")];
		const global = [
			createSession("local", "Local", "/work/current"),
			createSession("remote", "Remote", "/work/other-project"),
		];
		let loads = 0;
		const selector = new SessionSelectorComponent(
			folder,
			() => {},
			() => {},
			() => {},
			{
				loadAllSessions: async () => {
					loads++;
					return global;
				},
			},
		);

		// Folder scope: header says current folder, no foreign cwd column.
		expect(selector.render(120).join("\n")).toContain("(current folder)");
		expect(selector.render(120).join("\n")).not.toContain("other-project");

		selector.handleInput(TAB);
		await Bun.sleep(0);

		const rendered = selector.render(120).join("\n");
		expect(rendered).toContain("(all projects)");
		expect(rendered).toContain("other-project");
		expect(loads).toBe(1);

		// Toggling back returns to folder scope without reloading.
		selector.handleInput(TAB);
		await Bun.sleep(0);
		expect(selector.render(120).join("\n")).toContain("(current folder)");
		expect(loads).toBe(1);

		// Re-entering all scope reuses the cached global list.
		selector.handleInput(TAB);
		await Bun.sleep(0);
		expect(loads).toBe(1);
	});

	it("returns the full selected session, including its cwd", async () => {
		const folder = [createSession("local", "Local", "/work/current")];
		const remote = createSession("remote", "Remote", "/work/other-project");
		const selected: SessionInfo[] = [];
		const selector = new SessionSelectorComponent(
			folder,
			session => selected.push(session),
			() => {},
			() => {},
			{ loadAllSessions: async () => [remote] },
		);

		selector.handleInput(TAB);
		await Bun.sleep(0);
		selector.handleInput("\n");

		expect(selected).toHaveLength(1);
		expect(selected[0]?.path).toBe(remote.path);
		expect(selected[0]?.cwd).toBe("/work/other-project");
	});

	it("starts in current-folder scope even when the cwd is empty and a global list is preloaded (#3099)", () => {
		const global = [createSession("remote", "Remote", "/work/other-project")];
		// `startInAllScope` was the toggle behind #3099 (an empty folder auto-opened
		// the picker in all-projects scope). The fix removes the option, so force it
		// via a cast to prove the component now ignores it and stays folder-scoped —
		// without this, the test would pass against the buggy code too.
		const opts = { allSessions: global, loadAllSessions: async () => global };
		(opts as { startInAllScope?: boolean }).startInAllScope = true;
		const selector = new SessionSelectorComponent(
			[],
			() => {},
			() => {},
			() => {},
			opts,
		);

		const rendered = selector.render(120).join("\n");
		// Header stays scoped to the cwd so the user is never silently shown
		// other projects' sessions just because the current folder is empty.
		expect(rendered).toContain("(current folder)");
		expect(rendered).not.toContain("(all projects)");
		expect(rendered).not.toContain("other-project");
		// The empty-state hint must be visible so the user knows Tab is the way out.
		expect(rendered).toContain("No sessions in current folder");
		expect(rendered).toContain("Press Tab to view all");
	});

	it("marks forked child sessions in the rendered list", () => {
		const parent = createSession("root", "Incident", "/work/current");
		const child = createSession("child", "Incident", "/work/current", parent.path);
		const selector = new SessionSelectorComponent(
			[parent, child],
			() => {},
			() => {},
			() => {},
		);

		const rendered = selector.render(120).join("\n");
		const forkLines = rendered.split("\n").filter(line => line.includes("fork"));

		expect(forkLines).toHaveLength(1);
		expect(forkLines[0]).toContain("fork");
	});
});
