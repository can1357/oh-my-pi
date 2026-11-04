import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { AuthStorage, isAutoDisabledCredential } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { OAuthSelectorComponent } from "@oh-my-pi/pi-tui/overlays/oauth-selector";
import type { Component } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { StoredAuthCredential } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	listLogoutAccounts,
	logoutCredential,
	toLogoutAccounts,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => vi.restoreAllMocks());

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

	it("lists a failure-disabled login as removable and retires it on logout", async () => {
		await using temp = await TempDir.create("@logout-disabled-");
		const authStorage = await AuthStorage.create(temp.join("auth.db"));
		try {
			await authStorage.credentials.set("anthropic", [
				{
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
					email: "disabled@example.test",
					orgId: "org-disabled",
				},
			]);
			const id = authStorage.credentials.list("anthropic")[0]!.id;
			await authStorage.credentials.disable(id, "oauth refresh failed: invalid_grant");
			const accounts = await listLogoutAccounts(authStorage, "anthropic", "logout-session");
			expect(accounts).toHaveLength(1);
			expect(accounts[0]?.label).toContain("(disabled)");
			expect(accounts).toEqual([
				expect.objectContaining({
					credentialId: id,
					active: false,
					label: expect.stringContaining("disabled@example.test"),
					detail: expect.stringContaining("disabled"),
				}),
			]);
			const registry = new ModelRegistry(authStorage, temp.join("models.yml"));
			vi.spyOn(registry, "refreshProvider").mockResolvedValue(undefined);
			expect((await logoutCredential(registry, "anthropic", id, "logout-session")).removed).toBe(true);
			expect((await authStorage.credentials.listDisabled("anthropic")).some(isAutoDisabledCredential)).toBe(false);
			expect(await listLogoutAccounts(authStorage, "anthropic", "logout-session")).toEqual([]);
		} finally {
			authStorage.close();
		}
	});

	for (const explicitProvider of [true, false]) {
		it(`offers and removes a failure-disabled login through the ${explicitProvider ? "account" : "provider"} selector`, async () => {
			await using temp = await TempDir.create("@logout-selector-disabled-");
			const authStorage = await AuthStorage.create(temp.join("auth.db"));
			try {
				await Settings.init({ inMemory: true });
				await authStorage.credentials.set("anthropic", [
					{
						type: "oauth",
						access: "access",
						refresh: "refresh",
						expires: Date.now() + 60_000,
						email: "disabled@example.test",
					},
				]);
				const id = authStorage.credentials.list("anthropic")[0]!.id;
				await authStorage.credentials.disable(id, "oauth refresh failed: invalid_grant");
				const registry = new ModelRegistry(authStorage, temp.join("models.yml"));
				vi.spyOn(registry, "refreshProvider").mockResolvedValue(undefined);
				vi.spyOn(registry, "getApiKeyForProvider").mockResolvedValue(undefined);
				const completed = Promise.withResolvers<void>();
				const ctx = createInteractiveModeContext({
					session: { modelRegistry: registry, sessionId: "logout-session" },
					present: () => completed.resolve(),
					showError: error => completed.reject(new Error(error)),
				});
				const controller = new SelectorController(ctx);
				const shown: Component[] = [];
				const accountOpened = Promise.withResolvers<void>();
				controller.showSelector = create => {
					const result = create(() => {});
					shown.push(result.component);
					if (result.component instanceof LogoutAccountSelectorComponent) accountOpened.resolve();
				};
				// Keep a failed selector assertion from leaving a rejecting fixture promise behind.
				void completed.promise.catch(() => {});
				await controller.showOAuthSelector("logout", explicitProvider ? "anthropic" : undefined);
				if (!explicitProvider) {
					const provider = shown[0];
					expect(provider).toBeInstanceOf(OAuthSelectorComponent);
					provider!.handleInput?.("anthropic");
					provider!.handleInput?.("\n");
					await accountOpened.promise;
					expect(shown).toHaveLength(2);
				}
				const selector = shown.at(-1);
				expect(selector).toBeInstanceOf(LogoutAccountSelectorComponent);
				expect(selector!.render(100).map(Bun.stripANSI).join("\n")).toContain("(disabled)");
				selector!.handleInput?.("\n");
				await completed.promise;
				expect((await authStorage.credentials.listDisabled("anthropic")).some(isAutoDisabledCredential)).toBe(
					false,
				);
			} finally {
				authStorage.close();
			}
		});
	}
});
