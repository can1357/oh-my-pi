import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createSession(id: string, title: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 0,
		firstMessage: `${title} first message`,
		allMessagesText: `${title} first message`,
	};
}

function createSelector(onDelete: (session: SessionInfo) => Promise<boolean>): SessionSelectorComponent {
	return new SessionSelectorComponent(
		[createSession("session-a", "Alpha"), createSession("session-b", "Beta")],
		() => {},
		() => {},
		() => {},
		{ onDelete },
	);
}

function renderText(selector: SessionSelectorComponent): string {
	return selector.render(120).join("\n");
}

describe("SessionSelectorComponent delete confirmation", () => {
	it("keeps the session visible and shows the error when delete fails after confirmation", async () => {
		const onDelete = vi.fn(async () => {
			throw new Error("disk failed");
		});
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		expect(renderText(selector)).toContain("Delete session?");
		expect(renderText(selector)).toContain("Alpha");

		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).toContain("Error: disk failed");
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("Beta");
		expect(rendered).not.toContain("Delete session?");
	});

	it("keeps the session visible when delete is canceled upstream", async () => {
		const onDelete = vi.fn(async () => false);
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("Beta");
		expect(rendered).not.toContain("Error:");
	});

	it("removes the session row after a successful delete", async () => {
		const onDelete = vi.fn(async () => true);
		const selector = createSelector(onDelete);

		selector.handleInput("\x1b[3~");
		selector.handleInput("\n");
		await Bun.sleep(0);

		const rendered = renderText(selector);
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(rendered).not.toContain("Alpha");
		expect(rendered).toContain("Beta");
	});

	it("Backspace on an empty search query triggers delete confirmation (macOS Fn+Backspace sends \\x7f)", async () => {
		const onDelete = vi.fn(async () => true);
		const selector = createSelector(onDelete);

		// No search query typed yet — Backspace should mean "delete session",
		// not "edit the (empty) search box".
		selector.handleInput("\x7f");
		expect(renderText(selector)).toContain("Delete session?");
		expect(renderText(selector)).toContain("Alpha");

		// Confirm.
		selector.handleInput("\n");
		await Bun.sleep(0);

		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(renderText(selector)).not.toContain("Alpha");
		expect(renderText(selector)).toContain("Beta");
	});

	it("Backspace with a non-empty search query edits the query, not the session", async () => {
		const onDelete = vi.fn(async () => true);
		const selector = createSelector(onDelete);

		// Type a query, then Backspace — must delete a query char, NOT a session.
		selector.handleInput("alpha");
		const beforeBackspace = renderText(selector);
		expect(beforeBackspace).toContain("alpha");

		selector.handleInput("\x7f");
		await Bun.sleep(0);

		const afterBackspace = renderText(selector);
		// Deletion did not fire.
		expect(onDelete).not.toHaveBeenCalled();
		expect(afterBackspace).not.toContain("Delete session?");
		// The query was actually edited: "alpha" lost its trailing "a".
		expect(afterBackspace).toContain("alph");
		expect(afterBackspace).not.toContain("alpha");
	});
});
