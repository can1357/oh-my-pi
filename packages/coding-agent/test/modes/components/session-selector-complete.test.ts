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
});
