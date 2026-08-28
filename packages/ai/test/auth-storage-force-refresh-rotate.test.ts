import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withAuth } from "@oh-my-pi/pi-ai";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { CredentialRankingStrategy, UsageProvider } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-rotate-oauth";
const SOURCE = "auth-storage-force-refresh-rotate-test";

const CODEX_PROVIDER = "openai-codex";
const DAYBREAK_MODEL = "gpt-daybreak-blue-latest";
const CODEX_CHATGPT_MODEL_DENIAL =
	"The 'gpt-daybreak-blue-latest' model is not supported when using Codex with a ChatGPT account. (code=invalid_request_error)";
const CURSOR_PROVIDER = "cursor";
const CURSOR_MODEL = "cursor-grok-4.6";
const CURSOR_PLAN_DENIAL =
	'Connect error resource_exhausted: Error [details: {"error":"ERROR_RATE_LIMITED_CHANGEABLE","details":{"title":"Named models unavailable","detail":"Free plans can only use Auto."}}]';
function farExpiry(): number {
	return Date.now() + 60 * 60_000;
}

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 authentication_error"), { status: 401 });
}

function usageLimitError(): Error & { status: number } {
	return Object.assign(new Error("You have hit your ChatGPT usage limit (pro plan). Try again in ~158 min."), {
		status: 429,
	});
}

function quotaPayloadError(message: string, status?: number): Error & { status?: number } {
	return status === undefined ? new Error(message) : Object.assign(new Error(message), { status });
}

function invalidRequestError(): Error & { status: number } {
	return Object.assign(new Error("400 invalid_request_error: model unsupported"), { status: 400 });
}

describe("AuthStorage forceRefresh + rotateSessionCredential", () => {
	let tempDir = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-rotate-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		unregisterOAuthProviders(SOURCE);
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	function registerProvider(onRefresh?: () => void, nextAccess?: () => string): void {
		registerOAuthProvider({
			id: PROVIDER,
			name: "Rotate Unit",
			sourceId: SOURCE,
			async login() {
				return { access: "login", refresh: "login", expires: farExpiry() };
			},
			async refreshToken(credentials) {
				onRefresh?.();
				return {
					...credentials,
					access: nextAccess?.() ?? "minted-access",
					refresh: "minted-refresh",
					expires: farExpiry(),
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
	}

	test("forceRefresh re-mints a not-yet-expired token; a normal resolve uses the cached token", async () => {
		if (!authStorage) throw new Error("test setup failed");
		let refreshCalls = 0;
		registerProvider(() => {
			refreshCalls += 1;
		});
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "cached-access", refresh: "cached-refresh", expires: farExpiry() },
		]);

		const cached = await authStorage.getApiKey(PROVIDER, "s-control");
		expect(cached).toBe("cached-access");
		expect(refreshCalls).toBe(0);

		const forced = await authStorage.getApiKey(PROVIDER, "s-force", { forceRefresh: true });
		expect(forced).toBe("minted-access");
		expect(refreshCalls).toBe(1);

		// The re-minted credential is persisted, so the next plain resolve sees it.
		const after = await authStorage.getApiKey(PROVIDER, "s-after");
		expect(after).toBe("minted-access");
	});

	test("getOAuthAccess includes a stable credentialId across cached and forced refresh resolves", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "cached-access", refresh: "cached-refresh", expires: farExpiry() },
		]);

		const cached = await authStorage.getOAuthAccess(PROVIDER, "oauth-identity");
		expect(cached?.accessToken).toBe("cached-access");
		expect(typeof cached?.credentialId).toBe("number");
		const credentialId = cached?.credentialId;
		if (credentialId === undefined) throw new Error("expected OAuth credential id");

		const forced = await authStorage.getOAuthAccess(PROVIDER, "oauth-identity", { forceRefresh: true });
		expect(forced?.accessToken).toBe("minted-access");
		expect(forced?.credentialId).toBe(credentialId);

		const after = await authStorage.getOAuthAccess(PROVIDER, "oauth-identity");
		expect(after?.accessToken).toBe("minted-access");
		expect(after?.credentialId).toBe(credentialId);
	});

	test("rotateSessionCredential(401) blocks + clears the sticky and rotates to a sibling", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const first = await authStorage.getApiKey(PROVIDER, "sess");
		expect(["acc-A", "acc-B"]).toContain(first ?? "");

		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");
		const rotated = await authStorage.rotateSessionCredential(PROVIDER, "sess", { error: authError() });

		expect(rotated).toBe(true);
		// A hard 401 must NOT take the usage-limit code path.
		expect(usageLimitSpy).not.toHaveBeenCalled();

		const second = await authStorage.getApiKey(PROVIDER, "sess");
		expect(["acc-A", "acc-B"]).toContain(second ?? "");
		expect(second).not.toBe(first);
	});

	test("resolver rotates the credential matching previousKey instead of a stale sticky", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{ type: "api_key", key: "sticky-key" },
			{ type: "api_key", key: "failed-key" },
			{ type: "api_key", key: "survivor-key" },
		]);

		const sessionId = "resolver-previous-key";
		const sticky = await authStorage.getApiKey(PROVIDER, sessionId);
		if (!sticky) throw new Error("expected initial sticky credential");
		const failed = sticky === "failed-key" ? "sticky-key" : "failed-key";
		const resolver = authStorage.resolver(PROVIDER, { sessionId });

		const retry = await resolver({
			lastChance: true,
			error: authError(),
			previousKey: failed,
		});

		expect(retry).toBe(sticky);
		expect(retry).not.toBe(failed);

		const laterSelections = new Set<string>();
		for (let index = 0; index < 6; index += 1) {
			const selected = await authStorage.getApiKey(PROVIDER);
			if (selected) laterSelections.add(selected);
		}
		expect(laterSelections.has(failed)).toBe(false);
		expect(laterSelections.has(sticky)).toBe(true);
	});

	test("resolver rotates away from the account matching a stale OAuth bearer", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "stale-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "stale-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const sessionId = "resolver-concurrent-refresh";
		const previousKey = await authStorage.getApiKey(PROVIDER, sessionId);
		if (!previousKey) throw new Error("expected initial OAuth bearer");
		const rows = store.listAuthCredentials(PROVIDER);
		const target = rows.find(row => row.credential.type === "oauth" && row.credential.access === previousKey);
		const sibling = rows.find(row => row.id !== target?.id);
		if (target?.credential.type !== "oauth" || sibling?.credential.type !== "oauth") {
			throw new Error("expected target and sibling OAuth rows");
		}
		store.updateAuthCredential(target.id, {
			...target.credential,
			access: `${previousKey}-refreshed`,
		});
		await authStorage.reload();

		const retry = await authStorage.resolver(PROVIDER, { sessionId })({
			lastChance: true,
			error: usageLimitError(),
			previousKey,
		});

		expect(retry).toBe(sibling.credential.access);
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe(sibling.credential.access);
	});

	test("resolver re-resolves a peer-refreshed OAuth bearer after a stale 401", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "auth-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "auth-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const sessionId = "resolver-stale-auth";
		const previousKey = await authStorage.getApiKey(PROVIDER, sessionId);
		if (!previousKey) throw new Error("expected initial OAuth bearer");
		const target = store
			.listAuthCredentials(PROVIDER)
			.find(row => row.credential.type === "oauth" && row.credential.access === previousKey);
		if (target?.credential.type !== "oauth") throw new Error("expected failed OAuth credential row");
		const refreshedKey = `${previousKey}-refreshed`;
		store.updateAuthCredential(target.id, { ...target.credential, access: refreshedKey });
		await authStorage.reload();

		const retry = await authStorage.resolver(PROVIDER, { sessionId })({
			lastChance: true,
			error: authError(),
			previousKey,
		});

		expect(retry).toBe(refreshedKey);
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe(refreshedKey);
		expect(
			store
				.listAuthCredentials(PROVIDER)
				.some(
					row => row.id === target.id && row.credential.type === "oauth" && row.credential.access === refreshedKey,
				),
		).toBe(true);
	});

	test("resolver stops when a usage-limit rotation has no unblocked sibling", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const getApiKey = vi
			.spyOn(authStorage, "getApiKey")
			.mockResolvedValueOnce("quota-blocked-B")
			.mockResolvedValueOnce("quota-blocked-A");
		const rotate = vi.spyOn(authStorage, "rotateSessionCredential").mockResolvedValue(false);
		const attemptedKeys: string[] = [];

		await expect(
			withAuth(authStorage.resolver(PROVIDER, { sessionId: "all-quota-blocked" }), async key => {
				attemptedKeys.push(key);
				throw usageLimitError();
			}),
		).rejects.toThrow("usage limit");

		expect(attemptedKeys).toEqual(["quota-blocked-B"]);
		expect(getApiKey).toHaveBeenCalledTimes(1);
		expect(rotate).toHaveBeenCalledTimes(1);
	});

	test("usage marking keeps a stale OAuth bearer bound to its original row", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "quota-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "quota-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const sessionId = "usage-concurrent-refresh";
		const previousKey = await authStorage.getApiKey(PROVIDER, sessionId);
		if (!previousKey) throw new Error("expected initial OAuth bearer");
		const rows = store.listAuthCredentials(PROVIDER);
		const target = rows.find(row => row.credential.type === "oauth" && row.credential.access === previousKey);
		const sibling = rows.find(row => row.id !== target?.id);
		if (target?.credential.type !== "oauth" || sibling?.credential.type !== "oauth") {
			throw new Error("expected target and sibling OAuth rows");
		}
		store.updateAuthCredential(target.id, {
			...target.credential,
			access: `${previousKey}-refreshed`,
		});
		await authStorage.reload();

		const firstMark = await authStorage.markUsageLimitReached(PROVIDER, sessionId, {
			credentialId: target.id,
		});
		expect(firstMark.switched).toBe(true);
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe(sibling.credential.access);

		const delayedMark = await authStorage.markUsageLimitReached(PROVIDER, sessionId, {
			apiKey: previousKey,
		});

		expect(delayedMark.switched).toBe(true);
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe(sibling.credential.access);
	});

	test("OAuth bearer identity history evicts old entries but retains recent delayed requests", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		let refreshCount = 0;
		registerProvider(undefined, () => `bounded-${++refreshCount}`);
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "bounded-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "bounded-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const sessionId = "bounded-bearer-history";
		const initialKey = await authStorage.getApiKey(PROVIDER, sessionId);
		if (!initialKey) throw new Error("expected initial OAuth bearer");
		const initialRows = store.listAuthCredentials(PROVIDER);
		const target = initialRows.find(row => row.credential.type === "oauth" && row.credential.access === initialKey);
		const sibling = initialRows.find(row => row.id !== target?.id);
		if (target?.credential.type !== "oauth" || sibling?.credential.type !== "oauth") {
			throw new Error("expected target and sibling OAuth rows");
		}

		const resolvedKeys = [initialKey];
		for (let index = 0; index < 9; index += 1) {
			const refreshed = await authStorage.getApiKey(PROVIDER, sessionId, { forceRefresh: true });
			if (!refreshed) throw new Error("expected refreshed OAuth bearer");
			resolvedKeys.push(refreshed);
		}
		expect(new Set(resolvedKeys).size).toBe(10);

		const evictedMark = await authStorage.markUsageLimitReached(PROVIDER, sessionId, {
			apiKey: resolvedKeys[0],
		});
		expect(evictedMark.switched).toBe(false);

		const recentDelayedKey = resolvedKeys.at(-6);
		if (!recentDelayedKey) throw new Error("expected retained delayed bearer");
		const retainedMark = await authStorage.markUsageLimitReached(PROVIDER, sessionId, {
			apiKey: recentDelayedKey,
		});
		expect(retainedMark.switched).toBe(true);
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe(sibling.credential.access);
	});

	test("usage marking does not block a sibling when its target disappears during usage lookup", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		authStorage.close();
		const concurrentStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store = concurrentStore;
		let targetCredentialId: number | undefined;
		let targetRemoved = false;
		let concurrentStorage: AuthStorage;
		const usageProvider: UsageProvider = {
			id: PROVIDER,
			async fetchUsage() {
				if (targetCredentialId === undefined) throw new Error("expected target credential id");
				if (!targetRemoved) {
					targetRemoved = true;
					concurrentStore.deleteAuthCredential(targetCredentialId, "concurrent test removal");
					await concurrentStorage.reload();
				}
				return { provider: PROVIDER, fetchedAt: Date.now(), limits: [] };
			},
		};
		const rankingStrategy: CredentialRankingStrategy = {
			findWindowLimits: () => ({}),
			windowDefaults: { primaryMs: 60_000, secondaryMs: 60_000 },
		};
		concurrentStorage = new AuthStorage(concurrentStore, {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
			rankingStrategyResolver: provider => (provider === PROVIDER ? rankingStrategy : undefined),
		});
		authStorage = concurrentStorage;
		registerProvider();
		await concurrentStorage.set(PROVIDER, [
			{ type: "oauth", access: "removed-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "survivor-B", refresh: "ref-B", expires: farExpiry() },
			{ type: "oauth", access: "survivor-C", refresh: "ref-C", expires: farExpiry() },
		]);

		const rows = concurrentStore.listAuthCredentials(PROVIDER);
		const target = rows[0];
		if (!target) throw new Error("expected target credential");
		targetCredentialId = target.id;
		const siblings = rows.slice(1);

		const marked = await concurrentStorage.markUsageLimitReached(PROVIDER, undefined, {
			credentialId: target.id,
		});

		expect(marked.switched).toBe(true);
		for (const sibling of siblings) {
			expect(concurrentStore.getCredentialBlock?.(sibling.id, `${PROVIDER}:oauth`, "")).toBeUndefined();
		}
	});

	test("explicit missing rotation targets do not fall back to stale stickiness", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{ type: "api_key", key: "acc-A" },
			{ type: "api_key", key: "acc-B" },
			{ type: "api_key", key: "acc-C" },
		]);

		const sessionId = "explicit-missing-target";
		const sticky = await authStorage.getApiKey(PROVIDER, sessionId);
		if (!sticky) throw new Error("expected sticky credential");
		const maxCredentialId = Math.max(...store.listAuthCredentials(PROVIDER).map(row => row.id));
		const missingCredentialId = maxCredentialId + 1000;

		const rotated = await authStorage.rotateSessionCredential(PROVIDER, sessionId, {
			error: authError(),
			apiKey: "missing-or-changed-failed-bearer",
		});
		expect(rotated).toBe(false);
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe(sticky);

		const rotatedByMissingId = await authStorage.rotateSessionCredential(PROVIDER, sessionId, {
			error: authError(),
			credentialId: missingCredentialId,
		});
		expect(rotatedByMissingId).toBe(false);
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe(sticky);

		const marked = await authStorage.markUsageLimitReached(PROVIDER, sessionId, {
			apiKey: "missing-or-changed-failed-bearer",
		});
		expect(marked.switched).toBe(false);
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe(sticky);

		const markedByMissingId = await authStorage.markUsageLimitReached(PROVIDER, sessionId, {
			credentialId: missingCredentialId,
		});
		expect(markedByMissingId.switched).toBe(false);
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe(sticky);
	});

	test("credentialId rotation targets the failed row after bearer changes without clearing stale sticky", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");
		await authStorage.set(PROVIDER, [
			{ type: "api_key", key: "acc-A" },
			{ type: "api_key", key: "acc-B" },
			{ type: "api_key", key: "acc-C" },
		]);

		const sessionId = "credential-id-target";
		const sticky = await authStorage.getApiKey(PROVIDER, sessionId);
		if (!sticky) throw new Error("expected sticky credential");
		const targetRow = store.listAuthCredentials(PROVIDER).find(row => {
			const credential = row.credential;
			return credential.type === "api_key" && credential.key !== sticky;
		});
		if (targetRow?.credential.type !== "api_key") throw new Error("expected non-sticky target row");
		const oldKey = targetRow.credential.key;
		const changedKey = `${oldKey}-rotated`;
		store.updateAuthCredential(targetRow.id, { type: "api_key", key: changedKey });
		await authStorage.reload();

		const rotated = await authStorage.rotateSessionCredential(PROVIDER, sessionId, {
			error: authError(),
			apiKey: oldKey,
			credentialId: targetRow.id,
		});
		expect(rotated).toBe(true);
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe(sticky);

		const laterSelections = new Set<string>();
		for (let index = 0; index < 6; index += 1) {
			const selected = await authStorage.getApiKey(PROVIDER);
			if (selected) laterSelections.add(selected);
		}
		expect(laterSelections.has(changedKey)).toBe(false);
		expect(laterSelections.has(sticky)).toBe(true);
	});

	test("rotateSessionCredential(usage-limit) delegates to markUsageLimitReached", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const first = await authStorage.getApiKey(PROVIDER, "sess");
		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");

		const rotated = await authStorage.rotateSessionCredential(PROVIDER, "sess", {
			error: usageLimitError(),
		});

		expect(rotated).toBe(true);
		// Usage / account-rate-limit errors route to markUsageLimitReached, which
		// owns the block duration (default + server usage-report reset) — the
		// resolver never parses retry-after itself.
		expect(usageLimitSpy).toHaveBeenCalledTimes(1);
		expect(usageLimitSpy.mock.calls[0]?.[0]).toBe(PROVIDER);
		expect(usageLimitSpy.mock.calls[0]?.[1]).toBe("sess");

		const second = await authStorage.getApiKey(PROVIDER, "sess");
		expect(second).not.toBe(first);
	});

	test("rotateSessionCredential(cyber policy) soft-blocks the denied account and rotates", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const first = await authStorage.getApiKey(PROVIDER, "cyber-policy");
		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");
		const rotated = await authStorage.rotateSessionCredential(PROVIDER, "cyber-policy", {
			error: new Error(
				"Codex error event: This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)",
			),
		});

		expect(rotated).toBe(true);
		expect(usageLimitSpy).not.toHaveBeenCalled();
		expect(await authStorage.getApiKey(PROVIDER, "cyber-policy")).not.toBe(first);
	});

	test("Codex ChatGPT model denial blocks only that model and rotates to a sibling", async () => {
		if (!store) throw new Error("test setup failed");
		const codexStorage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[CODEX_PROVIDER] as OAuthCredentials | undefined;
			if (!credential) return null;
			return { apiKey: credential.access, newCredentials: credential };
		});
		await codexStorage.set(CODEX_PROVIDER, [
			{
				type: "oauth",
				access: "daybreak-denied",
				refresh: "ref-A",
				expires: farExpiry(),
				accountId: "account-A",
			},
			{
				type: "oauth",
				access: "daybreak-sibling",
				refresh: "ref-B",
				expires: farExpiry(),
				accountId: "account-B",
			},
		]);

		const sessionId = "daybreak-model-policy";
		const first = await codexStorage.getApiKey(CODEX_PROVIDER, sessionId, { modelId: DAYBREAK_MODEL });
		expect(first).toBe("daybreak-denied");
		const denial = new ProviderHttpError(CODEX_CHATGPT_MODEL_DENIAL, 400, {
			code: "invalid_request_error",
		});
		expect(
			await codexStorage.rotateSessionCredential(CODEX_PROVIDER, sessionId, {
				error: denial,
				apiKey: first,
			}),
		).toBe(false);
		expect(
			await codexStorage.rotateSessionCredential(CODEX_PROVIDER, sessionId, {
				error: denial,
				modelId: "gpt-5.3-codex",
				apiKey: first,
			}),
		).toBe(false);
		expect(await codexStorage.getApiKey(CODEX_PROVIDER, sessionId, { modelId: DAYBREAK_MODEL })).toBe(first);
		const usageLimitSpy = vi.spyOn(codexStorage, "markUsageLimitReached");
		const rotated = await codexStorage.rotateSessionCredential(CODEX_PROVIDER, sessionId, {
			error: denial,
			modelId: DAYBREAK_MODEL,
			apiKey: first,
		});

		expect(rotated).toBe(true);
		expect(usageLimitSpy).not.toHaveBeenCalled();
		expect(await codexStorage.getApiKey(CODEX_PROVIDER, sessionId, { modelId: DAYBREAK_MODEL })).toBe(
			"daybreak-sibling",
		);

		const deniedRow = store
			.listAuthCredentials(CODEX_PROVIDER)
			.find(row => row.credential.type === "oauth" && row.credential.access === "daybreak-denied");
		if (!deniedRow) throw new Error("denied credential row missing");
		const modelBlock = store.getCredentialBlock?.(
			deniedRow.id,
			`${CODEX_PROVIDER}:oauth`,
			"model-policy:gpt-daybreak-blue-latest",
		);
		expect(typeof modelBlock).toBe("number");
		expect(store.getCredentialBlock?.(deniedRow.id, `${CODEX_PROVIDER}:oauth`, "chat")).toBeUndefined();
		expect(store.getCredentialBlock?.(deniedRow.id, `${CODEX_PROVIDER}:oauth`, "")).toBeUndefined();

		const otherModelStorage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await otherModelStorage.reload();
		expect(
			await otherModelStorage.getApiKey(CODEX_PROVIDER, "other-codex-model", {
				modelId: "gpt-5.3-codex",
			}),
		).toBe("daybreak-denied");
	});

	test("Cursor plan denial blocks only that model and rotates to a sibling", async () => {
		if (!store) throw new Error("test setup failed");
		const cursorStorage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[CURSOR_PROVIDER];
			if (!credential) return null;
			return { apiKey: credential.access, newCredentials: credential };
		});
		await cursorStorage.set(CURSOR_PROVIDER, [
			{
				type: "oauth",
				access: "cursor-plan-denied",
				refresh: "ref-A",
				expires: farExpiry(),
				accountId: "account-A",
			},
			{
				type: "oauth",
				access: "cursor-plan-sibling",
				refresh: "ref-B",
				expires: farExpiry(),
				accountId: "account-B",
			},
		]);

		const sessionId = "cursor-model-policy";
		const first = await cursorStorage.getApiKey(CURSOR_PROVIDER, sessionId, { modelId: CURSOR_MODEL });
		expect(first).toBe("cursor-plan-denied");
		const usageLimitSpy = vi.spyOn(cursorStorage, "markUsageLimitReached");
		const rotated = await cursorStorage.rotateSessionCredential(CURSOR_PROVIDER, sessionId, {
			error: new Error(CURSOR_PLAN_DENIAL),
			modelId: CURSOR_MODEL,
			apiKey: first,
		});

		expect(rotated).toBe(true);
		expect(usageLimitSpy).not.toHaveBeenCalled();
		expect(await cursorStorage.getApiKey(CURSOR_PROVIDER, sessionId, { modelId: CURSOR_MODEL })).toBe(
			"cursor-plan-sibling",
		);

		const deniedRow = store
			.listAuthCredentials(CURSOR_PROVIDER)
			.find(row => row.credential.type === "oauth" && row.credential.access === "cursor-plan-denied");
		if (!deniedRow) throw new Error("denied credential row missing");
		const modelBlock = store.getCredentialBlock?.(
			deniedRow.id,
			`${CURSOR_PROVIDER}:oauth`,
			"model-policy:cursor-grok-4.6",
		);
		expect(typeof modelBlock).toBe("number");
		expect(store.getCredentialBlock?.(deniedRow.id, `${CURSOR_PROVIDER}:oauth`, "")).toBeUndefined();

		const otherModelStorage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await otherModelStorage.reload();
		const otherModelSelections = new Set<string>();
		for (let index = 0; index < 6; index += 1) {
			const selected = await otherModelStorage.getApiKey(CURSOR_PROVIDER, `cursor-included-model-${index}`, {
				modelId: "composer-2.5",
			});
			if (selected) otherModelSelections.add(selected);
		}
		expect(otherModelSelections.has("cursor-plan-denied")).toBe(true);
	});

	test("rotateSessionCredential treats structured usage codes as quota blocks despite generic messages", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const first = await authStorage.getApiKey(PROVIDER, "machine-code-quota");
		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");
		const rotated = await authStorage.rotateSessionCredential(PROVIDER, "machine-code-quota", {
			error: new ProviderHttpError("Generic provider failure", 401, { code: "insufficient_quota" }),
		});

		expect(rotated).toBe(true);
		expect(usageLimitSpy).toHaveBeenCalledTimes(1);
		expect(usageLimitSpy.mock.calls[0]?.[0]).toBe(PROVIDER);
		expect(usageLimitSpy.mock.calls[0]?.[1]).toBe("machine-code-quota");
		expect(await authStorage.getApiKey(PROVIDER, "machine-code-quota")).not.toBe(first);
	});

	test("rotateSessionCredential(xAI credits 403) blocks the exhausted account and rotates", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const first = await authStorage.getApiKey(PROVIDER, "xai-credits");
		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");
		const xaiCreditsError = Object.assign(
			new Error(
				"403 You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok. (type=personal-team-blocked:spending-limit)",
			),
			{ status: 403 },
		);

		const rotated = await authStorage.rotateSessionCredential(PROVIDER, "xai-credits", {
			error: xaiCreditsError,
		});

		expect(rotated).toBe(true);
		expect(usageLimitSpy).toHaveBeenCalledTimes(1);
		expect(await authStorage.getApiKey(PROVIDER, "xai-credits")).not.toBe(first);
	});

	test("rotateSessionCredential treats quota payloads as temporary usage blocks", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
			{ type: "oauth", access: "acc-C", refresh: "ref-C", expires: farExpiry() },
			{ type: "oauth", access: "acc-D", refresh: "ref-D", expires: farExpiry() },
			{ type: "oauth", access: "acc-E", refresh: "ref-E", expires: farExpiry() },
		]);

		for (const [index, error] of [
			[0, quotaPayloadError("429", 429)],
			[1, quotaPayloadError("insufficient_quota")],
			[2, quotaPayloadError("usage_limit_exceeded")],
			[3, quotaPayloadError("usage_limit_reached")],
		] as const) {
			const sessionId = `quota-payload-${index}`;
			const first = await authStorage.getApiKey(PROVIDER, sessionId);
			const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");

			const rotated = await authStorage.rotateSessionCredential(PROVIDER, sessionId, { error });

			expect(rotated).toBe(true);
			expect(usageLimitSpy).toHaveBeenCalledTimes(1);
			expect(await authStorage.getApiKey(PROVIDER, sessionId)).not.toBe(first);
			usageLimitSpy.mockRestore();
		}
	});

	test("rotateSessionCredential does not treat invalid requests as quota blocks", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		await authStorage.getApiKey(PROVIDER, "invalid-request");
		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");

		await authStorage.rotateSessionCredential(PROVIDER, "invalid-request", { error: invalidRequestError() });

		expect(usageLimitSpy).not.toHaveBeenCalled();
	});

	test("rotateSessionCredential leaves informative transient 429s out of the quota block path", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		const transient429Bodies = [
			"Cloud Code Assist API error (429): Too many requests",
			"Please retry in 5s",
			"Service overloaded 529",
		];

		for (const [index, body] of transient429Bodies.entries()) {
			const sessionId = `transient-429-${index}`;
			await authStorage.getApiKey(PROVIDER, sessionId);
			const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");

			await authStorage.rotateSessionCredential(PROVIDER, sessionId, {
				error: Object.assign(new Error(body), { status: 429 }),
			});

			// `Too many requests`, server retry hints, and capacity overload are
			// owned by the provider's own retry layer — burning a sibling
			// credential here would orphan a healthy account for the default
			// backoff window.
			expect(usageLimitSpy).not.toHaveBeenCalled();
			usageLimitSpy.mockRestore();
		}
	});

	test("rotateSessionCredential reports no sibling for a single-credential setup", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "only-access", refresh: "only-refresh", expires: farExpiry() },
		]);

		await authStorage.getApiKey(PROVIDER, "sess");
		expect(await authStorage.rotateSessionCredential(PROVIDER, "sess", { error: authError() })).toBe(false);
	});

	test("rotateSessionCredential returns false when the session has no sticky credential", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() }]);

		// Never resolved a key for this session → nothing to rotate away from.
		expect(await authStorage.rotateSessionCredential(PROVIDER, "untouched", { error: authError() })).toBe(false);
	});

	test("markUsageLimitReached reports the earliest sibling unblock time when every sibling is blocked", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "acc-A", refresh: "ref-A", expires: farExpiry() },
			{ type: "oauth", access: "acc-B", refresh: "ref-B", expires: farExpiry() },
		]);

		// Session A takes one credential and parks it briefly (e.g. a transient
		// probe block) — a sibling is still free, so this reports switched.
		await authStorage.getApiKey(PROVIDER, "sess-a");
		const blockedBefore = Date.now();
		const first = await authStorage.markUsageLimitReached(PROVIDER, "sess-a", { retryAfterMs: 30_000 });
		const blockedAfter = Date.now();
		expect(first.switched).toBe(true);

		// Session B lands on the remaining credential and hits a multi-hour
		// usage limit. No sibling is free *right now*, but the result must
		// carry session A's short unblock time — not the 1h window — so the
		// retry layer can wait seconds instead of bailing on the long wait.
		await authStorage.getApiKey(PROVIDER, "sess-b");
		const second = await authStorage.markUsageLimitReached(PROVIDER, "sess-b", { retryAfterMs: 3_600_000 });
		expect(second.switched).toBe(false);
		expect(second.retryAtMs).toBeDefined();
		expect(second.retryAtMs!).toBeGreaterThanOrEqual(blockedBefore + 30_000);
		expect(second.retryAtMs!).toBeLessThanOrEqual(blockedAfter + 30_000);
	});

	test("markUsageLimitReached reports no retry time for a single-credential setup", async () => {
		if (!authStorage) throw new Error("test setup failed");
		registerProvider();
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "only-access", refresh: "only-refresh", expires: farExpiry() },
		]);

		await authStorage.getApiKey(PROVIDER, "sess");
		const outcome = await authStorage.markUsageLimitReached(PROVIDER, "sess", { retryAfterMs: 3_600_000 });
		expect(outcome).toEqual({ switched: false, retryAtMs: undefined });
	});
});
