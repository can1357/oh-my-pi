import { beforeAll, describe, expect, it } from "bun:test";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/logout-account-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { StoredAuthCredential } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { toLogoutAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";

beforeAll(async () => {
	await initTheme();
});

describe("LogoutAccountSelectorComponent", () => {
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
		const component = new LogoutAccountSelectorComponent(
			"Anthropic",
			accounts,
			account => selected.push(account.credentialId),
			() => {},
		);

		const rendered = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("b@example.com (active)");
		expect(rendered.indexOf("b@example.com")).toBeLessThan(rendered.indexOf("a@example.com"));

		component.handleInput("\n");

		expect(selected).toEqual([12]);
	});
});
