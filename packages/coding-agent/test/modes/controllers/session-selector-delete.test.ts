import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { SessionSelectorEntry } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/session-selector";
import { initTheme } from "../../../src/ui/theme/service";
import { type MountedSessionSelector, mountSessionSelector, sessionEntry } from "../../helpers/session-selector";

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Resolves once every delete the picker asked for has settled (its reaction runs first). */
async function deletes(onDelete: { mock: { results: { value: unknown }[] } }): Promise<void> {
	await Promise.allSettled(onDelete.mock.results.map(result => result.value));
}

function mount(onDelete: (session: SessionSelectorEntry) => Promise<boolean>): MountedSessionSelector {
	return mountSessionSelector({
		sessions: [
			sessionEntry("session-a", "Alpha", "2024-01-03T00:00:00Z"),
			sessionEntry("session-b", "Beta", "2024-01-02T00:00:00Z"),
		],
		onDelete,
	});
}

/** The delete question replaces the list: titled, naming only the selected session (Alpha). */
function expectAlphaDeleteQuestion(picker: MountedSessionSelector): void {
	const screen = picker.screen();
	expect(screen).toContain("Delete session?");
	expect(screen).toContain("Alpha");
	expect(screen).not.toContain("Beta");
}

describe("session picker delete confirmation", () => {
	it("keeps the session visible and shows the error when delete fails after confirmation", async () => {
		const onDelete = vi.fn(async () => {
			throw new Error("disk failed");
		});
		const picker = mount(onDelete);

		picker.press("delete");
		expectAlphaDeleteQuestion(picker);

		picker.press("enter");
		await deletes(onDelete);

		const screen = picker.screen();
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(screen).toContain("Error: disk failed");
		expect(screen).toContain("Alpha");
		expect(screen).toContain("Beta");
		expect(screen).not.toContain("Delete session?");
	});

	it("keeps the session visible when delete is canceled upstream", async () => {
		const onDelete = vi.fn(async () => false);
		const picker = mount(onDelete);

		picker.press("delete", "enter");
		await deletes(onDelete);

		const screen = picker.screen();
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(screen).toContain("Alpha");
		expect(screen).toContain("Beta");
		expect(screen).not.toContain("Error:");
	});

	it("removes the session row after a successful delete", async () => {
		const onDelete = vi.fn(async () => true);
		const picker = mount(onDelete);

		picker.press("delete", "enter");
		await deletes(onDelete);

		const screen = picker.screen();
		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(screen).not.toContain("Alpha");
		expect(screen).toContain("Beta");
	});

	it("Backspace on an empty search query asks to delete the session (macOS Fn+Backspace)", async () => {
		const onDelete = vi.fn(async () => true);
		const picker = mount(onDelete);

		picker.press("backspace");
		expectAlphaDeleteQuestion(picker);

		picker.press("enter");
		await deletes(onDelete);

		expect(onDelete).toHaveBeenCalledTimes(1);
		expect(picker.screen()).not.toContain("Alpha");
		expect(picker.screen()).toContain("Beta");
	});

	it("Backspace with a non-empty search query edits the query, not the session", async () => {
		const onDelete = vi.fn(async () => true);
		const picker = mount(onDelete);

		picker.press(..."alpha");
		expect(picker.screen()).toContain("alpha");

		picker.press("backspace");
		await deletes(onDelete);

		const screen = picker.screen();
		expect(onDelete).not.toHaveBeenCalled();
		expect(screen).not.toContain("Delete session?");
		expect(screen).toContain("alph");
		expect(screen).not.toContain("alpha");
	});
});
