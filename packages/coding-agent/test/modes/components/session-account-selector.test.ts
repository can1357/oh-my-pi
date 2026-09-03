import { beforeAll, describe, expect, it } from "bun:test";
import { SessionAccountSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-account-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { toSessionPinAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/session-pin";

beforeAll(async () => {
	await initTheme();
});

const accounts = toSessionPinAccounts([
	{ position: 0, credentialId: 11, email: "first@example.com", active: false },
	{ position: 1, credentialId: 12, email: "second@example.com", active: true },
]);

describe("SessionAccountSelectorComponent", () => {
	it("handles navigation, selection, Escape, and Ctrl+C while focused", () => {
		const selected: number[] = [];
		let cancellations = 0;
		const component = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			account => selected.push(account.credentialId),
			() => {
				cancellations += 1;
			},
		);

		component.handleInput("\x1b[A");
		component.handleInput("\n");
		expect(selected).toEqual([11]);

		const escapeComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			() => {},
			() => {
				cancellations += 1;
			},
		);
		escapeComponent.handleInput("\x1b");

		const ctrlCComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			() => {},
			() => {
				cancellations += 1;
			},
		);
		ctrlCComponent.handleInput("\x03");
		expect(cancellations).toBe(2);
	});
});
