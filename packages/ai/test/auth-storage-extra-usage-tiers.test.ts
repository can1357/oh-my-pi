import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type AuthAccountPolicies, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { parseClaudeUsagePayload } from "@oh-my-pi/pi-ai/usage/claude";
import { openaiCodexUsageProvider } from "@oh-my-pi/pi-ai/usage/openai-codex";

const ANTHROPIC = "anthropic" as const;
const CODEX = "openai-codex" as const;
const CLAUDE_MODEL_ID = "claude-sonnet-4-5";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STREAM_API = "extra-usage-tier-test" as Api;

const storages: AuthStorage[] = [];

type ClaudeLedgerEntry = {
	allowanceUsedPct: number;
	paid?: { used: number; limit: number | null; enabled?: boolean };
};

function money(amount: number): { amount_minor: number; currency: "USD"; exponent: 2 } {
	return { amount_minor: Math.round(amount * 100), currency: "USD", exponent: 2 };
}

function claudePayload(entry: ClaudeLedgerEntry): Record<string, unknown> {
	const resetsAt = new Date(Date.now() + WEEK_MS).toISOString();
	return {
		five_hour: { utilization: 0, resets_at: resetsAt },
		seven_day: { utilization: entry.allowanceUsedPct, resets_at: resetsAt },
		...(entry.paid
			? {
					spend: {
						enabled: entry.paid.enabled ?? true,
						used: money(entry.paid.used),
						limit: entry.paid.limit === null ? null : money(entry.paid.limit),
					},
				}
			: {}),
	};
}

function claudeUsageProvider(ledger: Map<string, ClaudeLedgerEntry>): UsageProvider {
	return {
		id: ANTHROPIC,
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			const entry = accountId === undefined ? undefined : ledger.get(accountId);
			return entry === undefined ? null : parseClaudeUsagePayload(claudePayload(entry), { accountId });
		},
	};
}

function oauthCredential(accountId: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + WEEK_MS,
		accountId,
		email: `${accountId}@example.com`,
	};
}

async function createClaudeStorage(args: {
	ledger: Map<string, ClaudeLedgerEntry>;
	accountIds: readonly string[];
	policies: AuthAccountPolicies;
	includeStoredApiKey?: boolean;
}): Promise<AuthStorage> {
	const storage = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"), {
		usageProviderResolver: provider => (provider === ANTHROPIC ? claudeUsageProvider(args.ledger) : undefined),
		accountPolicies: args.policies,
	});
	storages.push(storage);
	await storage.credentials.set(ANTHROPIC, [
		...args.accountIds.map(accountId => ({ type: "oauth" as const, ...oauthCredential(accountId) })),
		...(args.includeStoredApiKey ? [{ type: "api_key" as const, key: "stored-api-key" }] : []),
	]);
	return storage;
}

async function claudeBearer(
	auth: AuthStorage,
	sessionId: string,
	extraUsage?: "to-floor" | "past-floor",
): Promise<string | undefined> {
	return auth.keys.get(ANTHROPIC, sessionId, {
		modelId: CLAUDE_MODEL_ID,
		...(extraUsage === undefined ? {} : { extraUsage }),
	});
}

async function expectExtraUsageWithheld(
	auth: AuthStorage,
	provider: typeof ANTHROPIC | typeof CODEX,
	options: { modelId?: string } = {},
): Promise<void> {
	let failure: unknown;
	try {
		await auth.keys.getWithCredential(provider, "withheld", options);
	} catch (error) {
		failure = error;
	}
	expect(AIError.isUsageLimit(failure)).toBe(true);
	if (!(failure instanceof Error)) throw new Error("Expected paid-usage floor to reject selection");
	expect(failure.message).toStartWith(AIError.EXTRA_USAGE_WITHHELD_PREFIX);
}

function exhaustedCodexPlanLimit(): UsageLimit {
	return {
		id: "openai-codex:primary",
		label: "Codex Primary",
		scope: { provider: CODEX, windowId: "1h", shared: true },
		window: { id: "1h", label: "1 Hour", durationMs: 60 * 60_000, resetsAt: Date.now() + WEEK_MS },
		amount: { unit: "percent", usedFraction: 1, remainingFraction: 0 },
		status: "exhausted",
	};
}

function codexCreditReport(accountId: string, balance: number): UsageReport {
	return {
		provider: CODEX,
		fetchedAt: Date.now(),
		limits: [
			exhaustedCodexPlanLimit(),
			{
				id: "openai-codex:credits",
				label: "Codex Credits",
				scope: { provider: CODEX, windowId: "credits" },
				amount: { unit: "credits", remaining: balance },
			},
		],
		metadata: {
			accountId,
			allowed: false,
			limitReached: true,
			creditOverage: true,
			creditsUnlimited: false,
		},
	};
}

async function createCodexStorage(floor: number): Promise<AuthStorage> {
	const storage = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"), {
		usageProviderResolver: provider =>
			provider === CODEX
				? {
						id: CODEX,
						async fetchUsage(params) {
							return codexCreditReport(params.credential.accountId ?? "codex", 100);
						},
					}
				: undefined,
		accountPolicies: [{ provider: CODEX, account: { accountId: "codex" }, extraUsageFloor: floor }],
	});
	storages.push(storage);
	await storage.credentials.set(CODEX, [{ type: "oauth", ...oauthCredential("codex") }]);
	return storage;
}

type CodexParserLedgerEntry = {
	balance?: number;
	resetAt: number;
};

function codexCreditPayload(entry: CodexParserLedgerEntry): Record<string, unknown> {
	return {
		plan_type: "pro",
		rate_limit: {
			allowed: false,
			limit_reached: true,
			primary_window: {
				used_percent: 100,
				limit_window_seconds: WEEK_MS / 1000,
				reset_at: Math.floor(entry.resetAt / 1000),
			},
			secondary_window: null,
		},
		additional_rate_limits: [],
		credits:
			entry.balance === undefined
				? { has_credits: false, unlimited: false, overage_limit_reached: false, balance: "0" }
				: {
						has_credits: true,
						unlimited: false,
						overage_limit_reached: false,
						balance: String(entry.balance),
					},
		spend_control: { reached: false },
	};
}

function parserBackedCodexUsageProvider(
	ledger: Map<string, CodexParserLedgerEntry>,
	fetches?: Map<string, number>,
	failingAccounts?: ReadonlySet<string>,
): UsageProvider {
	return {
		id: CODEX,
		async fetchUsage(params, context) {
			const accountId = params.credential.accountId;
			if (accountId === undefined) return null;
			const entry = ledger.get(accountId);
			if (!entry) return null;
			fetches?.set(accountId, (fetches.get(accountId) ?? 0) + 1);
			if (failingAccounts?.has(accountId)) throw new Error(`usage unavailable for ${accountId}`);
			return openaiCodexUsageProvider.fetchUsage(params, {
				...context,
				fetch: async input => {
					const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
					return url.includes("/wham/usage")
						? new Response(JSON.stringify(codexCreditPayload(entry)), {
								status: 200,
								headers: { "content-type": "application/json" },
							})
						: new Response(null, { status: 404 });
				},
			});
		},
	};
}

async function createParserBackedCodexStorage(args: {
	ledger: Map<string, CodexParserLedgerEntry>;
	accountIds: readonly string[];
	policies: AuthAccountPolicies;
	fetches?: Map<string, number>;
	failingAccounts?: ReadonlySet<string>;
}): Promise<AuthStorage> {
	const storage = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"), {
		usageProviderResolver: provider =>
			provider === CODEX
				? parserBackedCodexUsageProvider(args.ledger, args.fetches, args.failingAccounts)
				: undefined,
		accountPolicies: args.policies,
	});
	storages.push(storage);
	await storage.credentials.set(
		CODEX,
		args.accountIds.map(accountId => ({ type: "oauth" as const, ...oauthCredential(accountId) })),
	);
	return storage;
}

beforeEach(() => {
	vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
		const credential = credentials[provider] as OAuthCredentials | undefined;
		return credential === undefined
			? null
			: {
					apiKey: `bearer-${credential.accountId ?? "unknown"}`,
					newCredentials: credential,
				};
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const storage of storages) storage.close();
	storages.length = 0;
});

describe("AuthStorage paid extra-usage tiers", () => {
	it("selects a paid-capable Anthropic account and only blocks the account with no paid row", async () => {
		const ledger = new Map<string, ClaudeLedgerEntry>([
			["gmail", { allowanceUsedPct: 100 }],
			["org-e27f", { allowanceUsedPct: 100, paid: { used: 119.85, limit: null } }],
			["org-a623", { allowanceUsedPct: 100, paid: { used: 402.88, limit: null } }],
			["org-7b4f", { allowanceUsedPct: 100, paid: { used: 190.74, limit: 200 } }],
		]);
		const auth = await createClaudeStorage({
			ledger,
			accountIds: [...ledger.keys()],
			policies: [
				{ provider: ANTHROPIC, account: { accountId: "org-e27f" }, priority: 3 },
				{ provider: ANTHROPIC, account: { accountId: "org-a623" }, priority: 2 },
				{ provider: ANTHROPIC, account: { accountId: "org-7b4f" }, priority: 1 },
			],
		});

		expect(await claudeBearer(auth, "live-replay")).toMatch(/^bearer-org-(?:e27f|a623|7b4f)$/);
		const accounts = auth.oauth.accounts(ANTHROPIC);
		const gmail = accounts.find(account => account.accountId === "gmail");
		if (!gmail) throw new Error("Expected the gmail account");
		const blocks = auth.blocks.list(accounts.map(account => account.credentialId));
		expect(blocks.map(block => block.credentialId)).toEqual([gmail.credentialId]);
	});

	it("prefers remaining plan allowance over a higher-priority paid account", async () => {
		const ledger = new Map<string, ClaudeLedgerEntry>([
			["a", { allowanceUsedPct: 100, paid: { used: 20, limit: 100 } }],
			["b", { allowanceUsedPct: 10 }],
		]);
		const auth = await createClaudeStorage({
			ledger,
			accountIds: ["a", "b"],
			policies: [
				{ provider: ANTHROPIC, account: { accountId: "a" }, priority: 3 },
				{ provider: ANTHROPIC, account: { accountId: "b" }, priority: 1 },
			],
		});

		expect(await claudeBearer(auth, "allowance-first")).toBe("bearer-b");
		ledger.set("b", { allowanceUsedPct: 100 });
		await auth.usage.invalidate(ANTHROPIC);
		expect(await claudeBearer(auth, "allowance-first")).toBe("bearer-a");
	});

	it("evicts a warm paid pin only for a higher-priority paid sibling", async () => {
		const selectAfterPinning = async (aPriority: number, cPriority: number): Promise<string | undefined> => {
			const ledger = new Map<string, ClaudeLedgerEntry>([
				["a", { allowanceUsedPct: 100, paid: { used: 20, limit: 100 } }],
				["c", { allowanceUsedPct: 0 }],
			]);
			const auth = await createClaudeStorage({
				ledger,
				accountIds: ["a", "c"],
				policies: [
					{ provider: ANTHROPIC, account: { accountId: "a" }, priority: aPriority },
					{ provider: ANTHROPIC, account: { accountId: "c" }, priority: cPriority },
				],
			});
			expect(await claudeBearer(auth, `paid-pin-${aPriority}-${cPriority}`)).toBe("bearer-c");
			ledger.set("c", { allowanceUsedPct: 100, paid: { used: 20, limit: 100 } });
			await auth.usage.invalidate(ANTHROPIC);
			return claudeBearer(auth, `paid-pin-${aPriority}-${cPriority}`);
		};

		expect(await selectAfterPinning(3, 1)).toBe("bearer-a");
		expect(await selectAfterPinning(3, 3)).toBe("bearer-c");
	});

	it("withholds floor-protected paid usage without falling through to a stored API key", async () => {
		const ledger = new Map<string, ClaudeLedgerEntry>([
			["low", { allowanceUsedPct: 100, paid: { used: 95, limit: 100 } }],
			["high", { allowanceUsedPct: 100, paid: { used: 50, limit: 100 } }],
		]);
		const policies: AuthAccountPolicies = [
			{ provider: ANTHROPIC, account: { accountId: "low" }, extraUsageFloor: 10 },
			{ provider: ANTHROPIC, account: { accountId: "high" }, extraUsageFloor: 10 },
		];
		const auth = await createClaudeStorage({
			ledger,
			accountIds: ["low", "high"],
			policies,
			includeStoredApiKey: true,
		});

		expect(await claudeBearer(auth, "floor-selection")).toBe("bearer-high");
		ledger.set("high", { allowanceUsedPct: 100, paid: { used: 95, limit: 100 } });
		await auth.usage.invalidate(ANTHROPIC);
		await expectExtraUsageWithheld(auth, ANTHROPIC, { modelId: CLAUDE_MODEL_ID });
		expect(await claudeBearer(auth, "floor-selection")).toBeUndefined();
		expect(await claudeBearer(auth, "floor-selection-past", "past-floor")).toMatch(/^bearer-(?:low|high)$/);
	});

	it("uses an uncapped Anthropic budget as the paid-usage guard", async () => {
		const makeStorage = (budget: number) =>
			createClaudeStorage({
				ledger: new Map([["uncapped", { allowanceUsedPct: 100, paid: { used: 402.88, limit: null } }]]),
				accountIds: ["uncapped"],
				policies: [{ provider: ANTHROPIC, account: { accountId: "uncapped" }, extraUsageBudget: budget }],
			});

		await expectExtraUsageWithheld(await makeStorage(400), ANTHROPIC, { modelId: CLAUDE_MODEL_ID });
		expect(await claudeBearer(await makeStorage(450), "budget-allowed")).toBe("bearer-uncapped");
	});

	it("withholds a single account below its paid floor", async () => {
		const auth = await createClaudeStorage({
			ledger: new Map([["only", { allowanceUsedPct: 100, paid: { used: 95, limit: 100 } }]]),
			accountIds: ["only"],
			policies: [{ provider: ANTHROPIC, account: { accountId: "only" }, extraUsageFloor: 10 }],
		});

		await expectExtraUsageWithheld(auth, ANTHROPIC, { modelId: CLAUDE_MODEL_ID });
	});

	it("uses Codex credits only while their configured floor remains", async () => {
		await expectExtraUsageWithheld(await createCodexStorage(200), CODEX);
		await expect((await createCodexStorage(50)).keys.get(CODEX, "codex-floor")).resolves.toBe("bearer-codex");
	});

	it("A1 withholds an AUTH-blocked Codex balance below its configured floor before the last-resort pass", async () => {
		const now = Date.parse("2030-01-01T00:00:00.000Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const resetAt = now + WEEK_MS;
		const auth = await createParserBackedCodexStorage({
			ledger: new Map([
				["a", { balance: 120, resetAt }],
				["b", { resetAt }],
			]),
			accountIds: ["a", "b"],
			policies: [
				{ provider: CODEX, account: { accountId: "a" }, priority: 3, extraUsageFloor: 200 },
				{ provider: CODEX, account: { accountId: "b" }, priority: 1 },
			],
		});
		const a = auth.oauth.accounts(CODEX).find(account => account.accountId === "a");
		if (!a) throw new Error("Expected account a");
		auth.blocks.upsert({
			credentialId: a.credentialId,
			providerKey: "openai-codex:oauth",
			blockScope: "auth",
			blockedUntilMs: now + 5 * 60_000,
		});

		let failure: unknown;
		try {
			await auth.keys.getWithCredential(CODEX, "a1");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AIError.ExtraUsageWithheldError);
		expect((failure as AIError.ExtraUsageWithheldError).retryAt).toBe(resetAt);
	});

	it("A2 uses a retained cached Codex report to withhold a blocked floor account without another provider call", async () => {
		const now = Date.parse("2030-01-02T00:00:00.000Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const resetAt = now + WEEK_MS;
		const fetches = new Map<string, number>();
		const failingAccounts = new Set<string>();
		const auth = await createParserBackedCodexStorage({
			ledger: new Map([
				["a", { balance: 120, resetAt }],
				["b", { resetAt }],
			]),
			accountIds: ["a", "b"],
			policies: [
				{ provider: CODEX, account: { accountId: "a" }, priority: 3, extraUsageFloor: 200 },
				{ provider: CODEX, account: { accountId: "b" }, priority: 1 },
			],
			fetches,
			failingAccounts,
		});
		await auth.usage.reports();
		expect(fetches.get("a")).toBe(1);
		failingAccounts.add("a");
		const a = auth.oauth.accounts(CODEX).find(account => account.accountId === "a");
		if (!a) throw new Error("Expected account a");
		auth.blocks.upsert({
			credentialId: a.credentialId,
			providerKey: "openai-codex:oauth",
			blockScope: "auth",
			blockedUntilMs: now + 5 * 60_000,
		});

		await expectExtraUsageWithheld(auth, CODEX);
		expect(fetches.get("a")).toBe(1);
	});

	it("A3 still admits blocked paid capacity inside its floor and explicit past-floor use", async () => {
		const now = Date.parse("2030-01-03T00:00:00.000Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const resetAt = now + WEEK_MS;
		const withinFloor = await createParserBackedCodexStorage({
			ledger: new Map([
				["a", { balance: 500, resetAt }],
				["b", { resetAt }],
			]),
			accountIds: ["a", "b"],
			policies: [
				{ provider: CODEX, account: { accountId: "a" }, priority: 3, extraUsageFloor: 200 },
				{ provider: CODEX, account: { accountId: "b" }, priority: 1 },
			],
		});
		const withinFloorA = withinFloor.oauth.accounts(CODEX).find(account => account.accountId === "a");
		if (!withinFloorA) throw new Error("Expected account a");
		withinFloor.blocks.upsert({
			credentialId: withinFloorA.credentialId,
			providerKey: "openai-codex:oauth",
			blockScope: "auth",
			blockedUntilMs: now + 5 * 60_000,
		});
		expect(await withinFloor.keys.get(CODEX, "a3-within")).toBe("bearer-a");

		const pastFloor = await createParserBackedCodexStorage({
			ledger: new Map([
				["a", { balance: 120, resetAt }],
				["b", { resetAt }],
			]),
			accountIds: ["a", "b"],
			policies: [
				{ provider: CODEX, account: { accountId: "a" }, priority: 3, extraUsageFloor: 200 },
				{ provider: CODEX, account: { accountId: "b" }, priority: 1 },
			],
		});
		const pastFloorA = pastFloor.oauth.accounts(CODEX).find(account => account.accountId === "a");
		if (!pastFloorA) throw new Error("Expected account a");
		pastFloor.blocks.upsert({
			credentialId: pastFloorA.credentialId,
			providerKey: "openai-codex:oauth",
			blockScope: "auth",
			blockedUntilMs: now + 5 * 60_000,
		});
		expect(await pastFloor.keys.get(CODEX, "a3-past", { extraUsage: "past-floor" })).toBe("bearer-a");
	});

	it("A7 chooses a renewed high-priority account over a paid sibling when its old floor report has expired", async () => {
		const now = Date.parse("2030-01-04T00:00:00.000Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const expiredReset = new Date(now - 60_000).toISOString();
		const stale = parseClaudeUsagePayload(
			{
				five_hour: { utilization: 100, resets_at: expiredReset },
				seven_day: { utilization: 100, resets_at: expiredReset },
				spend: { enabled: true, used: money(95), limit: money(100) },
			},
			{ accountId: "a" },
			undefined,
			now - 10 * 60_000,
		);
		const paid = parseClaudeUsagePayload(
			{
				five_hour: { utilization: 100, resets_at: new Date(now + WEEK_MS).toISOString() },
				seven_day: { utilization: 100, resets_at: new Date(now + WEEK_MS).toISOString() },
				spend: { enabled: true, used: money(10), limit: null },
			},
			{ accountId: "c" },
			undefined,
			now,
		);
		if (!stale || !paid) throw new Error("Expected usage reports");
		const reports = new Map([
			["a", stale],
			["c", paid],
		]);
		const auth = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"), {
			usageProviderResolver: provider =>
				provider === ANTHROPIC
					? { id: ANTHROPIC, fetchUsage: async params => reports.get(params.credential.accountId ?? "") ?? null }
					: undefined,
			accountPolicies: [
				{ provider: ANTHROPIC, account: { accountId: "a" }, priority: 3, extraUsageFloor: 10 },
				{ provider: ANTHROPIC, account: { accountId: "c" }, priority: 1 },
			],
		});
		storages.push(auth);
		await auth.credentials.set(ANTHROPIC, [
			{ type: "oauth", ...oauthCredential("a") },
			{ type: "oauth", ...oauthCredential("c") },
		]);
		expect(await claudeBearer(auth, "a7")).toBe("bearer-a");
	});

	it("A8 chooses a renewed high-priority account even when its stale report has no paid row", async () => {
		const now = Date.parse("2030-01-05T00:00:00.000Z");
		vi.spyOn(Date, "now").mockReturnValue(now);
		const expiredReset = new Date(now - 60_000).toISOString();
		const stale = parseClaudeUsagePayload(
			{
				five_hour: { utilization: 100, resets_at: expiredReset },
				seven_day: { utilization: 100, resets_at: expiredReset },
			},
			{ accountId: "a" },
			undefined,
			now - 10 * 60_000,
		);
		const paid = parseClaudeUsagePayload(
			{
				five_hour: { utilization: 100, resets_at: new Date(now + WEEK_MS).toISOString() },
				seven_day: { utilization: 100, resets_at: new Date(now + WEEK_MS).toISOString() },
				spend: { enabled: true, used: money(10), limit: null },
			},
			{ accountId: "c" },
			undefined,
			now,
		);
		if (!stale || !paid) throw new Error("Expected usage reports");
		const reports = new Map([
			["a", stale],
			["c", paid],
		]);
		const auth = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"), {
			usageProviderResolver: provider =>
				provider === ANTHROPIC
					? { id: ANTHROPIC, fetchUsage: async params => reports.get(params.credential.accountId ?? "") ?? null }
					: undefined,
			accountPolicies: [
				{ provider: ANTHROPIC, account: { accountId: "a" }, priority: 3 },
				{ provider: ANTHROPIC, account: { accountId: "c" }, priority: 1 },
			],
		});
		storages.push(auth);
		await auth.credentials.set(ANTHROPIC, [
			{ type: "oauth", ...oauthCredential("a") },
			{ type: "oauth", ...oauthCredential("c") },
		]);
		expect(await claudeBearer(auth, "a8")).toBe("bearer-a");
	});

	it("A10 does not add provider probes when no account has a paid floor or budget", async () => {
		let fetches = 0;
		const auth = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"), {
			usageProviderResolver: provider =>
				provider === ANTHROPIC
					? {
							id: ANTHROPIC,
							async fetchUsage(params) {
								fetches += 1;
								return parseClaudeUsagePayload(claudePayload({ allowanceUsedPct: 100 }), {
									accountId: params.credential.accountId,
								});
							},
						}
					: undefined,
		});
		storages.push(auth);
		await auth.credentials.set(ANTHROPIC, [
			{ type: "oauth", ...oauthCredential("a") },
			{ type: "oauth", ...oauthCredential("b") },
		]);
		await auth.keys.get(ANTHROPIC, "a10");
		expect(fetches).toBe(2);
	});

	it("surfaces a resolver floor rejection as an unwrapped usage-limit stream error", async () => {
		const model: Model<Api> = {
			id: "extra-usage-tier-test-model",
			name: "Extra usage tier test",
			api: STREAM_API,
			provider: ANTHROPIC,
			contextWindow: 1_000,
			maxTokens: 100,
		} as Model<Api>;
		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		};
		const stream = streamSimple(model, context, {
			apiKey: async () => {
				throw new AIError.ExtraUsageWithheldError(ANTHROPIC, Date.now() + WEEK_MS);
			},
		});

		let failure: unknown;
		try {
			for await (const _event of stream) {
				// drain
			}
		} catch (error) {
			failure = error;
		}
		expect(AIError.isUsageLimit(failure)).toBe(true);
		if (!(failure instanceof Error)) throw new Error("Expected stream to fail with the resolver usage limit");
		expect(failure.message).toStartWith(AIError.EXTRA_USAGE_WITHHELD_PREFIX);
	});
});
