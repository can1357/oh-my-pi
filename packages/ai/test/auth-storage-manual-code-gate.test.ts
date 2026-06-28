import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@pk-nerdsaver-ai/pi-ai/registry/oauth";
import * as gitlabDuoWorkflowOAuth from "@pk-nerdsaver-ai/pi-ai/registry/oauth/gitlab-duo-workflow";
import type { OAuthLoginCallbacks, OAuthProviderInterface } from "@pk-nerdsaver-ai/pi-ai/registry/oauth/types";

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
		// gitlab-duo-agent is a built-in pasteCodeFlow provider (fixed vscode://
		// redirect): the default manual-code prompt is required so the user can paste
		// the callback URL. Spy on the lazily-imported login to capture the callbacks
		// AuthStorage forwards, and have it short-circuit before any network call.
		let forwarded: OAuthLoginCallbacks | undefined;
		const promptText = "PASTE-CODE-DEFAULT-PROMPT-PROBE";
		vi.spyOn(gitlabDuoWorkflowOAuth, "loginGitLabDuoWorkflow").mockImplementation(
			async (callbacks: OAuthLoginCallbacks) => {
				forwarded = callbacks;
				return { access: "access-token", refresh: "refresh-token", expires: Date.now() + 60_000 };
			},
		);

		await storage.login("gitlab-duo-agent", {
			onAuth: () => {},
			onPrompt: async prompt => {
				// The synthesized default routes its prompt through onPrompt; return a
				// sentinel so we can prove the default (not the caller) produced it.
				return `${promptText}:${prompt.message}`;
			},
		});

		expect(forwarded).toBeDefined();
		expect(forwarded?.onManualCodeInput).toBeDefined();
		// Invoking the synthesized default must route through the caller's onPrompt.
		const result = await forwarded?.onManualCodeInput?.();
		expect(result).toContain(promptText);
	});
});
