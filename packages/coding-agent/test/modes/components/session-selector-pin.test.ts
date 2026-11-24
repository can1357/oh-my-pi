import { afterAll, describe, expect, it, vi } from "bun:test";
import type { SessionSelectorEntry } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/session-selector";
import { type MountedSessionSelector, mountSessionSelector, sessionEntry } from "../../helpers/session-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

function session(id: string, modified: string): SessionSelectorEntry {
	return sessionEntry(id, `${id} shared`, modified, {
		firstMessage: `${id} prompt`,
		allMessagesText: `${id} prompt`,
	});
}

const newest = session("newest", "2024-01-03T00:00:00Z");
const middle = session("middle", "2024-01-02T00:00:00Z");
const oldest = session("oldest", "2024-01-01T00:00:00Z");

function picker(
	onSetPinned: (session: SessionSelectorEntry, pinned: boolean) => Promise<void>,
	pinnedIds = new Set<string>(),
): MountedSessionSelector {
	return mountSessionSelector({ sessions: [newest, middle, oldest], onSetPinned, pinnedIds });
}

/** Session ids in drawn order. */
function order(selector: MountedSessionSelector): string[] {
	const text = selector.screen();
	return [newest, middle, oldest]
		.map(s => ({ id: s.id, at: text.indexOf(`${s.id} shared`) }))
		.filter(s => s.at >= 0)
		.sort((a, b) => a.at - b.at)
		.map(s => s.id);
}

describe("session selector pin actions", () => {
	it("pins the selected session to the top and unpins it back to its recency slot, cursor following it", async () => {
		const onSetPinned = vi.fn(async () => {});
		const selector = picker(onSetPinned);
		try {
			selector.press("down", "down", "alt+k");
			await Promise.resolve();

			expect(onSetPinned).toHaveBeenLastCalledWith(oldest, true);
			expect(order(selector)).toEqual(["oldest", "newest", "middle"]);

			// Pin on an already-pinned session is a no-op, not a toggle.
			selector.press("alt+k");
			await Promise.resolve();
			expect(onSetPinned).toHaveBeenCalledTimes(1);

			selector.press("alt+shift+k");
			await Promise.resolve();

			expect(onSetPinned).toHaveBeenLastCalledWith(oldest, false);
			expect(order(selector)).toEqual(["newest", "middle", "oldest"]);
			expect(selector.enter()?.id).toBe("oldest");
		} finally {
			selector.term.dispose();
		}
	});

	it("keeps pinned matches ahead of better-ranked matches while searching", () => {
		const selector = picker(async () => {}, new Set(["oldest"]));
		try {
			selector.term.type("shared");
			expect(order(selector)).toEqual(["oldest", "newest", "middle"]);
		} finally {
			selector.term.dispose();
		}
	});

	it("leaves the order alone and shows the error when persisting the pin fails", async () => {
		const failed = Promise.withResolvers<void>();
		const selector = picker(async () => {
			failed.resolve();
			throw new Error("pins file locked");
		});
		try {
			selector.press("down", "alt+k");
			await failed.promise;
			await Promise.resolve();

			expect(selector.screen()).toContain("pins file locked");
			expect(order(selector)).toEqual(["newest", "middle", "oldest"]);
		} finally {
			selector.term.dispose();
		}
	});
});
