import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	AuthBrokerStreamUnsupportedError,
	type SnapshotStreamEvent,
	startAuthBroker,
} from "@pk-nerdsaver-ai/pi-ai/auth-broker";
import * as oauthUtils from "@pk-nerdsaver-ai/pi-ai/registry/oauth";
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

	test("GET /v1/snapshot returns generation headers and 304 for unchanged long-poll", async () => {
		const res = await fetch(`${handle!.url}/v1/snapshot`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { generation: number; serverNowMs: number; refresher: { enabled: boolean } };
		expect(res.headers.get("etag")).toBe(`"${body.generation}"`);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(body.generation).toBeGreaterThan(0);
		expect(body.serverNowMs).toBeGreaterThan(0);
		expect(body.refresher.enabled).toBe(false);

		const client = new AuthBrokerClient({ url: handle!.url, token });
		const unchanged = await client.fetchSnapshot({ ifGenerationGt: body.generation, waitMs: 10 });
		expect(unchanged.status).toBe(304);
		expect(unchanged.generation).toBe(body.generation);
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
