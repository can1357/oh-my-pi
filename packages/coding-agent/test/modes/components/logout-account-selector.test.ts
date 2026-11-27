import { afterAll, describe, expect, it } from "bun:test";
import type { StoredCredentialSummary } from "@oh-my-pi/pi-ai";
import { toLogoutAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";
import { LogoutAccountSelector } from "../../../src/ui/overlays/pickers/logout-account-selector";
import { mountOverlay } from "../../helpers/overlay-terminal";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

describe("logout account selector", () => {
	it("starts on the active stored account and selects that credential", () => {
		const rows: StoredCredentialSummary[] = [
			{
				id: 11,
				provider: "anthropic",
				disabled: false,
				type: "oauth",
				accessOff: false,
				fileUploadAllowed: true,
				email: "a@example.com",
				accountId: "acct-a",
			},
			{
				id: 12,
				provider: "anthropic",
				disabled: false,
				type: "oauth",
				accessOff: false,
				fileUploadAllowed: true,
				email: "b@example.com",
				accountId: "acct-b",
			},
		];
		const accounts = toLogoutAccounts("anthropic", rows, { activeIdentity: { accountId: "acct-b" } });
		const selected: number[] = [];
		const term = mountOverlay(
			() =>
				LogoutAccountSelector({
					provider: "Anthropic",
					accounts,
					onSelect: account => selected.push(account.credentialId),
					onCancel: () => {},
				}),
			{ columns: 100 },
		);
		try {
			const rendered = term.screen().join("\n");
			expect(rendered).toContain("b@example.com (active)");
			expect(rendered.indexOf("b@example.com")).toBeLessThan(rendered.indexOf("a@example.com"));

			term.press("enter");
		} finally {
			term.dispose();
		}

		expect(selected).toEqual([12]);
	});
});
