/**
 * Usage lookups shared by concurrent callers (a credential's usage probe, the aggregate poll, a usage
 * report the credential store supplies, the auth broker's usage report) belong to no caller. No
 * caller's timeout bounds them, and a held caller (its owner began disposing) starts none: it may only
 * join a lookup already in flight.
 *
 * Fixtures reach loopback endpoints through the global `fetch` (Bun's native fetch, plain HTTP). The
 * cases wait real time where only a span of silence at the endpoint shows that nothing was sent, or
 * where a caller's own timeout must pass while the shared lookup keeps waiting for its answer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";
import type { UsageService } from "../src/auth/usage";
import { runInRequestHoldScope } from "../src/request-hold";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A local endpoint that counts requests and answers none until released. */
interface Endpoint {
	readonly url: string;
	requests(): number;
	release(): void;
}

function endpoint(): Endpoint {
	let requests = 0;
	const gate = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch() {
			requests++;
			await gate.promise;
			return new Response("ok");
		},
	});
	cleanups.push(() => server.stop(true));
	return { url: server.url.origin, requests: () => requests, release: () => gate.resolve() };
}

/** A hold scope whose owner began disposing; `end()` is that owner finishing. */
function heldScope() {
	const held = new AbortController();
	const ended = new AbortController();
	held.abort();
	cleanups.push(() => ended.abort());
	return {
		run: <T>(fn: () => T): T => runInRequestHoldScope(held.signal, ended.signal, fn),
		end: () => ended.abort(),
	};
}

const settle = <T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> =>
	promise.then(
		value => ({ value }),
		(error: unknown) => ({ error }),
	);

const errorName = (outcome: { value: unknown } | { error: unknown }): string | undefined =>
	"error" in outcome && outcome.error instanceof Error ? outcome.error.name : undefined;

const REPORT: UsageReport = {
	provider: "anthropic",
	fetchedAt: Date.now(),
	limits: [],
	metadata: { email: "a@example.com", accountId: "account-a" },
};

/** Local usage storage whose Claude probe asks `site`, with the probe's own signal. */
async function localUsage(site: Endpoint, usageRequestTimeoutMs?: number) {
	const usage: UsageProvider = {
		...claudeUsageProvider,
		async fetchUsage(params) {
			await fetch(`${site.url}/usage`, { method: "POST", body: "{}", signal: params.signal });
			return { ...REPORT, fetchedAt: Date.now() };
		},
	};
	const storage = await AuthStorage.create(":memory:", {
		usageProviderResolver: provider => (provider === "anthropic" ? usage : undefined),
		...(usageRequestTimeoutMs !== undefined ? { usageRequestTimeoutMs } : {}),
	});
	cleanups.push(() => storage.close());
	await storage.credentials.set("anthropic", [
		{
			type: "oauth",
			access: "access-a",
			refresh: "refresh-a",
			expires: Date.now() + 3_600_000,
			accountId: "account-a",
			email: "a@example.com",
		},
	]);
	const credential = storage.credentials.get("anthropic");
	if (!credential) throw new Error("expected the stored credential");
	// The per-credential probe (`report`) is the service's own method, not part of the public usage API.
	return { storage, credential, probe: storage.usage as UsageService };
}

describe("a credential's usage probe", () => {
	it("is bounded by the service's own timeout, not its first caller's", async () => {
		const site = endpoint();
		const { credential, probe } = await localUsage(site, 5_000);
		// Callers once passed their own timeout here. The shared probe must not honor one.
		const shortWait = { timeoutMs: 50 } as unknown as { signal?: AbortSignal };
		const first = settle(probe.report("anthropic", credential, shortWait));
		const joiner = probe.report("anthropic", credential);
		await Bun.sleep(200);
		site.release();

		expect({
			first: "value" in (await first) ? "report" : "error",
			joiner: (await joiner)?.provider,
			requests: site.requests(),
		}).toEqual({ first: "report", joiner: "anthropic", requests: 1 });
	});

	it("is not started by a held caller, which a live caller then starts", async () => {
		const site = endpoint();
		const { credential, probe } = await localUsage(site);
		const scope = heldScope();
		const held = settle(scope.run(() => probe.report("anthropic", credential)));
		await Bun.sleep(150);
		const sentWhileOnlyHeld = site.requests();
		const live = probe.report("anthropic", credential);
		site.release();
		const liveReport = await live;
		scope.end();

		expect({
			sentWhileOnlyHeld,
			live: liveReport?.provider,
			held: errorName(await held),
			requests: site.requests(),
		}).toEqual({ sentWhileOnlyHeld: 0, live: "anthropic", held: "AbortError", requests: 1 });
	});
});

describe("the aggregate usage poll", () => {
	it("is not started by a held caller, which a live caller then starts", async () => {
		const site = endpoint();
		const { storage } = await localUsage(site);
		const scope = heldScope();
		const held = settle(scope.run(() => storage.usage.reports()));
		await Bun.sleep(150);
		const sentWhileOnlyHeld = site.requests();
		const live = storage.usage.reports();
		site.release();
		const liveReports = await live;
		scope.end();

		expect({
			sentWhileOnlyHeld,
			live: liveReports?.length,
			held: errorName(await held),
			requests: site.requests(),
		}).toEqual({ sentWhileOnlyHeld: 0, live: 1, held: "AbortError", requests: 1 });
	});
});

describe("a usage report the credential store supplies", () => {
	it("is not started by a held caller, which a live caller then starts", async () => {
		const site = endpoint();
		const store = await SqliteAuthCredentialStore.open(":memory:");
		// A store that answers usage itself, as the broker-backed one does, over its own request.
		const fetchUsageReports = async (): Promise<UsageReport[]> => {
			await fetch(`${site.url}/usage`, { method: "POST", body: "{}" });
			return [];
		};
		const storage = new AuthStorage(Object.assign(store, { fetchUsageReports }));
		cleanups.push(() => storage.close());
		const scope = heldScope();
		const held = settle(scope.run(() => storage.usage.reports()));
		await Bun.sleep(150);
		const sentWhileOnlyHeld = site.requests();
		const live = storage.usage.reports();
		site.release();
		const liveReports = await live;
		scope.end();

		expect({
			sentWhileOnlyHeld,
			live: liveReports,
			held: errorName(await held),
			requests: site.requests(),
		}).toEqual({ sentWhileOnlyHeld: 0, live: [], held: "AbortError", requests: 1 });
	});
});

describe("the auth broker's usage report", () => {
	it("is not started by a held caller, which a live caller then starts", async () => {
		const token = "shared-usage-bearer";
		const brokerStorage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		cleanups.push(() => brokerStorage.close());
		const handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		cleanups.push(() => handle.close());
		const usageRequests: string[] = [];
		const answer = Promise.withResolvers<void>();
		const client = new AuthBrokerClient({
			url: handle.url,
			token,
			// Answers are held back until released, so the live caller can only start the request, not
			// find a cached result.
			fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (url.pathname === "/v1/usage") usageRequests.push(url.pathname);
				const response = await fetch(input, init);
				await answer.promise;
				return response;
			}) as typeof fetch,
		});
		const remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		cleanups.push(() => remote.close());
		const scope = heldScope();
		const held = settle(scope.run(() => remote.fetchUsageReports()));
		await Bun.sleep(150);
		const sentWhileOnlyHeld = usageRequests.length;
		const live = remote.fetchUsageReports();
		answer.resolve();
		const liveReports = await live;
		scope.end();

		expect({
			sentWhileOnlyHeld,
			live: liveReports,
			held: errorName(await held),
			requests: usageRequests.length,
		}).toEqual({ sentWhileOnlyHeld: 0, live: [], held: "AbortError", requests: 1 });
	});
});
