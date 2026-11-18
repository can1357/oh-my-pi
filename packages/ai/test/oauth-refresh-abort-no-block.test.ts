import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const MODEL = "claude-opus-4-1";
const HOUR_MS = 3_600_000;

// Regression for #19607: a refresh this process abandoned (shutdown or caller
// cancel) must not persist an `auth` block that makes every peer process see
// the account as depleted.
describe("abandoned OAuth refresh", () => {
	let tempDir = "";
	let dbPath = "";
	let tokenExchange: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
	let rotation = 0;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-abort-no-block-"));
		dbPath = path.join(tempDir, "agent.db");
		tokenExchange = undefined;
		rotation = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: Request | URL | string) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname.endsWith("/oauth/token")) {
				if (tokenExchange) {
					tokenExchange.started.resolve();
					await tokenExchange.release.promise;
				}
				rotation++;
				return Response.json({
					access_token: `acc-${rotation}`,
					refresh_token: `ref-${rotation}`,
					expires_in: 3600,
				});
			}
			if (url.pathname === "/api/oauth/usage") {
				const resetsAt = (hours: number) => new Date(Date.now() + hours * HOUR_MS).toISOString();
				return Response.json({
					five_hour: { utilization: 20, resets_at: resetsAt(2) },
					seven_day: { utilization: 30, resets_at: resetsAt(72) },
				});
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tempDir);
	});

	async function openStorage(): Promise<AuthStorage> {
		const storage = await AuthStorage.create(dbPath);
		await storage.credentials.reload();
		return storage;
	}

	/** What another omp process sharing the agent dir sees. */
	async function peerHealth(): Promise<string> {
		const peer = await openStorage();
		try {
			return (await peer.health.model("anthropic", { modelId: MODEL, reserveFraction: 0.01 })).state;
		} finally {
			peer.close();
		}
	}

	/** Begin shutdown while one unrelated refresh keeps the store open, as the exit drain does. */
	async function beginShutdown(storage: AuthStorage): Promise<() => Promise<void>> {
		await storage.credentials.set("unit-oauth-drain", [{ type: "oauth", access: "d", refresh: "d", expires: 0 }]);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const pending = storage.oauth.refreshStored("unit-oauth-drain", {
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async () => {
				started.resolve();
				await release.promise;
				return { access: "d1", refresh: "d1", expires: Date.now() + HOUR_MS };
			},
		});
		await started.promise;
		storage.close();
		return async () => {
			release.resolve();
			await pending;
		};
	}

	test("refreshes refused during shutdown leave peers healthy", async () => {
		const storage = await openStorage();
		await storage.credentials.set("anthropic", [
			{ type: "oauth", access: "a1", refresh: "r1", expires: Date.now() - 60_000 },
			{ type: "oauth", access: "a2", refresh: "r2", expires: Date.now() - 60_000 },
		]);
		const finishShutdown = await beginShutdown(storage);
		expect(await storage.keys.get("anthropic", "s1", { modelId: MODEL })).toBeUndefined();
		await finishShutdown();

		expect(await peerHealth()).toBe("healthy");
	});

	test("a still-valid token is served during shutdown", async () => {
		const storage = await openStorage();
		await storage.credentials.set("anthropic", [
			{ type: "oauth", access: "fresh", refresh: "r1", expires: Date.now() + HOUR_MS },
		]);
		const finishShutdown = await beginShutdown(storage);
		expect(await storage.keys.get("anthropic", "s1", { modelId: MODEL })).toBe("fresh");
		await finishShutdown();

		expect(await peerHealth()).toBe("healthy");
	});

	test("a refresh the caller cancelled leaves peers healthy", async () => {
		const storage = await openStorage();
		await storage.credentials.set("anthropic", [
			{ type: "oauth", access: "a1", refresh: "r1", expires: Date.now() - 60_000 },
		]);
		tokenExchange = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		const controller = new AbortController();
		const key = storage.keys.get("anthropic", "s1", { modelId: MODEL, signal: controller.signal });
		await tokenExchange.started.promise;
		controller.abort();
		expect(await key.catch(() => undefined)).toBeUndefined();
		// The exchange outlives the caller and lands; let it, so the peer never waits on its lease.
		tokenExchange.release.resolve();
		storage.close();

		expect(await peerHealth()).toBe("healthy");
	});

	test("cancelling a request that joined another's refresh leaves peers healthy", async () => {
		const storage = await openStorage();
		await storage.credentials.set("anthropic", [
			{ type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + HOUR_MS },
		]);
		tokenExchange = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		// An auth-retry re-mints the still-valid token; its exchange is held open.
		const forced = storage.keys.get("anthropic", "s1", { modelId: MODEL, forceRefresh: true });
		await tokenExchange.started.promise;

		// A second request joins that in-flight refresh, then its caller cancels.
		const controller = new AbortController();
		const joined = Promise.withResolvers<void>();
		const addListener = controller.signal.addEventListener.bind(controller.signal);
		vi.spyOn(controller.signal, "addEventListener").mockImplementation((type, listener, options) => {
			addListener(type, listener, options);
			if (type === "abort") joined.resolve();
		});
		const cancelled = storage.keys.get("anthropic", "s2", { modelId: MODEL, signal: controller.signal });
		await joined.promise;
		controller.abort();
		expect(await cancelled.catch(() => undefined)).toBeUndefined();

		tokenExchange.release.resolve();
		expect(await forced).toBe("acc-1");
		storage.close();

		expect(await peerHealth()).toBe("healthy");
	});
});
