import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	DEFAULT_USAGE_RESERVE_PCT,
	type ResetCreditAccountStatus,
	type ResetCreditTarget,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CodexAutoRedeemCoordinator,
	createCodexAutoRedeemCoordinator,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

import { cfgClaudeResetsAutoRedeem } from "@oh-my-pi/pi-coding-agent/session/settings";

const ACCOUNT_ID = "claude-account";
const EMAIL = "claude@example.com";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_ID = 7;
const SIBLING_ORG_ID = "22222222-2222-4222-8222-222222222222";
const SIBLING_CREDENTIAL_ID = 8;
const HOUR = 3_600_000;
const CLAUDE_USAGE_LIMIT_ERROR =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"usage_limit_reached"}} retry-after-ms=259200000';

function claudeReport(weeklyUsed: number): UsageReport {
	const now = Date.now();
	return {
		provider: "anthropic",
		fetchedAt: now,
		limits: [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", shared: true, windowId: "5h" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR, resetsAt: now + 2 * HOUR },
				amount: { usedFraction: 0.5, unit: "percent" },
			},
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", shared: true, windowId: "7d" },
				window: { id: "7d", label: "7 Day", durationMs: 7 * 24 * HOUR, resetsAt: now + 3 * 24 * HOUR },
				amount: { usedFraction: weeklyUsed, unit: "percent" },
			},
		],
		metadata: { accountId: ACCOUNT_ID, email: EMAIL, orgId: ORG_ID },
	};
}

function claudeStatus(requiresLimit: boolean): ResetCreditAccountStatus {
	const expiresAt = new Date(Date.now() + 2 * HOUR).toISOString();
	return {
		provider: "anthropic",
		credentialId: CREDENTIAL_ID,
		report: claudeReport(requiresLimit ? 1 : 0.5),
		accountId: ACCOUNT_ID,
		email: EMAIL,
		orgId: ORG_ID,
		active: true,
		availableCount: 1,
		redeemableCount: 1,
		eligible: true,
		nextCreditId: "cedar-grant-1",
		credits: [
			{
				id: "cedar-grant-1",
				title: "Claude saved reset",
				program: "cedar_ember",
				remainingCount: 1,
				usable: true,
				requiresLimit,
				clears: ["anthropic:7d"],
				blocking: requiresLimit ? ["anthropic:7d"] : [],
				usedFractions: { "anthropic:7d": requiresLimit ? 1 : 0.5 },
				expiresAt,
				status: "available",
			},
		],
	};
}

/** The usage report as the broker or local usage fetch hands it over, carrying the account's reset inventory. */
function withInventory(report: UsageReport, status: ResetCreditAccountStatus): UsageReport {
	const { availableCount, redeemableCount, eligible, nextCreditId, credits } = status;
	return { ...report, resetCredits: { availableCount, redeemableCount, eligible, nextCreditId, credits } };
}

/** A second organization under the same login whose grant expires an hour after the primary's. */
function siblingStatus(): ResetCreditAccountStatus {
	const status = claudeStatus(false);
	return {
		...status,
		credentialId: SIBLING_CREDENTIAL_ID,
		orgId: SIBLING_ORG_ID,
		active: false,
		report: { ...claudeReport(0.5), metadata: { accountId: ACCOUNT_ID, email: EMAIL, orgId: SIBLING_ORG_ID } },
		credits: status.credits.map(credit => ({
			...credit,
			expiresAt: new Date(Date.now() + 3 * HOUR).toISOString(),
		})),
	};
}

function accountPolicies(autoRedeem: boolean, orgId = ORG_ID) {
	return {
		accountPolicies: [{ provider: "anthropic", account: { email: EMAIL, orgId }, autoRedeem }],
		defaultReservePct: DEFAULT_USAGE_RESERVE_PCT,
	};
}

/** An extension host whose only capability is answering the consent prompt. */
function promptRunner(select: (question: string) => Promise<string | undefined>): ExtensionRunner {
	return {
		hasUI: () => true,
		getUIContext: () => ({ select }),
		hasHandlers: () => false,
	} as unknown as ExtensionRunner;
}
describe("Claude saved-reset trigger integration", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let managers: SessionManager[];
	let tempDir: TempDir;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	});

	beforeEach(() => {
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		sessions = [];
		managers = [];
		tempDir = TempDir.createSync("@pi-claude-reset-");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) {
			await session.dispose();
		}
		for (const manager of managers.splice(0).reverse()) {
			await manager.close();
		}
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	function buildSession(options: {
		withExtensionRunner?: boolean;
		report: UsageReport | null;
		status: ResetCreditAccountStatus;
		siblings?: ResetCreditAccountStatus[];
		streamErrorFirst?: boolean;
		transientFailures?: number;
		listFailures?: number;
		maxDelayMs?: number;
		quota?: { restored: boolean };
		autoRedeem?: "unset" | "yes" | "no";
		salvageHorizonHours?: number;
		keepCredits?: number;
		/** Answers the consent prompt; without it the session has no prompt UI. */
		select?: (question: string) => Promise<string | undefined>;
	}): {
		session: AgentSession;
		coordinator: CodexAutoRedeemCoordinator;
		targets: ResetCreditTarget[];
		listCalls: () => number;
	} {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		authStorage.keys.setRuntime("anthropic", "test-key");
		vi.spyOn(authStorage.oauth, "identity").mockReturnValue({
			accountId: ACCOUNT_ID,
			email: EMAIL,
			orgId: ORG_ID,
		});
		const siblings = options.siblings ?? [];
		vi.spyOn(authStorage.oauth, "accounts").mockReturnValue([
			{ position: 0, credentialId: CREDENTIAL_ID, accountId: ACCOUNT_ID, email: EMAIL, orgId: ORG_ID, active: true },
			...siblings.map((sibling, index) => ({
				position: index + 1,
				credentialId: sibling.credentialId,
				accountId: sibling.accountId,
				email: sibling.email,
				orgId: sibling.orgId,
				active: false,
			})),
		]);
		vi.spyOn(authStorage.usage, "reports").mockImplementation(
			async () =>
				options.report && [options.report, ...siblings.map(sibling => withInventory(sibling.report!, sibling))],
		);
		let listAttempts = 0;
		vi.spyOn(authStorage.resets, "list").mockImplementation(async request => {
			if (request?.provider !== "anthropic") return [];
			listAttempts++;
			return [
				listAttempts <= (options.listFailures ?? 0)
					? { ...options.status, report: undefined, error: "Rate limited", retryAfterMs: 0 }
					: options.status,
				...(options.siblings ?? []),
			];
		});
		const targets: ResetCreditTarget[] = [];
		const quota = options.quota ?? { restored: !options.streamErrorFirst };
		vi.spyOn(authStorage.resets, "redeem").mockImplementation(async request => {
			targets.push(request.target);
			quota.restored = true;
			return {
				ok: true,
				code: "reset",
				provider: "anthropic",
				accountId: ACCOUNT_ID,
				email: EMAIL,
				orgId: ORG_ID,
				creditId: "cedar-grant-1",
				cleared: ["anthropic:7d"],
			};
		});

		const mock = createMockModel();
		let calls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, streamOptions) => {
				calls++;
				const transientFailures = options.transientFailures ?? 0;
				if (calls <= transientFailures) mock.push({ throw: "503 Service unavailable" });
				else if (options.streamErrorFirst && (calls === transientFailures + 1 || !quota.restored)) {
					mock.push({ throw: CLAUDE_USAGE_LIMIT_ERROR });
				} else mock.push({ content: ["recovered after Claude reset"], stopReason: "stop" });
				return mock.stream(requestedModel, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": options.maxDelayMs ?? 100,
			"retry.maxRetries": 1,
			"codexResets.autoRedeem": "no",
			"claudeResets.autoRedeem": options.autoRedeem ?? "yes",
			"claudeResets.salvageHorizonHours": options.salvageHorizonHours ?? 12,
			"claudeResets.keepCredits": options.keepCredits ?? 0,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory();
		managers.push(sessionManager);
		const coordinator = createCodexAutoRedeemCoordinator();
		coordinator.resetLockPath = `${tempDir.path()}/auth.db`;
		const session = new AgentSession({
			agent,
			extensionRunner: options.withExtensionRunner
				? new ExtensionRunner([], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry)
				: undefined,
			sessionManager,
			settings,
			modelRegistry,
			codexResetCoordinator: coordinator,
			...(options.select && { extensionRunner: promptRunner(options.select) }),
		});
		sessions.push(session);
		return { session, coordinator, targets, listCalls: () => listAttempts };
	}

	it("redeems the exact live Cedar grant on a blocked retry and immediately recovers", async () => {
		const { session, targets } = buildSession({
			report: claudeReport(1),
			status: claudeStatus(true),
			streamErrorFirst: true,
		});
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a Claude usage limit");
		await session.waitForIdle();

		expect(targets).toEqual([
			{
				provider: "anthropic",
				credentialId: CREDENTIAL_ID,
				creditId: "cedar-grant-1",
				accountId: ACCOUNT_ID,
				email: EMAIL,
				orgId: ORG_ID,
			},
		]);
		const recovered = session.sessionManager
			.getEntries()
			.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some(
						block => block.type === "text" && block.text === "recovered after Claude reset",
					),
			);
		expect(recovered).toBe(true);
	});

	it("continues the task using live reset evidence when broker usage polling is unavailable", async () => {
		const { session, targets } = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
		});

		await session.prompt("continue through a quota reset");
		await session.waitForIdle();

		expect(targets.map(target => target.credentialId)).toEqual([CREDENTIAL_ID]);
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "recovered after Claude reset" }],
		});
	});

	it("redeems and continues when earlier provider failures consumed the retry budget", async () => {
		const { session, targets } = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
			transientFailures: 1,
		});
		mockSchedulerWaitWithClock();

		await session.prompt("recover after retry budget exhaustion");
		await session.waitForIdle();

		expect(targets.map(target => target.credentialId)).toEqual([CREDENTIAL_ID]);
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("waits for throttled reset discovery and resumes without retrying the blocked model prematurely", async () => {
		const { session, targets } = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
			listFailures: 1,
			maxDelayMs: 2_500,
		});
		mockSchedulerWaitWithClock();

		await session.prompt("wait for reset eligibility");
		await session.waitForIdle();

		expect(targets.map(target => target.credentialId)).toEqual([CREDENTIAL_ID]);
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("neither spends nor re-reads throttled reset discovery for a blocked account whose policy turns auto-redeem off", async () => {
		const { session, targets } = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
			listFailures: 1,
			maxDelayMs: 2_500,
		});
		authStorage.setAccountPolicies(accountPolicies(false));
		mockSchedulerWaitWithClock();
		try {
			await session.prompt("hit the limit on a borrowed account");
			await session.waitForIdle();
		} finally {
			authStorage.setAccountPolicies({ accountPolicies: [], defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });
		}

		expect(targets).toEqual([]);
		expect(authStorage.resets.list).toHaveBeenCalledTimes(1);
	});

	it("waits for throttled discovery and restores a blocked account whose policy turns auto-redeem on while claudeResets.autoRedeem is no", async () => {
		const { session, targets } = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
			listFailures: 1,
			maxDelayMs: 2_500,
			autoRedeem: "no",
		});
		authStorage.setAccountPolicies(accountPolicies(true));
		mockSchedulerWaitWithClock();
		try {
			await session.prompt("hit the limit on the account allowed to spend");
			await session.waitForIdle();
		} finally {
			authStorage.setAccountPolicies({ accountPolicies: [], defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });
		}

		expect(targets.map(target => target.credentialId)).toEqual([CREDENTIAL_ID]);
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("cancels reset discovery backoff without spending a credit or resuming the task", async () => {
		const { session, targets } = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
			maxDelayMs: 5_000,
		});
		const listed = Promise.withResolvers<void>();
		vi.spyOn(authStorage.resets, "list").mockImplementation(async () => {
			listed.resolve();
			return [{ ...claudeStatus(true), report: undefined, error: "Rate limited", retryAfterMs: 1_000 }];
		});

		const prompt = session.prompt("cancel while waiting for reset eligibility");
		await listed.promise;
		await session.abort();
		await prompt;
		await session.waitForIdle();

		expect(targets).toEqual([]);
		expect(session.isRetrying).toBe(false);
		expect(session.agent.state.messages.at(-1)).not.toMatchObject({ stopReason: "stop" });
	});

	it("adopts a peer's confirmed reset without spending again or looping on the same marker", async () => {
		const quota = { restored: false };
		const first = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
			quota,
		});
		await first.session.prompt("restore the shared account");
		await first.session.waitForIdle();
		expect(first.targets).toHaveLength(1);

		const spent = claudeStatus(true);
		spent.availableCount = 0;
		spent.redeemableCount = 0;
		spent.eligible = false;
		const peer = buildSession({ report: null, status: spent, streamErrorFirst: true, quota });
		await peer.session.prompt("recover a request issued before the peer reset");
		await peer.session.waitForIdle();
		expect(peer.targets).toEqual([]);
		expect(peer.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });

		quota.restored = false;
		await peer.session.prompt("do not reuse an old reset for a new quota failure");
		await peer.session.waitForIdle();
		expect(peer.targets).toEqual([]);
		expect(peer.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("salvages an expiring early-use Cedar grant from the usage heartbeat exactly once, listing only to confirm it", async () => {
		const status = claudeStatus(false);
		const { session, coordinator, targets, listCalls } = buildSession({
			report: withInventory(claudeReport(0.5), status),
			status,
		});

		await session.fetchUsageReports();
		expect(coordinator.sweepPromise).toBeDefined();
		await coordinator.sweepPromise;
		expect(targets).toHaveLength(1);

		coordinator.lastSweepAt = 0;
		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(targets).toHaveLength(1);
		expect(listCalls()).toBe(1);
	});

	it("lists no Claude account and salvages nothing when its usage report carries no reset inventory", async () => {
		const { session, coordinator, targets, listCalls } = buildSession({
			report: claudeReport(0.5),
			status: claudeStatus(false),
		});

		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(targets).toEqual([]);
		expect(listCalls()).toBe(0);
	});

	it.each([
		{ brokerSweeps: "anthropic", spent: 0 },
		{ brokerSweeps: "openai-codex", spent: 1 },
	])(
		"salvages $spent Claude grants when the auth broker sweeps $brokerSweeps resets itself",
		async ({ brokerSweeps, spent }) => {
			const status = claudeStatus(false);
			const { session, coordinator, targets, listCalls } = buildSession({
				report: withInventory(claudeReport(0.5), status),
				status,
			});
			vi.spyOn(authStorage.resets, "brokerSweeps").mockImplementation(provider => provider === brokerSweeps);

			await session.fetchUsageReports();
			await coordinator.sweepPromise;
			expect(targets).toHaveLength(spent);
			// A candidate is confirmed by one live listing before it is spent.
			expect(listCalls()).toBe(spent);
		},
	);

	it("does not salvage on usage a carried-over inventory recorded before the window rolled over", async () => {
		// A failed reset probe keeps the previous report's inventory, usage figures included.
		const carried = claudeStatus(false);
		carried.credits[0]!.usedFractions = { "anthropic:7d": 0.8 };
		const live = claudeStatus(false);
		live.report = claudeReport(0.01);
		live.credits[0]!.usedFractions = { "anthropic:7d": 0.01 };
		const { session, coordinator, targets, listCalls } = buildSession({
			report: withInventory(claudeReport(0.01), carried),
			status: live,
		});

		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(listCalls()).toBe(1);
		expect(targets).toEqual([]);
	});

	it("spends for a credential stored without its organization under the organization its live listing resolves", async () => {
		const status = claudeStatus(false);
		const report = withInventory(claudeReport(0.5), status);
		report.metadata = { accountId: ACCOUNT_ID, email: EMAIL };
		const { session, coordinator, targets } = buildSession({ report, status });
		vi.spyOn(authStorage.oauth, "accounts").mockReturnValue([
			{ position: 0, credentialId: CREDENTIAL_ID, accountId: ACCOUNT_ID, email: EMAIL, active: true },
		]);

		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(targets).toEqual([
			{
				provider: "anthropic",
				credentialId: CREDENTIAL_ID,
				creditId: "cedar-grant-1",
				accountId: ACCOUNT_ID,
				email: EMAIL,
				orgId: ORG_ID,
			},
		]);
		expect([...coordinator.lastAttemptAtByAccount.keys()]).toEqual([`anthropic|${ORG_ID}|${CREDENTIAL_ID}`]);
	});

	it("leaves an account whose policy turns auto-redeem off out of the heartbeat salvage until the policy is removed", async () => {
		const status = claudeStatus(false);
		const { session, coordinator, targets } = buildSession({
			report: withInventory(claudeReport(0.5), status),
			status,
		});
		authStorage.setAccountPolicies(accountPolicies(false));
		try {
			await session.fetchUsageReports();
			await coordinator.sweepPromise;
			expect(targets).toEqual([]);
			expect(coordinator.attemptedKeys.size).toBe(0);
		} finally {
			authStorage.setAccountPolicies({ accountPolicies: [], defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });
		}

		coordinator.lastSweepAt = 0;
		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(targets).toMatchObject([{ provider: "anthropic", credentialId: CREDENTIAL_ID }]);
	});

	it.each(["no", "unset"] as const)(
		"spends without asking only the account whose policy turns auto-redeem on while claudeResets.autoRedeem is %s",
		async autoRedeem => {
			const status = claudeStatus(false);
			const { session, coordinator, targets } = buildSession({
				report: withInventory(claudeReport(0.5), status),
				status,
				siblings: [siblingStatus()],
				autoRedeem,
			});
			authStorage.setAccountPolicies(accountPolicies(true));
			try {
				await session.fetchUsageReports();
				await coordinator.sweepPromise;
			} finally {
				authStorage.setAccountPolicies({ accountPolicies: [], defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });
			}

			expect(targets).toMatchObject([{ credentialId: CREDENTIAL_ID, orgId: ORG_ID }]);
			expect([...coordinator.lastAttemptAtByAccount.keys()]).toEqual([`anthropic|${ORG_ID}|${CREDENTIAL_ID}`]);
			expect(cfgClaudeResetsAutoRedeem.get(session.settings)).toBe(autoRedeem);
		},
	);

	it("asks only about accounts following an unset claudeResets.autoRedeem, and a No still spends the account turned on", async () => {
		const questions: string[] = [];
		const status = claudeStatus(false);
		const { session, coordinator, targets } = buildSession({
			report: withInventory(claudeReport(0.5), status),
			status,
			siblings: [siblingStatus()],
			autoRedeem: "unset",
			select: async question => {
				questions.push(question);
				return "No";
			},
		});
		authStorage.setAccountPolicies(accountPolicies(true));
		try {
			await session.fetchUsageReports();
			await coordinator.sweepPromise;
		} finally {
			authStorage.setAccountPolicies({ accountPolicies: [], defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });
		}

		expect(questions).toHaveLength(1);
		expect(questions[0]).toStartWith("Spend a saved Claude rate-limit reset?");
		expect(questions[0]).toContain(SIBLING_ORG_ID);
		expect(questions[0]).not.toContain(ORG_ID);
		expect(targets).toMatchObject([{ credentialId: CREDENTIAL_ID, orgId: ORG_ID }]);
	});

	it("does not spend a planned salvage when the account's policy turns auto-redeem off before execution", async () => {
		const status = claudeStatus(false);
		const { session, coordinator, targets } = buildSession({
			report: withInventory(claudeReport(0.5), status),
			status,
		});
		const planned = Promise.withResolvers<void>();
		const policy = authStorage.oauth.policy.bind(authStorage.oauth);
		vi.spyOn(authStorage.oauth, "policy").mockImplementation((provider, identity) => {
			const result = policy(provider, identity);
			planned.resolve();
			return result;
		});
		try {
			await session.fetchUsageReports();
			await planned.promise;
			authStorage.setAccountPolicies(accountPolicies(false));
			await coordinator.sweepPromise;
			expect(targets).toEqual([]);
			expect(coordinator.attemptedKeys.size).toBe(0);
			expect(coordinator.lastAttemptAtByAccount.size).toBe(0);
		} finally {
			authStorage.setAccountPolicies({ accountPolicies: [], defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });
		}

		coordinator.lastSweepAt = 0;
		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(targets).toMatchObject([{ credentialId: CREDENTIAL_ID }]);
	});

	it("does not spend a queued salvage whose account's policy turns auto-redeem off while an earlier spend runs", async () => {
		const status = claudeStatus(false);
		const { session, coordinator, targets } = buildSession({
			report: withInventory(claudeReport(0.5), status),
			status,
			siblings: [siblingStatus()],
		});
		const spending = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(authStorage.resets, "redeem").mockImplementation(async request => {
			targets.push(request.target);
			spending.resolve();
			await release.promise;
			return { ok: true, code: "reset", provider: "anthropic", cleared: ["anthropic:7d"] };
		});
		try {
			await session.fetchUsageReports();
			await spending.promise;
			authStorage.setAccountPolicies(accountPolicies(false, SIBLING_ORG_ID));
			release.resolve();
			await coordinator.sweepPromise;
			expect(targets).toMatchObject([{ credentialId: CREDENTIAL_ID }]);
			expect([...coordinator.lastAttemptAtByAccount.keys()]).toEqual([`anthropic|${ORG_ID}|${CREDENTIAL_ID}`]);
		} finally {
			authStorage.setAccountPolicies({ accountPolicies: [], defaultReservePct: DEFAULT_USAGE_RESERVE_PCT });
		}

		coordinator.lastSweepAt = 0;
		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(targets).toMatchObject([{ credentialId: CREDENTIAL_ID }, { credentialId: SIBLING_CREDENTIAL_ID }]);
	});
	it.each(["yes", "no", "unset"] as const)(
		"consumes an imminent reset without a prompt UI unless auto-redeem is no (%s)",
		async autoRedeem => {
			const status = claudeStatus(false);
			for (const credit of status.credits) {
				credit.expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
				credit.usedFractions = { "anthropic:7d": 0 };
			}
			const report = withInventory(claudeReport(0), status);
			status.report = report;
			const { session, coordinator, targets } = buildSession({
				report,
				status,
				autoRedeem,
				salvageHorizonHours: 0,
				keepCredits: 1,
			});

			await session.fetchUsageReports();
			await coordinator.sweepPromise;
			expect(targets).toEqual(
				autoRedeem !== "no"
					? [
							{
								provider: "anthropic",
								credentialId: CREDENTIAL_ID,
								creditId: "cedar-grant-1",
								accountId: ACCOUNT_ID,
								email: EMAIL,
								orgId: ORG_ID,
							},
						]
					: [],
			);

			coordinator.lastSweepAt = 0;
			await session.fetchUsageReports();
			await coordinator.sweepPromise;
			expect(targets).toHaveLength(autoRedeem !== "no" ? 1 : 0);
		},
	);

	it("does not spend headlessly before independent Claude consent", async () => {
		// Codex being disabled does not enable Claude, and short of a reset about to expire an unset headless
		// session cannot spend silently.
		const status = claudeStatus(false);
		const { session, coordinator, targets } = buildSession({
			report: withInventory(claudeReport(0.5), status),
			status,
			autoRedeem: "unset",
		});

		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(targets).toHaveLength(0);
		expect(coordinator.attemptedKeys.size).toBe(0);
		expect(cfgClaudeResetsAutoRedeem.get(session.settings)).toBe("unset");
	});

	it("still asks before spending an imminent reset when a prompt UI is available", async () => {
		const status = claudeStatus(false);
		for (const credit of status.credits) {
			credit.expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
		}
		const { availableCount, redeemableCount, eligible, nextCreditId, credits } = status;
		const report = {
			...claudeReport(0.5),
			resetCredits: { availableCount, redeemableCount, eligible, nextCreditId, credits },
		};
		status.report = report;
		const { session, coordinator, targets } = buildSession({
			withExtensionRunner: true,
			report,
			status,
			autoRedeem: "unset",
			salvageHorizonHours: 0,
		});
		const questions: string[] = [];
		await initializeExtensions(session, {
			reportSendError: () => {},
			reportRuntimeError: () => {},
			uiContext: Object.create(session.extensionRunner!.getUIContext(), {
				select: {
					value: async (question: string) => {
						questions.push(question);
						return "No";
					},
				},
			}),
		});

		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(questions).toEqual([expect.stringContaining("Spend a saved Claude rate-limit reset?")]);
		expect(targets).toEqual([]);
	});
});
