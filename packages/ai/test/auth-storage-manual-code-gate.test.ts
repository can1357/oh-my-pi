import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthLoginCallbacks, OAuthProviderInterface } from "@oh-my-pi/pi-ai/registry/oauth/types";

const TEST_SOURCE = "manual-code-gate-test";

// A custom (extension) OAuth provider is, by construction, NOT in
// PASTE_CODE_LOGIN_PROVIDERS (that set is built from the static built-in
// registry's `pasteCodeFlow` flags). It therefore exercises the loopback path:
// AuthStorage.login must NOT synthesize a default manual-code prompt for it.
function registerCapturingLoopbackProvider(id: string): { received: () => OAuthLoginCallbacks | undefined } {
	let captured: OAuthLoginCallbacks | undefined;
	const provider: OAuthProviderInterface = {
		id,
		name: `Capturing ${id}`,
		sourceId: TEST_SOURCE,
		async login(callbacks: OAuthLoginCallbacks) {
			captured = callbacks;
			// Return an empty string so AuthStorage treats it as "no key entered"
			// and skips credential persistence — we only assert the forwarded callbacks.
			return "";
		},
	};
	registerOAuthProvider(provider);
	return { received: () => captured };
}

describe("AuthStorage.login default manual-code prompt gating", () => {
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		storage = new AuthStorage(store);
		await storage.reload();
	});

	afterEach(() => {
		unregisterOAuthProviders(TEST_SOURCE);
		vi.restoreAllMocks();
		store.close();
	});

	it("does NOT synthesize a default manual-code prompt for a loopback provider", async () => {
		const capture = registerCapturingLoopbackProvider("loopback-capture-provider");

		await storage.login("loopback-capture-provider", {
			onAuth: () => {},
			onPrompt: async () => "should-not-be-called",
		});

		const forwarded = capture.received();
		expect(forwarded).toBeDefined();
		// The loopback OAuthCallbackFlow keys its readline-vs-callback race solely on
		// a truthy `onManualCodeInput`; leaving it undefined is what prevents the
		// dangling-prompt regression for normal loopback logins.
		expect(forwarded?.onManualCodeInput).toBeUndefined();
	});

	it("honors an explicit caller-supplied manual-code prompt for a loopback provider (escape hatch)", async () => {
		const capture = registerCapturingLoopbackProvider("loopback-explicit-provider");
		const explicit = async () => "explicit-code";

		await storage.login("loopback-explicit-provider", {
			onAuth: () => {},
			onPrompt: async () => "unused",
			onManualCodeInput: explicit,
		});

		const forwarded = capture.received();
		expect(forwarded?.onManualCodeInput).toBe(explicit);
	});

	it("synthesizes a default manual-code prompt for a paste-code provider when the caller omits one", async () => {
		let authUrl = "";
		let promptMessage = "";
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						access_token: "access-token",
						refresh_token: "refresh-token",
						expires_in: 3600,
						created_at: 1000,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);

		await storage.login("gitlab-duo-agent", {
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				const state = new URL(authUrl).searchParams.get("state");
				return `vscode://gitlab.gitlab-workflow/authentication?code=manual-code&state=${state}`;
			},
			fetch: fetchImpl,
		});

		expect(promptMessage).not.toBe("");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
