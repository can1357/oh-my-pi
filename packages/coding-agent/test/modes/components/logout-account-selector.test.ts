import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as registry from "@oh-my-pi/pi-ai/registry";
import * as authRules from "@oh-my-pi/pi-catalog/compat/auth";
import type { LogoutAccount } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/logout-account-selector";
import { AuthStorage, type StoredAuthCredential } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { logoutCredential, toLogoutAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";
import { bubbleEvent, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { LogoutAccountSelector } from "../../../src/ui/overlays/pickers/logout-account-selector";
import { findKind, mountOverlay } from "../../helpers/overlay-terminal";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const PROVIDER = "anthropic";
const CONNECTIONS = "https://accounts.example.com/connections";
const DISCONNECT_LABEL = "Disconnect account at host";
const MANAGE_LABEL = "Manage connections";
const storedAccount = (id: number, email: string): StoredAuthCredential => ({
	id,
	provider: PROVIDER,
	disabledCause: null,
	credential: {
		type: "oauth",
		access: "synthetic-access",
		refresh: `synthetic-refresh-${id}`,
		expires: Date.now() + 60_000,
		email,
		accountId: `internal-account-${id}`,
	},
});

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
					onOpenConnection: () => {},
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

	it("shows the connected email and routes both native actions and terminal shortcuts separately", () => {
		const policy = spyOn(authRules, "authPolicyFor").mockReturnValue({
			id: PROVIDER,
			name: "Example subscription",
			apiKeyFormat: "bearer",
			signOut: { hook: "example", label: DISCONNECT_LABEL },
			manageUrl: CONNECTIONS,
			manageLabel: MANAGE_LABEL,
		});
		let accounts: LogoutAccount[];
		try {
			accounts = toLogoutAccounts(PROVIDER, [storedAccount(77, "me@example.com")]);
		} finally {
			policy.mockRestore();
		}
		const actions: string[] = [];
		const links: string[] = [];
		const term = mountOverlay(() =>
			LogoutAccountSelector({
				provider: "Example subscription",
				accounts,
				onSelect: (account, action) => actions.push(`${account.credentialId}:${action}`),
				onOpenConnection: url => links.push(url),
				onCancel: () => {},
			}),
		);
		try {
			const rendered = term.screen().join("\n");
			expect(rendered).toContain("me@example.com  Connected");
			expect(rendered).toContain("Sign out on this device");
			expect(rendered).toContain(DISCONNECT_LABEL);
			expect(rendered).toContain(MANAGE_LABEL);
			expect(rendered).toContain(CONNECTIONS);
			expect(rendered).not.toMatch(/internal-account|77|oauth/i);
			term.press("enter");
			term.press("f5");
			term.press("f6");

			const layers = term.surface.layer();
			const picker = findKind(layers[0]!, "picker")!;
			const native = picker.props() as TspPickerProps;
			expect(native.items).toEqual([{ id: "77", label: "me@example.com", detail: "Connected" }]);
			expect(native.actions?.map(action => action.label)).toEqual([
				"Sign out on this device",
				DISCONNECT_LABEL,
				MANAGE_LABEL,
				"Close",
			]);
			const path = pathTo(layers, picker);
			for (const act of ["confirm", "disconnect", "manage"]) {
				bubbleEvent(path, { type: "action", key: "picker", act, mods: [] });
			}
		} finally {
			term.dispose();
		}

		expect(actions).toEqual(["77:sign-out-local", "77:disconnect", "77:sign-out-local", "77:disconnect"]);
		expect(links).toEqual([CONNECTIONS, CONNECTIONS]);
	});

	it("signs out locally without revoking, but disconnect attempts revocation before removing the account", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		const revoked: string[] = [];
		const original = registry.getProviderDefinition;
		const provider = spyOn(registry, "getProviderDefinition").mockImplementation(id => {
			const definition = original(id);
			if (id !== PROVIDER || !definition) return definition;
			return {
				...definition,
				signOut: async credential => {
					revoked.push(credential.refresh);
					throw new Error("The host did not confirm revocation");
				},
			};
		});
		try {
			await authStorage.credentials.upsert(PROVIDER, storedAccount(1, "first@example.com").credential);
			await authStorage.credentials.upsert(PROVIDER, storedAccount(2, "second@example.com").credential);
			const rows = authStorage.credentials.list(PROVIDER);
			const first = rows.find(
				row => row.credential.type === "oauth" && row.credential.email === "first@example.com",
			)!;
			const second = rows.find(row => row.id !== first.id)!;
			const session = {
				modelRegistry: { authStorage, refreshProvider: async () => {} },
				sessionId: "logout-test",
				refreshScopedModels: async () => {},
			};

			expect(await logoutCredential(session, PROVIDER, first.id, "sign-out-local")).toMatchObject({ removed: true });
			expect(await logoutCredential(session, PROVIDER, first.id, "disconnect")).toEqual({ removed: false });
			expect(revoked).toEqual([]);
			expect(authStorage.credentials.list(PROVIDER).map(row => row.id)).toEqual([second.id]);

			expect(await logoutCredential(session, PROVIDER, second.id, "disconnect")).toEqual({
				removed: true,
				signOutError: "The host did not confirm revocation",
			});
			expect(revoked).toEqual(["synthetic-refresh-2"]);
			expect(authStorage.credentials.list(PROVIDER)).toEqual([]);
		} finally {
			provider.mockRestore();
			authStorage.close();
		}
	});
});
