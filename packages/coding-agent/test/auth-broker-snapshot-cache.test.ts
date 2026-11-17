import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerError,
	type AuthBrokerServerHandle,
	openAuthCredentialStore,
	readAuthBrokerSnapshotCache,
	type SnapshotResponse,
	startAuthBroker,
	writeAuthBrokerSnapshotCache,
} from "@oh-my-pi/pi-ai/auth-broker";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

const ENV_KEYS = [
	"OMP_AUTH_BROKER_URL",
	"OMP_AUTH_BROKER_TOKEN",
	"OMP_AUTH_BROKER_SNAPSHOT_CACHE",
	"OMP_AUTH_BROKER_SNAPSHOT_TTL_MS",
] as const;
const PROVIDER = "unit-auth-broker-cache";
const TOKEN = "coding-agent-cache-token";

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function makeSnapshot(urlTime: number): SnapshotResponse {
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
				credential: { type: "api_key", key: "cached-api-key" },
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

	test("retries the initial snapshot while the broker restarts", async () => {
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
		// The proxy in front of the broker answers 503 to the first snapshot request, as during a restart.
		let snapshotRequests = 0;
		const proxy = Bun.serve({
			port: 0,
			fetch: request => {
				const { pathname, search } = new URL(request.url);
				if (pathname === "/v1/snapshot" && ++snapshotRequests === 1) {
					return new Response("restarting", { status: 503 });
				}
				return fetch(new URL(`${pathname}${search}`, handle.url), request);
			},
		});
		let storage: AuthStorage | undefined;
		try {
			process.env.OMP_AUTH_BROKER_URL = proxy.url.toString();
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "0";
			storage = await discoverAuthStorage(tempDir);
			expect(await storage.keys.get(PROVIDER)).toBe("broker-api-key");
			expect(snapshotRequests).toBe(2);
		} finally {
			storage?.close();
			proxy.stop(true);
			await handle.close();
			brokerStorage.close();
			brokerStore.close();
		}
	});

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

	test("fails startup once the broker stays unreachable for the whole retry budget", async () => {
		// The broker accepts connections and never answers.
		const reached = Promise.withResolvers<void>();
		const hang = Promise.withResolvers<Response>();
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				reached.resolve();
				return hang.promise;
			},
		});
		const turn = () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			return promise;
		};
		vi.useFakeTimers();
		try {
			process.env.OMP_AUTH_BROKER_URL = server.url.toString();
			process.env.OMP_AUTH_BROKER_TOKEN = TOKEN;
			process.env.OMP_AUTH_BROKER_SNAPSHOT_TTL_MS = "0";
			let settled = false;
			const outcome = rejectionOf(discoverAuthStorage(tempDir)).finally(() => {
				settled = true;
			});
			await reached.promise;
			// Short of 30 s of fake time, startup is still waiting on the broker.
			for (let second = 1; second < 30; second++) {
				vi.advanceTimersByTime(1_000);
				await turn();
			}
			expect(settled).toBe(false);
			// At 30 s the deadline cancels the request in flight.
			vi.advanceTimersByTime(1_000);
			expect(await outcome).toBeInstanceOf(AuthBrokerError);
		} finally {
			vi.useRealTimers();
			hang.resolve(new Response(null, { status: 503 }));
			server.stop(true);
		}
	});
});
