import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { kimiUsageProvider } from "@oh-my-pi/pi-ai/usage/kimi";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const storages: AuthStorage[] = [];
const tempDirs: string[] = [];

beforeEach(() => {
	vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
		const credential = credentials["kimi-code"];
		return credential ? { apiKey: credential.access, newCredentials: credential } : null;
	});
});

afterEach(async () => {
	setSystemTime();
	vi.restoreAllMocks();
	for (const storage of storages) storage.close();
	storages.length = 0;
	// SQLite handles must be closed before their directory can be removed.
	for (const dir of tempDirs.splice(0)) await removeWithRetries(dir);
});

function kimiLimit(windowId: string, usedFraction: number, resetsAt?: number): UsageLimit {
	return {
		id: `kimi-code:${windowId}`,
		label: `${windowId} limit`,
		scope: { provider: "kimi-code", shared: true, windowId },
		window: resetsAt === undefined ? { id: windowId, label: windowId } : { id: windowId, label: windowId, resetsAt },
		amount: { usedFraction, remainingFraction: 1 - usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : usedFraction >= 0.9 ? "warning" : "ok",
	};
}

function kimiReport(limits: UsageLimit[], options?: { fetchedAt?: number; accountId?: string }): UsageReport {
	return {
		provider: "kimi-code",
		fetchedAt: options?.fetchedAt ?? Date.now(),
		limits,
		metadata: { accountId: options?.accountId ?? "account-1" },
	};
}

function completePayload(monthlyReset: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		usage: { limit: "100", used: "10", remaining: "90", resetTime: new Date(Date.now() + 5 * DAY_MS).toISOString() },
		limits: [
			{
				window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
				detail: { limit: "100", used: "10", remaining: "90" },
			},
		],
		usages: {
			limit_month_total: { used_ratio: 0.3, reset_time: monthlyReset },
			limit_month_code: { used_ratio: 0.3, reset_time: monthlyReset },
		},
		...extra,
	};
}

async function parsePayload(payload: Record<string, unknown>): Promise<UsageReport | null> {
	return kimiUsageProvider.fetchUsage(
		{ provider: "kimi-code", credential: { type: "oauth", accessToken: "kimi-test-token" } },
		{ fetch: async () => new Response(JSON.stringify(payload), { status: 200 }) },
	);
}

function oauthCred(id: number, expires: number): AuthCredential {
	return { type: "oauth", access: `access-${id}`, refresh: `refresh-${id}`, expires, accountId: `account-${id}` };
}

interface HarnessOptions {
	/** Account 1's live report; `null` is a failed probe. */
	report?: UsageReport | null;
	/** Account 2's live answer; defaults to a nearly-spent sibling. */
	sibling?: UsageReport;
	/** Scope and deadline of account 1's seeded block; `null` seeds none. */
	blockScope?: string;
	blockedUntilMs?: number | null;
}

async function openStorage(options?: HarnessOptions) {
	const rows: StoredAuthCredential[] = [1, 2].map(id => ({
		id,
		provider: "kimi-code",
		credential: oauthCred(id, Date.now() + 24 * HOUR_MS),
		disabledCause: null,
	}));
	const blocks = new Map<string, number>();
	if (options?.blockedUntilMs !== null) {
		blocks.set(`1:${options?.blockScope ?? ""}`, options?.blockedUntilMs ?? Date.now() + 3 * DAY_MS);
	}
	const store: AuthCredentialStore = {
		close() {},
		listAuthCredentials: provider => rows.filter(row => provider === undefined || row.provider === provider),
		updateAuthCredential() {},
		deleteAuthCredential: async () => false,
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentials: async () => rows,
		upsertAuthCredential: async () => rows,
		deleteAuthCredentials: async () => {},
		getCredentialBlock: (credentialId, _providerKey, scope) => blocks.get(`${credentialId}:${scope}`),
		upsertCredentialBlock: block => {
			blocks.set(`${block.credentialId}:${block.blockScope}`, block.blockedUntilMs);
		},
		deleteCredentialBlock: (credentialId, _providerKey, scope) => {
			blocks.delete(`${credentialId}:${scope}`);
		},
		getCache: () => null,
		setCache() {},
		cleanExpiredCache() {},
	};
	const usageProvider: UsageProvider = {
		id: "kimi-code",
		async fetchUsage(params) {
			const access = params.credential.type === "oauth" ? params.credential.accessToken : undefined;
			if (access === "access-2") {
				return (
					options?.sibling ?? kimiReport([kimiLimit("5h", 0.95), kimiLimit("7d", 0.9)], { accountId: "account-2" })
				);
			}
			return options?.report === undefined ? null : options.report;
		},
	};
	const storage = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === "kimi-code" ? usageProvider : undefined),
		configValueResolver: async value => value,
	});
	storages.push(storage);
	await storage.credentials.reload();
	return { storage, blocks };
}

const healthy = () =>
	kimiReport([
		kimiLimit("5h", 0.1),
		kimiLimit("7d", 0.2),
		kimiLimit("limit_month_total", 0.3),
		kimiLimit("limit_month_code", 0.3),
	]);

describe("Kimi usage-block healing", () => {
	it("recovers a stale account-wide block through a usage pass and through a health check, on independent fixtures", async () => {
		const usagePass = await openStorage({ report: healthy() });
		await usagePass.storage.usage.reports();
		expect(usagePass.blocks.has("1:")).toBe(false);

		const healthCheck = await openStorage({ report: healthy() });
		const health = await healthCheck.storage.health.model("kimi-code", { reserveFraction: 0.1 });
		expect(healthCheck.blocks.has("1:")).toBe(false);
		expect(health.accounts.find(account => account.credentialId === 1)?.state).toBe("healthy");
	});

	it("recovers a stale account-wide block during selection from a complete zero-week report", async () => {
		const { storage, blocks } = await openStorage({
			report: kimiReport([
				kimiLimit("7d", 0),
				kimiLimit("limit_month_total", 0.3),
				kimiLimit("limit_month_code", 0.3),
			]),
		});

		expect(await storage.keys.get("kimi-code", "s-zero-week")).toBe("access-1");
		expect(blocks.has("1:")).toBe(false);
	});

	it("does not keep a healthy subscription blocked when only the one-shot top-up is spent", async () => {
		const monthlyReset = new Date(Date.now() + 20 * DAY_MS).toISOString();
		const report = await parsePayload(
			completePayload(monthlyReset, {
				totalQuota: {
					limit: "500",
					used: "500",
					remaining: "0",
					window: { duration: 30, timeUnit: "TIME_UNIT_DAY" },
				},
			}),
		);
		if (!report) throw new Error("expected a parsed report");
		const { storage, blocks } = await openStorage({ report });

		expect(await storage.keys.get("kimi-code", "s-top-up")).toBe("access-1");
		expect(blocks.has("1:")).toBe(false);
	});

	it("rotates a usage-limited session onto a recovered sibling within the pool", async () => {
		const { storage, blocks } = await openStorage({
			report: kimiReport([kimiLimit("5h", 1, Date.now() + 5 * HOUR_MS), kimiLimit("7d", 0.5)]),
			sibling: healthy(),
			blockedUntilMs: null,
		});
		blocks.set("2:", Date.now() + 3 * DAY_MS);
		storage.sessions.pin("kimi-code", "s-rotate", 1);

		const mark = await storage.limits.markReached("kimi-code", "s-rotate", {
			credentialId: 1,
			retryAfterMs: 4 * DAY_MS,
			providerTimed: true,
		});

		expect(mark.switched).toBe(true);
		expect(blocks.has("2:")).toBe(false);
		expect(await storage.keys.get("kimi-code", "s-rotate")).toBe("access-2");
	});

	it("keeps the block when the report does not cover every healing window", async () => {
		const monthlyReset = Date.now() + 20 * DAY_MS;
		for (const limits of [
			[kimiLimit("5h", 0.1, Date.now() + 5 * HOUR_MS)],
			[kimiLimit("7d", 0.3, Date.now() + 5 * DAY_MS)],
			[
				kimiLimit("7d", 0.3),
				kimiLimit("limit_month_total", 0.3, monthlyReset),
				kimiLimit("limit_month_code", 0.3, monthlyReset),
			],
			[kimiLimit("5h", 0.1), kimiLimit("7d", 0.2), kimiLimit("limit_month_total", 0.3, monthlyReset)],
		]) {
			const { storage, blocks } = await openStorage({ report: kimiReport(limits) });

			expect(await storage.keys.get("kimi-code", "s-partial")).toBe("access-2");
			expect(blocks.has("1:")).toBe(true);
		}
	});

	it("heals a single partial window only when its reset matches the stored deadline", async () => {
		const resetAt = Date.now() + 5 * HOUR_MS;
		const { storage, blocks } = await openStorage({
			report: kimiReport([kimiLimit("5h", 0.1, resetAt)]),
			blockedUntilMs: resetAt,
		});

		expect(await storage.keys.get("kimi-code", "s-reset-match")).toBe("access-1");
		expect(blocks.has("1:")).toBe(false);
	});

	it("keeps the block while any healing window is exhausted", async () => {
		for (const windowId of ["5h", "7d", "limit_month_total", "limit_month_code"]) {
			const report = healthy();
			const index = report.limits.findIndex(limit => limit.window?.id === windowId);
			report.limits[index] = kimiLimit(windowId, 1, Date.now() + 5 * DAY_MS);
			const { storage, blocks } = await openStorage({ report });

			expect(await storage.keys.get("kimi-code", "s-spent")).toBe("access-2");
			expect(blocks.has("1:")).toBe(true);
		}
	});

	it("does not heal from an unknown-status or a non-quantitative window", async () => {
		for (const replace of [
			{ ...kimiLimit("7d", 0.2), status: "unknown" as const },
			{ ...kimiLimit("7d", 0), amount: { unit: "percent" as const } },
		]) {
			const report = healthy();
			const index = report.limits.findIndex(limit => limit.window?.id === "7d");
			report.limits[index] = replace;
			const { storage, blocks } = await openStorage({ report });

			expect(await storage.keys.get("kimi-code", "s-unusable")).toBe("access-2");
			expect(blocks.has("1:")).toBe(true);
		}
	});

	it("does not heal from a stale report, a failed probe, or inside the post-429 window", async () => {
		for (const report of [kimiReport(healthy().limits, { fetchedAt: Date.now() - HOUR_MS }), null]) {
			const { storage, blocks } = await openStorage({ report });
			await storage.health.model("kimi-code", { reserveFraction: 0.1 });
			expect(blocks.has("1:")).toBe(true);
		}

		const fresh = await openStorage({ report: healthy() });
		await fresh.storage.limits.markReached("kimi-code", "fresh-429", {
			credentialId: 1,
			retryAfterMs: 3 * DAY_MS,
			providerTimed: true,
		});
		await fresh.storage.health.model("kimi-code", { reserveFraction: 0.1 });
		expect(fresh.blocks.has("1:")).toBe(true);
	});

	it("does not heal an independent auth or account-policy block", async () => {
		for (const scope of ["auth", "account-policy"]) {
			const { storage, blocks } = await openStorage({ report: healthy(), blockScope: scope });

			expect(await storage.keys.get("kimi-code", "s-protected")).toBe("access-2");
			expect(blocks.has(`1:${scope}`)).toBe(true);
		}
	});

	it("keeps a monthly cooldown when only one of the two monthly meters is reported", async () => {
		// Both monthly meters share one billing reset, so a lone healthy meter
		// cannot vouch for the meter the report omitted, even on a reset match.
		const monthlyReset = Date.now() + 20 * DAY_MS;
		for (const reported of ["limit_month_total", "limit_month_code"]) {
			const { storage, blocks } = await openStorage({
				report: kimiReport([kimiLimit("5h", 0.1), kimiLimit("7d", 0.2), kimiLimit(reported, 0.3, monthlyReset)]),
				blockedUntilMs: monthlyReset,
			});

			await storage.usage.reports();

			expect(blocks.has("1:")).toBe(true);
		}

		const report = kimiReport([
			kimiLimit("5h", 0.1),
			kimiLimit("limit_month_total", 0.3, monthlyReset),
			kimiLimit("limit_month_code", 0.3, monthlyReset),
		]);
		const withoutWeekly = await openStorage({ report });
		await withoutWeekly.storage.usage.reports();
		expect(withoutWeekly.blocks.has("1:")).toBe(true);

		const matching = await openStorage({ report, blockedUntilMs: monthlyReset });
		await matching.storage.usage.reports();
		expect(matching.blocks.has("1:")).toBe(false);
	});

	it("still selects an unblocked account whose monthly code meter is spent", async () => {
		const { storage, blocks } = await openStorage({
			report: kimiReport([kimiLimit("5h", 0.1), kimiLimit("7d", 0.2), kimiLimit("limit_month_code", 1)]),
			blockedUntilMs: null,
		});

		expect(await storage.keys.get("kimi-code", "s-unblocked")).toBe("access-1");
		expect(blocks.has("1:")).toBe(false);
	});
});

describe("Kimi usage-block healing across processes sharing one SQLite store", () => {
	it("a monthly 403 cooldown survives healthy weekly-only reports; a sibling's complete fetch retires the mirror", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-kimi-healing-"));
		tempDirs.push(tempDir);
		const monthlyReset = new Date(Date.now() + 20 * DAY_MS).toISOString();
		// Account 1 only ever answers its healthy week (monthly-403 shape);
		// account 2 answers a complete report.
		const weeklyOnly = {
			none: { usage: { limit: "100", used: "0", remaining: "100" } },
			withReset: {
				usage: {
					limit: "100",
					used: "0",
					remaining: "100",
					resetTime: new Date(Date.now() + 6 * DAY_MS + HOUR_MS).toISOString(),
				},
			},
		};
		const complete = completePayload(monthlyReset);
		let firstPayload: unknown = weeklyOnly.none;
		const serving = (): UsageProvider => ({
			id: "kimi-code",
			fetchUsage: (params, ctx) =>
				kimiUsageProvider.fetchUsage(params, {
					...ctx,
					fetch: async () =>
						new Response(JSON.stringify(params.credential.accountId === "account-2" ? complete : firstPayload), {
							status: 200,
						}),
				}),
		});
		const open = async () => {
			const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
			const storage = new AuthStorage(store, {
				usageProviderResolver: p => (p === "kimi-code" ? serving() : undefined),
			});
			storages.push(storage);
			return { store, storage };
		};
		const { store: storeA, storage: storageA } = await open();
		const { storage: storageB } = await open();
		const base = Date.now();
		setSystemTime(new Date(base));
		await storageA.credentials.set("kimi-code", [
			oauthCred(1, base + 24 * HOUR_MS),
			oauthCred(2, base + 24 * HOUR_MS),
		]);
		await storageB.credentials.reload();
		const [firstRow, secondRow] = storeA.listAuthCredentials("kimi-code");

		// The monthly termination 403 rotates into a 4-day unscoped block.
		const rotation = await storageA.limits.rotate("kimi-code", undefined, {
			error: new ProviderHttpError(
				`403 {"error":{"type":"access_terminated_error"}} retry-after-ms=${4 * DAY_MS}`,
				403,
			),
			credentialId: firstRow.id,
		});
		expect(rotation.switched).toBe(true);
		const firstBlock = () => storeA.getCredentialBlock(firstRow.id, "kimi-code:oauth", "");
		expect(firstBlock()).toBeDefined();

		// Past the post-429 window, the weekly-only report must not clear the
		// monthly cooldown; 13 minutes on, past the report cache TTL, the
		// reset-time variant is fetched and parsed fresh and must not either.
		setSystemTime(new Date(base + 6 * 60_000));
		await storageA.usage.reports();
		expect(firstBlock()).toBeDefined();
		expect(await storageA.keys.get("kimi-code", "s-monthly-cooldown")).toBe("access-2");
		firstPayload = weeklyOnly.withReset;
		setSystemTime(new Date(base + 13 * 60_000));
		await storageA.usage.reports();
		expect(firstBlock()).toBeDefined();

		// A sibling's complete fetch heals its block; the marking process
		// retires its stale mirror without resurrecting the old deadline.
		setSystemTime(new Date(base + 14 * 60_000));
		await storageA.limits.markReached("kimi-code", undefined, {
			credentialId: secondRow.id,
			retryAfterMs: 3 * DAY_MS,
			providerTimed: true,
		});
		setSystemTime(new Date(base + 21 * 60_000));
		expect(await storageB.keys.get("kimi-code", "s-sibling")).toBe("access-2");
		expect(storeA.getCredentialBlock(secondRow.id, "kimi-code:oauth", "")).toBeUndefined();

		setSystemTime(new Date(base + 22 * 60_000));
		expect(await storageA.keys.get("kimi-code", "s-mirror")).toBe("access-2");
		await storageA.limits.markReached("kimi-code", undefined, { credentialId: secondRow.id, retryAfterMs: 60_000 });
		const revived = storeA.getCredentialBlock(secondRow.id, "kimi-code:oauth", "");
		expect(revived).toBeDefined();
		expect(revived ?? 0).toBeLessThan(base + 24 * 60_000);
	});
});
