import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ApiKey, ModelUsageHealth, ResetCreditAccountStatus, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { parseClaudeUsagePayload } from "@oh-my-pi/pi-ai/usage/claude";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { createCodexAutoRedeemCoordinator } from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const ANTHROPIC = "anthropic" as const;
const PRIMARY_MODEL_ID = "claude-sonnet-4-5";
const FALLBACK_MODEL_ID = "gpt-4o-mini";
const PAID_LIMIT = 10;
const PAID_FLOOR = 3;
const PAID_CHARGE = 4;
const HOUR_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const TEST_ACCOUNT_PREFIX = "tiered-s7";

const ACCOUNT_IDS = ["a", "b", "c"] as const;
type AccountId = (typeof ACCOUNT_IDS)[number];

type AccountSetup = {
	allowanceUsedPct?: number;
	paid?: { limit: number; used: number } | null;
	resetAvailable?: boolean;
	resetExpiresInMs?: number;
	priority?: number;
};

type TieredHarnessOptions = {
	withFallbackChain: boolean;
	accountOrder?: "tiered" | "usage";
	extraUsageBelowFloor?: boolean;
	usageAwareFallback?: boolean;
	withSavedReset?: boolean;
	failBUsageLimitOnce?: boolean;
	accounts?: Partial<Record<AccountId, AccountSetup>>;
	storageOrder?: readonly AccountId[];
};

type LedgerEntry = {
	allowanceUsedPct: number;
	paidLimit?: number;
	paidUsed: number;
	resetAvailable: boolean;
	resetExpiresAtMs: number;
};

type RequestTrace = {
	selector: string;
	bearer: string;
};

type Charge = {
	accountId: AccountId;
	kind: "allowance" | "paid";
	allowanceWasAvailable: boolean;
	usableResetWasAvailable: boolean;
	remainingBefore?: number;
};

type TieredPeer = {
	session: AgentSession;
	prompt(count: number): Promise<void>;
	resolvePrimary(): Promise<string | undefined>;
};

type TieredHarness = {
	session: AgentSession;
	authStorage: AuthStorage;
	primarySelector: string;
	fallbackSelector: string;
	ledger: Record<AccountId, LedgerEntry>;
	requests: RequestTrace[];
	charges: Charge[];
	events: string[];
	redemptions: string[];
	usageLimitFailures: AccountId[];
	resolvePrimary(): Promise<string | undefined>;
	readHealth(): Promise<ModelUsageHealth>;
	prompt(count: number): Promise<void>;
	peer(): TieredPeer;
	preblock(accountId: AccountId, scope: string, until: number): void;
	hasBlock(accountId: AccountId, scope: string): boolean;
	dispose(): Promise<void>;
};

function money(amount: number): { amount_minor: number; currency: "USD"; exponent: 2 } {
	return { amount_minor: Math.round(amount * 100), currency: "USD", exponent: 2 };
}

function resolveInitialApiKey(apiKey: ApiKey | undefined): string {
	const resolved = typeof apiKey === "function" ? apiKey({ lastChance: false, error: undefined }) : apiKey;
	const bearer =
		typeof resolved === "string" ? resolved : resolved && "apiKey" in resolved ? resolved.apiKey : undefined;
	if (typeof bearer !== "string") throw new Error("Expected API key to be resolved before streaming");
	return bearer;
}

function oauthCredential(accountId: AccountId): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + WEEK_MS,
		accountId: `${TEST_ACCOUNT_PREFIX}-${accountId}`,
		email: `${TEST_ACCOUNT_PREFIX}-${accountId}@example.test`,
		orgId: `${TEST_ACCOUNT_PREFIX}-org-${accountId}`,
	};
}

function claudePayload(entry: LedgerEntry): Record<string, unknown> {
	const resetsAt = new Date(Date.now() + 2 * HOUR_MS).toISOString();
	const payload = {
		five_hour: { utilization: 0, resets_at: resetsAt },
		seven_day: { utilization: entry.allowanceUsedPct, resets_at: resetsAt },
	};
	if (entry.paidLimit === undefined) return payload;
	return {
		...payload,
		spend: {
			enabled: true,
			used: money(entry.paidUsed),
			limit: money(entry.paidLimit),
		},
	};
}

function resetInventory(accountId: AccountId, expiresAtMs: number) {
	return {
		availableCount: 1,
		redeemableCount: 1,
		eligible: true,
		nextCreditId: `cedar-${accountId}`,
		credits: [
			{
				id: `cedar-${accountId}`,
				title: "Saved Claude reset",
				program: "cedar_ember",
				remainingCount: 1,
				usable: true,
				requiresLimit: true,
				clears: ["anthropic:7d"],
				blocking: ["anthropic:7d"],
				usedFractions: { "anthropic:7d": 1 },
				expiresAt: new Date(expiresAtMs).toISOString(),
				status: "available" as const,
			},
		],
	};
}

function accountIdFromBearer(bearer: string): AccountId | undefined {
	return bearer === "a" || bearer === "b" || bearer === "c" ? bearer : undefined;
}

function chargedBearers(harness: TieredHarness): string[] {
	return harness.requests
		.filter(request => request.selector === harness.primarySelector)
		.map(request => request.bearer);
}

async function createTieredHarness(options: TieredHarnessOptions) {
	const primaryModel = getBundledModel(ANTHROPIC, PRIMARY_MODEL_ID);
	const fallbackModel = getBundledModel("openai", FALLBACK_MODEL_ID);
	if (!primaryModel || !fallbackModel) throw new Error("Expected bundled Anthropic and OpenAI test models");

	const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
	const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;
	const defaults = {
		a: {
			allowanceUsedPct: 0,
			paid: { limit: PAID_LIMIT, used: 0 },
			resetAvailable: options.withSavedReset === true,
			resetExpiresInMs: WEEK_MS,
			priority: 3,
		},
		b: {
			allowanceUsedPct: 0,
			paid: { limit: PAID_LIMIT, used: 0 },
			resetAvailable: false,
			resetExpiresInMs: WEEK_MS,
			priority: 2,
		},
		c: {
			allowanceUsedPct: 0,
			paid: { limit: PAID_LIMIT, used: 0 },
			resetAvailable: false,
			resetExpiresInMs: WEEK_MS,
			priority: 1,
		},
	} satisfies Record<AccountId, Required<AccountSetup>>;
	const configured = {} as Record<AccountId, Required<AccountSetup>>;
	for (const accountId of ACCOUNT_IDS) {
		const override = options.accounts?.[accountId];
		const fallback = defaults[accountId];
		configured[accountId] = {
			allowanceUsedPct: override?.allowanceUsedPct ?? fallback.allowanceUsedPct,
			paid: override?.paid === null ? null : (override?.paid ?? fallback.paid),
			resetAvailable: override?.resetAvailable ?? fallback.resetAvailable,
			resetExpiresInMs: override?.resetExpiresInMs ?? fallback.resetExpiresInMs,
			priority: override?.priority ?? fallback.priority,
		};
	}
	const storageOrder = options.storageOrder ?? ACCOUNT_IDS;
	if (storageOrder.length !== ACCOUNT_IDS.length || new Set(storageOrder).size !== ACCOUNT_IDS.length) {
		throw new Error("Expected storage order to contain every tiered account exactly once");
	}
	const ledger = {} as Record<AccountId, LedgerEntry>;
	for (const accountId of ACCOUNT_IDS) {
		const account = configured[accountId];
		ledger[accountId] = {
			allowanceUsedPct: account.allowanceUsedPct,
			paidLimit: account.paid?.limit,
			paidUsed: account.paid?.used ?? 0,
			resetAvailable: account.resetAvailable,
			resetExpiresAtMs: Date.now() + account.resetExpiresInMs,
		};
	}
	const reportFor = (accountId: AccountId): UsageReport => {
		const entry = ledger[accountId];
		if (!entry) throw new Error(`Expected ledger entry for ${accountId}`);
		const report = parseClaudeUsagePayload(claudePayload(entry), {
			accountId: `${TEST_ACCOUNT_PREFIX}-${accountId}`,
			email: `${TEST_ACCOUNT_PREFIX}-${accountId}@example.test`,
			orgId: `${TEST_ACCOUNT_PREFIX}-org-${accountId}`,
		});
		if (!report) throw new Error("Expected fake Claude ledger to produce a usage report");
		return entry.resetAvailable
			? { ...report, resetCredits: resetInventory(accountId, entry.resetExpiresAtMs) }
			: report;
	};
	const usageProvider: UsageProvider = {
		id: ANTHROPIC,
		async fetchUsage({ credential }) {
			const accountId = credential.accountId?.replace(`${TEST_ACCOUNT_PREFIX}-`, "");
			return accountId === "a" || accountId === "b" || accountId === "c" ? reportFor(accountId) : null;
		},
	};
	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: provider => (provider === ANTHROPIC ? usageProvider : undefined),
		accountPolicies: ACCOUNT_IDS.map(accountId => ({
			provider: ANTHROPIC,
			account: { accountId: `${TEST_ACCOUNT_PREFIX}-${accountId}` },
			priority: configured[accountId].priority,
			extraUsageFloor: PAID_FLOOR,
		})),
	});
	const requests: RequestTrace[] = [];
	const charges: Charge[] = [];
	const events: string[] = [];
	const redemptions: string[] = [];
	const usageLimitFailures: AccountId[] = [];

	vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
		if (provider !== ANTHROPIC) return null;
		const credential = credentials[provider] as OAuthCredentials | undefined;
		const bearer = credential?.accountId?.replace(`${TEST_ACCOUNT_PREFIX}-`, "");
		if (!credential || (bearer !== "a" && bearer !== "b" && bearer !== "c")) return null;
		return { apiKey: bearer, newCredentials: credential };
	});

	await authStorage.credentials.reload();
	await authStorage.credentials.set(
		ANTHROPIC,
		storageOrder.map(accountId => ({
			type: "oauth" as const,
			...oauthCredential(accountId),
		})),
	);
	authStorage.keys.setRuntime("openai", "fallback-key");

	const accountFor = (accountId: AccountId) => {
		const account = authStorage.oauth
			.accounts(ANTHROPIC)
			.find(candidate => candidate.accountId === `${TEST_ACCOUNT_PREFIX}-${accountId}`);
		if (!account) throw new Error(`Expected ${accountId} in the OAuth pool`);
		return account;
	};
	vi.spyOn(authStorage.resets, "list").mockImplementation(async request => {
		if (request?.provider !== ANTHROPIC) return [];
		const activeCredentialId = authStorage.oauth
			.accounts(ANTHROPIC, request.sessionId)
			.find(account => account.active)?.credentialId;
		return ACCOUNT_IDS.flatMap(accountId => {
			if (!ledger[accountId].resetAvailable) return [];
			const account = accountFor(accountId);
			return [
				{
					provider: ANTHROPIC,
					credentialId: account.credentialId,
					report: reportFor(accountId),
					accountId: `${TEST_ACCOUNT_PREFIX}-${accountId}`,
					email: `${TEST_ACCOUNT_PREFIX}-${accountId}@example.test`,
					orgId: `${TEST_ACCOUNT_PREFIX}-org-${accountId}`,
					active: account.credentialId === activeCredentialId,
					...resetInventory(accountId, ledger[accountId].resetExpiresAtMs),
				} satisfies ResetCreditAccountStatus,
			];
		});
	});
	vi.spyOn(authStorage.resets, "redeem").mockImplementation(async request => {
		const accountId = ACCOUNT_IDS.find(account => accountFor(account).credentialId === request.target.credentialId);
		if (!accountId || request.target.creditId !== `cedar-${accountId}` || !ledger[accountId].resetAvailable) {
			return { ok: false, code: "no_credit", provider: ANTHROPIC };
		}
		const account = accountFor(accountId);
		const entry = ledger[accountId];
		if (options.failBUsageLimitOnce === true && usageLimitFailures.length === 0) {
			throw new Error("A saved reset was redeemed before B returned its live usage-limit response");
		}
		entry.allowanceUsedPct = 0;
		entry.resetAvailable = false;
		redemptions.push(accountId);
		events.push(`redeem:${accountId}`);
		await authStorage.usage.invalidate(ANTHROPIC);
		for (const block of authStorage.blocks.list([account.credentialId])) {
			authStorage.blocks.delete(block.credentialId, block.providerKey, block.blockScope);
		}
		return {
			ok: true,
			code: "reset",
			provider: ANTHROPIC,
			accountId: `${TEST_ACCOUNT_PREFIX}-${accountId}`,
			email: `${TEST_ACCOUNT_PREFIX}-${accountId}@example.test`,
			orgId: `${TEST_ACCOUNT_PREFIX}-org-${accountId}`,
			creditId: `cedar-${accountId}`,
			cleared: ["anthropic:7d"],
		};
	});

	const modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const resetCoordinator = createCodexAutoRedeemCoordinator();
	const tempDir = TempDir.createSync("@pi-tiered-account-order-");
	resetCoordinator.resetLockPath = `${tempDir.path()}/auth.db`;
	const sessions: AgentSession[] = [];
	const settingsForSession = () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.accountOrder": options.accountOrder ?? "tiered",
			"retry.usageAwareFallback": options.usageAwareFallback ?? true,
			"retry.fallbackOn": "usage-limit",
			"retry.fallbackChains": options.withFallbackChain ? { [primarySelector]: [fallbackSelector] } : {},
			"retry.extraUsageBelowFloor": options.extraUsageBelowFloor === true,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			"claudeResets.autoRedeem": "yes",
			"claudeResets.keepCredits": 0,
			"claudeResets.minBlockedMinutes": 60,
		});
		settings.setModelRole("default", primarySelector);
		return settings;
	};
	const createSession = () => {
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model =>
				modelRegistry.resolver(model, {
					sessionId: agent.sessionId,
					...session.apiKeyResolverOptions(model),
				}),
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: async (model, context, streamOptions) => {
				const selector = `${model.provider}/${model.id}`;
				let bearer: string;
				try {
					bearer = resolveInitialApiKey(streamOptions?.apiKey);
				} catch (error) {
					mock.push({ throw: error instanceof Error ? error : String(error) });
					return mock.stream(model, context, streamOptions);
				}
				requests.push({ selector, bearer });
				events.push(`request:${bearer}`);
				if (selector === primarySelector) {
					const accountId = accountIdFromBearer(bearer);
					if (!accountId) throw new Error(`Expected an OAuth bearer, got ${bearer}`);
					const entry = ledger[accountId];
					if (!entry) throw new Error(`Expected ledger entry for ${accountId}`);
					if (accountId === "b" && options.failBUsageLimitOnce === true && !usageLimitFailures.includes("b")) {
						entry.allowanceUsedPct = 100;
						usageLimitFailures.push("b");
						mock.push({
							throw: '429 {"type":"error","error":{"type":"rate_limit_error","message":"usage_limit_reached"}} retry-after-ms=7200000',
						});
						return mock.stream(model, context, streamOptions);
					}
					const allowanceWasAvailable = Object.values(ledger).some(candidate => candidate.allowanceUsedPct < 100);
					const usableResetWasAvailable = Object.values(ledger).some(candidate => candidate.resetAvailable);
					if (entry.allowanceUsedPct < 100) {
						charges.push({ accountId, kind: "allowance", allowanceWasAvailable, usableResetWasAvailable });
						entry.allowanceUsedPct = Math.min(100, entry.allowanceUsedPct + 50);
					} else {
						const remainingBefore = entry.paidLimit === undefined ? undefined : entry.paidLimit - entry.paidUsed;
						charges.push({
							accountId,
							kind: "paid",
							allowanceWasAvailable,
							usableResetWasAvailable,
							remainingBefore,
						});
						entry.paidUsed += PAID_CHARGE;
					}
					await authStorage.usage.invalidate(ANTHROPIC);
				}
				mock.push({ content: [`ok:${selector}`], stopReason: "stop" });
				return mock.stream(model, context, streamOptions);
			},
		});
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: settingsForSession(),
			modelRegistry,
			codexResetCoordinator: resetCoordinator,
		});
		sessions.push(session);
		return {
			session,
			async prompt(count: number) {
				for (let index = 0; index < count; index++) {
					await session.prompt(`Tiered account order request ${index + 1}`);
					await session.waitForIdle();
				}
			},
			async resolvePrimary() {
				return authStorage.keys.get(ANTHROPIC, session.sessionId, {
					modelId: primaryModel.id,
					extraUsage: session.apiKeyResolverOptions(primaryModel).extraUsage,
				});
			},
		} satisfies TieredPeer;
	};
	const primary = createSession();

	return {
		session: primary.session,
		authStorage,
		primarySelector,
		fallbackSelector,
		ledger,
		requests,
		charges,
		events,
		redemptions,
		usageLimitFailures,
		resolvePrimary: primary.resolvePrimary,
		async readHealth() {
			return authStorage.health.model(ANTHROPIC, {
				modelId: primaryModel.id,
				sessionId: primary.session.sessionId,
				reserveFraction: 0,
				extraUsage: primary.session.apiKeyResolverOptions(primaryModel).extraUsage,
			});
		},
		prompt: primary.prompt,
		peer: createSession,
		preblock(accountId, scope, until) {
			authStorage.blocks.upsert({
				credentialId: accountFor(accountId).credentialId,
				providerKey: `${ANTHROPIC}:oauth`,
				blockScope: scope,
				blockedUntilMs: until,
			});
		},
		hasBlock(accountId, scope) {
			return authStorage.blocks
				.list([accountFor(accountId).credentialId])
				.some(block => block.blockScope === scope && block.blockedUntilMs > Date.now());
		},
		async dispose() {
			for (const session of sessions.reverse()) await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		},
	} satisfies TieredHarness;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AgentSession tiered same-provider account order", () => {
	it("uses every plan allowance before paid usage, preserves each floor, then falls back", async () => {
		const harness = await createTieredHarness({ withFallbackChain: true });
		try {
			await harness.prompt(13);

			expect(harness.requests).toEqual([
				{ selector: harness.primarySelector, bearer: "a" },
				{ selector: harness.primarySelector, bearer: "a" },
				{ selector: harness.primarySelector, bearer: "b" },
				{ selector: harness.primarySelector, bearer: "b" },
				{ selector: harness.primarySelector, bearer: "c" },
				{ selector: harness.primarySelector, bearer: "c" },
				{ selector: harness.primarySelector, bearer: "a" },
				{ selector: harness.primarySelector, bearer: "a" },
				{ selector: harness.primarySelector, bearer: "b" },
				{ selector: harness.primarySelector, bearer: "b" },
				{ selector: harness.primarySelector, bearer: "c" },
				{ selector: harness.primarySelector, bearer: "c" },
				{ selector: harness.fallbackSelector, bearer: "fallback-key" },
			]);
			const paidCharges = harness.charges.filter(
				(charge): charge is Charge & { kind: "paid"; remainingBefore: number } =>
					charge.kind === "paid" && charge.remainingBefore !== undefined,
			);
			expect(paidCharges.map(charge => [charge.accountId, charge.remainingBefore])).toEqual([
				["a", 10],
				["a", 6],
				["b", 10],
				["b", 6],
				["c", 10],
				["c", 6],
			]);
			expect(paidCharges.every(charge => !charge.allowanceWasAvailable && charge.remainingBefore > PAID_FLOOR)).toBe(
				true,
			);
			expect(Object.values(harness.ledger).map(entry => PAID_LIMIT - entry.paidUsed)).toEqual([2, 2, 2]);
		} finally {
			await harness.dispose();
		}
	});

	it("redeems A's saved reset before sending the next request to B", async () => {
		const harness = await createTieredHarness({ withFallbackChain: true, withSavedReset: true });
		try {
			await harness.prompt(6);

			expect(chargedBearers(harness)).toEqual(["a", "a", "a", "a", "b", "b"]);
			expect(harness.events).toEqual([
				"request:a",
				"request:a",
				"redeem:a",
				"request:a",
				"request:a",
				"request:b",
				"request:b",
			]);
			expect(harness.redemptions).toEqual(["a"]);
		} finally {
			await harness.dispose();
		}
	});

	it("permits below-floor paid usage only when the primary has no successor", async () => {
		const terminal = await createTieredHarness({ withFallbackChain: false, extraUsageBelowFloor: true });
		try {
			await terminal.prompt(7);
			expect(chargedBearers(terminal)).toEqual(["a", "a", "b", "b", "c", "c", "a"]);
			expect(terminal.requests.some(request => request.selector === terminal.fallbackSelector)).toBe(false);
			expect(terminal.charges.at(-1)).toMatchObject({ accountId: "a", kind: "paid", remainingBefore: 10 });
		} finally {
			await terminal.dispose();
		}

		const withSuccessor = await createTieredHarness({ withFallbackChain: true, extraUsageBelowFloor: true });
		try {
			await withSuccessor.prompt(13);
			expect(withSuccessor.requests.at(-1)).toEqual({
				selector: withSuccessor.fallbackSelector,
				bearer: "fallback-key",
			});
			expect(
				withSuccessor.charges
					.filter(charge => charge.kind === "paid")
					.every(charge => charge.remainingBefore! > PAID_FLOOR),
			).toBe(true);
		} finally {
			await withSuccessor.dispose();
		}
	});
});

function staleBAllowanceResetOptions(accountOrder: "tiered" | "usage"): TieredHarnessOptions {
	return {
		withFallbackChain: true,
		accountOrder,
		usageAwareFallback: false,
		failBUsageLimitOnce: true,
		storageOrder: ["c", "a", "b"],
		accounts: {
			a: {
				allowanceUsedPct: 100,
				paid: null,
				resetAvailable: true,
				resetExpiresInMs: 72 * HOUR_MS,
				priority: 3,
			},
			b: { allowanceUsedPct: 0, paid: null, resetAvailable: false, priority: 2 },
			c: {
				allowanceUsedPct: 100,
				paid: null,
				resetAvailable: true,
				resetExpiresInMs: 24 * HOUR_MS,
				priority: 1,
			},
		},
	};
}

describe("AgentSession stale allowance recovery", () => {
	it("uses the tiered priority order after B's cached allowance becomes a live usage limit", async () => {
		const harness = await createTieredHarness(staleBAllowanceResetOptions("tiered"));
		try {
			const markReached = vi.spyOn(harness.authStorage.limits, "markReached");
			expect(await harness.resolvePrimary()).toBe("b");
			expect(harness.hasBlock("a", "")).toBe(true);
			expect(harness.hasBlock("c", "")).toBe(true);
			expect(harness.redemptions).toEqual([]);

			const bCredentialId = harness.authStorage.oauth
				.accounts(ANTHROPIC, harness.session.sessionId)
				.find(account => account.accountId === `${TEST_ACCOUNT_PREFIX}-b`)?.credentialId;
			if (bCredentialId === undefined) throw new Error("Expected B in the OAuth pool");
			expect((await harness.readHealth()).accounts.find(account => account.selected)).toMatchObject({
				credentialId: bCredentialId,
				fundingTier: "allowance",
			});

			await harness.prompt(1);

			expect(markReached).toHaveBeenCalledTimes(1);
			const markResult = markReached.mock.results[0]?.value;
			expect(markResult).toBeDefined();
			expect(await markResult).toMatchObject({ switched: false });
			expect(harness.usageLimitFailures).toEqual(["b"]);
			expect(harness.redemptions).toEqual(["a"]);
			expect(harness.ledger.c.resetAvailable).toBe(true);
			expect(harness.events).toEqual(["request:b", "redeem:a", "request:a"]);
			expect(harness.requests.some(request => request.selector === harness.fallbackSelector)).toBe(false);
			expect(harness.charges.some(charge => charge.kind === "paid")).toBe(false);
		} finally {
			await harness.dispose();
		}
	});

	it("keeps usage account order on the legacy expiry-ranked reset planner", async () => {
		const harness = await createTieredHarness(staleBAllowanceResetOptions("usage"));
		try {
			expect(await harness.resolvePrimary()).toBe("b");

			await harness.prompt(1);

			expect(harness.usageLimitFailures).toEqual(["b"]);
			expect(harness.redemptions).toEqual(["c"]);
			expect(harness.ledger.a.resetAvailable).toBe(true);
			expect(harness.events).toEqual(["request:b", "redeem:c", "request:c"]);
		} finally {
			await harness.dispose();
		}
	});
});

function expectPaidChargesToRespectFunding(harness: TieredHarness) {
	const paidCharges = harness.charges.filter(charge => charge.kind === "paid");
	expect(paidCharges.every(charge => !charge.allowanceWasAvailable && !charge.usableResetWasAvailable)).toBe(true);
	expect(
		paidCharges.every(charge => charge.remainingBefore === undefined || charge.remainingBefore > PAID_FLOOR),
	).toBe(true);
}

describe("AgentSession tiered same-provider boundary cases", () => {
	it("FP1 redeems a reset from a pre-blocked account before paid fallback", async () => {
		const harness = await createTieredHarness({
			withFallbackChain: true,
			accounts: {
				a: { allowanceUsedPct: 100, paid: null, resetAvailable: true },
				b: { allowanceUsedPct: 100, paid: null },
				c: { allowanceUsedPct: 100, paid: { limit: PAID_LIMIT, used: 0 } },
			},
		});
		try {
			const peer = harness.peer();
			await peer.resolvePrimary();
			expect(harness.hasBlock("a", "")).toBe(true);
			expect(harness.hasBlock("b", "")).toBe(true);

			await harness.prompt(3);

			expect(harness.events.slice(0, 4)).toEqual(["redeem:a", "request:a", "request:a", "request:c"]);
			expect(harness.redemptions).toEqual(["a"]);
			expectPaidChargesToRespectFunding(harness);
		} finally {
			await harness.dispose();
		}
	});

	it("FP2 follows priority rather than credential storage order when choosing a reset", async () => {
		const harness = await createTieredHarness({
			withFallbackChain: true,
			storageOrder: ["c", "a", "b"],
			accounts: {
				a: { allowanceUsedPct: 100, resetAvailable: true },
				b: { allowanceUsedPct: 100 },
				c: { allowanceUsedPct: 100, resetAvailable: true },
			},
		});
		try {
			await harness.prompt(1);

			expect(harness.redemptions).toEqual(["a"]);
			expect(chargedBearers(harness)).toEqual(["a"]);
			expectPaidChargesToRespectFunding(harness);
		} finally {
			await harness.dispose();
		}
	});

	it("FP3 blocks AUTH-preblocked paid usage below its floor before model fallback", async () => {
		const harness = await createTieredHarness({
			withFallbackChain: true,
			usageAwareFallback: false,
			accounts: {
				a: { allowanceUsedPct: 100, paid: { limit: PAID_LIMIT, used: 8 } },
				b: { allowanceUsedPct: 100, paid: null },
				c: { allowanceUsedPct: 100, paid: null },
			},
		});
		try {
			harness.preblock("a", "auth", Date.now() + 2 * HOUR_MS);

			await harness.prompt(1);

			expect(harness.requests).toEqual([{ selector: harness.fallbackSelector, bearer: "fallback-key" }]);
			expect(harness.charges).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it("FP4 makes a joining session share the reset path before spending another account", async () => {
		const harness = await createTieredHarness({
			withFallbackChain: true,
			accounts: {
				a: { paid: null, resetAvailable: true },
				b: { allowanceUsedPct: 100 },
				c: { allowanceUsedPct: 100 },
			},
		});
		try {
			await harness.prompt(2);
			const peer = harness.peer();
			await peer.resolvePrimary();
			harness.authStorage.sessions.release(ANTHROPIC, peer.session.sessionId);
			expect(harness.hasBlock("a", "")).toBe(true);

			for (let index = 0; index < 7; index++) {
				await (index % 2 === 0 ? harness : peer).prompt(1);
			}

			expect(chargedBearers(harness)).toEqual(["a", "a", "a", "a", "b", "b", "c", "c"]);
			expect(harness.redemptions).toEqual(["a"]);
			expect(harness.events.indexOf("redeem:a")).toBeLessThan(harness.events.indexOf("request:b"));
			expectPaidChargesToRespectFunding(harness);
			expect(harness.requests.at(-1)).toEqual({ selector: harness.fallbackSelector, bearer: "fallback-key" });
			expect(
				harness.charges
					.filter(charge => charge.kind === "paid")
					.map(charge => [charge.accountId, charge.remainingBefore]),
			).toEqual([
				["b", 10],
				["b", 6],
				["c", 10],
				["c", 6],
			]);
		} finally {
			await harness.dispose();
		}
	});
	it("FP5 permits terminal paid usage below the floor when enabled", async () => {
		const harness = await createTieredHarness({
			withFallbackChain: false,
			extraUsageBelowFloor: true,
			usageAwareFallback: false,
			accounts: {
				a: { allowanceUsedPct: 100, paid: { limit: PAID_LIMIT, used: 8 } },
				b: { allowanceUsedPct: 100, paid: null },
				c: { allowanceUsedPct: 100, paid: null },
			},
		});
		try {
			await harness.prompt(1);

			expect(harness.requests).toEqual([{ selector: harness.primarySelector, bearer: "a" }]);
			expect(harness.charges).toEqual([
				{
					accountId: "a",
					kind: "paid",
					allowanceWasAvailable: false,
					usableResetWasAvailable: false,
					remainingBefore: 2,
				},
			]);
		} finally {
			await harness.dispose();
		}
	});

	it("FP6 reports terminal paid usage held at the floor as a usage-limit error", async () => {
		const harness = await createTieredHarness({
			withFallbackChain: false,
			usageAwareFallback: false,
			accounts: {
				a: { allowanceUsedPct: 100, paid: { limit: PAID_LIMIT, used: 8 } },
				b: { allowanceUsedPct: 100, paid: null },
				c: { allowanceUsedPct: 100, paid: null },
			},
		});
		try {
			await harness.prompt(1);

			expect(harness.requests).toEqual([]);
			expect(harness.charges).toEqual([]);
			const errors = harness.session.agent.state.messages.filter(
				message => message.role === "assistant" && message.stopReason === "error",
			);
			expect(errors).toHaveLength(1);
			const [error] = errors;
			if (!error || error.role !== "assistant" || error.stopReason !== "error") {
				throw new Error("Expected one terminal error message");
			}
			expect(AIError.isExtraUsageWithheldMessage(error)).toBe(true);
		} finally {
			await harness.dispose();
		}
	});
});
