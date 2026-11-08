import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { codexRankingStrategy, openaiCodexUsageProvider } from "@oh-my-pi/pi-ai/usage/openai-codex";
import { installFetchTripwire } from "./fixtures/usage-governor/harness";

installFetchTripwire();

const CHAT_MODEL = "gpt-5.3-codex";
const SPARK_MODEL = "gpt-5.3-codex-spark";

interface FetchCallRecord {
	url: string;
	method: string;
}

interface WorldOptions {
	availableCount?: number;
	expiries?: string[];
	failListing?: boolean;
	includeSparkLimit?: boolean;
	creditsOverride?: Array<{
		id: string;
		status?: string;
		reset_type?: string;
		granted_at?: string;
		expires_at?: string;
	}>;
}

class World {
	dir = "";
	authDbPath = "";
	governorDbPath = "";
	store!: SqliteAuthCredentialStore;
	auth!: AuthStorage;
	fetchLog: FetchCallRecord[] = [];

	static async open(options: WorldOptions = {}): Promise<World> {
		const world = new World();
		world.dir = await fs.mkdtemp(path.join(os.tmpdir(), "governor-codex-reset-evidence-"));
		world.authDbPath = path.join(world.dir, "auth.db");
		world.governorDbPath = path.join(world.dir, "governor.db");
		world.store = await SqliteAuthCredentialStore.open(world.authDbPath);

		const availableCount = options.availableCount ?? 2;
		const expiries = options.expiries ?? [
			new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
			new Date(Date.now() + 1 * 24 * 3600_000).toISOString(),
		];
		const failListing = options.failListing ?? false;
		const includeSparkLimit = options.includeSparkLimit ?? true;

		const usagePayload = {
			plan_type: "pro",
			rate_limit: {
				primary_window: {
					used_percent: 20,
					limit_window_seconds: 18000,
					reset_after_seconds: 14400,
				},
				secondary_window: {
					used_percent: 30,
					limit_window_seconds: 604800,
					reset_after_seconds: 500000,
				},
			},
			credits: {
				has_credits: false,
				unlimited: false,
			},
			rate_limit_reset_credits: {
				available_count: availableCount,
			},
			...(includeSparkLimit
				? {
						additional_rate_limits: [
							{
								limit_name: "spark",
								metered_feature: "spark",
								primary_window: {
									used_percent: 10,
									limit_window_seconds: 18000,
									reset_after_seconds: 14400,
								},
							},
						],
					}
				: {}),
		};

		const creditsPayload = {
			available_count: options.creditsOverride ? options.creditsOverride.length : expiries.length,
			credits:
				options.creditsOverride ??
				expiries.map((expires_at, index) => ({
					id: `RateLimitResetCredit_${index + 1}`,
					reset_type: "codex_rate_limits",
					status: "available",
					granted_at: new Date(Date.now() - 24 * 3600_000).toISOString(),
					expires_at,
				})),
		};

		const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			world.fetchLog.push({ url, method });

			if (url.includes("accounts/verified_access")) {
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("wham/rate-limit-reset-credits/consume")) {
				return new Response(JSON.stringify({ error: "unexpected consume call" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("wham/rate-limit-reset-credits")) {
				if (failListing) {
					return new Response(JSON.stringify({ error: "server error" }), {
						status: 500,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(JSON.stringify(creditsPayload), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("wham/usage")) {
				return new Response(JSON.stringify(usagePayload), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		world.auth = new AuthStorage(world.store, {
			usageProviderResolver: id => (id === "openai-codex" ? openaiCodexUsageProvider : undefined),
			rankingStrategyResolver: id => (id === "openai-codex" ? codexRankingStrategy : undefined),
			usageFetch: fakeFetch as unknown as typeof fetch,
			governor: {
				dbPath: world.governorDbPath,
				config: { enabled: true, lead: 0.25, interactiveReserve: "hold" },
			},
		});

		await world.auth.credentials.set("openai-codex", [
			{
				type: "oauth",
				access: "mock-access-token",
				refresh: "mock-refresh-token",
				expires: Date.now() + 7 * 24 * 3600_000,
				accountId: "acct-test",
				email: "user@example.com",
			},
		]);

		await world.auth.usage.reports({ provider: "openai-codex" });
		return world;
	}

	async evaluate(modelId: string) {
		const target = {
			selector: `openai-codex/${modelId}`,
			provider: "openai-codex",
			modelId,
		};
		const scopeId = `scope-${modelId}`;
		this.auth.governor.setRoutingScope({
			id: scopeId,
			revision: 1,
			roles: [{ role: "task", targets: [target] }],
		});
		return this.auth.governor.evaluateRoutes({
			scopeId,
			revision: 1,
			role: "task",
			sessionId: "test-session",
			targets: [target],
		});
	}

	blockRowCount(): number {
		const db = new Database(this.authDbPath, { readonly: true });
		try {
			const row = db.prepare("SELECT COUNT(*) AS n FROM auth_credential_blocks").get() as { n: number };
			return row.n;
		} finally {
			db.close();
		}
	}

	async close() {
		this.auth?.close();
		this.store?.close();
		if (this.dir) await fs.rm(this.dir, { recursive: true, force: true });
	}
}

let activeWorld: World | undefined;
afterEach(async () => {
	setSystemTime();
	await activeWorld?.close();
	activeWorld = undefined;
});

describe("OpenAI Codex reset credits governor evidence (slice D)", () => {
	test("yields resetTieBreakExpiresAtMs equal to soonest available expiry for non-Spark model", async () => {
		const laterExpiry = new Date(Date.now() + 5 * 24 * 3600_000).toISOString();
		const soonestExpiry = new Date(Date.now() + 1 * 24 * 3600_000).toISOString();
		const expiries = [laterExpiry, soonestExpiry];

		activeWorld = await World.open({ availableCount: 2, expiries });
		const evaluation = await activeWorld.evaluate(CHAT_MODEL);

		expect(evaluation.accounts).toHaveLength(1);
		const account = evaluation.accounts[0]!;
		expect(account.resetTieBreakExpiresAtMs).toBe(Date.parse(soonestExpiry));
		expect(account.allowance).toBe("included");

		// Zero /consume POSTs and zero block rows
		expect(activeWorld.fetchLog.some(req => req.url.includes("consume"))).toBe(false);
		expect(activeWorld.fetchLog.some(req => req.method === "POST")).toBe(false);
		expect(activeWorld.blockRowCount()).toBe(0);
	});

	test("yields undefined resetTieBreakExpiresAtMs for Spark model", async () => {
		const soonestExpiry = new Date(Date.now() + 1 * 24 * 3600_000).toISOString();
		activeWorld = await World.open({ availableCount: 2, expiries: [soonestExpiry] });
		const evaluation = await activeWorld.evaluate(SPARK_MODEL);

		expect(evaluation.accounts).toHaveLength(1);
		const account = evaluation.accounts[0]!;
		expect(account.resetTieBreakExpiresAtMs).toBeUndefined();

		// Zero /consume POSTs and zero block rows
		expect(activeWorld.fetchLog.some(req => req.url.includes("consume"))).toBe(false);
		expect(activeWorld.fetchLog.some(req => req.method === "POST")).toBe(false);
		expect(activeWorld.blockRowCount()).toBe(0);
	});

	test("yields undefined resetTieBreakExpiresAtMs when listing credits fails", async () => {
		activeWorld = await World.open({ availableCount: 2, failListing: true });
		const evaluation = await activeWorld.evaluate(CHAT_MODEL);

		expect(evaluation.accounts).toHaveLength(1);
		const account = evaluation.accounts[0]!;
		expect(account.resetTieBreakExpiresAtMs).toBeUndefined();

		// Zero /consume POSTs and zero block rows
		expect(activeWorld.fetchLog.some(req => req.url.includes("consume"))).toBe(false);
		expect(activeWorld.fetchLog.some(req => req.method === "POST")).toBe(false);
		expect(activeWorld.blockRowCount()).toBe(0);
	});

	test("yields undefined resetTieBreakExpiresAtMs when available_count is 0", async () => {
		activeWorld = await World.open({ availableCount: 0 });
		const evaluation = await activeWorld.evaluate(CHAT_MODEL);

		expect(evaluation.accounts).toHaveLength(1);
		const account = evaluation.accounts[0]!;
		expect(account.resetTieBreakExpiresAtMs).toBeUndefined();

		// Detail route was never called when available_count is 0
		expect(activeWorld.fetchLog.some(req => req.url.includes("rate-limit-reset-credits"))).toBe(false);
		// Zero /consume POSTs and zero block rows
		expect(activeWorld.fetchLog.some(req => req.url.includes("consume"))).toBe(false);
		expect(activeWorld.fetchLog.some(req => req.method === "POST")).toBe(false);
		expect(activeWorld.blockRowCount()).toBe(0);
	});

	test("yields undefined resetTieBreakExpiresAtMs when credits have missing or non-available status", async () => {
		activeWorld = await World.open({
			availableCount: 2,
			creditsOverride: [
				{
					id: "credit-missing-status",
					reset_type: "codex_rate_limits",
					expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
				},
				{
					id: "credit-pending-status",
					reset_type: "codex_rate_limits",
					status: "pending",
					expires_at: new Date(Date.now() + 48 * 3600_000).toISOString(),
				},
			],
		});
		const evaluation = await activeWorld.evaluate(CHAT_MODEL);

		expect(evaluation.accounts).toHaveLength(1);
		const account = evaluation.accounts[0]!;
		expect(account.resetTieBreakExpiresAtMs).toBeUndefined();

		// Zero /consume POSTs and zero block rows
		expect(activeWorld.fetchLog.some(req => req.url.includes("consume"))).toBe(false);
		expect(activeWorld.fetchLog.some(req => req.method === "POST")).toBe(false);
		expect(activeWorld.blockRowCount()).toBe(0);
	});

	test("yields undefined resetTieBreakExpiresAtMs when credits have missing or non-chat reset_type", async () => {
		activeWorld = await World.open({
			availableCount: 2,
			creditsOverride: [
				{
					id: "credit-missing-type",
					status: "available",
					expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
				},
				{
					id: "credit-other-type",
					reset_type: "spark_limits",
					status: "available",
					expires_at: new Date(Date.now() + 48 * 3600_000).toISOString(),
				},
			],
		});
		const evaluation = await activeWorld.evaluate(CHAT_MODEL);

		expect(evaluation.accounts).toHaveLength(1);
		const account = evaluation.accounts[0]!;
		expect(account.resetTieBreakExpiresAtMs).toBeUndefined();

		// Zero /consume POSTs and zero block rows
		expect(activeWorld.fetchLog.some(req => req.url.includes("consume"))).toBe(false);
		expect(activeWorld.fetchLog.some(req => req.method === "POST")).toBe(false);
		expect(activeWorld.blockRowCount()).toBe(0);
	});

	test("header ingestion after >15min renders allowance unknown until fresh full payload arrives", async () => {
		const baseNow = Date.parse("2026-11-08T12:00:00.000Z");
		setSystemTime(new Date(baseNow));

		activeWorld = await World.open({ availableCount: 2 });
		const evaluationInitial = await activeWorld.evaluate(CHAT_MODEL);
		expect(evaluationInitial.accounts[0]!.allowance).toBe("included");

		// Advance time by 16 minutes (> GOVERNOR_STALE_MS = 15min)
		const laterTime = baseNow + 16 * 60_000;
		setSystemTime(new Date(laterTime));

		// Ingest fresh rate limit headers. Ingestion refreshes fetchedAt and limit.observedAt to laterTime,
		// but preserves prior metadata (governorNoPaidOverageObservedAt stays at baseNow).
		const headers = {
			"x-codex-primary-used-percent": "25",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": String(Math.floor((laterTime + 14400_000) / 1000)),
			"x-codex-secondary-used-percent": "35",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": String(Math.floor((laterTime + 500000_000) / 1000)),
		};
		const credentialId = activeWorld.store.listAuthCredentials("openai-codex")[0]?.id;
		const ingested = activeWorld.auth.usage.ingestHeaders("openai-codex", headers, { credentialId });
		expect(ingested).toBe(true);

		// Now evaluate routes: governorAllowance detects governorNoPaidOverageObservedAt is > 15min old,
		// returning undefined (unknown allowance) despite fresh header limits.
		const evaluationStaleHeaders = await activeWorld.evaluate(CHAT_MODEL);
		expect(evaluationStaleHeaders.accounts[0]!.allowance).toBe("unknown");

		// Fresh full payload arrives at laterTime
		await activeWorld.auth.usage.reports({ provider: "openai-codex" });
		const evaluationFreshFull = await activeWorld.evaluate(CHAT_MODEL);
		expect(evaluationFreshFull.accounts[0]!.allowance).toBe("included");
	});
});
