import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	type AuthBrokerServerHandle,
	readAuthBrokerSnapshotCache,
	SNAPSHOT_CACHE_REVALIDATION_TIMEOUT_MS,
	type SnapshotResponse,
	startAuthBroker,
	writeAuthBrokerSnapshotCache,
} from "@oh-my-pi/pi-ai/auth-broker";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const ENV_KEYS = [
	"OMP_AUTH_BROKER_URL",
	"OMP_AUTH_BROKER_TOKEN",
	"OMP_AUTH_BROKER_SNAPSHOT_CACHE",
	"OMP_AUTH_BROKER_SNAPSHOT_TTL_MS",
] as const;
const PROVIDER = "unit-auth-broker-cache";
const TOKEN = "coding-agent-cache-token";

type FetchInput = string | URL | Request;

/** Typed like the global so `DiscoverAuthStorageOptions.fetch` accepts it without touching `globalThis.fetch`. */
function fakeFetch(handler: (input: FetchInput, init?: RequestInit) => Promise<Response>): typeof fetch {
	return Object.assign(handler, { preconnect: fetch.preconnect });
}

/** Rejects with the signal's reason once it aborts, like a stalled proxy that never answers. */
function stallUntilAbort(signal: AbortSignal | null | undefined): Promise<Response> {
	const { promise, reject } = Promise.withResolvers<Response>();
	if (signal?.aborted) reject(signal.reason);
	else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	return promise;
}

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function makeSnapshot(urlTime: number, apiKey = "cached-api-key"): SnapshotResponse {
	return {
		generation: 11,
		generatedAt: urlTime,
		serverNowMs: urlTime,
		refresher: {
			enabled: false,
			intervalMs: 60_000,
			skewMs: 300_000,
			nextSweepInMs: Number.MAX_SAFE_INTEGER,
		},
		credentials: [
			{
				id: 1,
				provider: PROVIDER,
				credential: { type: "api_key", key: apiKey },
				identityKey: null,
				rotatesInMs: null,
			},
		],
	};
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	if (!(await predicate())) throw new Error("waitUntil timeout");
}

describe("discoverAuthStorage auth-broker snapshot cache", () => {
	let tempDir = "";

	beforeEach(async () => {
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "coding-agent-auth-broker-cache-"));
	});

	afterEach(async () => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		await removeWithRetries(tempDir);
	});

	test("boots from a fresh encrypted cache when the broker is down", async () => {
		const cachePath = path.join(tempDir, "snapshot.enc");
		const downUrl = "http://127.0.0.1:1";
		process.env.OMP_AUTH_BROKER_URL = downUrl;
		process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
		process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";
		await writeAuthBrokerSnapshotCache({
			path: cachePath,
			token: TOKEN,
			url: downUrl,
			snapshot: makeSnapshot(Date.now()),
		});

		const storage = await discoverAuthStorage(tempDir);
		try {
			expect(await storage.getApiKey(PROVIDER)).toBe("cached-api-key");
		} finally {
			storage.close();
		}
	});

	test("seeds the encrypted cache after an initial broker fetch", async () => {
		const cachePath = path.join(tempDir, "snapshot.enc");
		const brokerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		brokerStore.saveApiKey(PROVIDER, "broker-api-key");
		const brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.reload();
		let handle: AuthBrokerServerHandle | undefined;
		let storage: AuthStorage | undefined;
		try {
			handle = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [TOKEN],
				disableRefresher: true,
			});
			process.env.OMP_AUTH_BROKER_URL = handle.url;
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";

			storage = await discoverAuthStorage(tempDir);
			expect(await storage.getApiKey(PROVIDER)).toBe("broker-api-key");
			await waitUntil(async () => {
				const cached = await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: TOKEN,
					url: handle!.url,
					ttlMs: 3_600_000,
				});
				return cached?.credentials.some(entry => entry.provider === PROVIDER) ?? false;
			});
			const cached = await readAuthBrokerSnapshotCache({
				path: cachePath,
				token: TOKEN,
				url: handle.url,
				ttlMs: 3_600_000,
			});
			const entry = cached?.credentials.find(candidate => candidate.provider === PROVIDER);
			expect(entry?.credential).toEqual({ type: "api_key", key: "broker-api-key" });
		} finally {
			storage?.close();
			await handle?.close();
			brokerStorage.close();
			brokerStore.close();
		}
	});

	test("boots from a fresh cache when revalidation returns a server error", async () => {
		const cachePath = path.join(tempDir, "snapshot.enc");
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("temporarily unavailable", { status: 503 }),
		});
		const url = server.url.toString();
		let storage: AuthStorage | undefined;
		try {
			process.env.OMP_AUTH_BROKER_URL = url;
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";
			await writeAuthBrokerSnapshotCache({
				path: cachePath,
				token: TOKEN,
				url,
				snapshot: makeSnapshot(Date.now()),
			});

			storage = await discoverAuthStorage(tempDir);
			expect(await storage.getApiKey(PROVIDER)).toBe("cached-api-key");
		} finally {
			storage?.close();
			server.stop(true);
		}
	});

	test("rejects a fresh cache when the broker rejects its bearer token", async () => {
		const cachePath = path.join(tempDir, "snapshot.enc");
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("unauthorized", { status: 401 }),
		});
		const url = server.url.toString();
		try {
			process.env.OMP_AUTH_BROKER_URL = url;
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";
			await writeAuthBrokerSnapshotCache({
				path: cachePath,
				token: TOKEN,
				url,
				snapshot: makeSnapshot(Date.now()),
			});

			await expect(discoverAuthStorage(tempDir)).rejects.toMatchObject({ status: 401, kind: "unauthorized" });
		} finally {
			server.stop(true);
		}
	});

	test("prefers a reachable broker snapshot over a fresh cached snapshot", async () => {
		const cachePath = path.join(tempDir, "snapshot.enc");
		const brokerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		brokerStore.saveApiKey(PROVIDER, "broker-api-key");
		const brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.reload();
		let handle: AuthBrokerServerHandle | undefined;
		let storage: AuthStorage | undefined;
		try {
			handle = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [TOKEN],
				disableRefresher: true,
			});
			process.env.OMP_AUTH_BROKER_URL = handle.url;
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";
			await writeAuthBrokerSnapshotCache({
				path: cachePath,
				token: TOKEN,
				url: handle.url,
				snapshot: makeSnapshot(Date.now()),
			});

			storage = await discoverAuthStorage(tempDir);
			expect(await storage.getApiKey(PROVIDER)).toBe("broker-api-key");
		} finally {
			storage?.close();
			await handle?.close();
			brokerStorage.close();
			brokerStore.close();
		}
	});

	test("uses the proxy-aware client transport for cached-broker reachability", async () => {
		const cachePath = path.join(tempDir, "snapshot.enc");
		const brokerUrl = "https://broker.proxy-only.invalid";
		const requests: string[] = [];
		let storage: AuthStorage | undefined;
		const transport = fakeFetch(async input => {
			const requestedUrl = input instanceof Request ? input.url : String(input);
			requests.push(requestedUrl);
			const pathname = new URL(requestedUrl).pathname;
			if (pathname === "/v1/healthz") return Response.json({ ok: true });
			if (pathname === "/v1/snapshot") return Response.json(makeSnapshot(Date.now(), "broker-api-key"));
			return new Response("not found", { status: 404 });
		});

		try {
			process.env.OMP_AUTH_BROKER_URL = brokerUrl;
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";
			await writeAuthBrokerSnapshotCache({
				path: cachePath,
				token: TOKEN,
				url: brokerUrl,
				snapshot: makeSnapshot(Date.now()),
			});

			storage = await discoverAuthStorage(tempDir, { fetch: transport });
			expect(await storage.getApiKey(PROVIDER)).toBe("broker-api-key");
			expect(requests.slice(0, 2)).toEqual([`${brokerUrl}/v1/healthz`, `${brokerUrl}/v1/snapshot`]);
		} finally {
			storage?.close();
		}
	});

	test("revalidation defaults to a 500 ms startup budget", () => {
		expect(SNAPSHOT_CACHE_REVALIDATION_TIMEOUT_MS).toBe(500);
	});

	test("healthz and the snapshot fetch share one revalidation deadline", async () => {
		const cachePath = path.join(tempDir, "snapshot.enc");
		const brokerUrl = "https://broker.stalled-snapshot.invalid";
		// No clock: the test owns the deadline and releases each request itself.
		const deadline = new AbortController();
		const budgetExhausted = new Error("revalidation budget exhausted");
		const healthzRequested = Promise.withResolvers<AbortSignal | null | undefined>();
		const healthzRelease = Promise.withResolvers<void>();
		const snapshotRequested = Promise.withResolvers<AbortSignal | null | undefined>();
		const snapshotSettled = Promise.withResolvers<unknown>();
		let storage: AuthStorage | undefined;
		const transport = fakeFetch(async (input, init) => {
			const requestedUrl = input instanceof Request ? input.url : String(input);
			const pathname = new URL(requestedUrl).pathname;
			if (pathname === "/v1/healthz") {
				healthzRequested.resolve(init?.signal);
				await healthzRelease.promise;
				return Response.json({ ok: true });
			}
			// The store's background `/v1/snapshot/stream` also lands here and
			// stalls until close; only the startup `/v1/snapshot` is observed.
			if (pathname !== "/v1/snapshot") return stallUntilAbort(init?.signal);
			snapshotRequested.resolve(init?.signal);
			try {
				return await stallUntilAbort(init?.signal);
			} catch (reason) {
				snapshotSettled.resolve(reason);
				throw reason;
			}
		});

		try {
			process.env.OMP_AUTH_BROKER_URL = brokerUrl;
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_CACHE = cachePath;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "3600000";
			await writeAuthBrokerSnapshotCache({
				path: cachePath,
				token: TOKEN,
				url: brokerUrl,
				snapshot: makeSnapshot(Date.now()),
			});

			const discovery = discoverAuthStorage(tempDir, { fetch: transport, revalidationSignal: deadline.signal });
			const healthzSignal = await healthzRequested.promise;
			healthzRelease.resolve();
			const snapshotSignal = await snapshotRequested.promise;
			expect(snapshotSignal?.aborted).toBeFalse();

			// Exhausting the one injected deadline after healthz already answered
			// must cut the in-flight snapshot off with that same reason; a fresh
			// per-request budget would leave it stalled on the client's timeout.
			deadline.abort(budgetExhausted);
			expect(await snapshotSettled.promise).toBe(budgetExhausted);
			expect(healthzSignal?.aborted).toBeTrue();
			expect(healthzSignal?.reason).toBe(budgetExhausted);

			storage = await discovery;
			expect(await storage.getApiKey(PROVIDER)).toBe("cached-api-key");
		} finally {
			storage?.close();
		}
	});
});
