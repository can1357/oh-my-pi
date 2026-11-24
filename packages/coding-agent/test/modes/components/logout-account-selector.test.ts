import { afterAll, describe, expect, it } from "bun:test";
import type { StoredAuthCredential } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { toLogoutAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";
import { LogoutAccountSelector } from "../../../src/ui/overlays/pickers/logout-account-selector";
import { mountOverlay } from "../../helpers/overlay-terminal";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

describe("logout account selector", () => {
	it("starts on the active stored account and selects that credential", () => {
		const rows: StoredAuthCredential[] = [
			{
				id: 11,
				provider: "anthropic",
				disabledCause: null,
				credential: {
					type: "oauth",
					access: "access-a",
					refresh: "refresh-a",
					expires: Date.now() + 60_000,
					email: "a@example.com",
					accountId: "acct-a",
				},
			},
			{
				id: 12,
				provider: "anthropic",
				disabledCause: null,
				credential: {
					type: "oauth",
					access: "access-b",
					refresh: "refresh-b",
					expires: Date.now() + 60_000,
					email: "b@example.com",
					accountId: "acct-b",
				},
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
