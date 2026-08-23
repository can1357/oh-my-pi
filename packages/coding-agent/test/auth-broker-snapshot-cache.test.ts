import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	type AuthBrokerServerHandle,
	readAuthBrokerSnapshotCache,
	type SnapshotResponse,
	startAuthBroker,
	writeAuthBrokerSnapshotCache,
} from "@oh-my-pi/pi-ai/auth-broker";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const ENV_KEYS = [
	"OMP_AUTH_BROKER_URL",
	"OMP_AUTH_BROKER_TOKEN",
	"OMP_AUTH_BROKER_SNAPSHOT_CACHE",
	"OMP_AUTH_BROKER_SNAPSHOT_TTL_MS",
] as const;
const PROVIDER = "unit-auth-broker-cache";
const TOKEN = "coding-agent-cache-token";
const nativeFetch = globalThis.fetch;

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
		globalThis.fetch = nativeFetch;
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

			await expect(discoverAuthStorage(tempDir)).rejects.toMatchObject({ status: 401 });
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
		globalThis.fetch = (async (input: string | URL | Request) => {
			const requestedUrl = input instanceof Request ? input.url : String(input);
			requests.push(requestedUrl);
			const pathname = new URL(requestedUrl).pathname;
			if (pathname === "/v1/healthz") return Response.json({ ok: true });
			if (pathname === "/v1/snapshot") return Response.json(makeSnapshot(Date.now(), "broker-api-key"));
			return new Response("not found", { status: 404 });
		}) as typeof globalThis.fetch;

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

			storage = await discoverAuthStorage(tempDir);
			expect(await storage.getApiKey(PROVIDER)).toBe("broker-api-key");
			expect(requests.slice(0, 2)).toEqual([`${brokerUrl}/v1/healthz`, `${brokerUrl}/v1/snapshot`]);
		} finally {
			storage?.close();
		}
	});
});
