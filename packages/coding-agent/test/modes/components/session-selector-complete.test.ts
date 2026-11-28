import { afterAll, describe, expect, it } from "bun:test";
import type { SessionSelectorEntry } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/session-selector";
import { mountSessionSelector, sessionEntry } from "../../helpers/session-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

/**
 * The picker opens on preliminary rows (history.db titles) and swaps in the
 * full scan when it settles; the swap must neither move the cursor onto
 * another session nor undo edits made while the scan ran.
 */
describe("session selector complete listing", () => {
	it("swaps in the complete listing without moving the cursor off the selected session", async () => {
		const complete = Promise.withResolvers<readonly SessionSelectorEntry[]>();
		const picker = mountSessionSelector({
			sessions: [
				sessionEntry("alpha", "Alpha", "2024-01-03T00:00:00Z"),
				sessionEntry("beta", "Beta", "2024-01-02T00:00:00Z"),
			],
			completeSessions: complete.promise,
		});
		try {
			picker.press("down");
			// The full scan adds an untitled session above the cursor.
			complete.resolve([
				sessionEntry("fresh", undefined, "2024-01-04T00:00:00Z"),
				sessionEntry("alpha", "Alpha", "2024-01-03T00:00:00Z"),
				sessionEntry("beta", "Beta", "2024-01-02T00:00:00Z"),
			]);
			// The picker subscribed first, so its swap has run once this await resumes.
			await complete.promise;

			expect(picker.screen()).toContain("first message fresh");
			expect(picker.enter()?.id).toBe("beta");
		} finally {
			picker.term.dispose();
		}
	});

	it("keeps a session deleted before the complete listing landed out of it", async () => {
		const complete = Promise.withResolvers<readonly SessionSelectorEntry[]>();
		const deleted = Promise.withResolvers<void>();
		const picker = mountSessionSelector({
			sessions: [
				sessionEntry("alpha", "Alpha", "2024-01-03T00:00:00Z"),
				sessionEntry("beta", "Beta", "2024-01-02T00:00:00Z"),
			],
			completeSessions: complete.promise,
			onDelete: async () => {
				deleted.resolve();
				return true;
			},
		});
		try {
			picker.press("delete", "enter");
			await deleted.promise;
			await Promise.resolve();

			// Scanned before the delete, so the listing still holds the session.
			complete.resolve([
				sessionEntry("alpha", "Alpha", "2024-01-03T00:00:00Z"),
				sessionEntry("beta", "Beta", "2024-01-02T00:00:00Z"),
			]);
			await complete.promise;

			const rendered = picker.screen();
			expect(rendered).not.toContain("Alpha");
			expect(rendered).toContain("Beta");
		} finally {
			picker.term.dispose();
		}
	});

	it("swaps the complete all-projects listing in, restoring each session's folder", async () => {
		const complete = Promise.withResolvers<SessionSelectorEntry[]>();
		const cwd = "/work/far-project";
		const scanned = sessionEntry("far", "Far", "2024-01-03T00:00:00Z", { path: "/sessions/far.jsonl", cwd });
		const picker = mountSessionSelector({
			sessions: [],
			// history.db rows carry no cwd until the full scan lands.
			loadAllSessions: async () => ({ sessions: [{ ...scanned, cwd: "" }], complete: complete.promise }),
		});
		try {
			picker.press("tab");
			for (let i = 0; i < 5; i++) await Promise.resolve();
			expect(picker.screen()).not.toContain(cwd);

			complete.resolve([scanned]);
			await complete.promise;

			expect(picker.screen()).toContain(cwd);
			picker.press(..."far-project");
			expect(picker.enter()?.id).toBe("far");
		} finally {
			picker.term.dispose();
		}
	});
});
