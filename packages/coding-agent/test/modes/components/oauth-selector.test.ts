import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import * as authRules from "@oh-my-pi/pi-catalog/compat/auth";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { OAuthSelector, type OAuthSelectorAuthSource } from "../../../src/ui/overlays/pickers/oauth-selector";
import { mountOverlay } from "../../helpers/overlay-terminal";

import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const authStorage = {
	credentials: { has: (_providerId: string) => false },
	keys: { source: (_providerId: string) => undefined },
} as unknown as OAuthSelectorAuthSource;

/**
 * Type `query` into the selector, then press Enter when `confirm`; answers the screen before the
 * Enter and the providers picked.
 */
function search(
	mode: "login" | "logout",
	auth: OAuthSelectorAuthSource,
	query: string,
	options: { confirm?: boolean; disabledProviders?: readonly string[] } = {},
): { rendered: string; selected: string[] } {
	const selected: string[] = [];
	const term = mountOverlay(
		() =>
			OAuthSelector({
				mode,
				auth,
				...(options.disabledProviders ? { disabledProviders: options.disabledProviders } : {}),
				onSelect: providerId => selected.push(providerId),
				onCancel: () => {},
			}),
		{ columns: 80 },
	);
	try {
		term.type(query);
		const rendered = term.screen().join("\n");
		if (options.confirm) term.press("enter");
		return { rendered, selected };
	} finally {
		term.dispose();
	}
}

/** Auth with a stored OpenCode Go key. */
const storedOpencodeGo = {
	credentials: { has: (providerId: string) => providerId === "opencode-go" },
	keys: {
		source: (providerId: string) => (providerId === "opencode-go" ? { kind: "api_key", concrete: true } : undefined),
	},
} as unknown as OAuthSelectorAuthSource;

describe("OAuth selector", () => {
	it("fuzzy-filters overflowing provider lists from typed input", () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(10);
		const target =
			providers.find(provider => provider.available && provider.id === "vllm") ??
			providers.find(provider => provider.available) ??
			providers[0];
		expect(target).toBeDefined();
		if (!target) return;

		const { rendered, selected } = search("login", authStorage, target.id, { confirm: true });
		expect(rendered).toContain(target.name);
		expect(rendered).toContain(target.id);
		expect(selected).toEqual([target.id]);
	});

	it.each([false, true])("groups sign-in methods and labels the linked account (linked=%s)", linked => {
		const subscription = "example-subscription";
		const connectedName = "Example subscription";
		const signInName = "Sign in to Example";
		const keyId = "example-key";
		const keyName = "Example API key";
		const group = { title: "Example", label: "Example (subscription or API key)" };
		const providers: OAuthProviderInfo[] = [
			{ id: keyId, name: keyName, available: true, loginGroup: { ...group, order: 2 } },
			{ id: subscription, name: signInName, available: true, loginGroup: { ...group, order: 1 } },
			...Array.from({ length: 10 }, (_, i) => ({ id: `vendor-${i}`, name: `Vendor ${i}`, available: true })),
		];
		const auth: OAuthSelectorAuthSource = {
			credentials: { has: id => linked && id === subscription },
			keys: {
				source: id => (linked && id === subscription ? { kind: "oauth", concrete: true } : undefined),
			},
		};
		const connected = spyOn(authRules, "providerConnectedName").mockImplementation(id =>
			id === subscription ? connectedName : undefined,
		);
		const selected: string[] = [];
		let cancelled = false;
		const term = mountOverlay(
			() =>
				OAuthSelector({
					mode: "login",
					auth,
					providers,
					onSelect: id => selected.push(id),
					onCancel: () => {
						cancelled = true;
					},
				}),
			{ columns: 80 },
		);
		try {
			term.type(subscription);
			expect(term.screen().join("\n")).toContain(group.label);
			term.press("enter");
			const menu = term.screen().join("\n");
			const label = linked ? connectedName : signInName;
			expect(menu.indexOf(label)).toBeGreaterThanOrEqual(0);
			expect(menu.indexOf(keyName)).toBeGreaterThan(menu.indexOf(label));
			expect(menu.includes("logged in")).toBe(linked);
			expect(selected).toEqual([]);
			term.press("escape");
			expect(cancelled).toBe(false);
			expect(term.screen().join("\n")).toContain(`Search: ${subscription}`);
			term.press("enter");
			term.press("enter");
			term.press("down");
			term.press("enter");
			expect(selected).toEqual([subscription, keyId]);
		} finally {
			term.dispose();
			connected.mockRestore();
		}
	});

	it("does not offer env-only providers as logout targets", () => {
		const auth = {
			credentials: { has: (_providerId: string) => false },
			keys: {
				source: (providerId: string) =>
					providerId === "opencode-go" || providerId === "opencode-zen"
						? { kind: "api_key", concrete: true }
						: undefined,
			},
		} as unknown as OAuthSelectorAuthSource;
		const { rendered, selected } = search("logout", auth, "opencode-go", { confirm: true });
		expect(rendered).toContain("No stored provider credentials to log out");
		expect(selected).toEqual([]);
	});

	it("offers stored providers as logout targets", () => {
		const { rendered, selected } = search("logout", storedOpencodeGo, "opencode-go", { confirm: true });
		expect(rendered).toContain("OpenCode Go");
		expect(rendered).toContain("logged in");
		expect(selected).toEqual(["opencode-go"]);
	});

	describe("disabledProviders", () => {
		afterEach(() => {
			resetSettingsForTest();
		});

		it("hides disabled providers from the login list even when searched", async () => {
			const providers = getOAuthProviders();
			const victim =
				providers.find(provider => provider.available && provider.id === "vllm") ??
				providers.find(provider => provider.available) ??
				providers[0];
			expect(victim).toBeDefined();
			if (!victim) return;

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: [victim.id] } });

			const { rendered } = search("login", authStorage, victim.id, {
				disabledProviders: cfgDisabledProviders.get(settings),
			});
			expect(rendered).not.toContain(victim.name);
		});

		it("hides alias logins whose storeCredentialsAs target is disabled", async () => {
			const alias = getOAuthProviders().find(provider => provider.storeCredentialsAs === "openai-codex");
			expect(alias).toBeDefined();
			if (!alias) return;
			expect(alias.id).not.toBe("openai-codex");

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["openai-codex"] } });

			const { rendered } = search("login", authStorage, alias.id, {
				disabledProviders: cfgDisabledProviders.get(settings),
			});
			expect(rendered).not.toContain(alias.name);
		});

		it("keeps disabled providers as logout targets", async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["opencode-go"] } });

			const { rendered } = search("logout", storedOpencodeGo, "opencode-go", {
				disabledProviders: cfgDisabledProviders.get(settings),
			});
			expect(rendered).toContain("OpenCode Go");
		});
	});
});
