import { afterAll, describe, expect, it } from "bun:test";
import { mountSessionSelector, sessionEntry } from "../../helpers/session-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

/** The rows from the one naming `title` (its label and metadata lines). */
function sessionSection(rendered: string, title: string): string {
	const lines = rendered.split("\n");
	const idx = lines.findIndex(line => line.includes(title));
	expect(idx).toBeGreaterThan(-1);
	return lines.slice(idx, idx + 3).join("\n");
}

describe("session selector current session", () => {
	const newer = sessionEntry("newer", "Newer session", "2024-01-03T00:00:00Z");
	const older = sessionEntry("older", "Older session", "2024-01-02T00:00:00Z");

	it("renders no current marker when the live session path is not provided", () => {
		const picker = mountSessionSelector({ sessions: [newer, older] });
		const rendered = picker.screen();
		picker.term.dispose();
		expect(sessionSection(rendered, "Newer session")).not.toContain("current");
		expect(sessionSection(rendered, "Older session")).not.toContain("current");
	});

	it("labels only the live session current", () => {
		const picker = mountSessionSelector({ sessions: [newer, older], currentSessionPath: older.path });
		const rendered = picker.screen();
		picker.term.dispose();
		expect(sessionSection(rendered, "Older session")).toContain("current");
		expect(sessionSection(rendered, "Newer session")).not.toContain("current");
	});

	it("focuses the live session even when it is not the most recent row", () => {
		const picker = mountSessionSelector({ sessions: [newer, older], currentSessionPath: older.path });
		expect(picker.enter()?.id).toBe("older");
		picker.term.dispose();
	});

	it("resets focus to the top search match when the live session is excluded", () => {
		const work = sessionEntry("work", "Alpha work", "2024-01-03T00:00:00Z");
		const live = sessionEntry("live", "Beta live", "2024-01-02T00:00:00Z");
		const other = sessionEntry("other", "Alpha other", "2024-01-01T00:00:00Z");
		const picker = mountSessionSelector({ sessions: [work, live, other], currentSessionPath: live.path });
		picker.term.type("alpha");
		expect(picker.enter()?.id).toBe("work");
		picker.term.dispose();
	});

	it("keeps the neighboring row focused after deleting with an empty query", async () => {
		const alpha = sessionEntry("alpha", "Alpha", "2024-01-03T00:00:00Z");
		const bravo = sessionEntry("bravo", "Bravo", "2024-01-02T00:00:00Z");
		const live = sessionEntry("live", "Charlie live", "2024-01-01T00:00:00Z");
		const deleted = Promise.withResolvers<void>();
		const picker = mountSessionSelector({
			sessions: [alpha, bravo, live],
			currentSessionPath: live.path,
			onDelete: async () => {
				deleted.resolve();
				return true;
			},
		});
		picker.press("up", "up", "delete", "enter");
		await deleted.promise;
		await Promise.resolve();
		expect(picker.screen()).not.toContain("Alpha");
		expect(picker.enter()?.id).toBe("bravo");
		picker.term.dispose();
	});

	it("keeps the neighboring row focused after deleting a filtered result", async () => {
		const alpha = sessionEntry("alpha", "Alpha work", "2024-01-03T00:00:00Z");
		const bravo = sessionEntry("bravo", "Alpha bravo", "2024-01-02T00:00:00Z");
		const charlie = sessionEntry("charlie", "Alpha charlie", "2024-01-01T00:00:00Z");
		const live = sessionEntry("live", "Beta live", "2023-12-31T00:00:00Z");
		const deleted = Promise.withResolvers<void>();
		const picker = mountSessionSelector({
			sessions: [alpha, bravo, charlie, live],
			currentSessionPath: live.path,
			onDelete: async () => {
				deleted.resolve();
				return true;
			},
		});
		picker.term.type("alpha");
		picker.press("down", "delete", "enter");
		await deleted.promise;
		await Promise.resolve();
		expect(picker.screen()).not.toContain("Alpha bravo");
		expect(picker.enter()?.id).toBe("charlie");
		picker.term.dispose();
	});

	it("restores live-session focus when the search query is cleared", () => {
		const picker = mountSessionSelector({ sessions: [newer, older], currentSessionPath: older.path });
		picker.term.type("x");
		picker.press("backspace");
		expect(picker.enter()?.id).toBe("older");
		picker.term.dispose();
	});

	it("drops a deleted live session from the all-projects listing", async () => {
		const alpha = sessionEntry("alpha", "Alpha", "2024-01-03T00:00:00Z");
		const live = sessionEntry("live", "Charlie live", "2024-01-02T00:00:00Z");
		const other = sessionEntry("other", "Other project", "2024-01-01T00:00:00Z", { cwd: "/elsewhere" });
		const deleted = Promise.withResolvers<void>();
		const loaded = Promise.withResolvers<void>();
		const picker = mountSessionSelector({
			sessions: [alpha, live],
			currentSessionPath: live.path,
			loadAllSessions: async () => {
				loaded.resolve();
				return { sessions: [alpha, live, other] };
			},
			onDelete: async () => {
				deleted.resolve();
				return true;
			},
		});
		try {
			picker.press("delete", "enter");
			await deleted.promise;
			await Promise.resolve();
			picker.press("tab");
			await loaded.promise;
			await Promise.resolve();
			const rendered = picker.screen();
			expect(rendered).toContain("(all projects)");
			expect(rendered).toContain("Other project");
			expect(rendered).not.toContain("Charlie live");
		} finally {
			picker.term.dispose();
		}
	});
});
