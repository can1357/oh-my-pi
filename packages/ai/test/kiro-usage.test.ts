import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { encodeKiroCredential } from "@oh-my-pi/pi-catalog/wire/kiro-credential";
import type { UsageFetchContext, UsageFetchParams, UsageReport } from "../src/usage";
import { kiroRankingStrategy, kiroUsageProvider, parseKiroUsage } from "../src/usage/kiro";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/test-profile";
const RESET_S = 1796083200;
const BONUS_EXPIRES_S = 1825966765.739;

/** `GetUsageLimits` shape from a Kiro Pro Google login, reduced to the fields the parser reads. */
function livePayload(
	overrides: { used?: number; limit?: number; overage?: "ENABLED" | "DISABLED"; bonus?: boolean } = {},
) {
	const bonuses = [
		{
			bonusType: "FIRST_UPGRADE_TRIAL",
			displayName: "Trial credits",
			currentUsage: 0,
			usageLimit: 500,
			expiresAt: BONUS_EXPIRES_S,
			status: "ACTIVE",
		},
		{ bonusType: "PROMO", displayName: "Old promo", currentUsage: 10, usageLimit: 10, status: "EXPIRED" },
	];
	return {
		overageConfiguration: { overageStatus: overrides.overage ?? "DISABLED" },
		subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
		userInfo: { email: "someone@example.com" },
		usageBreakdownList: [
			{
				resourceType: "CREDIT",
				displayNamePlural: "Credits",
				currentUsageWithPrecision: overrides.used ?? 0.32,
				usageLimitWithPrecision: overrides.limit ?? 638,
				nextDateReset: RESET_S,
				currentOveragesWithPrecision: 12.5,
				overageCapWithPrecision: 10000,
				overageRate: 0.04,
				overageCharges: 0.5,
				bonuses: overrides.bonus === false ? [] : bonuses,
			},
		],
	};
}

type Captured = { url: string; headers: Headers; body: unknown };

function context(respond: () => Response, captured: Captured[] = []): UsageFetchContext {
	return {
		fetch: async (input, init) => {
			captured.push({
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)),
			});
			return respond();
		},
	};
}

const socialParams = (): UsageFetchParams => ({
	provider: "kiro",
	credential: {
		type: "oauth",
		accessToken: "social-access",
		expiresAt: Date.now() + 3_600_000,
		orgId: PROFILE_ARN,
		apiEndpoint: "https://runtime.us-east-1.kiro.dev/",
	},
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("kiroUsageProvider", () => {
	it("reports plan credits and active bonuses from GetUsageLimits on the profile's management region", async () => {
		const captured: Captured[] = [];
		const report = await kiroUsageProvider.fetchUsage(
			socialParams(),
			context(() => json(livePayload()), captured),
		);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://management.us-east-1.kiro.dev/");
		expect(captured[0]?.headers.get("x-amz-target")).toBe("AmazonCodeWhispererService.GetUsageLimits");
		expect(captured[0]?.body).toEqual({
			origin: "KIRO_CLI",
			profileArn: PROFILE_ARN,
			resourceType: "AGENTIC_REQUEST",
		});

		expect(report?.limits.map(limit => limit.id)).toEqual(["kiro:credits", "kiro:bonus:first-upgrade-trial"]);
		const [plan, bonus] = report!.limits;
		expect(plan).toMatchObject({
			label: "Kiro Pro credits",
			status: "ok",
			amount: { used: 0.32, limit: 638, remaining: 637.68, unit: "credits" },
			window: { resetsAt: RESET_S * 1000 },
		});
		expect(bonus).toMatchObject({
			label: "Trial credits",
			amount: { used: 0, limit: 500, unit: "credits" },
			window: { resetsAt: BONUS_EXPIRES_S * 1000, resetLabel: "expires" },
		});
		// Overage disabled: no overage row; the account email never leaves the response.
		expect(JSON.stringify(report)).not.toContain("someone@example.com");
	});

	it("marks a spent plan exhausted only when no bonus or overage remains, and flags paid overage", () => {
		const spent = { used: 638, limit: 638 };
		expect(parseKiroUsage(livePayload({ ...spent, bonus: false }))?.limits.map(limit => limit.status)).toEqual([
			"exhausted",
		]);
		expect(parseKiroUsage(livePayload(spent))?.limits[0]?.status).toBe("warning");

		const withOverage = parseKiroUsage(livePayload({ ...spent, bonus: false, overage: "ENABLED" }));
		expect(withOverage?.limits[0]?.status).toBe("warning");
		expect(withOverage?.limits.find(limit => limit.id === "kiro:overage")).toMatchObject({
			amount: { used: 12.5, limit: 10000, unit: "credits" },
			status: "ok",
			notes: ["Free credits used up; drawing paid overage", "Overage charges: $0.50 ($0.04 per credit)"],
		});
	});

	it("returns no report for a malformed or failed response and throws an auth error for a rejected login", async () => {
		for (const respond of [
			() => json({ usageBreakdownList: "nope" }),
			() => new Response("not json"),
			() => json({}, 500),
		]) {
			expect(await kiroUsageProvider.fetchUsage(socialParams(), context(respond))).toBeNull();
		}
		await expect(
			kiroUsageProvider.fetchUsage(
				socialParams(),
				context(() => json({ message: "denied" }, 403)),
			),
		).rejects.toMatchObject({ status: 403 });
	});

	it("routes an API key by its stored endpoint without a profile and never fails on a refusal", async () => {
		const captured: Captured[] = [];
		const params: UsageFetchParams = {
			provider: "kiro",
			credential: {
				type: "api_key",
				apiKey: encodeKiroCredential({
					kind: "api_key",
					token: "ksk_key",
					apiEndpoint: "https://runtime.eu-central-1.kiro.dev/",
				}),
			},
		};
		await kiroUsageProvider.fetchUsage(
			params,
			context(() => json(livePayload()), captured),
		);
		expect(captured[0]?.url).toBe("https://management.eu-central-1.kiro.dev/");
		expect(captured[0]?.body).toEqual({ origin: "KIRO_CLI", resourceType: "AGENTIC_REQUEST" });
		expect(
			await kiroUsageProvider.fetchUsage(
				params,
				context(() => json({}, 403)),
			),
		).toBeNull();
	});
});

describe("kiroRankingStrategy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * Which account a new session lands on: `preferred` has priority, `fallback`
	 * (unless `alone`) has plan credits left.
	 */
	async function selectedAccount(preferred: UsageReport, alone = false): Promise<string | undefined> {
		const reports: Record<string, UsageReport> = {
			preferred,
			fallback: parseKiroUsage(livePayload({ used: 100, bonus: false }))!,
		};
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials.kiro as OAuthCredentials | undefined;
			return credential?.accountId ? { apiKey: credential.accountId, newCredentials: credential } : null;
		});
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === "kiro"
					? { id: "kiro", fetchUsage: async params => reports[params.credential.accountId ?? ""] ?? null }
					: undefined,
			accountPolicies: [
				{ provider: "kiro", account: { accountId: "preferred" }, priority: 100 },
				{ provider: "kiro", account: { accountId: "fallback" }, priority: 10 },
			],
		});
		try {
			await storage.credentials.reload();
			await storage.credentials.set(
				"kiro",
				(alone ? ["preferred"] : ["preferred", "fallback"]).map(accountId => ({
					type: "oauth" as const,
					access: `access-${accountId}`,
					refresh: `refresh-${accountId}`,
					expires: Date.now() + 3_600_000,
					accountId,
				})),
			);
			return await storage.keys.get("kiro", "kiro-ranking-session");
		} finally {
			storage.close();
		}
	}

	it("ranks on free credits: bonus keeps a spent plan's slot, paid overage yields but still serves alone", async () => {
		const spent = { used: 638, limit: 638 };
		// Plan meter reads 100% used, but a free bonus grant still serves.
		expect(await selectedAccount(parseKiroUsage(livePayload(spent))!)).toBe("preferred");
		// Only paid overage left: a sibling with free plan credits takes over…
		const overageOnly = parseKiroUsage(livePayload({ ...spent, bonus: false, overage: "ENABLED" }))!;
		expect(await selectedAccount(overageOnly)).toBe("fallback");
		// …but the account is not blocked, so it still serves when it is the only one.
		expect(await selectedAccount(overageOnly, true)).toBe("preferred");
		// Nothing left to draw on: the account is out and the sibling serves.
		expect(await selectedAccount(parseKiroUsage(livePayload({ ...spent, bonus: false }))!)).toBe("fallback");
	});

	it("does not count a bonus grant that expired after the report was fetched", () => {
		const report = parseKiroUsage(livePayload({ used: 638, limit: 638 }))!;
		const stale: UsageReport = {
			...report,
			limits: report.limits.map(limit =>
				limit.id.startsWith("kiro:bonus:")
					? { ...limit, window: { ...limit.window!, resetsAt: Date.now() - 1 } }
					: limit,
			),
		};
		expect(kiroRankingStrategy.scopeLimits?.(report)?.[0]?.status).not.toBe("exhausted");
		expect(kiroRankingStrategy.scopeLimits?.(stale)?.[0]?.status).toBe("exhausted");
	});
});
