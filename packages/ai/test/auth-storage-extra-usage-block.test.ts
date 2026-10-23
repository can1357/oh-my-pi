import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { claudeRankingStrategy, parseClaudeUsagePayload } from "@oh-my-pi/pi-ai/usage/claude";
import { openaiCodexUsageProvider } from "@oh-my-pi/pi-ai/usage/openai-codex";
import { EXTRA_USAGE_BLOCK_SCOPE } from "../src/auth/blocks";

interface TieredUsageAccount {
	accountId: string;
	payload: Record<string, unknown>;
}

function claudePayload(
	resetAt: number,
	planUsed: number,
	spend?: { used: number; limit: number | null },
): Record<string, unknown> {
	const resetsAt = new Date(resetAt).toISOString();
	return {
		five_hour: { utilization: planUsed, resets_at: resetsAt },
		seven_day: { utilization: planUsed, resets_at: resetsAt },
		...(spend === undefined
			? {}
			: {
					spend: {
						enabled: true,
						used: {
							amount_minor: Math.round(spend.used * 100),
							currency: "USD",
							exponent: 2,
						},
						limit:
							spend.limit === null
								? null
								: {
										amount_minor: Math.round(spend.limit * 100),
										currency: "USD",
										exponent: 2,
									},
					},
				}),
	};
}

describe("AuthStorage paid usage blocks", () => {
	const storages: AuthStorage[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	async function createStorage(accounts: readonly TieredUsageAccount[]): Promise<AuthStorage> {
		const byAccount = new Map(accounts.map(account => [account.accountId, account]));
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const storage = new AuthStorage(store, {
			configValueResolver: async value => value,
			rankingStrategyResolver: provider => (provider === "anthropic" ? claudeRankingStrategy : undefined),
			usageProviderResolver: provider =>
				provider === "anthropic"
					? {
							id: "anthropic",
							fetchUsage: async params => {
								const accountId = params.credential.accountId;
								const account = accountId === undefined ? undefined : byAccount.get(accountId);
								if (!account) return null;
								return parseClaudeUsagePayload(account.payload, { accountId });
							},
						}
					: undefined,
		});
		await storage.credentials.set(
			"anthropic",
			accounts.map(account => ({
				type: "oauth" as const,
				access: `access-${account.accountId}`,
				refresh: `refresh-${account.accountId}`,
				expires: Date.now() + 60 * 60_000,
				accountId: account.accountId,
			})),
		);
		storages.push(storage);
		return storage;
	}

	it("blocks paid usage through the allowance reset, rotates to a sibling, and preserves that block through global healing", async () => {
		let now = Date.parse("2030-01-01T00:00:00.000Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const resetAt = now + 24 * 60 * 60_000;
		const storage = await createStorage([
			{
				accountId: "paid",
				payload: claudePayload(resetAt, 100, { used: 50, limit: 100 }),
			},
			{
				accountId: "sibling",
				payload: claudePayload(resetAt, 20, { used: 0, limit: 100 }),
			},
		]);
		const primary = storage.oauth.accounts("anthropic")[0];
		if (!primary) throw new Error("expected paid account");

		const marked = await storage.limits.markReached("anthropic", "tiered", {
			credentialId: primary.credentialId,
			modelId: "claude-sonnet-4-5",
			retryAfterMs: 60_000,
			providerTimed: true,
		});
		expect(marked.switched).toBe(true);
		const extraBlock = storage.blocks
			.list([primary.credentialId])
			.find(block => block.blockScope === EXTRA_USAGE_BLOCK_SCOPE);
		expect(extraBlock).toMatchObject({
			credentialId: primary.credentialId,
			providerKey: "anthropic:oauth",
			blockedUntilMs: resetAt,
		});
		expect(await storage.keys.get("anthropic", "tiered", { modelId: "claude-sonnet-4-5" })).toBe("access-sibling");

		now += 5 * 60_000 + 1;
		await storage.usage.invalidate("anthropic");
		await storage.health.model("anthropic", {
			modelId: "claude-sonnet-4-5",
			reserveFraction: 0.05,
			extraUsage: "to-floor",
		});

		const healed = storage.blocks.list([primary.credentialId]);
		expect(healed.find(block => block.blockScope === "")).toBeUndefined();
		expect(healed.find(block => block.blockScope === EXTRA_USAGE_BLOCK_SCOPE)?.blockedUntilMs).toBe(resetAt);
	});

	it("does not add an extra-usage block while plan allowance remains", async () => {
		const resetAt = Date.now() + 24 * 60 * 60_000;
		const storage = await createStorage([
			{
				accountId: "allowance",
				payload: claudePayload(resetAt, 50, { used: 50, limit: 100 }),
			},
		]);
		const account = storage.oauth.accounts("anthropic")[0];
		if (!account) throw new Error("expected allowance account");

		await storage.limits.markReached("anthropic", "allowance", {
			credentialId: account.credentialId,
			modelId: "claude-sonnet-4-5",
			retryAfterMs: 60_000,
			providerTimed: true,
		});

		expect(
			storage.blocks.list([account.credentialId]).some(block => block.blockScope === EXTRA_USAGE_BLOCK_SCOPE),
		).toBe(false);
	});
	it("A5 extends a credit-funded Codex paid-refusal block to the allowance reset without a retry hint", async () => {
		const now = Date.parse("2030-01-03T00:00:00.000Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const resetAt = now + 7 * 24 * 60 * 60_000;
		const payload = {
			plan_type: "pro",
			rate_limit: {
				allowed: false,
				limit_reached: true,
				primary_window: {
					used_percent: 100,
					limit_window_seconds: 7 * 24 * 60 * 60,
					reset_at: Math.floor(resetAt / 1000),
				},
				secondary_window: null,
			},
			additional_rate_limits: [],
			credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: "120" },
			spend_control: { reached: false },
		};
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"), {
			usageProviderResolver: provider =>
				provider === "openai-codex"
					? {
							id: "openai-codex",
							fetchUsage: async (params, context) =>
								openaiCodexUsageProvider.fetchUsage(params, {
									...context,
									fetch: async input => {
										const url =
											typeof input === "string"
												? input
												: input instanceof URL
													? input.toString()
													: input.url;
										return url.includes("/wham/usage")
											? new Response(JSON.stringify(payload), {
													status: 200,
													headers: { "content-type": "application/json" },
												})
											: new Response(null, { status: 404 });
									},
								}),
						}
					: undefined,
		});
		storages.push(storage);
		await storage.credentials.set("openai-codex", [
			{
				type: "oauth",
				access: "access-codex",
				refresh: "refresh-codex",
				expires: now + 60 * 60_000,
				accountId: "codex",
			},
		]);
		const account = storage.oauth.accounts("openai-codex")[0];
		if (!account) throw new Error("Expected Codex OAuth account");

		await storage.limits.markReached("openai-codex", "a5", {
			credentialId: account.credentialId,
			modelId: "gpt-5.3-codex",
		});

		expect(
			storage.blocks.list([account.credentialId]).find(block => block.blockScope === EXTRA_USAGE_BLOCK_SCOPE)
				?.blockedUntilMs,
		).toBe(resetAt);
	});
});
