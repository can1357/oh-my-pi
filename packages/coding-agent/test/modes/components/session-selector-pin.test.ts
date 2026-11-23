import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { getKeybindings, type KeybindingsManager as TuiKeybindingsManager, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

const ALT_K = "\x1bk";
const ALT_SHIFT_K = "\x1bK";
const DOWN = "\x1b[B";

function session(id: string, modified: string): SessionInfo {
	return {
		path: `/sessions/${id}.jsonl`,
		id,
		cwd: "/repo",
		title: `${id} shared`,
		created: new Date(modified),
		modified: new Date(modified),
		messageCount: 1,
		size: 0,
		firstMessage: `${id} prompt`,
		allMessagesText: `${id} prompt`,
	};
}

const newest = session("newest", "2024-01-03T00:00:00Z");
const middle = session("middle", "2024-01-02T00:00:00Z");
const oldest = session("oldest", "2024-01-01T00:00:00Z");

function picker(onSetPinned: (session: SessionInfo, pinned: boolean) => Promise<void>, pinnedIds = new Set<string>()) {
	return new SessionSelectorComponent(
		[newest, middle, oldest],
		() => {},
		() => {},
		() => {},
		{
			onSetPinned,
			pinnedIds,
		},
	);
}

/** Session ids in rendered order. */
function order(selector: SessionSelectorComponent<SessionInfo>): string[] {
	const text = selector.render(120).join("\n");
	return [newest, middle, oldest]
		.map(s => ({ id: s.id, at: text.indexOf(`${s.id} shared`) }))
		.filter(s => s.at >= 0)
		.sort((a, b) => a.at - b.at)
		.map(s => s.id);
}

let previous: TuiKeybindingsManager;

beforeAll(() => {
	initTheme();
});

beforeEach(() => {
	previous = getKeybindings();
	setKeybindings(KeybindingsManager.inMemory());
});

afterEach(() => {
	setKeybindings(previous);
	vi.restoreAllMocks();
});

describe("SessionSelectorComponent pin actions", () => {
	it("pins the selected session to the top and unpins it back to its recency slot, cursor following it", async () => {
		const onSetPinned = vi.fn(async () => {});
		const selector = picker(onSetPinned);
		const list = selector.getSessionList();

		selector.handleInput(DOWN);
		selector.handleInput(DOWN);
		selector.handleInput(ALT_K);
		await Bun.sleep(0);

		expect(onSetPinned).toHaveBeenLastCalledWith(oldest, true);
		expect(order(selector)).toEqual(["oldest", "newest", "middle"]);
		expect(list.selectedSession?.id).toBe("oldest");
		expect(selector.render(120).join("\n")).toContain("unpin");

		// Pin on an already-pinned session is a no-op, not a toggle.
		selector.handleInput(ALT_K);
		await Bun.sleep(0);
		expect(onSetPinned).toHaveBeenCalledTimes(1);

		selector.handleInput(ALT_SHIFT_K);
		await Bun.sleep(0);

		expect(onSetPinned).toHaveBeenLastCalledWith(oldest, false);
		expect(order(selector)).toEqual(["newest", "middle", "oldest"]);
		expect(list.selectedSession?.id).toBe("oldest");
	});

	it("keeps pinned matches ahead of better-ranked matches while searching", async () => {
		const selector = picker(async () => {}, new Set(["oldest"]));

		for (const ch of "shared") selector.handleInput(ch);

		expect(order(selector)).toEqual(["oldest", "newest", "middle"]);
	});

	it("leaves the order alone and shows the error when persisting the pin fails", async () => {
		const selector = picker(async () => {
			throw new Error("pins file locked");
		});

		selector.handleInput(DOWN);
		selector.handleInput(ALT_K);
		await Bun.sleep(0);

		const rendered = selector.render(120).join("\n");
		expect(rendered).toContain("Error: pins file locked");
		expect(order(selector)).toEqual(["newest", "middle", "oldest"]);
	});
});
