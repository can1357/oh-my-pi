import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerError,
	type AuthBrokerServerHandle,
	type AuthBrokerStartupRetry,
	openAuthCredentialStore,
	readAuthBrokerSnapshotCache,
	type SnapshotResponse,
	startAuthBroker,
	writeAuthBrokerSnapshotCache,
} from "@oh-my-pi/pi-ai/auth-broker";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { removeWithRetries, setInteractiveHost } from "@oh-my-pi/pi-utils";
import { flush } from "./helpers/fake-clock";
import { rejectionOf } from "./helpers/rejection";

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
		vi.useRealTimers();
		vi.restoreAllMocks();
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
			expect(await storage.keys.get(PROVIDER)).toBe("cached-api-key");
		} finally {
			storage.close();
		}
	});

	test("seeds the encrypted cache after an initial broker fetch", async () => {
		const cachePath = path.join(tempDir, "snapshot.enc");
		const brokerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		await brokerStore.saveApiKey(PROVIDER, "broker-api-key");
		const brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.credentials.reload();
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
			expect(await storage.keys.get(PROVIDER)).toBe("broker-api-key");
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
			expect(await storage.keys.get(PROVIDER)).toBe("cached-api-key");
		} finally {
			storage?.close();
			server.stop(true);
		}
	});

	// A TCP proxy in front of the broker sends a raw reply to the first connection
	// (the startup snapshot request), as during a restart, and pipes later ones through.
	const interruptions = [
		{
			name: "answers 503",
			firstReply: "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 10\r\nConnection: close\r\n\r\nrestarting",
			status: 503,
		},
		{
			name: "drops the connection mid-body",
			firstReply: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"generation":',
			status: undefined,
		},
	];
	test.each(interruptions)(
		"retries the initial snapshot when the broker $name, reporting the retry",
		async ({ firstReply, status }) => {
			const brokerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
			await brokerStore.saveApiKey(PROVIDER, "broker-api-key");
			const brokerStorage = new AuthStorage(brokerStore);
			await brokerStorage.credentials.reload();
			const handle = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [TOKEN],
				disableRefresher: true,
			});
			const brokerPort = Number(new URL(handle.url).port);
			let connections = 0;
			const proxy = Bun.listen<{ first: boolean; upstream?: Promise<Bun.Socket> }>({
				hostname: "127.0.0.1",
				port: 0,
				socket: {
					open(client) {
						client.data = { first: ++connections === 1 };
						if (client.data.first) return;
						client.data.upstream = Bun.connect({
							hostname: "127.0.0.1",
							port: brokerPort,
							socket: {
								data: (_upstream, chunk) => {
									client.write(chunk);
								},
								close: () => {
									client.end();
								},
							},
						});
					},
					async data(client, chunk) {
						if (client.data.first) client.end(firstReply);
						else (await client.data.upstream)?.write(chunk);
					},
					async close(client) {
						(await client.data.upstream)?.end();
					},
				},
			});
			const proxyUrl = `http://127.0.0.1:${proxy.port}/`;
			let storage: AuthStorage | undefined;
			try {
				process.env.OMP_AUTH_BROKER_URL = proxyUrl;
				process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
				process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "0";
				const retries: AuthBrokerStartupRetry[] = [];
				storage = await discoverAuthStorage(tempDir, { onBrokerRetry: retry => retries.push(retry) });
				expect(await storage.keys.get(PROVIDER)).toBe("broker-api-key");
				expect(retries).toMatchObject([{ url: proxyUrl, error: { status }, delayMs: 500, budgetMs: 30_000 }]);
			} finally {
				storage?.close();
				proxy.stop(true);
				await handle.close();
				brokerStorage.close();
				brokerStore.close();
			}
		},
	);

	test("fails at once on a rejected token, and on any failure when switching brokers at runtime", async () => {
		let status = 401;
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				requests += 1;
				return new Response("refused", { status });
			},
		});
		try {
			process.env.OMP_AUTH_BROKER_URL = server.url.toString();
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "0";
			expect(await rejectionOf(discoverAuthStorage(tempDir))).toMatchObject({ status: 401 });
			expect(requests).toBe(1);

			status = 503;
			requests = 0;
			const switched = openAuthCredentialStore({ brokerConfig: { url: server.url.toString(), token: TOKEN } });
			expect(await rejectionOf(switched)).toMatchObject({ status: 503 });
			expect(requests).toBe(1);
		} finally {
			server.stop(true);
		}
	});

	// A restarting broker answers 503; a later answer the retry cannot fix (401) ends startup.
	test.each([
		{ interactive: true, requests: 1, notice: false },
		{ interactive: false, requests: 2, notice: true },
	])(
		"retries only outside interactive omp (interactive: $interactive)",
		async ({ interactive, requests, notice }) => {
			let served = 0;
			using server = Bun.serve({
				port: 0,
				fetch: () => new Response("unavailable", { status: ++served === 1 ? 503 : 401 }),
			});
			process.env.OMP_AUTH_BROKER_URL = server.url.toString();
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "0";
			const previous = setInteractiveHost(interactive);
			let stderr = "";
			vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
				stderr += String(chunk);
				return true;
			});
			try {
				await expect(discoverAuthStorage(tempDir)).rejects.toBeInstanceOf(AuthBrokerError);
			} finally {
				vi.restoreAllMocks();
				setInteractiveHost(previous);
			}
			expect(served).toBe(requests);
			expect(stderr.includes("Waiting for auth broker")).toBe(notice);
		},
		15_000,
	);

	test("fails startup once the broker stays unreachable for the whole retry budget", async () => {
		// The broker accepts connections and never answers. Each startup fetch makes two attempts,
		// each cut by the client's 10 s request timeout, so startup retries once within its 30 s
		// budget, whose deadline then cancels the third request in flight. Fake time moves only
		// in fixed steps, each after the event it waits for, never by event-loop turns.
		const hang = Promise.withResolvers<Response>();
		const requests = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
		const unseen = [...requests];
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				unseen.shift()?.resolve();
				return hang.promise;
			},
		});
		// The client takes the global `fetch` when startup makes it; each call's signal is the one
		// the deadline aborts.
		const fetched = vi.spyOn(globalThis, "fetch");
		vi.useFakeTimers();
		try {
			process.env.OMP_AUTH_BROKER_URL = server.url.toString();
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "0";
			const retries: AuthBrokerStartupRetry[] = [];
			const retried = Promise.withResolvers<void>();
			const discovered = discoverAuthStorage(tempDir, {
				onBrokerRetry: retry => {
					retries.push(retry);
					retried.resolve();
				},
			});
			let settled = false;
			const outcome = rejectionOf(discovered).finally(() => {
				settled = true;
			});
			// Each step waits for an event only startup that is still running makes; if startup
			// ends first, the step fails saying so rather than at the test's timeout.
			const before = <T>(event: Promise<T>, what: string) =>
				Promise.race([
					event,
					outcome.then(error => {
						throw new Error(`startup ended before ${what}: ${error}`);
					}),
				]);
			await before(requests[0].promise, "the first request");
			// The 10 s steps and two attempts per fetch follow `DEFAULT_TIMEOUT_MS` and `DEFAULT_MAX_RETRIES` in
			// packages/ai/src/auth-broker/client.ts. A longer timeout or another retry count leaves a step below
			// waiting until the test times out; a timeout under 9.5 s fails the in-flight check 1 ms short of 30 s.
			// At 10 s the request timeout cuts the first attempt, and the client makes its second.
			vi.advanceTimersByTime(10_000);
			await before(requests[1].promise, "the second request");
			// At 20 s it cuts that one too: startup reports one retry and waits 500 ms.
			vi.advanceTimersByTime(10_000);
			await before(retried.promise, "the retry");
			expect(retries).toMatchObject([{ delayMs: 500, budgetMs: 30_000 }]);
			// No third request before 500 ms of fake time. Fixed steps, not a step to the next timer: the wait
			// is `scheduler.wait`, which Bun may stop faking. Exactly one turn, not `flush()`'s default: where
			// that wait runs on real time, the check must come before it can fire.
			vi.advanceTimersByTime(499);
			await flush(1);
			expect(fetched).toHaveBeenCalledTimes(2);
			vi.advanceTimersByTime(1);
			await before(requests[2].promise, "the third request");
			const third = fetched.mock.calls.at(-1)?.[1]?.signal;
			expect(fetched).toHaveBeenCalledTimes(3);
			// 1 ms short of 30 s, the third request is still in flight.
			vi.advanceTimersByTime(9_499);
			// Let the promise jobs that advance queued run, so an early end shows below.
			await flush(1);
			expect(third?.aborted).toBe(false);
			expect(settled).toBe(false);
			// At 30 s the deadline cancels it.
			vi.advanceTimersByTime(1);
			expect(third?.aborted).toBe(true);
			expect(await outcome).toBeInstanceOf(AuthBrokerError);
			// Giving up is not reported as one more retry.
			expect(retries).toHaveLength(1);
			// Counted at the `fetch` spy, so a request started at the deadline counts too.
			expect(fetched).toHaveBeenCalledTimes(3);
		} finally {
			// A check that fails before 30 s leaves startup retrying: fire its budget before real timers return.
			vi.advanceTimersByTime(30_000);
			hang.resolve(new Response(null, { status: 503 }));
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

			await expect(discoverAuthStorage(tempDir)).rejects.toMatchObject({ status: 401, kind: "unauthorized", url });
		} finally {
			server.stop(true);
		}
	});

	test("prefers a reachable broker snapshot over a fresh cached snapshot", async () => {
		const cachePath = path.join(tempDir, "snapshot.enc");
		const brokerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		await brokerStore.saveApiKey(PROVIDER, "broker-api-key");
		const brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.credentials.reload();
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
			expect(await storage.keys.get(PROVIDER)).toBe("broker-api-key");
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
			expect(await storage.keys.get(PROVIDER)).toBe("broker-api-key");
			expect(requests.slice(0, 2)).toEqual([`${brokerUrl}/v1/healthz`, `${brokerUrl}/v1/snapshot`]);
		} finally {
			storage?.close();
		}
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
			expect(await storage.keys.get(PROVIDER)).toBe("cached-api-key");
		} finally {
			storage?.close();
		}
	});
});
