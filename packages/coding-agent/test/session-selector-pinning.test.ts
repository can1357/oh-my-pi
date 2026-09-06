import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager, setKeyHintPlatform } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { getKeybindings, setKeybindings, type KeybindingsManager as TuiKeybindingsManager } from "@oh-my-pi/pi-tui";

function makeSession(id: string, modified: string): SessionInfo {
	return {
		path: `/sessions/${id}.jsonl`,
		id,
		cwd: "/repo",
		title: id,
		created: new Date(modified),
		modified: new Date(modified),
		messageCount: 1,
		size: 100,
		firstMessage: `${id} message`,
		allMessagesText: `${id} message`,
	};
}

function selectedOrder(selector: SessionSelectorComponent): string[] {
	const list = selector.getSessionList();
	const ids: string[] = [];
	list.onSelect = session => ids.push(session.id);
	for (let index = 0; ; index++) {
		const before = ids.length;
		list.selectAndConfirm(index);
		if (ids.length === before) break;
	}
	list.onSelect = undefined;
	return ids;
}

describe("Resume Session pin actions", () => {
	let previous: TuiKeybindingsManager;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(() => {
		previous = getKeybindings();
		setKeyHintPlatform("linux");
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		setKeybindings(previous);
		setKeyHintPlatform(undefined);
	});

	it("pins and unpins the selected session with separate default shortcuts", async () => {
		const recent = makeSession("recent", "2024-01-03T00:00:00Z");
		const older = makeSession("older", "2024-01-01T00:00:00Z");
		const changes: Array<{ id: string; isPinned: boolean }> = [];
		const selector = new SessionSelectorComponent(
			[recent, older],
			() => {},
			() => {},
			() => {},
			{
				onSetPinned: async (session, isPinned) => {
					changes.push({ id: session.id, isPinned });
				},
			},
		);

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1bk");
		await Bun.sleep(0);

		expect(changes).toEqual([{ id: older.id, isPinned: true }]);
		expect(selectedOrder(selector)).toEqual([older.id, recent.id]);
		const rendered = selector.render(120).join("\n");
		expect(rendered).toContain("📌");
		expect(rendered).toContain("Alt+K pin · Alt+Shift+K unpin");

		selector.handleInput("\x1b[A");
		selector.handleInput("\x1bK");
		await Bun.sleep(0);

		expect(changes.at(-1)).toEqual({ id: older.id, isPinned: false });
		expect(selectedOrder(selector)).toEqual([recent.id, older.id]);
	});

	it("honors remapped actions instead of hardcoded picker chords", async () => {
		setKeybindings(
			KeybindingsManager.inMemory({
				"app.session.pin": "ctrl+k",
				"app.session.unpin": "ctrl+u",
			}),
		);
		const session = makeSession("remapped", "2024-01-01T00:00:00Z");
		const changes: boolean[] = [];
		const selector = new SessionSelectorComponent(
			[session],
			() => {},
			() => {},
			() => {},
			{
				onSetPinned: async (_session, isPinned) => {
					changes.push(isPinned);
				},
			},
		);

		selector.handleInput("\x0b");
		await Bun.sleep(0);

		expect(changes).toEqual([true]);
		expect(selector.render(120).join("\n")).toContain("Ctrl+K pin · Ctrl+U unpin");
	});

	it("reorders the all-projects scope immediately after pinning", async () => {
		const local = makeSession("local", "2024-01-04T00:00:00Z");
		const recent = makeSession("remote-recent", "2024-01-03T00:00:00Z");
		const older = makeSession("remote-older", "2024-01-01T00:00:00Z");
		const selector = new SessionSelectorComponent(
			[local],
			() => {},
			() => {},
			() => {},
			{
				allSessions: [recent, older],
				onSetPinned: async () => {},
			},
		);

		selector.handleInput("\t");
		await Bun.sleep(0);
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1bk");
		await Bun.sleep(0);

		expect(selector.render(120).join("\n")).toContain("(all projects)");
		expect(selectedOrder(selector)).toEqual([older.id, recent.id]);
	});

	it("restores recency order when an initially pinned session is unpinned", async () => {
		const recent = makeSession("recent", "2024-01-03T00:00:00Z");
		const older = makeSession("older", "2024-01-01T00:00:00Z");
		const selector = new SessionSelectorComponent(
			[older, recent],
			() => {},
			() => {},
			() => {},
			{
				pinnedIds: new Set([older.id]),
				onSetPinned: async () => {},
			},
		);

		selector.handleInput("\x1bK");
		await Bun.sleep(0);

		expect(selectedOrder(selector)).toEqual([recent.id, older.id]);
	});
});
