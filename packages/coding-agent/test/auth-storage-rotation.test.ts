import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type OAuthCredential, type UsageProvider, withAuth } from "@oh-my-pi/pi-ai";
import * as oauth from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createApiKeyResolver } from "../src/config/api-key-resolver";

describe("AuthStorage account rotation", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let usageExhausted = false;

	const stickyInvalidationSource = "auth-storage-rotation-issue-4982";
	const targetProvider = "issue-4982-target" as OAuthProviderId;
	const unrelatedProvider = "issue-4982-unrelated" as OAuthProviderId;
	let nextLoginCredential: OAuthCredentials | undefined;

	const findSessionWhereFreshSelectionChanges = async (
		provider: string,
		initialCredentials: OAuthCredential[],
		finalCredentials: OAuthCredential[],
	): Promise<{ sessionId: string; stickyKey: string; freshKey: string }> => {
		const control = await AuthStorage.create(":memory:", {
			usageProviderResolver: () => undefined,
		});
		try {
			await control.set(provider, finalCredentials);
			await authStorage.set(provider, initialCredentials);

			for (let attempt = 0; attempt < 128; attempt += 1) {
				const sessionId = `issue-4982-session-${attempt}`;
				const stickyKey = await authStorage.getApiKey(provider, sessionId);
				const freshKey = await control.getApiKey(provider, sessionId);
				if (stickyKey && freshKey && stickyKey !== freshKey) {
					return { sessionId, stickyKey, freshKey };
				}
			}
		} finally {
			control.close();
		}

		throw new Error("expected at least one session whose fresh credential selection changes after login");
	};
	const usageProvider: UsageProvider = {
		id: "openai-codex",
		async fetchUsage(params) {
			const accountId = params.credential.accountId ?? "unknown";
			return {
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [
					{
						id: `requests-${accountId}`,
						label: "Requests",
						scope: { provider: "openai-codex", accountId },
						amount: { unit: "requests", used: usageExhausted ? 100 : 10, limit: 100 },
						status: usageExhausted ? "exhausted" : "ok",
					},
				],
			};
		},
	};
	const createRotationStorage = (dbPath: string) =>
		AuthStorage.create(dbPath, {
			usageProviderResolver: provider => (provider === "openai-codex" ? usageProvider : undefined),
		});

	beforeEach(async () => {
		tempDir = "";
		usageExhausted = false;
		nextLoginCredential = undefined;
		for (const provider of [targetProvider, unrelatedProvider]) {
			oauth.registerOAuthProvider({
				id: provider,
				name: provider,
				sourceId: stickyInvalidationSource,
				async login() {
					if (!nextLoginCredential) {
						throw new Error(`missing queued OAuth credential for ${provider}`);
					}
					return nextLoginCredential;
				},
			});
		}

		authStorage = await createRotationStorage(":memory:");

		// Stub the refresh path so AuthStorage doesn't hit a real OAuth endpoint
		// when the credential lands inside the 60s skew. Returning the credential
		// unchanged preserves deterministic access-token routing.
		vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			return credential;
		});
		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["openai-codex"] as OAuthCredentials | undefined;
			if (!credential) return null;
			return {
				apiKey: credential.access,
				newCredentials: credential,
			};
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		oauth.unregisterOAuthProviders(stickyInvalidationSource);
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("returns a fallback key when every OAuth account is usage-limited", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 60_000,
				accountId: "acct-1",
			},
			{
				type: "oauth",
				access: "access-2",
				refresh: "refresh-2",
				expires: Date.now() + 60_000,
				accountId: "acct-2",
			},
		]);

		const sessionId = "issue-55-session";
		const firstKey = await authStorage.getApiKey("openai-codex", sessionId);
		expect(firstKey).toMatch(/^access-/);

		usageExhausted = true;
		const { switched } = await authStorage.markUsageLimitReached("openai-codex", sessionId);
		expect(switched).toBe(true);

		const exhaustedFallbackKey = await authStorage.getApiKey("openai-codex", sessionId);
		expect(exhaustedFallbackKey).toMatch(/^access-/);
	});

	test("usage-limit rotation can match the failed bearer when session stickiness is missing", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 60_000,
				accountId: "acct-1",
			},
			{
				type: "oauth",
				access: "access-2",
				refresh: "refresh-2",
				expires: Date.now() + 60_000,
				accountId: "acct-2",
			},
		]);

		const sessionId = "missing-sticky-session";
		const result = await authStorage.markUsageLimitReached("openai-codex", sessionId, { apiKey: "access-1" });
		expect(result.switched).toBe(true);
		expect(await authStorage.getApiKey("openai-codex", sessionId)).toBe("access-2");
	});

	test("usage-limit rotation trusts the failed bearer over stale session stickiness", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "plus-access",
				refresh: "plus-refresh",
				expires: Date.now() + 60_000,
				accountId: "plus-acct",
			},
			{
				type: "oauth",
				access: "k12-access",
				refresh: "k12-refresh",
				expires: Date.now() + 60_000,
				accountId: "k12-acct",
			},
		]);

		const sessionId = "stale-sticky-session";
		const stickyKey = await authStorage.getApiKey("openai-codex", sessionId);
		const failedKey = stickyKey === "plus-access" ? "k12-access" : "plus-access";
		const result = await authStorage.markUsageLimitReached("openai-codex", sessionId, { apiKey: failedKey });
		expect(result.switched).toBe(true);
		expect(await authStorage.getApiKey("openai-codex", sessionId)).toBe(stickyKey);
	});

	test("API key resolver re-resolves after a concurrent OAuth refresh makes a 401 bearer stale", async () => {
		const resolvedKeys = ["stale-access", "refreshed-access"];
		const rotationTargets: Array<string | undefined> = [];
		const registry: Parameters<typeof createApiKeyResolver>[0] = {
			async getApiKeyForProvider() {
				return resolvedKeys.shift();
			},
			authStorage: {
				async rotateSessionCredential(_provider, _sessionId, options) {
					rotationTargets.push(options?.apiKey);
					return false;
				},
			},
		};
		const resolver = createApiKeyResolver(registry, "openai-codex", {
			sessionId: "concurrent-oauth-refresh",
		});

		const initial = await resolver({ lastChance: false, error: undefined });
		const refreshed = await resolver({
			lastChance: true,
			error: Object.assign(new Error("401 authentication_error"), { status: 401 }),
			previousKey: initial,
		});

		expect(initial).toBe("stale-access");
		expect(refreshed).toBe("refreshed-access");
		expect(rotationTargets).toEqual(["stale-access"]);
	});

	test("API key resolver stops when a usage-limit rotation has no unblocked sibling", async () => {
		const resolvedKeys = ["quota-blocked-B", "quota-blocked-A"];
		const registry: Parameters<typeof createApiKeyResolver>[0] = {
			async getApiKeyForProvider() {
				return resolvedKeys.shift();
			},
			authStorage: {
				async rotateSessionCredential() {
					return false;
				},
			},
		};
		const attemptedKeys: string[] = [];

		await expect(
			withAuth(createApiKeyResolver(registry, "openai-codex"), async key => {
				attemptedKeys.push(key);
				throw Object.assign(new Error("You have hit your ChatGPT usage limit (pro plan). Try again later."), {
					status: 429,
				});
			}),
		).rejects.toThrow("usage limit");

		expect(attemptedKeys).toEqual(["quota-blocked-B"]);
		expect(resolvedKeys).toEqual(["quota-blocked-A"]);
	});

	test("withAuth reaches a fourth healthy Codex OAuth sibling through ModelRegistry", async () => {
		await authStorage.set("openai-codex", [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 60_000,
				accountId: "acct-a",
			},
			{
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 60_000,
				accountId: "acct-b",
			},
			{
				type: "oauth",
				access: "access-c",
				refresh: "refresh-c",
				expires: Date.now() + 60_000,
				accountId: "acct-c",
			},
			{
				type: "oauth",
				access: "access-d",
				refresh: "refresh-d",
				expires: Date.now() + 60_000,
				accountId: "acct-d",
			},
		]);

		const model = getBundledModel("openai-codex", "gpt-5.5");
		if (!model) {
			throw new Error("Expected bundled Codex test model to exist");
		}

		const modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		const attemptedKeys: string[] = [];
		const result = await withAuth(modelRegistry.resolver(model, "codex-four-oauth-session"), async key => {
			attemptedKeys.push(key);
			if (key !== "access-d") {
				throw new Error("You have hit your ChatGPT usage limit (pro plan). Try again later.");
			}
			return key;
		});

		expect(result).toBe("access-d");
		expect(attemptedKeys.at(-1)).toBe("access-d");
		expect([...attemptedKeys].sort()).toEqual(["access-a", "access-b", "access-c", "access-d"]);
		expect(new Set(attemptedKeys).size).toBe(4);
	});

	test("provider login invalidates only that provider's persisted session stickiness", async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-auth-rotation-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage.close();
		authStorage = await createRotationStorage(path.join(tempDir, "testauth.db"));
		const targetInitialCredentials: OAuthCredential[] = [
			{
				type: "oauth",
				access: "target-access-a",
				refresh: "target-refresh-a",
				expires: Date.now() + 3600_000,
				accountId: "target-acct-a",
				email: "target-a@example.com",
			},
			{
				type: "oauth",
				access: "target-access-b",
				refresh: "target-refresh-b",
				expires: Date.now() + 3600_000,
				accountId: "target-acct-b",
				email: "target-b@example.com",
			},
		];
		const targetAddedCredential: OAuthCredential = {
			type: "oauth",
			access: "target-access-c",
			refresh: "target-refresh-c",
			expires: Date.now() + 3600_000,
			accountId: "target-acct-c",
			email: "target-c@example.com",
		};
		const targetFinalCredentials = [...targetInitialCredentials, targetAddedCredential];
		const { sessionId, stickyKey, freshKey } = await findSessionWhereFreshSelectionChanges(
			targetProvider,
			targetInitialCredentials,
			targetFinalCredentials,
		);

		await authStorage.set(unrelatedProvider, [
			{
				type: "oauth",
				access: "unrelated-access-a",
				refresh: "unrelated-refresh-a",
				expires: Date.now() + 3600_000,
				accountId: "unrelated-acct-a",
				email: "unrelated-a@example.com",
			},
			{
				type: "oauth",
				access: "unrelated-access-b",
				refresh: "unrelated-refresh-b",
				expires: Date.now() + 3600_000,
				accountId: "unrelated-acct-b",
				email: "unrelated-b@example.com",
			},
		]);
		const unrelatedSessionId = "issue-4982-unrelated-session";
		const unrelatedStickyKey = await authStorage.getApiKey(unrelatedProvider, unrelatedSessionId);
		expect(unrelatedStickyKey).toMatch(/^unrelated-access-/);

		const { type: _type, ...loginCredential } = targetAddedCredential;
		nextLoginCredential = loginCredential;
		await authStorage.login(targetProvider, {
			onAuth: () => {},
			onPrompt: async () => "",
		});
		nextLoginCredential = undefined;

		authStorage.close();
		authStorage = await createRotationStorage(path.join(tempDir, "testauth.db"));
		await authStorage.reload();

		const reloadedTargetKey = await authStorage.getApiKey(targetProvider, sessionId);
		expect(reloadedTargetKey).toBe(freshKey);
		expect(reloadedTargetKey).not.toBe(stickyKey);
		expect(await authStorage.getApiKey(unrelatedProvider, unrelatedSessionId)).toBe(unrelatedStickyKey);
	});
});
