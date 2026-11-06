import { describe, expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	resolveAuthorizedRetryFallbackChainKey,
	resolveRetryFallbackChainKey,
	type RetryFallbackResolutionContext,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import {
	CODEX,
	createHarness,
	disposeHarness,
	ENABLED,
	expectNoStrayFetch,
	PROVIDER,
	seedAccounts,
	seedReports,
	type Harness,
	windowAt,
} from "../../ai/test/fixtures/usage-governor/harness";
import type { UsageRouteTarget, UsageRoutingScope } from "@oh-my-pi/pi-ai/usage-governor/types";

const primary = "openrouter/google/gemini-3.5-flash";
const taskAlternative = "google/gemini-3.5-flash";
const defaultAlternative = "openai/gpt-4o-mini";
const wildcardAlternative = "google-vertex/gemini-3.5-flash";

function context(
	chains: RetryFallbackResolutionContext["chains"],
	roles: Record<string, string>,
): RetryFallbackResolutionContext {
	const models = [
		getBundledModel("openrouter", "google/gemini-3.5-flash"),
		getBundledModel("google", "gemini-3.5-flash"),
		getBundledModel("google-vertex", "gemini-3.5-flash"),
		getBundledModel("openai", "gpt-4o-mini"),
	].filter(model => model !== undefined);
	return {
		chains,
		getModelRole: role => roles[role],
		modelLookup: {
			find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => models.some(model => model.provider === provider),
		},
	};
}

function candidates(ctx: RetryFallbackResolutionContext, role?: string): string[] {
	const key = resolveAuthorizedRetryFallbackChainKey(ctx, primary, undefined, role);
	return key ? findRetryFallbackCandidates(ctx, key, primary).map(candidate => candidate.raw) : [];
}

describe("governed role fallback envelopes", () => {
	test("role assignment wins over overlapping exact model, wildcard, and default chains", () => {
		const ctx = context(
			{
				[primary]: [defaultAlternative],
				"openrouter/google/*": [wildcardAlternative],
				default: [defaultAlternative],
				task: [taskAlternative],
			},
			{ default: primary, task: primary },
		);
		expect(resolveRetryFallbackChainKey(ctx, primary, undefined, "task")).toBe(primary);
		expect(candidates(ctx, "task")).toEqual([taskAlternative]);
		expect(candidates(ctx, "default")).toEqual([defaultAlternative]);
		expect(candidates(ctx)).toEqual([defaultAlternative]);
	});

	test("explicit empty and missing role chains cannot borrow another role or model chain", () => {
		const ctx = context(
			{ [primary]: [defaultAlternative], default: [defaultAlternative], task: [] },
			{ default: primary, task: primary, slow: primary },
		);
		expect(candidates(ctx, "task")).toEqual([]);
		expect(candidates(ctx, "slow")).toEqual([]);
	});

	test("default inheritance fills only absent ordinary roles, not empty or kind roles", () => {
		const chains = expandDefaultRetryFallbackChains({ default: [defaultAlternative], task: [] }, [
			"default",
			"task",
			"slow",
			"judge",
		]);
		const ctx = context(chains, { default: primary, task: primary, slow: primary, judge: primary });
		expect(candidates(ctx, "task")).toEqual([]);
		expect(candidates(ctx, "slow")).toEqual([defaultAlternative]);
		expect(candidates(ctx, "judge")).toEqual([]);
	});
});

const shared: UsageRouteTarget = { selector: `${PROVIDER}/shared`, provider: PROVIDER, modelId: "shared" };
const independent: UsageRouteTarget = { selector: `${CODEX}/independent`, provider: CODEX, modelId: "independent" };

/** Real AuthStorage and ledger; only the usage provider is synthetic. */
async function setupRoutes(otherUsed: number, verified: boolean) {
	const h = await createHarness({ ...ENABLED, roleProtection: "prefer-alternatives" });
	const originalProvider = h.usage.provider.bind(h.usage);
	h.usage.provider = id => {
		const provider = originalProvider(id);
		const fetchUsage = provider.fetchUsage;
		return {
			...provider,
			...(id === PROVIDER || verified ? { governorAllowance: () => ["primary"] } : {}),
			fetchUsage: async (params, ctx) => {
				const report = await fetchUsage(params, ctx);
				if (report) for (const limit of report.limits) limit.observedAt = Date.now();
				return report;
			},
		};
	};
	await seedAccounts(h, PROVIDER, [
		{ accountId: "shared", email: "shared@example.test", window: windowAt(30_000, 60_000, 0.1) },
	]);
	await seedAccounts(h, CODEX, [
		{ accountId: "independent", email: "independent@example.test", window: windowAt(30_000, 60_000, otherUsed) },
	]);
	await seedReports(h, PROVIDER);
	await seedReports(h, CODEX);
	const scope: UsageRoutingScope = {
		id: "session-main",
		revision: 1,
		roles: [
			{ role: "default", targets: [shared, independent] },
			{ role: "task", targets: [shared] },
		],
	};
	h.storage.governor.setRoutingScope(scope);
	return { h, scope };
}
async function evaluate(h: Harness, scope: UsageRoutingScope, role: string) {
	const targets = scope.roles.find(plan => plan.role === role)?.targets;
	if (!targets) throw new Error(`missing role ${role}`);
	return h.storage.governor.evaluateRoutes({
		scopeId: scope.id,
		revision: scope.revision,
		role,
		sessionId: "session-main",
		targets,
	});
}

describe("governed role quota protection", () => {
	test("a verified independent included route protects the shared quota for the constrained role", async () => {
		const { h, scope } = await setupRoutes(0.1, true);
		try {
			const flexible = await evaluate(h, scope, "default");
			const constrained = await evaluate(h, scope, "task");
			expect(flexible.accounts.find(account => account.selector === shared.selector)).toMatchObject({
				eligibility: "eligible",
				allowance: "included",
				state: "open",
				protectedFor: ["task"],
			});
			expect(flexible.accounts.find(account => account.selector === independent.selector)).toMatchObject({
				eligibility: "eligible",
				allowance: "included",
				state: "open",
				protectedFor: [],
			});
			expect(constrained.accounts[0]?.protectedFor).toEqual([]);
			expectNoStrayFetch(h);
		} finally {
			await disposeHarness();
		}
	});

	for (const [label, used, verified, allowance] of [
		["unknown", 0.1, false, "unknown"],
		["spent", 1, true, "spent"],
	] as const) {
		test(`${label} alternative does not establish independent included capacity`, async () => {
			const { h, scope } = await setupRoutes(used, verified);
			try {
				const result = await evaluate(h, scope, "default");
				expect(result.accounts.find(account => account.selector === independent.selector)?.allowance).toBe(
					allowance,
				);
				expect(result.accounts.find(account => account.selector === shared.selector)?.protectedFor).toEqual([]);
				expectNoStrayFetch(h);
			} finally {
				await disposeHarness();
			}
		});
	}

	test("scope and revision isolate role authorization", async () => {
		const { h, scope } = await setupRoutes(0.1, true);
		try {
			await expect(
				h.storage.governor.evaluateRoutes({
					scopeId: scope.id,
					revision: 0,
					role: "default",
					sessionId: "session-main",
					targets: [shared],
				}),
			).rejects.toThrow();
			await expect(
				h.storage.governor.evaluateRoutes({
					scopeId: scope.id,
					revision: 1,
					role: "task",
					sessionId: "session-main",
					targets: [independent],
				}),
			).rejects.toThrow();
			await expect(
				h.storage.governor.evaluateRoutes({
					scopeId: "other-worker",
					revision: 1,
					role: "default",
					sessionId: "session-main",
					targets: [shared],
				}),
			).rejects.toThrow();
		} finally {
			await disposeHarness();
		}
	});
});
