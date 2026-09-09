import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	discoverAuthStorage,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	if (!predicate()) throw new Error("waitUntil timeout");
}

describe("RemoteAuthCredentialStore SSE integration", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	const token = "remote-store-bearer";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-store-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveOAuth("anthropic", mintOAuthCredential("a", Date.now() + 60_000));
		storage = new AuthStorage(store);
		await storage.reload();
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		remote?.close();
		await handle?.close();
		storage?.close();
		store?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("consumes initial snapshot, upsert, and removal over SSE without manual refresh", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client });

		// 1. Initial snapshot frame populates the local store.
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const initialEntry = remote!.snapshot.credentials[0];
		expect(initialEntry.provider).toBe("anthropic");
		expect(initialEntry.credential.type).toBe("oauth");
		if (initialEntry.credential.type === "oauth") {
			expect(initialEntry.credential.access).toBe("access-a");
			expect(initialEntry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		const initialGeneration = remote!.snapshot.generation;

		// 2. Server-side upsert is delivered as an `entry` frame.
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await waitUntil(() => remote!.snapshot.credentials.length === 2);
		expect(remote!.snapshot.generation).toBeGreaterThan(initialGeneration);
		const accessTokens = remote!.snapshot.credentials
			.filter(entry => entry.credential.type === "oauth")
			.map(entry => (entry.credential.type === "oauth" ? entry.credential.access : ""))
			.sort();
		expect(accessTokens).toEqual(["access-a", "access-b"]);

		// 3. Server-side disable is delivered as a `removed` frame.
		const bId = remote!.snapshot.credentials.find(
			entry => entry.credential.type === "oauth" && entry.credential.access === "access-b",
		)?.id;
		expect(bId).toBeDefined();
		const disabled = storage!.disableCredentialById(bId!, "revoked by test");
		expect(disabled).toBe(true);
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		expect(remote!.snapshot.credentials[0].id).not.toBe(bId);
	});

	test("batches observed usage and reports it to the broker as per-install client usage", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client, observedUsageFlushMs: 25 });

		const at = Date.now();
		// Two requests for the same (provider, model) must merge into one entry;
		// a second model produces its own entry in the same flush.
		remote.recordObservedUsage([
			{
				at,
				provider: "anthropic",
				model: "claude-x",
				requests: 1,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 10,
				cacheWriteTokens: 5,
				costUsd: 0.5,
			},
		]);
		remote.recordObservedUsage([
			{
				at: at + 1,
				provider: "anthropic",
				model: "claude-x",
				requests: 1,
				inputTokens: 200,
				outputTokens: 100,
				cacheReadTokens: 20,
				cacheWriteTokens: 10,
				costUsd: 1.0,
			},
			{
				at: at + 2,
				provider: "openai-codex",
				model: "gpt-y",
				requests: 1,
				inputTokens: 30,
				outputTokens: 15,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0,
			},
		]);

		await waitUntil(() => storage!.getClientUsageSummary(0).clients.length === 1);
		const summary = storage!.getClientUsageSummary(0);
		const reported = summary.clients[0];
		expect(reported.installId.length).toBeGreaterThan(0);
		expect(reported.hostname).toBe(os.hostname());
		// Default identity carries the app label so broker-side attribution can
		// answer "what did app X use" even for broker-direct installs.
		expect(reported.providers.every(p => p.app === "omp")).toBe(true);

		const anthropic = reported.providers.find(p => p.provider === "anthropic");
		expect(anthropic).toMatchObject({
			requests: 2,
			inputTokens: 300,
			outputTokens: 150,
			cacheReadTokens: 30,
			cacheWriteTokens: 15,
		});
		expect(anthropic?.costUsd).toBeCloseTo(1.5, 10);
		expect(reported.providers.find(p => p.provider === "openai-codex")).toMatchObject({
			requests: 1,
			inputTokens: 30,
		});

		// A follow-up report — routed through the client-side AuthStorage facade,
		// like the coding-agent does per assistant message — merges into the same
		// 5-minute bucket row instead of accreting a new row per flush.
		const clientStorage = new AuthStorage(remote);
		clientStorage.recordObservedUsage({
			provider: "anthropic",
			model: "claude-x",
			at: at + 3,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		});
		await waitUntil(() => {
			const current = storage!.getClientUsageSummary(0).clients[0];
			return current?.providers.find(p => p.provider === "anthropic")?.requests === 3;
		});
		// An explicit identity (the auth-gateway attributing a caller) must
		// produce its own client row instead of folding into this install.
		remote.recordObservedUsage(
			[
				{
					at: at + 4,
					provider: "anthropic",
					model: "claude-x",
					requests: 1,
					inputTokens: 7,
					outputTokens: 3,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costUsd: 0.05,
				},
			],
			{ installId: "robomp-install", hostname: "robomp-box", app: "robomp" },
		);
		await waitUntil(() => storage!.getClientUsageSummary(0).clients.length === 2);
		const attributed = storage!.getClientUsageSummary(0).clients.find(c => c.installId === "robomp-install");
		expect(attributed?.hostname).toBe("robomp-box");
		expect(attributed?.providers).toEqual([
			{
				app: "robomp",
				provider: "anthropic",
				requests: 1,
				inputTokens: 7,
				outputTokens: 3,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0.05,
			},
		]);
	});

	test("background sync parks after the idle window and resumes on the next store use", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const openSpy = vi.spyOn(client, "openSnapshotStream");
		remote = new RemoteAuthCredentialStore({ client, backgroundIdleMs: 150 });

		// Stream opens immediately (construction counts as activity).
		await waitUntil(() => openSpy.mock.calls.length === 1);
		const firstSignal = openSpy.mock.calls[0]![0]!.signal!;

		// Idle window elapses with no foreground use: the in-flight SSE request
		// is aborted without close(). A leaked store would otherwise hold this
		// connection forever and pin the process (the git-tui hang).
		await waitUntil(() => firstSignal.aborted);

		// Parked: no reconnect attempts while the store stays unused.
		// Real delay on purpose: the idle watchdog runs on real unref'd timers
		// against a live SSE server, so fake timers cannot drive this path.
		await Bun.sleep(300);
		expect(openSpy.mock.calls.length).toBe(1);

		// Any foreground use wakes the loop and re-establishes the stream.
		remote.listAuthCredentials();
		await waitUntil(() => openSpy.mock.calls.length === 2);
		expect(openSpy.mock.calls[1]![0]!.signal!.aborted).toBe(false);
	});

	test("calls onSnapshot for broker snapshots but not the constructor snapshot", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const callbacks: Array<{ snapshot: SnapshotResponse; generation: number }> = [];
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			onSnapshot: (snapshot, generation) => {
				callbacks.push({ snapshot, generation });
			},
		});
		expect(callbacks).toHaveLength(0);

		const refreshed = await remote.refreshSnapshot();

		expect(callbacks).toHaveLength(1);
		expect(callbacks[0].generation).toBe(refreshed.generation);
		expect(callbacks[0].snapshot).toEqual(refreshed);
	});

	test("filters configured OAuth identities while preserving API keys and raw snapshot callbacks", async () => {
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		storage!.upsertCredential("anthropic", { type: "api_key", key: "visible-api-key" });
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowed = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("a@example.com"));
		const excluded = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("b@example.com"));
		if (!allowed?.identityKey || !excluded?.identityKey) throw new Error("expected OAuth identity keys");
		const identities = new Set([allowed.identityKey]);
		const callbacks: SnapshotResponse[] = [];
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", identities]]),
			onSnapshot: snapshot => {
				callbacks.push(snapshot);
			},
		});

		identities.add(excluded.identityKey);
		expect(
			remote
				.listAuthCredentials("anthropic")
				.map(entry => entry.credential.type)
				.sort(),
		).toEqual(["api_key", "oauth"]);
		const refreshed = await remote.refreshSnapshot();
		expect(refreshed.credentials.filter(entry => entry.credential.type === "oauth")).toHaveLength(1);
		expect(callbacks.at(-1)?.credentials).toHaveLength(3);
	});

	test("advances the SSE generation without exposing an excluded entry", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowed = initialResult.snapshot.credentials[0];
		if (!allowed?.identityKey) throw new Error("expected OAuth identity key");
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			accountPool: new Map([["anthropic", new Set([allowed.identityKey])]]),
		});
		const initialGeneration = remote.snapshot.generation;

		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await waitUntil(() => remote!.snapshot.generation > initialGeneration);

		expect(remote.snapshot.credentials).toHaveLength(1);
		expect(remote.snapshot.credentials[0]?.identityKey).toBe(allowed.identityKey);
	});

	test("treats a missing provider as unrestricted and an empty provider pool as OAuth-disabled", async () => {
		storage!.upsertCredential("openai-codex", mintOAuthCredential("codex", Date.now() + 120_000));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", new Set()]]),
		});

		expect(remote.listAuthCredentials("anthropic")).toEqual([]);
		expect(remote.listAuthCredentials("openai-codex")).toHaveLength(1);
	});

	test("loads the account pool once for broker-backed discovery", async () => {
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowed = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("a@example.com"));
		const excluded = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("b@example.com"));
		if (!allowed?.identityKey || !excluded?.identityKey) throw new Error("expected OAuth identity keys");
		const poolPath = path.join(tempDir, "account-pool.json");
		await Bun.write(poolPath, JSON.stringify({ anthropic: [allowed.identityKey] }));

		await withEnv(
			{
				OMP_AUTH_BROKER_URL: handle!.url,
				OMP_AUTH_BROKER_TOKEN: token,
				OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: poolPath,
			},
			async () => {
				const discovered = await discoverAuthStorage({
					agentDir: tempDir,
					cachePath: path.join(tempDir, "snapshot-cache.enc"),
				});
				try {
					expect(discovered.listOAuthAccounts("anthropic").map(account => account.email)).toEqual([
						"a@example.com",
					]);

					await Bun.write(poolPath, JSON.stringify({ anthropic: [allowed.identityKey, excluded.identityKey] }));
					await discovered.reload();
					expect(discovered.listOAuthAccounts("anthropic").map(account => account.email)).toEqual([
						"a@example.com",
					]);
				} finally {
					discovered.close();
				}
			},
		);
	});

	test("prefers a programmatic SDK account pool over the environment file", async () => {
		await withEnv(
			{
				OMP_AUTH_BROKER_URL: handle!.url,
				OMP_AUTH_BROKER_TOKEN: token,
				OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: path.join(tempDir, "missing-account-pool.json"),
			},
			async () => {
				const discovered = await discoverAuthStorage({
					agentDir: tempDir,
					cachePath: path.join(tempDir, "sdk-snapshot-cache.enc"),
					accountPool: new Map([["anthropic", new Set()]]),
				});
				try {
					expect(discovered.listOAuthAccounts("anthropic")).toEqual([]);
				} finally {
					discovered.close();
				}
			},
		);
	});
});
