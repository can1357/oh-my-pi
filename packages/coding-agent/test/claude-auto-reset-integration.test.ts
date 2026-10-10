import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type {
	ResetCreditAccountStatus,
	ResetCreditTarget,
	SessionRestrictionLease,
	UsageReport,
} from "@oh-my-pi/pi-ai";
import { resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CodexAutoRedeemCoordinator,
	createCodexAutoRedeemCoordinator,
	defaultCodexAutoRedeemCoordinator,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

import { cfgClaudeResetsAutoRedeem } from "@oh-my-pi/pi-coding-agent/session/settings";

const ACCOUNT_ID = "claude-account";
const EMAIL = "claude@example.com";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL_ID = 7;
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
		report: UsageReport | null;
		status: ResetCreditAccountStatus;
		streamErrorFirst?: boolean;
		transientFailures?: number;
		listFailures?: number;
		maxDelayMs?: number;
		quota?: { restored: boolean };
		autoRedeem?: "unset" | "yes" | "no";
		salvageHorizonHours?: number;
		keepCredits?: number;
		/** Answers the auto-redeem consent prompt; without it the session has no prompt UI. */
		consent?: () => Promise<string | undefined>;
		/** Shares another session's coordinator, as sessions of one process do. */
		coordinator?: CodexAutoRedeemCoordinator;
	}): {
		session: AgentSession;
		coordinator: CodexAutoRedeemCoordinator;
		targets: ResetCreditTarget[];
		modelCalls: () => number;
	} {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		authStorage.keys.setRuntime("anthropic", "test-key");
		vi.spyOn(authStorage.oauth, "identity").mockReturnValue({
			accountId: ACCOUNT_ID,
			email: EMAIL,
			orgId: ORG_ID,
		});
		vi.spyOn(authStorage.usage, "reports").mockImplementation(async () => options.report && [options.report]);
		let listAttempts = 0;
		vi.spyOn(authStorage.resets, "list").mockImplementation(async request => {
			if (request?.provider !== "anthropic") return [];
			listAttempts++;
			return [
				listAttempts <= (options.listFailures ?? 0)
					? { ...options.status, report: undefined, error: "Rate limited", retryAfterMs: 0 }
					: options.status,
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
		let coordinator = options.coordinator;
		if (!coordinator) {
			coordinator = createCodexAutoRedeemCoordinator();
			coordinator.resetLockPath = `${tempDir.path()}/auth.db`;
		}
		let extensionRunner: ExtensionRunner | undefined;
		if (options.consent) {
			extensionRunner = new ExtensionRunner(
				[],
				new ExtensionRuntime(),
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			vi.spyOn(extensionRunner, "hasUI").mockReturnValue(true);
			vi.spyOn(extensionRunner.getUIContext(), "select").mockImplementation(options.consent);
		}
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			codexResetCoordinator: coordinator,
			extensionRunner,
		});
		sessions.push(session);
		return { session, coordinator, targets, modelCalls: () => calls };
	}

	/**
	 * Stores the session's account and one outside its pool, pools the session to
	 * its own, and lists both as blocked with a saved reset. The outside account's
	 * weekly wall clears in `outsideWaitMs` and its reset is far from expiry, so
	 * only a restore could spend it.
	 */
	async function poolToSessionAccount(
		session: AgentSession,
		outsideWaitMs: number,
	): Promise<{ pooledId: number; outsideId: number; release: () => Promise<void> }> {
		await authStorage.credentials.set(
			"anthropic",
			[
				{ accountId: ACCOUNT_ID, email: EMAIL, orgId: ORG_ID },
				{ accountId: "claude-excluded", email: "excluded@example.com", orgId: "org-excluded" },
			].map(identity => ({
				type: "oauth" as const,
				access: `access-${identity.accountId}`,
				refresh: `refresh-${identity.accountId}`,
				expires: Date.now() + HOUR,
				...identity,
			})),
		);
		const [pooled, outside] = authStorage.credentials.list("anthropic");
		if (!pooled || !outside) throw new Error("expected stored accounts");
		const outsideReport = claudeReport(1);
		outsideReport.metadata = { accountId: "claude-excluded", email: "excluded@example.com", orgId: "org-excluded" };
		for (const limit of outsideReport.limits) {
			if (limit.id === "anthropic:7d" && limit.window) limit.window.resetsAt = Date.now() + outsideWaitMs;
		}
		const outsideStatus: ResetCreditAccountStatus = {
			...claudeStatus(true),
			credentialId: outside.id,
			accountId: "claude-excluded",
			email: "excluded@example.com",
			orgId: "org-excluded",
			active: false,
			availableCount: 2,
			report: outsideReport,
		};
		outsideStatus.credits = outsideStatus.credits.map(credit => ({
			...credit,
			expiresAt: new Date(Date.now() + 20 * 24 * HOUR).toISOString(),
		}));
		vi.spyOn(authStorage.resets, "list").mockImplementation(async () => [
			{ ...claudeStatus(true), credentialId: pooled.id },
			outsideStatus,
		]);
		const lease = authStorage.sessions.restrict("anthropic", session.sessionId, [`email:${EMAIL}|org:${ORG_ID}`]);
		return {
			pooledId: pooled.id,
			outsideId: outside.id,
			release: async () => {
				authStorage.sessions.unrestrict("anthropic", session.sessionId, lease);
				await authStorage.credentials.remove("anthropic");
			},
		};
	}

	/** Records each redeemed credential and restores the quota it serves. */
	function recordSpends(quotaFor: (credentialId: number) => { restored: boolean } | undefined): number[] {
		const spent: number[] = [];
		vi.spyOn(authStorage.resets, "redeem").mockImplementation(async request => {
			spent.push(request.target.credentialId);
			const quota = quotaFor(request.target.credentialId);
			if (quota) quota.restored = true;
			return {
				ok: true,
				code: "reset",
				provider: "anthropic",
				creditId: "cedar-grant-1",
				cleared: ["anthropic:7d"],
			};
		});
		return spent;
	}

	/**
	 * Prompts `runner` and, once its blocked pass is listing resets, `joiner`,
	 * which finds that pass in flight; the listing answers only after it has.
	 */
	async function promptJoined(
		runner: AgentSession,
		joiner: AgentSession,
		coordinator: CodexAutoRedeemCoordinator,
	): Promise<void> {
		const statuses = await authStorage.resets.list({ provider: "anthropic" });
		const listing = Promise.withResolvers<void>();
		const joined = Promise.withResolvers<void>();
		vi.spyOn(authStorage.resets, "list").mockImplementation(async () => {
			listing.resolve();
			await joined.promise;
			return statuses;
		});
		const inFlight = coordinator.inFlightByAccount;
		const get = inFlight.get.bind(inFlight);
		vi.spyOn(inFlight, "get").mockImplementation(key => {
			const pass = get(key);
			if (pass) joined.resolve();
			return pass;
		});
		const running = runner.prompt("run the blocked pass");
		await listing.promise;
		await Promise.all([running, joiner.prompt("join the blocked pass")]);
		await Promise.all([runner.waitForIdle(), joiner.waitForIdle()]);
	}

	/** Empties the session's pool while the first pending attempt marker is written; returns that lease. */
	function emptyPoolOnPendingMarker(session: AgentSession): () => SessionRestrictionLease | undefined {
		const write = Bun.write.bind(Bun);
		let replaced: SessionRestrictionLease | undefined;
		vi.spyOn(Bun, "write").mockImplementation(async (destination, input) => {
			// Only the reset lock files are written here, always as text.
			const written = await write(destination as string, input as string);
			if (!replaced && typeof input === "string" && input.startsWith("pending:")) {
				replaced = authStorage.sessions.restrict("anthropic", session.sessionId, []);
			}
			return written;
		});
		return () => replaced;
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

	it("never spends the reset of an account outside the session's account pool", async () => {
		// The pooled account holds only the kept reserve; the excluded one has a spare reset.
		const { session, targets } = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
			keepCredits: 1,
		});
		const pool = await poolToSessionAccount(session, 3 * 24 * HOUR);
		mockSchedulerWaitWithClock();

		try {
			await session.prompt("stay inside the account pool");
			await session.waitForIdle();
		} finally {
			await pool.release();
		}

		expect(targets).toEqual([]);
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("drops a planned restore whose account leaves the session's pool before it is spent", async () => {
		let replaced: SessionRestrictionLease | undefined;
		const { session, coordinator, targets } = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
			autoRedeem: "unset",
			// The pool is replaced while the planned restore waits for consent.
			consent: async () => {
				replaced = authStorage.sessions.restrict("anthropic", session.sessionId, []);
				return "Yes";
			},
		});
		const pool = await poolToSessionAccount(session, 3 * 24 * HOUR);
		mockSchedulerWaitWithClock();

		try {
			await session.prompt("lose the pooled account mid-recovery");
			await session.waitForIdle();
		} finally {
			if (replaced) authStorage.sessions.unrestrict("anthropic", session.sessionId, replaced);
			await pool.release();
		}

		expect(replaced).toBeDefined();
		expect(targets).toEqual([]);
		expect(coordinator.attemptedKeys.size).toBe(0);
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("drops a restore whose account leaves the session's pool while its attempt is recorded, then retries it", async () => {
		const { session, coordinator, targets } = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
		});
		const pool = await poolToSessionAccount(session, 3 * 24 * HOUR);
		mockSchedulerWaitWithClock();
		const replaced = emptyPoolOnPendingMarker(session);
		let repooled: SessionRestrictionLease | undefined;
		try {
			await session.prompt("lose the pooled account while recording the attempt");
			await session.waitForIdle();
			expect(replaced()).toBeDefined();
			expect(targets).toEqual([]);
			expect(coordinator.attemptedKeys.size).toBe(0);
			expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });

			// Neither the attempt nor its pending marker fences the account once it is pooled again.
			repooled = authStorage.sessions.restrict("anthropic", session.sessionId, [`email:${EMAIL}|org:${ORG_ID}`]);
			await session.prompt("recover once the account is pooled again");
			await session.waitForIdle();
		} finally {
			const lease = repooled ?? replaced();
			if (lease) authStorage.sessions.unrestrict("anthropic", session.sessionId, lease);
			await pool.release();
		}

		expect(targets.map(target => target.credentialId)).toEqual([pool.pooledId]);
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("restores an account outside a pooled peer's pool for an unrestricted session that joined its pass", async () => {
		// The shared account holds only the kept reserve; the outside account has a spare reset.
		const openQuota = { restored: false };
		const pooled = buildSession({ report: null, status: claudeStatus(true), streamErrorFirst: true, keepCredits: 1 });
		const open = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
			keepCredits: 1,
			quota: openQuota,
			coordinator: pooled.coordinator,
		});
		const pool = await poolToSessionAccount(pooled.session, 3 * 24 * HOUR);
		const spent = recordSpends(credentialId => (credentialId === pool.outsideId ? openQuota : undefined));
		mockSchedulerWaitWithClock();

		try {
			await promptJoined(pooled.session, open.session, pooled.coordinator);
		} finally {
			await pool.release();
		}

		expect(spent).toEqual([pool.outsideId]);
		expect(open.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(pooled.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("restores the shared account for an unrestricted session that joined a pass whose pool dropped it mid-spend", async () => {
		const openQuota = { restored: false };
		const pooled = buildSession({ report: null, status: claudeStatus(true), streamErrorFirst: true });
		const open = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
			quota: openQuota,
			coordinator: pooled.coordinator,
		});
		const pool = await poolToSessionAccount(pooled.session, 3 * 24 * HOUR);
		// Only the shared account is listed, so planning excludes nothing.
		const listed = await authStorage.resets.list({ provider: "anthropic" });
		vi.spyOn(authStorage.resets, "list").mockResolvedValue(
			listed.filter(status => status.credentialId === pool.pooledId),
		);
		const replaced = emptyPoolOnPendingMarker(pooled.session);
		const spent = recordSpends(credentialId => (credentialId === pool.pooledId ? openQuota : undefined));
		mockSchedulerWaitWithClock();

		try {
			await promptJoined(pooled.session, open.session, pooled.coordinator);
		} finally {
			const lease = replaced();
			if (lease) authStorage.sessions.unrestrict("anthropic", pooled.session.sessionId, lease);
			await pool.release();
		}

		expect(replaced()).toBeDefined();
		expect(spent).toEqual([pool.pooledId]);
		expect(open.modelCalls()).toBe(2);
		expect(open.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(pooled.session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("recovers a pooled session and an unrestricted one with one restore of the account they share", async () => {
		const quota = { restored: false };
		const open = buildSession({ report: null, status: claudeStatus(true), streamErrorFirst: true, quota });
		const pooled = buildSession({
			report: null,
			status: claudeStatus(true),
			streamErrorFirst: true,
			quota,
			coordinator: open.coordinator,
		});
		const pool = await poolToSessionAccount(pooled.session, 24 * HOUR);
		const spent = recordSpends(credentialId => (credentialId === pool.pooledId ? quota : undefined));
		mockSchedulerWaitWithClock();

		try {
			await promptJoined(open.session, pooled.session, open.coordinator);
		} finally {
			await pool.release();
		}

		expect(spent).toEqual([pool.pooledId]);
		for (const { session, modelCalls } of [open, pooled]) {
			expect(modelCalls()).toBe(2);
			expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		}
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

	it("salvages an expiring early-use Cedar grant from the usage heartbeat exactly once", async () => {
		const { session, coordinator, targets } = buildSession({
			report: claudeReport(0.5),
			status: claudeStatus(false),
		});

		await session.fetchUsageReports();
		expect(coordinator.sweepPromise).toBeDefined();
		await coordinator.sweepPromise;
		expect(targets).toHaveLength(1);

		coordinator.lastSweepAt = 0;
		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(targets).toHaveLength(1);
	});

	it.each(["yes", "no", "unset"] as const)(
		"only consumes an imminent reset with consent when auto-redeem is %s",
		async autoRedeem => {
			const report = claudeReport(0);
			const status = claudeStatus(false);
			status.report = report;
			for (const credit of status.credits) {
				credit.expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
				credit.usedFractions = { "anthropic:7d": 0 };
			}
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
				autoRedeem === "yes"
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
			expect(targets).toHaveLength(autoRedeem === "yes" ? 1 : 0);
		},
	);

	it("does not spend headlessly before independent Claude consent", async () => {
		// Codex being disabled does not enable Claude, and an unset headless
		// session cannot spend silently.
		const { session, coordinator, targets } = buildSession({
			report: claudeReport(0.5),
			status: claudeStatus(false),
			autoRedeem: "unset",
		});

		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(targets).toHaveLength(0);
		expect(coordinator.attemptedKeys.size).toBe(0);
		expect(cfgClaudeResetsAutoRedeem.get(session.settings)).toBe("unset");
	});
});

describe("saved reset before a reserve-protected sibling", () => {
	interface Account {
		accountId: string;
		email: string;
		orgId: string;
		priority: number;
		reservePct: number;
		usedPct: number;
		resets: number;
		usageUnavailable?: boolean;
		resetExpiresInMs?: number;
	}
	const previousProxy = Bun.env.PI_PROXY_ANTHROPIC;
	let tempDir: TempDir;
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(() => {
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { apiKey: `key-${credential.accountId}`, newCredentials: credential } : null;
		});
		// A provider proxy moves first-party Anthropic requests onto globalThis.fetch.
		Bun.env.PI_PROXY_ANTHROPIC = "http://proxy.example.test:8080";
		__resetProxyCache();
		tempDir = TempDir.createSync("@pi-reserve-takeover-");
		// createAgentSession uses the process-wide coordinator: start it empty, locking in scratch.
		Object.assign(defaultCodexAutoRedeemCoordinator, createCodexAutoRedeemCoordinator(), {
			resetLockPath: tempDir.join("auth.db"),
		});
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		Object.assign(defaultCodexAutoRedeemCoordinator, createCodexAutoRedeemCoordinator(), {
			resetLockPath: undefined,
		});
		if (previousProxy === undefined) delete Bun.env.PI_PROXY_ANTHROPIC;
		else Bun.env.PI_PROXY_ANTHROPIC = previousProxy;
		__resetProxyCache();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function sse(events: { type: string; [field: string]: unknown }[], named: boolean): Response {
		const body = events
			.map(event => `${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
			.join("");
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	}

	function modelAnswer(provider: string, modelId: string): Response {
		if (provider === "anthropic") {
			return sse(
				[
					{
						type: "message_start",
						message: { id: "msg_1", type: "message", role: "assistant", model: modelId, content: [], usage: {} },
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "served" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				],
				true,
			);
		}
		const message = { type: "message", id: "msg_1", role: "assistant" };
		return sse(
			[
				{ type: "response.created", response: { id: "resp_1" } },
				{ type: "response.output_item.added", item: { ...message, status: "in_progress", content: [] } },
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: "served" },
				{
					type: "response.output_item.done",
					item: { ...message, status: "completed", content: [{ type: "output_text", text: "served" }] },
				},
				{
					type: "response.completed",
					response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
				},
			],
			false,
		);
	}

	function claudeUsage(url: URL, account: Account): Response {
		const now = Date.now();
		return Response.json({
			five_hour: { utilization: 50, resets_at: new Date(now + 2 * HOUR).toISOString() },
			seven_day: { utilization: account.usedPct, resets_at: new Date(now + 72 * HOUR).toISOString() },
			cedar_ember: url.searchParams.has("cedar_ember")
				? {
						eligible: true,
						next_grant_id: account.resets > 0 ? "saved-reset" : null,
						grants:
							account.resets > 0
								? [
										{
											id: "saved-reset",
											resets_left: account.resets,
											ends_at: new Date(now + (account.resetExpiresInMs ?? 7 * 24 * HOUR)).toISOString(),
											clears: ["five_hour", "seven_day"],
											usable_now: true,
											percent_used: { seven_day: account.usedPct },
											blocking: account.usedPct >= 100 ? ["seven_day"] : [],
										},
									]
								: [],
					}
				: null,
			juniper_tide: null,
		});
	}

	function codexReport(account: Account): UsageReport {
		const exhausted = account.usedPct >= 100;
		return {
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "openai-codex:primary",
					label: "5 hours",
					scope: { provider: "openai-codex", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 hours", durationMs: 5 * HOUR, resetsAt: Date.now() + 3 * HOUR },
					amount: { usedFraction: account.usedPct / 100, unit: "percent" },
					status: exhausted ? "exhausted" : "ok",
				},
			],
			metadata: {
				accountId: account.accountId,
				email: account.email,
				orgId: account.orgId,
				allowed: !exhausted,
				limitReached: exhausted,
			},
		};
	}

	/**
	 * The preferred account spends the rest of its window on this request while
	 * a lower-priority backup still has 92% left. A real `createAgentSession`
	 * runs the stream's credential rotation, turn recovery, pool health, reset
	 * discovery and the reset; only provider HTTP and token minting are stubbed.
	 */
	async function hitWall(
		provider: "anthropic" | "openai-codex",
		options: {
			restoreBeforeReserve: boolean;
			backupReservePct?: number;
			primaryResets?: number;
			/** A third stored account outside the session's account pool. */
			excluded?: "healthy" | "unknown" | "blocked with a reset";
			excludedResetExpiresInMs?: number;
			abortAt?: "recovery health read" | "reset listing";
			/** The primary serves the prompt and hits its wall on the next request. */
			primaryServesFirst?: boolean;
			settings?: Record<string, unknown>;
		},
	) {
		const accounts: Record<string, Account> = {
			primary: {
				accountId: "primary",
				email: "primary@example.com",
				orgId: "11111111-1111-4111-8111-111111111111",
				priority: 20,
				reservePct: 0,
				usedPct: 99,
				resets: options.primaryResets ?? 1,
			},
			backup: {
				accountId: "backup",
				email: "backup@example.com",
				orgId: "22222222-2222-4222-8222-222222222222",
				priority: 10,
				reservePct: options.backupReservePct ?? 100,
				usedPct: 8,
				resets: 0,
			},
		};
		if (options.excluded) {
			const blocked = options.excluded === "blocked with a reset";
			accounts.extra = {
				accountId: "extra",
				email: "extra@example.com",
				orgId: "33333333-3333-4333-8333-333333333333",
				priority: 30,
				reservePct: 0,
				usedPct: blocked ? 100 : 8,
				resets: blocked ? 1 : 0,
				usageUnavailable: options.excluded === "unknown",
				resetExpiresInMs: options.excludedResetExpiresInMs,
			};
		}
		const resetPosts: string[] = [];
		let healthReads = 0;
		const live: { session?: AgentSession } = {};
		const requests: string[] = [];
		const model = getBundledModel(provider, provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5.6-sol");
		if (!model) throw new Error(`Expected a bundled ${provider} model`);

		const serve = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const headers = new Headers(init?.headers);
			const token = headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			if (url.pathname.endsWith("/v1/messages") || url.pathname.endsWith("/codex/responses")) {
				const account = accounts[token.replace(/^key-/, "")];
				if (!account) return new Response("unknown key", { status: 401 });
				requests.push(account.accountId);
				const servesFirst = options.primaryServesFirst && requests.length === 1;
				if (account.accountId !== "primary" || account.usedPct < 99 || servesFirst) {
					return modelAnswer(provider, model.id);
				}
				// The selection-time report read 99%; this request spends the rest of the window.
				account.usedPct = 100;
				const error =
					provider === "anthropic"
						? { type: "error", error: { type: "rate_limit_error", message: "usage_limit_reached" } }
						: { error: { type: "usage_limit_reached", message: "The usage limit has been reached" } };
				return Response.json(error, { status: 429, headers: { "retry-after": String(3 * 3600) } });
			}
			const account = accounts[token.replace(/^access-/, "")];
			if (!account) return new Response("not found", { status: 404 });
			if (account.usageUnavailable) return new Response("unavailable", { status: 500 });
			const listing = url.searchParams.has("cedar_ember") || url.pathname.endsWith("/wham/rate-limit-reset-credits");
			// Recovery has read pool health twice and now discovers the blocked account's reset.
			if (options.abortAt === "reset listing" && listing && healthReads >= 2) void live.session?.abort();
			const consume = url.pathname.endsWith("/reset_rate_limits") || url.pathname.endsWith("/consume");
			if (init?.method === "POST" && consume) {
				resetPosts.push(account.accountId);
				account.usedPct = 0;
				account.resets -= 1;
				return provider === "anthropic"
					? Response.json({ result: "reset", resets_left: account.resets, cleared: ["seven_day"] })
					: Response.json({ code: "reset" });
			}
			if (url.pathname.endsWith("/wham/rate-limit-reset-credits")) {
				return Response.json({
					available_count: account.resets,
					credits: Array.from({ length: account.resets }, (_, index) => ({
						id: `credit-${account.accountId}-${index}`,
						status: "available",
						expires_at: new Date(Date.now() + (account.resetExpiresInMs ?? 7 * 24 * HOUR)).toISOString(),
					})),
				});
			}
			return claudeUsage(url, account);
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(serve));

		const storage = await AuthStorage.create(":memory:", {
			usageFetch: asGlobalFetch(serve),
			usageProviderResolver: usageProvider => {
				if (usageProvider === "anthropic") return claudeUsageProvider;
				if (usageProvider !== "openai-codex") return undefined;
				return {
					id: "openai-codex",
					fetchUsage: async params => {
						const account = accounts[params.credential.accountId ?? ""];
						return account && !account.usageUnavailable ? codexReport(account) : null;
					},
				};
			},
			accountPolicies: Object.values(accounts).map(account => ({
				provider,
				account: { email: account.email },
				priority: account.priority,
				reservePct: account.reservePct,
			})),
		});
		cleanups.push(() => storage.close());
		const credentials = Object.values(accounts).map(account => ({
			type: "oauth" as const,
			access: `access-${account.accountId}`,
			refresh: `refresh-${account.accountId}`,
			expires: Date.now() + 7 * 24 * HOUR,
			accountId: account.accountId,
			email: account.email,
			orgId: account.orgId,
		}));
		await storage.credentials.set(provider, credentials);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"providers.openaiWebsockets": "off",
			"codexResets.autoRedeem": provider === "openai-codex" ? "yes" : "no",
			"claudeResets.autoRedeem": provider === "anthropic" ? "yes" : "no",
			"codexResets.restoreBeforeReserve": options.restoreBeforeReserve,
			"claudeResets.restoreBeforeReserve": options.restoreBeforeReserve,
			...options.settings,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage: storage,
			modelRegistry: new ModelRegistry(storage, tempDir.join("models.yml")),
			settings,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		cleanups.push(() => session.dispose());
		if (options.excluded) {
			const permitted = credentials.filter(credential => credential.accountId !== "extra");
			storage.sessions.restrict(
				provider,
				session.sessionId,
				permitted.map(credential => resolveCredentialIdentityKey(provider, credential) ?? ""),
			);
		}
		const healthModel = storage.health.model.bind(storage.health);
		live.session = session;
		vi.spyOn(storage.health, "model").mockImplementation(async (...args) => {
			healthReads++;
			// The stream's rotation reads pool health first; turn recovery reads it again before any reset.
			if (options.abortAt === "recovery health read" && healthReads === 2) void session.abort();
			return healthModel(...args);
		});
		const captures = vi.spyOn(session, "runAutolearnCapture");

		await session.prompt("keep working through the limit");
		await session.waitForIdle();
		await Promise.all(captures.mock.results.map(result => result.value));
		return { resetPosts, requests, healthReads, last: session.agent.state.messages.at(-1) };
	}

	it("spends the blocked Claude account's reset before a backup inside its reserve serves", async () => {
		const result = await hitWall("anthropic", { restoreBeforeReserve: true });
		expect(result.resetPosts).toEqual(["primary"]);
		expect(result.requests).toEqual(["primary", "primary"]);
		expect(result.last).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("spends the blocked Codex account's reset before a backup inside its reserve serves", async () => {
		const result = await hitWall("openai-codex", { restoreBeforeReserve: true });
		expect(result.resetPosts).toEqual(["primary"]);
		expect(result.requests).toEqual(["primary", "primary"]);
		expect(result.last).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it.each(["anthropic", "openai-codex"] as const)(
		"rotates %s to the backup without reading pool health when restoreBeforeReserve is off",
		async provider => {
			const result = await hitWall(provider, { restoreBeforeReserve: false });
			expect(result.resetPosts).toEqual([]);
			expect(result.requests).toEqual(["primary", "backup"]);
			expect(result.healthReads).toBe(0);
			expect(result.last).toMatchObject({ role: "assistant", stopReason: "stop" });
		},
	);

	it("rotates to a sibling outside its reserve without spending a reset", async () => {
		const result = await hitWall("anthropic", { restoreBeforeReserve: true, backupReservePct: 0 });
		expect(result.resetPosts).toEqual([]);
		expect(result.requests).toEqual(["primary", "backup"]);
	});

	it.each(["healthy", "unknown"] as const)(
		"ignores a %s account outside the session's account pool when judging the takeover",
		async excluded => {
			const result = await hitWall("anthropic", { restoreBeforeReserve: true, excluded });
			expect(result.resetPosts).toEqual(["primary"]);
			expect(result.requests).toEqual(["primary", "primary"]);
		},
	);

	it("never spends the reset of an account outside the session's account pool", async () => {
		const result = await hitWall("anthropic", {
			restoreBeforeReserve: true,
			primaryResets: 0,
			excluded: "blocked with a reset",
		});
		expect(result.resetPosts).toEqual([]);
		expect(result.requests).toEqual(["primary", "backup"]);
	});

	it("spends nothing when the turn is cancelled while recovery reads pool health", async () => {
		const result = await hitWall("anthropic", { restoreBeforeReserve: true, abortAt: "recovery health read" });
		expect(result.resetPosts).toEqual([]);
		expect(result.requests).toEqual(["primary"]);
	});

	it("spends nothing when the turn is cancelled while recovery discovers the reset", async () => {
		const result = await hitWall("anthropic", { restoreBeforeReserve: true, abortAt: "reset listing" });
		expect(result.resetPosts).toEqual([]);
		expect(result.requests).toEqual(["primary"]);
	});

	it.each([
		["retries are off", { "retry.enabled": false }],
		["the retry budget is spent", { "retry.maxRetries": 0 }],
	])("lets the backup take over in-stream when %s", async (_name, settings) => {
		const result = await hitWall("anthropic", { restoreBeforeReserve: true, settings });
		expect(result.resetPosts).toEqual([]);
		expect(result.requests).toEqual(["primary", "backup"]);
		expect(result.last).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("lets the backup take over an auto-learn capture in-stream", async () => {
		const result = await hitWall("anthropic", {
			restoreBeforeReserve: true,
			primaryServesFirst: true,
			settings: { "autolearn.enabled": true, "autolearn.autoContinue": true, "autolearn.minToolCalls": 0 },
		});
		expect(result.resetPosts).toEqual([]);
		expect(result.requests).toEqual(["primary", "primary", "backup"]);
	});

	it("never spends an outside account's expiring reset while the backup could take over", async () => {
		const result = await hitWall("anthropic", {
			restoreBeforeReserve: true,
			primaryResets: 0,
			excluded: "blocked with a reset",
			excludedResetExpiresInMs: 60_000,
		});
		expect(result.resetPosts).toEqual([]);
		expect(result.requests).toEqual(["primary", "backup"]);
	});
});
