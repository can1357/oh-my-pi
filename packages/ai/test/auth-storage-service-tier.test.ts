import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { SERVICE_TIER_UNAVAILABLE_FEATURE, streamSimple } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolveContext } from "@oh-my-pi/pi-ai/auth-retry";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { openaiCodexUsageProvider } from "@oh-my-pi/pi-ai/usage/openai-codex";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { Context } from "@oh-my-pi/pi-ai/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { withEnv } from "./helpers";

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

function window(provider: string, id: string, windowId: string, durationMs: number, usedFraction: number): UsageLimit {
	return {
		id,
		label: id,
		scope: { provider, windowId, shared: true },
		window: { id: windowId, label: windowId, durationMs, resetsAt: Date.now() + durationMs / 2 },
		amount: {
			unit: "percent",
			used: usedFraction * 100,
			limit: 100,
			remaining: (1 - usedFraction) * 100,
			usedFraction,
			remainingFraction: 1 - usedFraction,
		},
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function oauth(accountId: string): { type: "oauth" } & OAuthCredentials {
	return {
		type: "oauth",
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + WEEK_MS,
		accountId,
		email: `${accountId}@example.com`,
	};
}

describe("service-tier credential selection", () => {
	let store: SqliteAuthCredentialStore;
	let authStorage: AuthStorage;
	const usageByAccount = new Map<string, UsageReport>();
	/** Set by a test to stall usage reads until it releases them. */
	let usageHold: { started: PromiseWithResolvers<void>; release: Promise<void> } | undefined;

	beforeEach(() => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const usageProvider = (id: string): UsageProvider => ({
			id,
			async fetchUsage(params) {
				if (usageHold) {
					usageHold.started.resolve();
					await usageHold.release;
				}
				return usageByAccount.get(params.credential.accountId ?? "") ?? null;
			},
		});
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === "openai-codex" || provider === "anthropic" ? usageProvider(provider) : undefined,
		});
		usageByAccount.clear();
		usageHold = undefined;
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider] as OAuthCredentials | undefined;
			return credential?.accountId ? { apiKey: `oauth-${credential.accountId}`, newCredentials: credential } : null;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		store.close();
	});

	describe("Codex accounts with different tier entitlements", () => {
		const MODEL = "gpt-5.6-terra";
		const ultrafast = {
			modelId: MODEL,
			serviceTier: "ultrafast",
			serviceTierAccounts: { "acct-pro": true, "acct-plus": false },
		} as const;

		/** `acct-plus` is the ordinary ranking winner: its weekly window must drain fastest. */
		function setCodexUsage(proWeeklyUsed: number): void {
			const report = (accountId: string, weeklyUsed: number): UsageReport => ({
				provider: "openai-codex",
				fetchedAt: Date.now(),
				limits: [
					window("openai-codex", "openai-codex:primary", "5h", 5 * HOUR_MS, 0.1),
					window("openai-codex", "openai-codex:secondary", "7d", WEEK_MS, weeklyUsed),
				],
				metadata: { accountId, allowed: weeklyUsed < 1, limitReached: weeklyUsed >= 1 },
			});
			usageByAccount.set("acct-pro", report("acct-pro", proWeeklyUsed));
			usageByAccount.set("acct-plus", report("acct-plus", 0.05));
		}

		beforeEach(async () => {
			await authStorage.credentials.set("openai-codex", [oauth("acct-plus"), oauth("acct-pro")]);
		});

		test("a tier request goes to the account that offers the tier, against ordinary ranking", async () => {
			setCodexUsage(0.6);

			const plain = await authStorage.keys.getWithCredential("openai-codex", "plain", { modelId: MODEL });
			const tiered = await authStorage.keys.getWithCredential("openai-codex", "tiered", ultrafast);

			expect(plain?.apiKey).toBe("oauth-acct-plus");
			expect(tiered?.apiKey).toBe("oauth-acct-pro");
			expect(tiered?.serviceTierUnavailable).toBeUndefined();
		});

		test("turning the tier on moves a session pinned elsewhere, and turning it off leaves it there", async () => {
			setCodexUsage(0.6);

			const before = await authStorage.keys.getWithCredential("openai-codex", "s", { modelId: MODEL });
			const during = await authStorage.keys.getWithCredential("openai-codex", "s", ultrafast);
			const after = await authStorage.keys.getWithCredential("openai-codex", "s", { modelId: MODEL });

			expect(before?.apiKey).toBe("oauth-acct-plus");
			expect(during?.apiKey).toBe("oauth-acct-pro");
			expect(after?.apiKey).toBe("oauth-acct-pro");
		});

		test("the tier's account keeps serving on paid overage that ordinary requests would avoid", async () => {
			// The week is spent and credits fund the account: it answers 200 off its balance.
			const spent = await openaiCodexUsageProvider.fetchUsage(
				{ provider: "openai-codex", credential: { type: "oauth", accessToken: "t", accountId: "acct-pro" } },
				{
					fetch: (async () =>
						Response.json({
							plan_type: "pro",
							rate_limit: {
								allowed: false,
								limit_reached: true,
								primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 2_000_500_000 },
								secondary_window: null,
							},
							credits: { has_credits: true, overage_limit_reached: false, balance: "489.25" },
							spend_control: { reached: false },
						})) as unknown as typeof fetch,
				},
			);
			if (!spent) throw new Error("expected a usage report for acct-pro");
			setCodexUsage(0.6);
			usageByAccount.set("acct-pro", spent);

			const plain = await authStorage.keys.getWithCredential("openai-codex", "plain", { modelId: MODEL });
			const tiered = await authStorage.keys.getWithCredential("openai-codex", "tiered", ultrafast);

			expect(plain?.apiKey).toBe("oauth-acct-plus");
			expect(tiered?.apiKey).toBe("oauth-acct-pro");
			expect(tiered?.serviceTierUnavailable).toBeUndefined();
		});

		test("once the tier's account is out of quota the rest serve, with the tier reported unavailable", async () => {
			setCodexUsage(1);

			const tiered = await authStorage.keys.getWithCredential("openai-codex", "s", ultrafast);

			expect(tiered?.apiKey).toBe("oauth-acct-plus");
			expect(tiered?.serviceTierUnavailable).toBe(true);
		});

		// The tier path records after resolution; the plain path records inside it.
		for (const serviceTier of ["priority", undefined] as const) {
			test(`a pin made while a ${serviceTier ?? "plain"} selection is in flight survives that selection`, async () => {
				setCodexUsage(0.6);
				// Hold the ranking's usage reads until the pin lands, as a startup
				// prewarm still fetching reports does when `/session pin` runs.
				const started = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				usageHold = { started, release: release.promise };
				const pro = authStorage.oauth
					.accounts("openai-codex", "s")
					.find(account => account.accountId === "acct-pro");
				if (!pro) throw new Error("expected acct-pro");
				const request = { modelId: MODEL, serviceTier };

				const prewarm = authStorage.keys.getWithCredential("openai-codex", "s", request);
				await started.promise;
				expect(authStorage.sessions.pin("openai-codex", "s", pro.credentialId)).toBe(true);
				release.resolve();
				expect((await prewarm)?.apiKey).toBe("oauth-acct-plus");

				const next = await authStorage.keys.getWithCredential("openai-codex", "s", request);
				expect(next?.apiKey).toBe("oauth-acct-pro");
				expect(authStorage.sessions.sticky?.("openai-codex", "s")).toMatchObject({
					credentialId: pro.credentialId,
					explicit: true,
				});
			});
		}
	});

	describe("Claude fast mode across a subscription and an API key", () => {
		const MODEL = "claude-opus-5-5";
		const fast = { modelId: MODEL, serviceTier: "priority" } as const;

		async function setUp(fastMode: boolean): Promise<void> {
			await authStorage.credentials.set("anthropic", [
				oauth("acct-max"),
				{ type: "api_key", key: "sk-ant-api-console", source: "login" },
			]);
			usageByAccount.set("acct-max", {
				provider: "anthropic",
				fetchedAt: Date.now(),
				limits: [
					window("anthropic", "anthropic:5h", "5h", 5 * HOUR_MS, 0.1),
					window("anthropic", "anthropic:7d", "7d", WEEK_MS, 0.1),
				],
				metadata: { accountId: "acct-max", fastMode },
			});
		}

		test("the API key serves fast requests only while the subscription cannot", async () => {
			await setUp(false);

			const plain = await authStorage.keys.getWithCredential("anthropic", "s", { modelId: MODEL });
			const tiered = await authStorage.keys.getWithCredential("anthropic", "s", fast);

			expect(plain?.apiKey).toBe("oauth-acct-max");
			expect(tiered?.apiKey).toBe("sk-ant-api-console");
			expect(tiered?.serviceTierUnavailable).toBeUndefined();
		});

		test("an environment API key serves fast requests, and a refusal without a stored row sidelines it", async () => {
			await authStorage.credentials.set("anthropic", [oauth("acct-max")]);
			usageByAccount.set("acct-max", {
				provider: "anthropic",
				fetchedAt: Date.now(),
				limits: [window("anthropic", "anthropic:5h", "5h", 5 * HOUR_MS, 0.1)],
				metadata: { accountId: "acct-max", fastMode: false },
			});
			const refusal = { serviceTier: "priority", modelId: MODEL } as const;

			await withEnv({ ANTHROPIC_API_KEY: "sk-ant-api-env", ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
				const plain = await authStorage.keys.getWithCredential("anthropic", "s", { modelId: MODEL });
				const tiered = await authStorage.keys.getWithCredential("anthropic", "s", fast);
				expect(plain?.apiKey).toBe("oauth-acct-max");
				expect(tiered?.apiKey).toBe("sk-ant-api-env");
				expect(tiered?.credentialId).toBeUndefined();

				expect(await authStorage.limits.markServiceTierUnavailable("anthropic", refusal)).toBe(true);
				expect(await authStorage.limits.markServiceTierUnavailable("anthropic", refusal)).toBe(false);
				const refused = await authStorage.keys.getWithCredential("anthropic", "s", fast);
				expect(refused?.apiKey).toBe("oauth-acct-max");
				expect(refused?.serviceTierUnavailable).toBe(true);

				await authStorage.limits.rearmServiceTier("anthropic", "priority", MODEL);
				const rearmed = await authStorage.keys.getWithCredential("anthropic", "s", fast);
				expect(rearmed?.apiKey).toBe("sk-ant-api-env");
			});
		});

		test("a subscription with fast mode keeps the request", async () => {
			await setUp(true);

			const tiered = await authStorage.keys.getWithCredential("anthropic", "s", fast);

			expect(tiered?.apiKey).toBe("oauth-acct-max");
			expect(tiered?.serviceTierUnavailable).toBeUndefined();
		});

		test("a refused key steps aside until the tier is re-armed", async () => {
			await setUp(false);
			const apiKeyRow = (await authStorage.keys.getWithCredential("anthropic", "s", fast))?.credentialId;
			if (apiKeyRow === undefined) throw new Error("expected the API key row to serve the fast request");
			const refusal = { credentialId: apiKeyRow, serviceTier: "priority", modelId: MODEL } as const;

			expect(await authStorage.limits.markServiceTierUnavailable("anthropic", refusal)).toBe(true);
			// A refusal already on record cannot steer selection any further.
			expect(await authStorage.limits.markServiceTierUnavailable("anthropic", refusal)).toBe(false);

			const refused = await authStorage.keys.getWithCredential("anthropic", "s", fast);
			expect(refused?.apiKey).toBe("oauth-acct-max");
			expect(refused?.serviceTierUnavailable).toBe(true);
			// Only the refused tier is affected: the key still serves other models' fast requests.
			const otherModel = await authStorage.keys.getWithCredential("anthropic", "s", {
				modelId: "claude-fable-5-2",
				serviceTier: "priority",
			});
			expect(otherModel?.apiKey).toBe("sk-ant-api-console");

			await authStorage.limits.rearmServiceTier("anthropic", "priority", MODEL);
			const rearmed = await authStorage.keys.getWithCredential("anthropic", "s", fast);
			expect(rearmed?.apiKey).toBe("sk-ant-api-console");
		});
	});
});

describe("streamSimple with a credential that does not offer the requested tier", () => {
	const context: Context = { systemPrompt: [], messages: [{ role: "user", content: "hi", timestamp: 0 }] };
	registerMockApi();

	test("resolves for the tier, sends the request without it, and tags the reply", async () => {
		const mock = createMockModel({ handler: { content: ["ok"] } });
		const resolves: ApiKeyResolveContext[] = [];

		const reply = await streamSimple(mock.model, context, {
			serviceTier: "priority",
			apiKey: ctx => {
				resolves.push(ctx);
				return { apiKey: "key", credentialId: 7, serviceTierUnavailable: true };
			},
		}).result();

		expect(resolves.map(ctx => ctx.serviceTier)).toEqual(["priority"]);
		expect(mock.calls[0]?.options?.serviceTier).toBeUndefined();
		expect(reply.disabledFeatures).toEqual([SERVICE_TIER_UNAVAILABLE_FEATURE]);
	});

	test("leaves the tier alone for a credential that offers it", async () => {
		const mock = createMockModel({ handler: { content: ["ok"] } });

		const reply = await streamSimple(mock.model, context, {
			serviceTier: "priority",
			apiKey: () => ({ apiKey: "key", credentialId: 7 }),
		}).result();

		expect(mock.calls[0]?.options?.serviceTier).toBe("priority");
		expect(reply.disabledFeatures).toBeUndefined();
	});
});
