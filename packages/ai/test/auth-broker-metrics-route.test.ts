import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const MASTER = "master-bearer";
const SCRAPE = "scrape-token";

function sampleReports(): UsageReport[] {
	return [
		{
			provider: "openai-codex",
			fetchedAt: 1_700_000_000_000,
			metadata: { accountId: "acct-1" },
			resetCredits: { availableCount: 2 },
			limits: [
				{
					id: "openai-codex:primary",
					label: "5 Hour",
					scope: { provider: "openai-codex", windowId: "5h" },
					window: { id: "5h", label: "5 Hour", resetsAt: 1_700_000_900_000 },
					amount: { usedFraction: 0.25, unit: "percent" },
					status: "ok",
				},
			],
		},
	];
}

describe("auth-broker GET /metrics route", () => {
	let tempDir: string | undefined;
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let usageImpl: (signal?: AbortSignal) => Promise<UsageReport[] | null> = async () => sampleReports();

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-metrics-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, { fetchUsageReports: signal => usageImpl(signal) });
		await storage.reload();
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [MASTER],
			metricsTokens: [SCRAPE],
			disableRefresher: true,
		});
	});

	test("refuses to boot when a scrape token equals a master bearer", () => {
		// The vault routes authorize against the bearer set, so identical bytes
		// would let a credential advertised as scrape-only read stored
		// credentials. Least privilege is the reason the token exists, so an
		// overlap is a provisioning fault rather than something to resolve.
		// `storage` is assigned in beforeEach; narrow rather than cast (no `as`).
		if (!storage) throw new Error("expected storage from beforeEach");
		const readyStorage = storage;
		expect(() =>
			startAuthBroker({
				storage: readyStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [MASTER],
				metricsTokens: [MASTER],
				disableRefresher: true,
			}),
		).toThrow(/must not equal a master bearer/i);
	});
	// The overlap check must apply the SAME normalization `isAuthorized()` does.
	// That function trims the presented bearer out of the Authorization header,
	// so a whitespace-equivalent pair is the same live credential: a byte-for-byte
	// check passes it through, and the scraper then authenticates as the master
	// bearer on the vault routes despite being provisioned as scrape-only.
	test("refuses to boot when a scrape token is whitespace-equivalent to a master bearer", () => {
		if (!storage) throw new Error("expected storage from beforeEach");
		const readyStorage = storage;
		for (const padded of [` ${MASTER} `, `${MASTER}\n`, `\t${MASTER}`]) {
			expect(() =>
				startAuthBroker({
					storage: readyStorage,
					bind: "127.0.0.1:0",
					bearerTokens: [MASTER],
					metricsTokens: [padded],
					disableRefresher: true,
				}),
			).toThrow(/must not equal a master bearer/i);
		}
	});

	// Symmetric: the padding can just as easily be on the bearer side.
	test("refuses to boot when the padded value is the master bearer", () => {
		if (!storage) throw new Error("expected storage from beforeEach");
		const readyStorage = storage;
		expect(() =>
			startAuthBroker({
				storage: readyStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [` ${MASTER} `],
				metricsTokens: [MASTER],
				disableRefresher: true,
			}),
		).toThrow(/must not equal a master bearer/i);
	});

	// A token that trims to nothing must not be stored: the bearer regex's `.+`
	// matches pure whitespace, so `Authorization: "Bearer  "` would trim to ""
	// and match an empty stored entry — a live credential nobody provisioned.
	// An empty ARRAY stays the documented auth-disabled signal and is untouched.
	test("rejects a whitespace-only configured token rather than storing it", () => {
		if (!storage) throw new Error("expected storage from beforeEach");
		const readyStorage = storage;
		expect(() =>
			startAuthBroker({
				storage: readyStorage,
				bind: "127.0.0.1:0",
				bearerTokens: [MASTER],
				metricsTokens: ["   "],
				disableRefresher: true,
			}),
		).toThrow(/empty or whitespace-only token/i);
		expect(() =>
			startAuthBroker({
				storage: readyStorage,
				bind: "127.0.0.1:0",
				bearerTokens: ["\n"],
				disableRefresher: true,
			}),
		).toThrow(/empty or whitespace-only token/i);
	});

	afterEach(async () => {
		await handle?.close();
		storage?.close();
		store?.close();
		if (tempDir) await removeWithRetries(tempDir);
		usageImpl = async () => sampleReports();
	});

	test("scrape token yields the Prometheus exposition", async () => {
		const res = await fetch(`${handle!.url}/metrics`, { headers: { authorization: `Bearer ${SCRAPE}` } });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
		const body = await res.text();
		expect(body).toContain(
			'llm_usage_limit_used_fraction{provider="openai-codex",account="acct-1",org="",email="",limit_id="openai-codex:primary",window="5h"} 0.25',
		);
		expect(body).toContain(
			'llm_usage_reset_credits_available{provider="openai-codex",account="acct-1",org="",email=""} 2',
		);
	});

	// Normalizing at boot must make a padded configured token WORK, not merely
	// be rejected: a file-backed secret piped into an env var routinely arrives
	// with a trailing newline, and `isAuthorized()` trims the presented value,
	// so the stored form has to be trimmed to match.
	test("a configured token carrying padding still authenticates", async () => {
		if (!storage) throw new Error("expected storage from beforeEach");
		const padded = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [`${MASTER}\n`],
			metricsTokens: [`  ${SCRAPE}  `],
			disableRefresher: true,
		});
		try {
			const scrape = await fetch(`${padded.url}/metrics`, { headers: { authorization: `Bearer ${SCRAPE}` } });
			expect(scrape.status).toBe(200);
			const master = await fetch(`${padded.url}/metrics`, { headers: { authorization: `Bearer ${MASTER}` } });
			expect(master.status).toBe(200);
		} finally {
			await padded.close();
		}
	});

	test("master bearer also satisfies /metrics", async () => {
		const res = await fetch(`${handle!.url}/metrics`, { headers: { authorization: `Bearer ${MASTER}` } });
		expect(res.status).toBe(200);
	});

	test("no token and an unknown token are both 401", async () => {
		expect((await fetch(`${handle!.url}/metrics`)).status).toBe(401);
		const bad = await fetch(`${handle!.url}/metrics`, { headers: { authorization: "Bearer nope" } });
		expect(bad.status).toBe(401);
	});

	test("scrape token is least-privilege: it cannot reach the vault", async () => {
		const res = await fetch(`${handle!.url}/v1/snapshot`, { headers: { authorization: `Bearer ${SCRAPE}` } });
		expect(res.status).toBe(401);
	});

	test("null usage renders an empty 200 exposition, not a 5xx", async () => {
		usageImpl = async () => null;
		const res = await fetch(`${handle!.url}/metrics`, { headers: { authorization: `Bearer ${SCRAPE}` } });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
	});

	test("a storage-level throw surfaces as 503", async () => {
		usageImpl = async () => {
			throw new Error("storage exploded");
		};
		const res = await fetch(`${handle!.url}/metrics`, { headers: { authorization: `Bearer ${SCRAPE}` } });
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("");
	});
});

// Token validation is scoped to the route that consumes the tokens. With
// `/metrics` disabled — the default, and the state an operator reaches for to
// recover from a bad metrics-only config — a stale `metricsTokens` entry must
// not keep the broker from booting: there is no scrape route for an empty or
// bearer-colliding value to reach. Bearer normalization stays unconditional,
// since those tokens are always live.
describe("auth-broker scrape-token validation is route-scoped", () => {
	let tempDir: string | undefined;
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-scrape-scope-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, { fetchUsageReports: async () => sampleReports() });
		await storage.reload();
	});

	afterEach(async () => {
		await handle?.close();
		storage?.close();
		store?.close();
		if (tempDir) await removeWithRetries(tempDir);
	});

	test("boots with a whitespace-only scrape token while metrics are disabled", () => {
		handle = startAuthBroker({
			storage: storage!,
			bind: "127.0.0.1:0",
			bearerTokens: [MASTER],
			metricsTokens: ["   "],
			metricsEnabled: false,
			disableRefresher: true,
		});
		expect(handle.url).toContain("127.0.0.1");
	});

	test("boots with a scrape token colliding with the master bearer while metrics are disabled", () => {
		handle = startAuthBroker({
			storage: storage!,
			bind: "127.0.0.1:0",
			bearerTokens: [MASTER],
			metricsTokens: [` ${MASTER} `],
			metricsEnabled: false,
			disableRefresher: true,
		});
		expect(handle.url).toContain("127.0.0.1");
	});

	test("still refuses the same colliding token once metrics are enabled", () => {
		expect(() =>
			startAuthBroker({
				storage: storage!,
				bind: "127.0.0.1:0",
				bearerTokens: [MASTER],
				metricsTokens: [` ${MASTER} `],
				metricsEnabled: true,
				disableRefresher: true,
			}),
		).toThrow(/must not equal a master bearer token/);
	});
});

// `metricsEnabled: false` must make the route genuinely absent, not merely
// token-gated. Gating on `metricsTokens` alone would not close it: master
// `bearerTokens` are folded into the accepted metrics set, so a master-bearer
// holder would still reach usage data on a broker whose operator never enabled
// the endpoint.
describe("auth-broker GET /metrics when disabled", () => {
	let tempDir: string | undefined;
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-metrics-off-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, { fetchUsageReports: async () => sampleReports() });
		await storage.reload();
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [MASTER],
			metricsEnabled: false,
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		await handle?.close();
		storage?.close();
		store?.close();
		if (tempDir) await removeWithRetries(tempDir);
	});

	test("a valid master bearer gets 404, not usage data", async () => {
		const res = await fetch(`${handle!.url}/metrics`, { headers: { authorization: `Bearer ${MASTER}` } });

		// 404 (the unknown-path response), so the endpoint is absent rather than
		// merely unauthorized — an operator who never opted in exposes nothing.
		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain("llm_usage_limit_used_fraction");
	});

	test("the rest of the broker is unaffected", async () => {
		const res = await fetch(`${handle!.url}/v1/healthz`);

		expect(res.status).toBe(200);
	});
});
