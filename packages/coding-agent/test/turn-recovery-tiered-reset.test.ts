import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai/auth-storage";
import type { Model, ModelUsageHealth } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";

const PROVIDER = "anthropic";
const SESSION_ID = "tiered-reset-session";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MODEL = getBundledModel(PROVIDER, "claude-sonnet-4-5");

if (!MODEL) throw new Error("Expected bundled Claude model");

type AccountId = "a" | "b" | "c";
type AccountInput = {
	account: AccountId;
	state?: ModelUsageHealth["state"];
	fundingTier?: ModelUsageHealth["accounts"][number]["fundingTier"];
	savedResets?: number;
	selected?: true;
};

function identity(account: AccountId): string {
	return `tiered-reset-${account}`;
}

function credential(account: AccountId) {
	return {
		type: "oauth" as const,
		access: `access-${account}`,
		refresh: `refresh-${account}`,
		expires: Date.now() + WEEK_MS,
		accountId: identity(account),
		email: `${identity(account)}@example.test`,
	};
}

async function createTieredRecovery(options: {
	accounts: AccountInput[];
	storageOrder?: AccountId[];
	keepCredits?: number;
	permitted?: AccountId[];
	redeem?: Partial<Record<AccountId, boolean>>;
	accountOrder?: "tiered" | "usage";
}) {
	const authStorage = await AuthStorage.create(":memory:", {
		usageProviderResolver: () => undefined,
		accountPolicies: (
			[
				["a", 3],
				["b", 2],
				["c", 1],
			] as const
		).map(([account, priority]) => ({
			provider: PROVIDER,
			account: { accountId: identity(account) },
			priority,
		})),
	});
	await authStorage.credentials.set(PROVIDER, (options.storageOrder ?? ["a", "b", "c"]).map(credential));

	const summaries = authStorage.oauth.accounts(PROVIDER);
	const accountByCredentialId = new Map(
		summaries.map(summary => {
			const account = (["a", "b", "c"] as const).find(candidate => identity(candidate) === summary.accountId);
			if (!account) throw new Error(`Expected stored account identity for credential ${summary.credentialId}`);
			return [summary.credentialId, account] as const;
		}),
	);
	const credentialId = (account: AccountId) => {
		const summary = summaries.find(candidate => candidate.accountId === identity(account));
		if (!summary) throw new Error(`Expected stored OAuth account ${account}`);
		return summary.credentialId;
	};
	if (options.permitted) {
		authStorage.sessions.restrict(
			PROVIDER,
			SESSION_ID,
			options.permitted.map(account => {
				const identityKey = resolveCredentialIdentityKey(PROVIDER, credential(account));
				if (!identityKey) throw new Error(`Expected session identity key for ${account}`);
				return identityKey;
			}),
		);
	}

	const healthAccounts: ModelUsageHealth["accounts"] = options.accounts.map(account => ({
		credentialId: credentialId(account.account),
		credentialType: "oauth",
		state: account.state ?? "healthy",
		...(account.fundingTier === undefined ? {} : { fundingTier: account.fundingTier }),
		...(account.savedResets === undefined ? {} : { savedResets: account.savedResets }),
		...(account.selected === true ? { selected: true } : {}),
	}));
	const health = vi.spyOn(authStorage.health, "model").mockResolvedValue({
		state: "healthy",
		accounts: healthAccounts,
	});
	const settings = Settings.isolated({
		"retry.accountOrder": options.accountOrder ?? "tiered",
		"retry.usageAwareFallback": false,
		"claudeResets.keepCredits": options.keepCredits ?? 0,
	});
	const modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const attempts: AccountId[] = [];
	const host: TurnRecoveryHost = {
		agent: {
			state: { messages: [] as AgentMessage[] },
			replaceMessages: () => {},
		} as never,
		sessionManager: { getSessionId: () => SESSION_ID } as never,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => MODEL,
		contextFitsModel: () => true,
		textOutputCommitted: () => true,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		promptSequence: () => 0,
		sessionId: () => SESSION_ID,
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		persistedAssistantEntryId: () => undefined,
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async (_model: Model) => {},
		resolveActiveEditMode: () => "hashline",
		syncAfterModelChange: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => ({ restored: false }),
		redeemSavedReset: async request => {
			const account = accountByCredentialId.get(request.credentialId);
			if (!account) throw new Error(`Unexpected reset credential ${request.credentialId}`);
			attempts.push(account);
			return options.redeem?.[account] ?? true;
		},
		runAutoCompaction: async () => ({ continuationScheduled: false }) as RecoveryCompactionResult,
		shakeForRequestBodyReadTimeout: async () => false,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};

	return {
		authStorage,
		attempts,
		health,
		recovery: new TurnRecovery(host),
	};
}

async function expectResetAttempts(
	options: Parameters<typeof createTieredRecovery>[0],
	expected: AccountId[],
): Promise<void> {
	const fixture = await createTieredRecovery(options);
	try {
		await fixture.recovery.maybeApplyUsageAwareFallback(new AbortController().signal);
		expect(fixture.attempts).toEqual(expected);
	} finally {
		fixture.authStorage.close();
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TurnRecovery tiered saved-reset order", () => {
	test("T1 redeems the highest-priority saved reset instead of the first stored account", async () => {
		await expectResetAttempts(
			{
				storageOrder: ["c", "a", "b"],
				accounts: [
					{ account: "c", fundingTier: "extra", savedResets: 1 },
					{ account: "a", fundingTier: "extra", savedResets: 1 },
					{ account: "b", fundingTier: "extra", selected: true },
				],
			},
			["a"],
		);
	});

	test("T2 redeems a blocked saved reset before a lower-priority plan allowance", async () => {
		await expectResetAttempts(
			{
				accounts: [
					{ account: "a", state: "depleted", savedResets: 1 },
					{ account: "b", fundingTier: "allowance" },
					{ account: "c", fundingTier: "extra" },
				],
			},
			["a"],
		);
	});

	test("T3 leaves a selected lower-priority reset untouched when a higher-priority plan allowance exists", async () => {
		await expectResetAttempts(
			{
				accounts: [
					{ account: "a", fundingTier: "extra" },
					{ account: "b", fundingTier: "allowance" },
					{ account: "c", fundingTier: "extra", savedResets: 1, selected: true },
				],
			},
			[],
		);
	});

	test("T4 leaves the selected plan-allowance account alone", async () => {
		await expectResetAttempts(
			{
				accounts: [
					{ account: "a", fundingTier: "extra", savedResets: 1 },
					{ account: "b", fundingTier: "allowance", selected: true },
					{ account: "c", fundingTier: "extra" },
				],
			},
			[],
		);
	});

	test("T5 continues to the next eligible reset after a declined redemption", async () => {
		await expectResetAttempts(
			{
				redeem: { a: false },
				accounts: [
					{ account: "a", fundingTier: "extra", savedResets: 1, selected: true },
					{ account: "b", fundingTier: "extra", savedResets: 1 },
					{ account: "c", fundingTier: "allowance" },
				],
			},
			["a", "b"],
		);
	});

	test("T6 respects keepCredits while continuing to another account", async () => {
		await expectResetAttempts(
			{
				keepCredits: 1,
				accounts: [
					{ account: "a", fundingTier: "extra", savedResets: 1 },
					{ account: "b", fundingTier: "extra", savedResets: 2 },
					{ account: "c", fundingTier: "extra" },
				],
			},
			["b"],
		);
	});

	test("T7 skips resets outside the session pool", async () => {
		await expectResetAttempts(
			{
				permitted: ["b", "c"],
				accounts: [
					{ account: "a", fundingTier: "extra", savedResets: 1 },
					{ account: "b", fundingTier: "extra", savedResets: 1 },
					{ account: "c", fundingTier: "extra" },
				],
			},
			["b"],
		);
	});

	test("T8 leaves usage ordering network-free", async () => {
		const fixture = await createTieredRecovery({
			accountOrder: "usage",
			accounts: [{ account: "a", fundingTier: "extra", savedResets: 1 }],
		});
		try {
			await fixture.recovery.maybeApplyUsageAwareFallback(new AbortController().signal);
			expect(fixture.health).not.toHaveBeenCalled();
		} finally {
			fixture.authStorage.close();
		}
	});
});
