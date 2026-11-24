import { afterAll, describe, expect, it } from "bun:test";
import { toSessionPinAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/session-pin";
import { SessionAccountSelector } from "../../../src/ui/overlays/pickers/session-account-selector";
import { mountOverlay } from "../../helpers/overlay-terminal";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const accounts = toSessionPinAccounts([
	{ position: 0, credentialId: 11, email: "first@example.com", active: false },
	{ position: 1, credentialId: 12, email: "second@example.com", active: true },
]);

describe("session account selector", () => {
	it("handles navigation, selection, Escape, and Ctrl+C while focused", () => {
		const selected: number[] = [];
		let cancellations = 0;
		const open = () =>
			mountOverlay(() =>
				SessionAccountSelector({
					provider: "Anthropic",
					accounts,
					onSelect: account => selected.push(account.credentialId),
					onCancel: () => cancellations++,
				}),
			);

		const picker = open();
		picker.press("up");
		picker.press("enter");
		picker.dispose();
		expect(selected).toEqual([11]);

		const escape = open();
		escape.press("escape");
		escape.dispose();
		const ctrlC = open();
		ctrlC.press("ctrl+c");
		ctrlC.dispose();
		expect(cancellations).toBe(2);
	});

	it("lists paused accounts after pinnable ones and never pins them", () => {
		const [first, second] = accounts;
		const selected: number[] = [];
		const pausedPicks: number[] = [];
		const picker = mountOverlay(() =>
			SessionAccountSelector({
				provider: "Anthropic",
				accounts: [second!],
				paused: [{ account: first!, resume: "first@example.com" }],
				onSelect: account => selected.push(account.credentialId),
				onPausedPick: account => pausedPicks.push(account.credentialId),
				onCancel: () => {},
			}),
		);

		expect(picker.screen().join("\n")).toContain("paused — /usage resume first@example.com");
		picker.press("down");
		picker.press("enter");
		picker.dispose();

		expect(selected).toEqual([]);
		expect(pausedPicks).toEqual([11]);
	});
});
