import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-oauth-rotating";
const TOKEN_URL = "https://auth.example.test/token";
const WHOAMI_URL = "https://api.example.test/whoami";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("OAuth refresh budget", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-refresh-budget-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("persists a refresh token the provider rotated when post-exchange work outlasts the budget", async () => {
		if (!store) throw new Error("test setup failed");
		const authStorage = new AuthStorage(store, {});

		// Token endpoint that rotates the refresh token on every grant, so the
		// previous one is dead server-side as soon as the grant answers.
		const validRefreshTokens = new Set(["r0"]);
		let rotations = 0;
		// Post-exchange work (e.g. an org lookup) stays pending until the caller has given up.
		const whoamiGate = Promise.withResolvers<void>();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					const url = String(input);
					if (url === TOKEN_URL) {
						const presented = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
						if (!validRefreshTokens.delete(presented)) return json({ error: "invalid_grant" }, 400);
						const next = `r${++rotations}`;
						validRefreshTokens.add(next);
						return json({ access_token: `access-${next}`, refresh_token: next, expires_in: 3600 });
					}
					if (url === WHOAMI_URL) {
						// Like a real request, the lookup ends early if the exchange is aborted.
						const aborted = Promise.withResolvers<never>();
						init?.signal?.addEventListener("abort", () => aborted.reject(init.signal?.reason), { once: true });
						await Promise.race([whoamiGate.promise, aborted.promise]);
						return json({ orgId: "org-1" });
					}
					return json({}, 404);
				},
				{ preconnect: fetch.preconnect },
			),
		);

		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-r0", refresh: "r0", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(PROVIDER)[0]!.id;
		const leaseReleased = Promise.withResolvers<void>();
		const release = store.releaseCredentialRefreshLease.bind(store);
		vi.spyOn(store, "releaseCredentialRefreshLease").mockImplementation((id, owner) => {
			release(id, owner);
			leaseReleased.resolve();
		});

		let exchangeSignal: AbortSignal | undefined;
		const failures: unknown[] = [];
		const refresh = authStorage.oauth.refreshStored(PROVIDER, {
			credentialId,
			credentialFromRow: row => row,
			forceRefresh: true,
			refreshTimeoutMs: 50,
			onRefreshFailure: error => failures.push(error),
			refresh: async (credential, signal) => {
				exchangeSignal = signal;
				const grant = await fetch(TOKEN_URL, {
					method: "POST",
					body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refresh }),
					signal,
				});
				if (!grant.ok) throw new Error(`token endpoint ${grant.status}`);
				const tokens = (await grant.json()) as { access_token: string; refresh_token: string; expires_in: number };
				// Post-exchange hook (e.g. an org lookup) that outlasts the caller budget.
				const whoami = (await (await fetch(WHOAMI_URL, { signal })).json()) as { orgId: string };
				return {
					access: tokens.access_token,
					refresh: tokens.refresh_token,
					expires: Date.now() + tokens.expires_in * 1000,
					orgId: whoami.orgId,
				};
			},
		});

		// The caller stops waiting at the budget and sees the timeout.
		await expect(refresh).rejects.toMatchObject({
			message: `OAuth token refresh timed out for provider: ${PROVIDER}`,
		});
		expect(failures).toHaveLength(1);
		expect(validRefreshTokens).toEqual(new Set(["r1"]));

		// The exchange itself runs on and still holds the lease.
		expect(exchangeSignal?.aborted).toBe(false);
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "peer", Date.now() + 15_000)).toBe(false);
		expect(store.listAuthCredentials(PROVIDER)[0]?.credential).toMatchObject({ refresh: "r0" });

		// Once the post-exchange work answers, the rotated token is persisted.
		whoamiGate.resolve();
		await leaseReleased.promise;
		expect(exchangeSignal?.aborted).toBe(false);
		expect(store.listAuthCredentials(PROVIDER)[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-r1",
			refresh: "r1",
			orgId: "org-1",
		});
		// The lease is released once the exchange has persisted.
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "peer", Date.now() + 15_000)).toBe(true);
	});

	test("a peer waiting on a held lease gives up at its budget", async () => {
		if (!store) throw new Error("test setup failed");
		const authStorage = new AuthStorage(store, {});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-r0", refresh: "r0", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(PROVIDER)[0]!.id;
		const hung = Promise.withResolvers<never>();
		const first = authStorage.oauth.refreshStored(PROVIDER, {
			credentialId,
			credentialFromRow: row => row,
			forceRefresh: true,
			refreshTimeoutMs: 50,
			refresh: () => hung.promise,
		});
		await expect(first).rejects.toMatchObject({ message: `OAuth token refresh timed out for provider: ${PROVIDER}` });

		let peerExchanged = false;
		const started = Date.now();
		await expect(
			authStorage.oauth.refreshStored(PROVIDER, {
				credentialId,
				credentialFromRow: row => row,
				forceRefresh: true,
				refreshTimeoutMs: 50,
				refresh: async () => {
					peerExchanged = true;
					throw new Error("peer must not exchange while the lease is held");
				},
			}),
		).rejects.toMatchObject({ message: `OAuth token refresh timed out for provider: ${PROVIDER}` });
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(peerExchanged).toBe(false);
		hung.reject(new Error("done"));
	});

	test("a credential removed while the exchange ran is not restored to the pool", async () => {
		if (!store) throw new Error("test setup failed");
		const authStorage = new AuthStorage(store, {});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-a", refresh: "a0", expires: Date.now() - 60_000 },
			{ type: "oauth", access: "access-b", refresh: "b0", expires: Date.now() + 3_600_000 },
		]);
		const [target, sibling] = store.listAuthCredentials(PROVIDER);
		const gate = Promise.withResolvers<void>();
		const refresh = authStorage.oauth.refreshStored(PROVIDER, {
			credentialId: target!.id,
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async () => {
				await gate.promise;
				return { access: "access-a1", refresh: "a1", expires: Date.now() + 3_600_000 };
			},
		});
		await Bun.sleep(0);
		await store.deleteAuthCredential(sibling!.id, "deleted by user");
		gate.resolve();
		await expect(refresh).resolves.toMatchObject({ refreshed: true });
		const pooled = authStorage.credentials.list(PROVIDER).map(entry => entry.id);
		expect(pooled).toEqual([target!.id]);
	});

	test("a credential removed while a failing exchange ran is not restored to the pool", async () => {
		if (!store) throw new Error("test setup failed");
		const authStorage = new AuthStorage(store, {});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-a", refresh: "a0", expires: Date.now() - 60_000 },
			{ type: "oauth", access: "access-b", refresh: "b0", expires: Date.now() + 3_600_000 },
			{ type: "oauth", access: "access-c", refresh: "c0", expires: Date.now() + 3_600_000 },
		]);
		const [target, sibling, kept] = store.listAuthCredentials(PROVIDER);
		const gate = Promise.withResolvers<void>();
		const refresh = authStorage.oauth.refreshStored(PROVIDER, {
			credentialId: target!.id,
			credentialFromRow: row => row,
			forceRefresh: true,
			isDefinitiveFailure: () => true,
			refresh: async () => {
				await gate.promise;
				throw new Error("invalid_grant");
			},
		});
		await Bun.sleep(0);
		await store.deleteAuthCredential(sibling!.id, "deleted by user");
		gate.resolve();
		await expect(refresh).resolves.toMatchObject({ removed: true });
		const pooled = authStorage.credentials.list(PROVIDER).map(entry => entry.id);
		expect(pooled).toEqual([kept!.id]);
	});

	test("a waiter whose budget ran out does not take a lease that frees up", async () => {
		if (!store) throw new Error("test setup failed");
		const authStorage = new AuthStorage(store, {});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-r0", refresh: "r0", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(PROVIDER)[0]!.id;
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "peer", Date.now() + 15_000)).toBe(true);
		// The peer lets go exactly when the waiter's budget has run out.
		const realNow = Date.now;
		let exchanged = false;
		const start = realNow();
		const sleep = Bun.sleep;
		vi.spyOn(Bun, "sleep").mockImplementation(async ms => {
			await sleep(ms);
			if (realNow() - start >= 20) store?.releaseCredentialRefreshLease(credentialId, "peer");
		});
		const waiter = authStorage.oauth.refreshStored(PROVIDER, {
			credentialId,
			credentialFromRow: row => row,
			forceRefresh: true,
			refreshTimeoutMs: 20,
			refresh: async () => {
				exchanged = true;
				return { access: "access-r1", refresh: "r1", expires: realNow() + 3_600_000 };
			},
		});
		await expect(waiter).rejects.toMatchObject({
			message: `OAuth token refresh timed out for provider: ${PROVIDER}`,
		});
		expect(exchanged).toBe(false);
	});

	test("a caller whose lease acquisition outlasts its budget does not start the exchange", async () => {
		if (!store) throw new Error("test setup failed");
		const authStorage = new AuthStorage(store, {});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-r0", refresh: "r0", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(PROVIDER)[0]!.id;
		// Acquisition succeeds, but only after a SQLite busy wait longer than the budget.
		const acquire = store.tryAcquireCredentialRefreshLease.bind(store);
		vi.spyOn(store, "tryAcquireCredentialRefreshLease").mockImplementation((id, owner, expiresAt) => {
			const acquired = acquire(id, owner, expiresAt);
			Bun.sleepSync(30);
			return acquired;
		});
		let exchanged = false;
		await expect(
			authStorage.oauth.refreshStored(PROVIDER, {
				credentialId,
				credentialFromRow: row => row,
				forceRefresh: true,
				refreshTimeoutMs: 20,
				refresh: async () => {
					exchanged = true;
					return { access: "access-r1", refresh: "r1", expires: Date.now() + 3_600_000 };
				},
			}),
		).rejects.toMatchObject({ message: `OAuth token refresh timed out for provider: ${PROVIDER}` });
		expect(exchanged).toBe(false);
		expect(acquire(credentialId, "peer", Date.now() + 15_000)).toBe(true);
	});
});
