import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AUTH_BROKER_CAPABILITIES_HEADER,
	AUTH_BROKER_CAPABILITY_CODEX_METER_BLOCK_SCOPES,
	AuthBrokerClient,
	AuthBrokerError,
	type AuthBrokerServerHandle,
	AuthBrokerStreamUnsupportedError,
	type SnapshotResponse,
	type SnapshotStreamEvent,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, expires: number) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function fetchWithoutAuthBrokerCapabilities(): typeof fetch {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			headers.delete(AUTH_BROKER_CAPABILITIES_HEADER);
			return fetch(input, { ...init, headers });
		},
		{ preconnect: fetch.preconnect },
	);
}

function credentialBlocks(snapshot: SnapshotResponse, credentialId: number) {
	return snapshot.credentials.find(entry => entry.id === credentialId)?.blocks ?? [];
}

function readRawCodexCredentialBlocks(
	dbPath: string,
	credentialId: number,
): Array<{ block_scope: string; blocked_until_ms: number; updated_at: number }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT block_scope, blocked_until_ms, updated_at FROM auth_credential_blocks WHERE credential_id = ? AND provider_key = 'openai-codex:oauth' ORDER BY block_scope",
			)
			.all(credentialId) as Array<{ block_scope: string; blocked_until_ms: number; updated_at: number }>;
	} finally {
		db.close();
	}
}

describe("auth-broker wire surface", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let token = "";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-wire-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveOAuth("anthropic", mintOAuthCredential("a", Date.now() + 60_000));
		storage = new AuthStorage(store);
		await storage.reload();
		token = "test-bearer";
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await handle?.close();
		storage?.close();
		store?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("GET /v1/healthz returns ok without auth", async () => {
		const res = await fetch(`${handle!.url}/v1/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("GET /v1/snapshot requires bearer and redacts refresh tokens", async () => {
		const unauthorized = await fetch(`${handle!.url}/v1/snapshot`);
		expect(unauthorized.status).toBe(401);

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const snapshotResult = await client.fetchSnapshot();
		if (snapshotResult.status !== 200) throw new Error("expected snapshot");
		const snapshot = snapshotResult.snapshot;
		expect(snapshot.credentials).toHaveLength(1);
		const entry = snapshot.credentials[0];
		expect(entry.provider).toBe("anthropic");
		expect(entry.credential.type).toBe("oauth");
		if (entry.credential.type === "oauth") {
			expect(entry.credential.access).toBe("access-a");
			// Refresh token is replaced with the wire sentinel — clients never see it.
			expect(entry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
	});

	test("preserves an HTTP rejection when the caller aborts while reading its body", async () => {
		const client = new AuthBrokerClient({
			url: "http://broker.invalid",
			token,
			maxRetries: 0,
			fetchImpl: (async (_input, init) => {
				const signal = init?.signal;
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("forbidden"));
						signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
					},
				});
				return new Response(body, { status: 401 });
			}) as typeof fetch,
		});

		try {
			await client.fetchSnapshot({ signal: AbortSignal.timeout(10) });
			throw new Error("expected auth rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(AuthBrokerError);
			expect(error).toMatchObject({ status: 401 });
		}
	});

	test("GET /v1/usage outlives the base timeout for a serialized account batch", async () => {
		vi.useFakeTimers();
		const response = Promise.withResolvers<Response>();
		let usageSignal: AbortSignal | undefined;
		const fetchImpl: typeof fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const signal = init?.signal;
				if (signal) usageSignal = signal;
				return response.promise;
			},
			{ preconnect: fetch.preconnect },
		);
		const client = new AuthBrokerClient({
			url: "http://broker.invalid",
			token,
			timeoutMs: 10_000,
			maxRetries: 0,
			fetchImpl,
		});
		try {
			const usage = client.fetchUsage({ maxAccountsPerProvider: 3 });
			await Promise.resolve();
			const baseTimeout = AbortSignal.timeout(10_000);
			vi.advanceTimersByTime(10_001);
			await Promise.resolve();
			expect(baseTimeout.aborted).toBe(true);
			expect(usageSignal?.aborted).toBe(false);

			const generatedAt = Date.now();
			response.resolve(Response.json({ generatedAt, reports: [] }));
			expect(await usage).toEqual({ generatedAt, reports: [] });
		} finally {
			vi.useRealTimers();
		}
	});

	test("GET /v1/snapshot returns generation headers and 304 for unchanged long-poll", async () => {
		const res = await fetch(`${handle!.url}/v1/snapshot`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { generation: number; serverNowMs: number; refresher: { enabled: boolean } };
		expect(res.headers.get("etag")).toBe(`"${body.generation}"`);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("vary")).toBe(AUTH_BROKER_CAPABILITIES_HEADER);
		expect(body.generation).toBeGreaterThan(0);
		expect(body.serverNowMs).toBeGreaterThan(0);
		expect(body.refresher.enabled).toBe(false);

		const observedCapabilities: Array<string | null> = [];
		const fetchImpl: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				observedCapabilities.push(new Headers(init?.headers).get(AUTH_BROKER_CAPABILITIES_HEADER));
				return fetch(input, init);
			},
			{ preconnect: fetch.preconnect },
		);
		const client = new AuthBrokerClient({ url: handle!.url, token, fetchImpl });
		const unchanged = await client.fetchSnapshot({ ifGenerationGt: body.generation, waitMs: 10 });
		expect(unchanged.status).toBe(304);
		expect(unchanged.generation).toBe(body.generation);
		expect(observedCapabilities).toEqual([AUTH_BROKER_CAPABILITY_CODEX_METER_BLOCK_SCOPES]);

		const rawUnchanged = await fetch(`${handle!.url}/v1/snapshot?wait=10`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"If-None-Match": `"${body.generation}"`,
			},
		});
		expect(rawUnchanged.status).toBe(304);
		expect(rawUnchanged.headers.get("vary")).toBe(AUTH_BROKER_CAPABILITIES_HEADER);
	});

	test("ignores external SQLite commits outside auth tables", async () => {
		const generation = storage!.getGeneration();
		const db = new Database(path.join(tempDir, "agent.db"));
		try {
			db.run("CREATE TABLE unrelated_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
			db.run("INSERT INTO unrelated_state (value) VALUES ('changed')");
		} finally {
			db.close();
		}

		expect(await storage!.pollExternalChanges()).toBe(false);
		expect(storage!.getGeneration()).toBe(generation);
	});

	test("does not double-bump after a local auth write with an unrelated external commit pending", async () => {
		const db = new Database(path.join(tempDir, "agent.db"));
		try {
			db.run("CREATE TABLE unrelated_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
			db.run("INSERT INTO unrelated_state (value) VALUES ('changed')");
		} finally {
			db.close();
		}
		storage!.upsertCredential("unit-local", { type: "api_key", key: "local-key" });
		const generation = storage!.getGeneration();

		expect(await storage!.pollExternalChanges()).toBe(false);
		expect(storage!.getGeneration()).toBe(generation);
	});

	test("preserves a pending external auth commit while acknowledging local changes", async () => {
		const generation = storage!.getGeneration();
		const db = new Database(path.join(tempDir, "agent.db"));
		try {
			db.run("UPDATE auth_credentials SET updated_at = updated_at + 1 WHERE provider = 'anthropic'");
		} finally {
			db.close();
		}

		store!.acknowledgeLocalChanges();
		expect(await storage!.pollExternalChanges()).toBe(true);
		expect(storage!.getGeneration()).toBeGreaterThan(generation);
	});

	test("projects Codex meter blocks for legacy clients and observes writes from another connection", async () => {
		await handle!.close();
		handle = undefined;
		const credential = storage!.upsertCredential("openai-codex", {
			...mintOAuthCredential("codex-scopes", Date.now() + 60_000),
		})[0];
		if (!credential) throw new Error("expected Codex credential");
		const chatBlockedUntilMs = Date.now() + 60_000;
		const sparkBlockedUntilMs = Date.now() + 120_000;
		storage!.upsertCredentialBlock({
			credentialId: credential.id,
			providerKey: "openai-codex:oauth",
			blockScope: "chat",
			blockedUntilMs: chatBlockedUntilMs,
		});
		storage!.upsertCredentialBlock({
			credentialId: credential.id,
			providerKey: "openai-codex:oauth",
			blockScope: "spark",
			blockedUntilMs: sparkBlockedUntilMs,
		});
		expect(
			readRawCodexCredentialBlocks(path.join(tempDir, "agent.db"), credential.id).map(row => row.block_scope),
		).toEqual(["chat", "shared", "spark"]);

		const sparkUpdatedAtSec = Math.floor(Date.now() / 1000) - 20;
		const chatUpdatedAtSec = sparkUpdatedAtSec + 10;
		const db = new Database(path.join(tempDir, "agent.db"));
		try {
			const updateTimestamp = db.prepare(
				"UPDATE auth_credential_blocks SET updated_at = ? WHERE credential_id = ? AND provider_key = ? AND block_scope = ?",
			);
			updateTimestamp.run(chatUpdatedAtSec, credential.id, "openai-codex:oauth", "chat");
			updateTimestamp.run(sparkUpdatedAtSec, credential.id, "openai-codex:oauth", "spark");
		} finally {
			db.close();
		}
		await storage!.pollExternalChanges();
		expect(readRawCodexCredentialBlocks(path.join(tempDir, "agent.db"), credential.id)).toEqual([
			{
				block_scope: "chat",
				blocked_until_ms: chatBlockedUntilMs,
				updated_at: chatUpdatedAtSec,
			},
			{
				block_scope: "shared",
				blocked_until_ms: sparkBlockedUntilMs,
				updated_at: chatUpdatedAtSec,
			},
			{
				block_scope: "spark",
				blocked_until_ms: sparkBlockedUntilMs,
				updated_at: sparkUpdatedAtSec,
			},
		]);

		handle = startAuthBroker({
			storage: storage!,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
			externalChangePollMs: 10,
			// This integration exercises the real server poll; fake timers do not
			// drive Bun's HTTP stream lifecycle.
		});

		const currentClient = new AuthBrokerClient({ url: handle!.url, token });
		const currentResult = await currentClient.fetchSnapshot();
		if (currentResult.status !== 200) throw new Error("expected current-client snapshot");
		const currentBlocks = credentialBlocks(currentResult.snapshot, credential.id);
		expect(currentBlocks).toEqual([
			{
				providerKey: "openai-codex:oauth",
				blockScope: "chat",
				blockedUntilMs: chatBlockedUntilMs,
				updatedAtMs: chatUpdatedAtSec * 1000,
			},
			{
				providerKey: "openai-codex:oauth",
				blockScope: "spark",
				blockedUntilMs: sparkBlockedUntilMs,
				updatedAtMs: sparkUpdatedAtSec * 1000,
			},
		]);
		const maxUpdatedAtMs = Math.max(...currentBlocks.map(block => block.updatedAtMs ?? 0));
		expect(maxUpdatedAtMs).toBe(chatUpdatedAtSec * 1000);

		const legacyClient = new AuthBrokerClient({
			url: handle!.url,
			token,
			fetchImpl: fetchWithoutAuthBrokerCapabilities(),
		});
		const legacyResult = await legacyClient.fetchSnapshot();
		if (legacyResult.status !== 200) throw new Error("expected legacy-client snapshot");
		expect(credentialBlocks(legacyResult.snapshot, credential.id)).toEqual([
			{
				providerKey: "openai-codex:oauth",
				blockScope: "shared",
				blockedUntilMs: sparkBlockedUntilMs,
				updatedAtMs: maxUpdatedAtMs,
			},
		]);

		expect(
			storage!
				.listCredentialBlocks([credential.id])
				.map(block => block.blockScope)
				.sort(),
		).toEqual(["chat", "spark"]);

		const pendingLegacySnapshot = legacyClient.fetchSnapshot({
			ifGenerationGt: legacyResult.generation,
			waitMs: 1000,
		});
		const updatedChatBlockedUntilMs = sparkBlockedUntilMs + 60_000;
		const legacyWriter = new Database(path.join(tempDir, "agent.db"));
		try {
			legacyWriter
				.prepare(
					`INSERT INTO auth_credential_blocks (
						credential_id, provider_key, block_scope, blocked_until_ms, updated_at
					) VALUES (?, 'openai-codex:oauth', 'shared', ?, ?)
					ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
						blocked_until_ms = MAX(auth_credential_blocks.blocked_until_ms, excluded.blocked_until_ms),
						updated_at = excluded.updated_at`,
				)
				.run(credential.id, updatedChatBlockedUntilMs, Math.floor(Date.now() / 1000));
		} finally {
			legacyWriter.close();
		}
		const changedLegacyResult = await pendingLegacySnapshot;
		if (changedLegacyResult.status !== 200) throw new Error("expected legacy-client long-poll snapshot");
		expect(
			credentialBlocks(changedLegacyResult.snapshot, credential.id).map(block => [
				block.blockScope,
				block.blockedUntilMs,
			]),
		).toEqual([["shared", updatedChatBlockedUntilMs]]);
	});

	test("GET /v1/snapshot long-poll wakes when generation changes", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected snapshot");

		const pending = client.fetchSnapshot({ ifGenerationGt: initial.generation, waitMs: 1000 });
		setTimeout(() => {
			storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		}, 10);

		const changed = await pending;
		expect(changed.status).toBe(200);
		if (changed.status !== 200) throw new Error("expected changed snapshot");
		expect(changed.generation).toBeGreaterThan(initial.generation);
		expect(
			changed.snapshot.credentials.some(
				entry => entry.credential.type === "oauth" && entry.credential.access === "access-b",
			),
		).toBe(true);
	});

	test("POST /v1/credential/:id/refresh forces a refresh and persists the new credential", async () => {
		const refreshed = {
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: Date.now() + 120_000,
			accountId: "account-a",
			email: "a@example.com",
		};
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(refreshed);

		const initialResult = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const id = initialResult.snapshot.credentials[0].id;

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const result = await client.refreshCredential(id);
		expect(result.entry.id).toBe(id);
		if (result.entry.credential.type === "oauth") {
			expect(result.entry.credential.access).toBe("access-rotated");
			expect(result.entry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}

		// Underlying SQLite row was updated with the *real* refresh token (no sentinel).
		const persisted = store!.getOAuth("anthropic");
		expect(persisted?.access).toBe("access-rotated");
		expect(persisted?.refresh).toBe("refresh-rotated");
	});

	test("POST /v1/credential/:id/disable soft-deletes the credential and surfaces 404 thereafter", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected snapshot");
		const id = initialResult.snapshot.credentials[0].id;

		const result = await client.disableCredential(id, "revoked by user");
		expect(result.ok).toBe(true);

		const afterResult = await client.fetchSnapshot();
		if (afterResult.status !== 200) throw new Error("expected snapshot");
		expect(afterResult.snapshot.credentials).toHaveLength(0);

		await expect(client.refreshCredential(id)).rejects.toThrow();
	});

	test("GET /v1/usage/history serves recorded snapshots with sinceMs/provider filters and requires auth", async () => {
		const hourMs = 60 * 60 * 1000;
		const now = Date.now();
		// Hours apart so the store's per-bucket dedupe keeps distinct rows.
		store!.recordUsageSnapshots!([
			{
				recordedAt: now - 3 * hourMs,
				provider: "anthropic",
				accountKey: "acct-a",
				email: "a@example.com",
				limitId: "5h",
				label: "Claude 5 Hour",
				windowLabel: "5h",
				usedFraction: 0.2,
				status: "ok",
			},
			{
				recordedAt: now - hourMs,
				provider: "anthropic",
				accountKey: "acct-a",
				email: "a@example.com",
				limitId: "5h",
				label: "Claude 5 Hour",
				windowLabel: "5h",
				usedFraction: 0.9,
				status: "warning",
			},
			{
				recordedAt: now - hourMs,
				provider: "openai-codex",
				accountKey: "acct-b",
				limitId: "weekly",
				label: "Weekly",
				usedFraction: 0.5,
			},
		]);

		const unauthorized = await fetch(`${handle!.url}/v1/usage/history`);
		expect(unauthorized.status).toBe(401);

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const all = await client.fetchUsageHistory();
		expect(all.entries).toHaveLength(3);
		expect(all.entries[0].recordedAt).toBeLessThanOrEqual(all.entries[1].recordedAt);

		const recent = await client.fetchUsageHistory({ sinceMs: now - 2 * hourMs });
		expect(recent.entries.map(e => e.usedFraction).sort()).toEqual([0.5, 0.9]);

		const anthropicOnly = await client.fetchUsageHistory({ provider: "anthropic" });
		expect(anthropicOnly.entries).toHaveLength(2);
		expect(anthropicOnly.entries.every(e => e.provider === "anthropic")).toBe(true);
		expect(anthropicOnly.entries[1]).toMatchObject({
			accountKey: "acct-a",
			email: "a@example.com",
			windowLabel: "5h",
			usedFraction: 0.9,
			status: "warning",
		});
	});

	test("POST /v1/usage/observed persists per-client usage served by GET /v1/usage/clients", async () => {
		const unauthorized = await fetch(`${handle!.url}/v1/usage/observed`, { method: "POST" });
		expect(unauthorized.status).toBe(401);

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const now = Date.now();
		const entry = {
			at: now,
			provider: "anthropic",
			model: "claude-x",
			requests: 2,
			inputTokens: 1000,
			outputTokens: 400,
			cacheReadTokens: 50,
			cacheWriteTokens: 25,
			costUsd: 3.25,
		};
		const ack = await client.reportClientUsage({ installId: "install-1", hostname: "mbp.local", entries: [entry] });
		expect(ack.ok).toBe(true);
		await client.reportClientUsage({
			installId: "install-2",
			entries: [{ ...entry, provider: "openai-codex", model: "gpt-y", requests: 1, costUsd: 0 }],
		});

		const summary = await client.fetchClientUsageSummary();
		expect(summary.clients).toHaveLength(2);
		const first = summary.clients.find(c => c.installId === "install-1");
		expect(first).toMatchObject({ hostname: "mbp.local" });
		expect(first?.lastSeen).toBeGreaterThan(0);
		expect(first?.providers).toEqual([
			{
				provider: "anthropic",
				requests: 2,
				inputTokens: 1000,
				outputTokens: 400,
				cacheReadTokens: 50,
				cacheWriteTokens: 25,
				costUsd: 3.25,
			},
		]);
		const second = summary.clients.find(c => c.installId === "install-2");
		expect(second?.hostname).toBeUndefined();
		expect(second?.providers[0]).toMatchObject({ provider: "openai-codex", requests: 1 });

		// App-labeled usage lands in its own (install, app, provider) aggregate
		// row — "what did robomp spend" must not fold into the unlabeled bucket.
		await client.reportClientUsage({
			installId: "install-2",
			app: "robomp",
			entries: [{ ...entry, provider: "openai-codex", model: "gpt-y", requests: 4, costUsd: 1.5 }],
		});
		const withApps = await client.fetchClientUsageSummary();
		const labeled = withApps.clients.find(c => c.installId === "install-2");
		expect(labeled?.providers).toHaveLength(2);
		expect(labeled?.providers.find(p => p.app === "robomp")).toMatchObject({
			provider: "openai-codex",
			requests: 4,
			costUsd: 1.5,
		});
		expect(labeled?.providers.find(p => p.app === undefined)).toMatchObject({
			provider: "openai-codex",
			requests: 1,
		});

		// sinceMs beyond the recorded timestamps returns clients with no aggregates.
		const future = await client.fetchClientUsageSummary({ sinceMs: now + 60_000 });
		expect(future.clients.every(c => c.providers.length === 0)).toBe(true);

		// Malformed body is rejected by schema validation.
		const bad = await fetch(`${handle!.url}/v1/usage/observed`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ installId: "x", entries: [{ at: "not-a-number" }] }),
		});
		expect(bad.status).toBe(400);
	});

	test("Unknown route returns 404", async () => {
		const res = await fetch(`${handle!.url}/v1/nope`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(404);
	});

	test("GET /v1/snapshot/stream requires bearer", async () => {
		const res = await fetch(`${handle!.url}/v1/snapshot/stream`);
		expect(res.status).toBe(401);
	});

	test("SSE stream emits initial snapshot then upsert delta", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const controller = new AbortController();
		const iter = client.openSnapshotStream({ signal: controller.signal });
		try {
			const first = await iter.next();
			if (first.done) throw new Error("expected snapshot frame");
			expect(first.value.kind).toBe("snapshot");
			if (first.value.kind === "snapshot") {
				expect(first.value.credentials).toHaveLength(1);
				expect(first.value.credentials[0].provider).toBe("anthropic");
			}

			storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));

			const next = await nextMatching(iter, event => event.kind === "entry");
			if (next.kind !== "entry") throw new Error("expected entry frame");
			expect(next.entry.provider).toBe("anthropic");
			expect(next.entry.credential.type).toBe("oauth");
			if (next.entry.credential.type === "oauth") {
				expect(next.entry.credential.access).toBe("access-b");
				expect(next.entry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
			}
		} finally {
			controller.abort();
			await iter.return(undefined).catch(() => {});
		}
	});

	test("SSE stream projects Codex meter blocks only for clients without the capability", async () => {
		const credential = storage!.upsertCredential("openai-codex", {
			...mintOAuthCredential("codex-stream-scopes", Date.now() + 60_000),
		})[0];
		if (!credential) throw new Error("expected Codex credential");
		const chatBlockedUntilMs = Date.now() + 60_000;
		const sparkBlockedUntilMs = Date.now() + 120_000;
		storage!.upsertCredentialBlock({
			credentialId: credential.id,
			providerKey: "openai-codex:oauth",
			blockScope: "chat",
			blockedUntilMs: chatBlockedUntilMs,
		});
		storage!.upsertCredentialBlock({
			credentialId: credential.id,
			providerKey: "openai-codex:oauth",
			blockScope: "spark",
			blockedUntilMs: sparkBlockedUntilMs,
		});

		const currentController = new AbortController();
		const legacyController = new AbortController();
		const currentIter = new AuthBrokerClient({ url: handle!.url, token }).openSnapshotStream({
			signal: currentController.signal,
		});
		const legacyIter = new AuthBrokerClient({
			url: handle!.url,
			token,
			fetchImpl: fetchWithoutAuthBrokerCapabilities(),
		}).openSnapshotStream({ signal: legacyController.signal });
		try {
			const [currentInitial, legacyInitial] = await Promise.all([currentIter.next(), legacyIter.next()]);
			if (currentInitial.done || currentInitial.value.kind !== "snapshot") {
				throw new Error("expected current-client snapshot frame");
			}
			if (legacyInitial.done || legacyInitial.value.kind !== "snapshot") {
				throw new Error("expected legacy-client snapshot frame");
			}
			expect(
				credentialBlocks(currentInitial.value, credential.id).map(block => [
					block.blockScope,
					block.blockedUntilMs,
				]),
			).toEqual([
				["chat", chatBlockedUntilMs],
				["spark", sparkBlockedUntilMs],
			]);
			const initialCurrentBlocks = credentialBlocks(currentInitial.value, credential.id);
			expect(credentialBlocks(legacyInitial.value, credential.id)).toEqual([
				{
					providerKey: "openai-codex:oauth",
					blockScope: "shared",
					blockedUntilMs: sparkBlockedUntilMs,
					updatedAtMs: Math.max(...initialCurrentBlocks.map(block => block.updatedAtMs ?? 0)),
				},
			]);

			const updatedChatBlockedUntilMs = sparkBlockedUntilMs + 60_000;
			storage!.upsertCredentialBlock({
				credentialId: credential.id,
				providerKey: "openai-codex:oauth",
				blockScope: "chat",
				blockedUntilMs: updatedChatBlockedUntilMs,
			});

			const [currentDelta, legacyDelta] = await Promise.all([
				nextMatching(currentIter, event => event.kind === "entry" && event.entry.id === credential.id),
				nextMatching(legacyIter, event => event.kind === "entry" && event.entry.id === credential.id),
			]);
			if (currentDelta.kind !== "entry" || legacyDelta.kind !== "entry") {
				throw new Error("expected entry frames");
			}
			const currentDeltaBlocks = currentDelta.entry.blocks ?? [];
			expect(currentDeltaBlocks.map(block => [block.blockScope, block.blockedUntilMs])).toEqual([
				["chat", updatedChatBlockedUntilMs],
				["spark", sparkBlockedUntilMs],
			]);
			expect(legacyDelta.entry.blocks).toEqual([
				{
					providerKey: "openai-codex:oauth",
					blockScope: "shared",
					blockedUntilMs: updatedChatBlockedUntilMs,
					updatedAtMs: Math.max(...currentDeltaBlocks.map(block => block.updatedAtMs ?? 0)),
				},
			]);
		} finally {
			currentController.abort();
			legacyController.abort();
			await Promise.all([
				currentIter.return(undefined).catch(() => {}),
				legacyIter.return(undefined).catch(() => {}),
			]);
		}
	});

	test("SSE stream pushes entry frame on refresh", async () => {
		const refreshed = {
			access: "access-rotated",
			refresh: "refresh-rotated",
			expires: Date.now() + 120_000,
			accountId: "account-a",
			email: "a@example.com",
		};
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockResolvedValue(refreshed);

		const initialSnapshot = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (initialSnapshot.status !== 200) throw new Error("expected snapshot");
		const id = initialSnapshot.snapshot.credentials[0].id;

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const controller = new AbortController();
		const iter = client.openSnapshotStream({ signal: controller.signal });
		try {
			const first = await iter.next();
			if (first.done) throw new Error("expected snapshot frame");

			await storage!.refreshCredentialById(id);

			const next = await nextMatching(
				iter,
				event => event.kind === "entry" && event.entry.credential.type === "oauth" && event.entry.id === id,
			);
			if (next.kind !== "entry") throw new Error("expected entry frame");
			if (next.entry.credential.type !== "oauth") throw new Error("expected oauth credential");
			expect(next.entry.credential.access).toBe("access-rotated");
			expect(next.entry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		} finally {
			controller.abort();
			await iter.return(undefined).catch(() => {});
		}
	});

	test("SSE stream pushes removed frame on disable", async () => {
		const initialSnapshot = await new AuthBrokerClient({ url: handle!.url, token }).fetchSnapshot();
		if (initialSnapshot.status !== 200) throw new Error("expected snapshot");
		const id = initialSnapshot.snapshot.credentials[0].id;

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const controller = new AbortController();
		const iter = client.openSnapshotStream({ signal: controller.signal });
		try {
			const first = await iter.next();
			if (first.done) throw new Error("expected snapshot frame");

			const disabled = storage!.disableCredentialById(id, "revoked by test");
			expect(disabled).toBe(true);

			const next = await nextMatching(iter, event => event.kind === "removed");
			if (next.kind !== "removed") throw new Error("expected removed frame");
			expect(next.id).toBe(id);
		} finally {
			controller.abort();
			await iter.return(undefined).catch(() => {});
		}
	});

	test("SSE stream keepalive comment arrives on cadence", async () => {
		const localStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "keepalive.db"));
		localStore.saveOAuth("anthropic", mintOAuthCredential("k", Date.now() + 60_000));
		const localStorage = new AuthStorage(localStore);
		await localStorage.reload();
		const localToken = "keepalive-bearer";
		const localHandle = startAuthBroker({
			storage: localStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [localToken],
			disableRefresher: true,
			streamKeepaliveMs: 25,
		});
		const controller = new AbortController();
		try {
			const res = await fetch(`${localHandle.url}/v1/snapshot/stream`, {
				headers: { Authorization: `Bearer ${localToken}`, Accept: "text/event-stream" },
				signal: controller.signal,
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
			expect(res.headers.get("vary")).toBe(AUTH_BROKER_CAPABILITIES_HEADER);
			expect(res.body).not.toBeNull();
			const reader = (res.body as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			const deadline = Date.now() + 1_000;
			let seenKeepalive = false;
			let buffer = "";
			try {
				while (Date.now() < deadline) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					if (buffer.includes(": keepalive\n\n")) {
						seenKeepalive = true;
						break;
					}
				}
			} finally {
				await reader.cancel().catch(() => {});
			}
			expect(seenKeepalive).toBe(true);
		} finally {
			controller.abort();
			await localHandle.close();
			localStorage.close();
			localStore.close();
		}
	});

	test("openSnapshotStream throws AuthBrokerStreamUnsupportedError on 404", async () => {
		const dummy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("Not Found", { status: 404 }),
		});
		try {
			const client = new AuthBrokerClient({ url: `http://${dummy.hostname}:${dummy.port}`, token });
			const iter = client.openSnapshotStream();
			await expect(iter.next()).rejects.toBeInstanceOf(AuthBrokerStreamUnsupportedError);
		} finally {
			dummy.stop(true);
		}
	});

	test("openSnapshotStream rejects 200 responses that are not SSE", async () => {
		const dummy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
		});
		try {
			const client = new AuthBrokerClient({ url: `http://${dummy.hostname}:${dummy.port}`, token });
			const iter = client.openSnapshotStream();
			await expect(iter.next()).rejects.toThrow(/non-SSE/);
		} finally {
			dummy.stop(true);
		}
	});

	test("openSnapshotStream rejects SSE responses without an initial snapshot", async () => {
		const dummy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(": keepalive\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
		});
		try {
			const client = new AuthBrokerClient({ url: `http://${dummy.hostname}:${dummy.port}`, token });
			const iter = client.openSnapshotStream();
			await expect(iter.next()).rejects.toThrow(/initial snapshot/);
		} finally {
			dummy.stop(true);
		}
	});
});

describe("client_usage app column migration", () => {
	test("pre-app broker DBs gain the app column; legacy rows stay queryable as unlabeled", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-migrate-"));
		const dbPath = path.join(dir, "agent.db");
		// Replicate the pre-app schema exactly as older brokers created it, plus
		// one recorded legacy row — `CREATE TABLE IF NOT EXISTS` must skip it and
		// the ALTER-based migration must add the column without losing the row.
		const legacy = new Database(dbPath);
		legacy.run(`
			CREATE TABLE clients (
				install_id TEXT PRIMARY KEY,
				hostname TEXT,
				first_seen INTEGER NOT NULL,
				last_seen INTEGER NOT NULL
			);
			CREATE TABLE client_usage (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				recorded_at INTEGER NOT NULL,
				install_id TEXT NOT NULL,
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				requests INTEGER NOT NULL,
				input_tokens INTEGER NOT NULL,
				output_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL,
				cache_write_tokens INTEGER NOT NULL,
				cost_usd REAL NOT NULL DEFAULT 0
			);
		`);
		const now = Date.now();
		legacy.run("INSERT INTO clients (install_id, hostname, first_seen, last_seen) VALUES (?, ?, ?, ?)", [
			"legacy-install",
			"legacy-host",
			now,
			now,
		]);
		legacy.run(
			`INSERT INTO client_usage (recorded_at, install_id, provider, model, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[now, "legacy-install", "anthropic", "claude-x", 5, 100, 50, 10, 5, 2.5],
		);
		legacy.close();

		const migrated = await SqliteAuthCredentialStore.open(dbPath);
		try {
			migrated.recordClientUsage({
				installId: "legacy-install",
				app: "robomp",
				entries: [
					{
						at: now,
						provider: "anthropic",
						model: "claude-x",
						requests: 1,
						inputTokens: 10,
						outputTokens: 5,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						costUsd: 0.1,
					},
				],
			});
			const summary = migrated.getClientUsageSummary(0);
			const client = summary.clients.find(c => c.installId === "legacy-install");
			expect(client?.providers.find(p => p.app === undefined)).toMatchObject({
				provider: "anthropic",
				requests: 5,
				inputTokens: 100,
			});
			expect(client?.providers.find(p => p.app === "robomp")).toMatchObject({
				provider: "anthropic",
				requests: 1,
				inputTokens: 10,
			});
		} finally {
			migrated.close();
			await removeWithRetries(dir);
		}
	});
});

async function nextMatching(
	iter: AsyncGenerator<SnapshotStreamEvent>,
	predicate: (event: SnapshotStreamEvent) => boolean,
	timeoutMs = 2_000,
): Promise<SnapshotStreamEvent> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("nextMatching timeout");
		const timer = Promise.withResolvers<never>();
		const handle = setTimeout(() => timer.reject(new Error("nextMatching timeout")), remaining);
		try {
			const res = await Promise.race([iter.next(), timer.promise]);
			if (res.done) throw new Error("stream ended before predicate satisfied");
			if (predicate(res.value)) return res.value;
		} finally {
			clearTimeout(handle);
		}
	}
}
