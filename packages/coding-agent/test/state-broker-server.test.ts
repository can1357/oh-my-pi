import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { StateBrokerClient, StateBrokerError } from "@oh-my-pi/pi-coding-agent/state-broker/client";
import { createStateBrokerRoutes } from "@oh-my-pi/pi-coding-agent/state-broker/server";
import { StateBrokerStore } from "@oh-my-pi/pi-coding-agent/state-broker/store";
import type { StateEntry } from "@oh-my-pi/pi-coding-agent/state-broker/wire";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const TOKEN = "t";

/**
 * Real delay. These long-poll cases are integration tests over a live HTTP
 * broker: the server parks the request on an in-process timer/notifier behind
 * a real socket, so fake timers cannot drive it across the network boundary.
 * The waits are the minimum needed to let a request reach the server and park.
 */
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref?.();
	return promise;
}

describe("state broker HTTP surface", () => {
	let tempDir = "";
	let authStore: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let store: StateBrokerStore | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let client: StateBrokerClient;
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "state-broker-server-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		authStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(authStore);
		await storage.reload();
		store = StateBrokerStore.open(path.join(tempDir, "state.db"));
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [TOKEN],
			disableRefresher: true,
			routes: [createStateBrokerRoutes(store)],
		});
		client = new StateBrokerClient({ url: handle.url, token: TOKEN, maxRetries: 0 });
	});

	afterEach(async () => {
		await handle?.close();
		store?.close();
		storage?.close();
		authStore?.close();
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		await removeWithRetries(tempDir);
	});

	test("unauthenticated request -> 401", async () => {
		const res = await fetch(`${handle!.url}/v1/state`);
		expect(res.status).toBe(401);
	});

	test("wrong bearer -> 401", async () => {
		const wrong = new StateBrokerClient({ url: handle!.url, token: "nope", maxRetries: 0 });
		try {
			await wrong.summary();
			throw new Error("expected 401");
		} catch (error) {
			expect(error).toBeInstanceOf(StateBrokerError);
			expect((error as StateBrokerError).status).toBe(401);
		}
	});

	test("GET /v1/state returns the summary shape", async () => {
		store!.push("history", [{ key: "a", rev: 10, value: 1 }]);
		const summary = await client.summary();
		expect(typeof summary.generatedAt).toBe("number");
		expect(summary.domains.length).toBeGreaterThan(0);
		const history = summary.domains.find(d => d.domain === "history");
		expect(history).toEqual({ domain: "history", seq: 1, entries: 1 });
		// Every domain reports numeric counters.
		for (const d of summary.domains) {
			expect(Number.isFinite(d.seq)).toBe(true);
			expect(Number.isFinite(d.entries)).toBe(true);
		}
	});

	test("GET /v1/state/:domain delta paging round-trip", async () => {
		const entries: StateEntry[] = [];
		for (let i = 1; i <= 5; i += 1) entries.push({ key: `k${i}`, rev: i, value: i });
		const push = await client.push("history", entries);
		expect(push).toEqual({ domain: "history", seq: 5, accepted: 5 });

		const first = await client.delta("history", 0, { limit: 2 });
		expect(first.entries.map(e => e.key)).toEqual(["k1", "k2"]);
		expect(first.seq).toBe(2);
		expect(first.more).toBe(true);

		const second = await client.delta("history", first.seq, { limit: 2 });
		expect(second.entries.map(e => e.key)).toEqual(["k3", "k4"]);
		expect(second.more).toBe(true);

		const third = await client.delta("history", second.seq, { limit: 2 });
		expect(third.entries.map(e => e.key)).toEqual(["k5"]);
		expect(third.more).toBe(false);
		expect(third.seq).toBe(5);
	});

	test("unknown domain -> 404", async () => {
		const res = await fetch(`${handle!.url}/v1/state/bogus`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(404);
	});

	test("POST with malformed JSON body -> 400", async () => {
		const res = await fetch(`${handle!.url}/v1/state/history`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body: "{ not json",
		});
		expect(res.status).toBe(400);
	});

	test("POST with a non-integer rev -> 400 (statePushRequestSchema rejects it)", async () => {
		// The bug that shipped: a fractional epoch-millis rev slipped through.
		// `rev: "number.integer >= 0"` must reject it with a 400 the client
		// surfaces as a StateBrokerError.
		try {
			await client.push("history", [{ key: "k", rev: 1787868314876.4448, value: 1 }]);
			throw new Error("expected 400 for non-integer rev");
		} catch (error) {
			expect(error).toBeInstanceOf(StateBrokerError);
			expect((error as StateBrokerError).status).toBe(400);
		}
		// Rejected push stored nothing.
		expect(store!.currentSeq("history")).toBe(0);
	});

	test("long-poll with an up-to-date cursor resolves empty instead of hanging", async () => {
		store!.push("history", [{ key: "k", rev: 1, value: 1 }]);
		const start = Date.now();
		// Cursor already at the head: the broker parks for the wait window then
		// returns an empty delta rather than hanging forever.
		const delta = await client.delta("history", 1, { waitMs: 300 });
		const elapsed = Date.now() - start;
		expect(delta.entries).toHaveLength(0);
		expect(delta.seq).toBe(1);
		// It actually parked (roughly the wait window) but did resolve.
		expect(elapsed).toBeGreaterThanOrEqual(200);
		expect(elapsed).toBeLessThan(5_000);
	});

	test("long-poll returns promptly when a concurrent push arrives while parked", async () => {
		const start = Date.now();
		// Park on a long window, then push from a second client mid-wait.
		const parked = client.delta("history", 0, { waitMs: 10_000 });
		const pusher = new StateBrokerClient({ url: handle!.url, token: TOKEN, maxRetries: 0 });
		await sleep(100);
		await pusher.push("history", [{ key: "k", rev: 42, value: "hi" }]);

		const delta = await parked;
		const elapsed = Date.now() - start;
		expect(delta.entries).toEqual([{ key: "k", rev: 42, value: "hi" }]);
		expect(delta.seq).toBe(1);
		// Woken by the notifier well before the 10s ceiling.
		expect(elapsed).toBeLessThan(5_000);
	});

	test("a non-/v1/state path falls through to the auth broker's own routes", async () => {
		// Guards the BrokerRouteHandler fall-through contract: with the state
		// routes mounted, /v1/healthz still resolves to the auth broker.
		const res = await fetch(`${handle!.url}/v1/healthz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});
});
