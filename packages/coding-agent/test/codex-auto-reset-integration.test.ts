import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ResetCreditAccountStatus, ResetCreditTarget, UsageReport } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { createAcpExtensionUiContext } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CodexAutoRedeemCoordinator,
	createCodexAutoRedeemCoordinator,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgClaudeResetsAutoRedeem5h,
	cfgClaudeResetsAutoRedeemWeekly,
	cfgCodexResetsAutoRedeem5h,
	cfgCodexResetsAutoRedeemWeekly,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, CreateElicitationRequest } from "@oh-my-pi/pi-utils/acp";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";
import { getTestModel } from "./helpers/model-fixtures";

const EMAIL = "user@example.com";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CODEX_USAGE_LIMIT_ERROR =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"usage_limit_reached"}} retry-after-ms=259200000';

interface CodexAccount {
	accountId: string;
	credentialId: number;
	/** Account identity; the shared fixture email otherwise. */
	email?: string;
	fiveHourUsed?: number;
	weeklyUsed: number;
	/** How far the weekly wall is from rolling over; three days when omitted. */
	weeklyResetsInMs?: number;
	limitReached: boolean;
	creditExpiresInMs: number;
}

function codexReport(account: CodexAccount): UsageReport {
	const now = Date.now();
	const scope = { provider: "openai-codex", accountId: account.accountId };
	return {
		provider: "openai-codex",
		fetchedAt: now,
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 Hour",
				scope,
				window: { id: "5h", label: "5 Hour", resetsAt: now + 2 * HOUR },
				amount: { usedFraction: account.fiveHourUsed ?? 0.1, unit: "percent" },
			},
			{
				id: "openai-codex:secondary",
				label: "Weekly",
				scope,
				window: { id: "7d", label: "Weekly", resetsAt: now + (account.weeklyResetsInMs ?? 3 * 24 * HOUR) },
				amount: { usedFraction: account.weeklyUsed, unit: "percent" },
			},
		],
		metadata: { accountId: account.accountId, email: account.email ?? EMAIL, limitReached: account.limitReached },
	};
}

function liveCreditStatus(account: CodexAccount, active: boolean): ResetCreditAccountStatus {
	return {
		provider: "openai-codex",
		credentialId: account.credentialId,
		accountId: account.accountId,
		email: account.email ?? EMAIL,
		active,
		availableCount: 1,
		credits: [
			{
				id: `credit-${account.credentialId}`,
				status: "available",
				expiresAt: new Date(Date.now() + account.creditExpiresInMs).toISOString(),
			},
		],
	};
}

describe("Codex saved-reset consent without a prompt UI", () => {
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
		tempDir = TempDir.createSync("@pi-codex-reset-");
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
		accounts: CodexAccount[];
		streamErrorFirst?: boolean;
		/** Builds the session the way ACP does for a client with or without form elicitation. */
		acpForm?: boolean;
		/** Initial per-window consent; both windows start unset when omitted. */
		codexAutoRedeem5h?: "unset" | "yes" | "no";
		codexAutoRedeemWeekly?: "unset" | "yes" | "no";
		/** How far the provider's own 429 hint pushes the block; three days when omitted. */
		blockRetryAfterMs?: number;
		/** Answers the auto-redeem consent prompt; implies a prompt UI. */
		consent?: () => Promise<string | undefined>;
		/** Shares another session's coordinator, as sessions of one process do. */
		coordinator?: CodexAutoRedeemCoordinator;
	}): {
		session: AgentSession;
		coordinator: CodexAutoRedeemCoordinator;
		targets: ResetCreditTarget[];
		notices: string[];
	} {
		const model = getTestModel("openai-codex", candidate => !candidate.id.includes("-spark"));
		const [active] = options.accounts;
		authStorage.keys.setRuntime("openai-codex", "test-key");
		vi.spyOn(authStorage.oauth, "identity").mockReturnValue({ accountId: active.accountId, email: EMAIL });
		vi.spyOn(authStorage.usage, "reports").mockImplementation(async () => options.accounts.map(codexReport));
		vi.spyOn(authStorage.resets, "list").mockImplementation(async () =>
			options.accounts.map(account => liveCreditStatus(account, account === active)),
		);
		const targets: ResetCreditTarget[] = [];
		vi.spyOn(authStorage.resets, "redeem").mockImplementation(async request => {
			targets.push(request.target);
			return { ok: true, code: "reset", provider: "openai-codex", email: EMAIL, creditId: "credit" };
		});

		const mock = createMockModel();
		const usageLimitError =
			options.blockRetryAfterMs === undefined
				? CODEX_USAGE_LIMIT_ERROR
				: CODEX_USAGE_LIMIT_ERROR.replace(/retry-after-ms=\d+/, `retry-after-ms=${options.blockRetryAfterMs}`);
		let calls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, streamOptions) => {
				calls++;
				if (options.streamErrorFirst && calls === 1) mock.push({ throw: usageLimitError });
				else mock.push({ content: ["recovered after reset redemption"], stopReason: "stop" });
				return mock.stream(requestedModel, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
		});
		// Set through the handles so a consented answer can overwrite them (override-layer values win over set()).
		cfgClaudeResetsAutoRedeem5h.set(settings, "no");
		cfgClaudeResetsAutoRedeemWeekly.set(settings, "no");
		if (options.codexAutoRedeem5h) cfgCodexResetsAutoRedeem5h.set(settings, options.codexAutoRedeem5h);
		if (options.codexAutoRedeemWeekly) cfgCodexResetsAutoRedeemWeekly.set(settings, options.codexAutoRedeemWeekly);
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory();
		managers.push(sessionManager);
		const coordinator = options.coordinator ?? createCodexAutoRedeemCoordinator();
		coordinator.resetLockPath ??= `${tempDir.path()}/agent.db`;
		const interactivePrompts = options.consent !== undefined ? true : options.acpForm;
		let extensionRunner: ExtensionRunner | undefined;
		if (options.acpForm !== undefined || options.consent !== undefined) {
			extensionRunner = new ExtensionRunner(
				[],
				new ExtensionRuntime(),
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			if (options.consent) {
				vi.spyOn(extensionRunner, "hasUI").mockReturnValue(true);
				vi.spyOn(extensionRunner.getUIContext(), "select").mockImplementation(options.consent);
			}
		}
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			codexResetCoordinator: coordinator,
			extensionRunner,
			interactivePrompts,
		});
		sessions.push(session);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		return { session, coordinator, targets, notices };
	}

	/** Initializes extensions with ACP's elicitation-bridged UI context, installed whether or not the client can show forms. */
	async function attachAcpClient(session: AgentSession, form: boolean): Promise<string[]> {
		const elicitations: string[] = [];
		const connection = {
			unstable_createElicitation: async (request: CreateElicitationRequest) => {
				elicitations.push(request.message);
				return { action: "decline" };
			},
		} as unknown as AgentSideConnection;
		await initializeExtensions(session, {
			mode: "rpc",
			reportSendError: () => {},
			reportRuntimeError: () => {},
			uiContext: createAcpExtensionUiContext(
				connection,
				() => session.sessionId,
				form ? { elicitation: { form: {} } } : {},
			),
		});
		return elicitations;
	}

	it("never spends a reset about to expire while auto-redeem is unset", async () => {
		const account = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			limitReached: true,
			creditExpiresInMs: 4 * MINUTE,
		};
		const { session, targets, notices } = buildSession({ accounts: [account], streamErrorFirst: true });
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		expect(targets).toEqual([]);
		expect(notices).toContainEqual(expect.stringContaining("auto-redeem is unset and no prompt UI is available"));
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("never spends for an ACP client without form elicitation while auto-redeem is unset", async () => {
		const account = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			limitReached: true,
			creditExpiresInMs: 4 * MINUTE,
		};
		const { session, targets, notices } = buildSession({
			accounts: [account],
			streamErrorFirst: true,
			acpForm: false,
		});
		const elicitations = await attachAcpClient(session, false);
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		// Extensions keep ACP's UI context; only the consent prompt knows it cannot reach anyone.
		expect(session.extensionRunner?.hasUI()).toBe(true);
		expect(elicitations).toEqual([]);
		expect(targets).toEqual([]);
		expect(notices).toContainEqual(expect.stringContaining("auto-redeem is unset and no prompt UI is available"));
	});

	it("still asks an ACP client with form elicitation about a reset about to expire", async () => {
		const account = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			limitReached: true,
			creditExpiresInMs: 4 * MINUTE,
		};
		const { session, targets } = buildSession({ accounts: [account], streamErrorFirst: true, acpForm: true });
		const elicitations = await attachAcpClient(session, true);
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		expect(elicitations).toEqual([expect.stringContaining("Spend a saved Codex rate-limit reset?")]);
		expect(targets).toEqual([]);
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("remembers a consented weekly restore only on the weekly setting", async () => {
		const account = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			limitReached: true,
			creditExpiresInMs: 6 * HOUR,
		};
		const { session, targets } = buildSession({
			accounts: [account],
			streamErrorFirst: true,
			codexAutoRedeem5h: "no",
			codexAutoRedeemWeekly: "unset",
			consent: async () => "Yes",
		});
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		// The 5h window was explicitly off; only the governing weekly key records the answer.
		expect(cfgCodexResetsAutoRedeem5h.get(session.settings)).toBe("no");
		expect(cfgCodexResetsAutoRedeemWeekly.get(session.settings)).toBe("yes");
		// An interactive "yes" spends the credit the plan priced, never a later one.
		expect(targets).toEqual([
			{ provider: "openai-codex", credentialId: 1, accountId: "acct-a", email: EMAIL, creditId: "credit-1" },
		]);
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("recovers a blocked turn while an unrelated salvage question is still open", async () => {
		const accounts: CodexAccount[] = [
			{
				accountId: "acct-a",
				credentialId: 1,
				weeklyUsed: 1,
				limitReached: true,
				creditExpiresInMs: 6 * HOUR,
			},
			{
				accountId: "acct-b",
				credentialId: 2,
				email: "sibling@example.com",
				fiveHourUsed: 0.8,
				weeklyUsed: 0.1,
				limitReached: false,
				creditExpiresInMs: 2 * HOUR,
			},
		];
		const prompted = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<string | undefined>();
		const consent = vi.fn(() => {
			prompted.resolve();
			return answer.promise;
		});
		const { session, coordinator, targets } = buildSession({
			accounts,
			streamErrorFirst: true,
			codexAutoRedeem5h: "unset",
			codexAutoRedeemWeekly: "yes",
			consent,
		});
		mockSchedulerWaitWithClock();
		const recovering = session
			.prompt("recover while the sibling salvage awaits consent")
			.then(() => session.waitForIdle());
		let later: Promise<void> | undefined;
		let laterTargets: ResetCreditTarget[] = [];

		try {
			await withTimeout(prompted.promise, 2_000, "no salvage question was asked");
			// The weekly-approved restore is spent and the turn continues before the
			// sibling's unset salvage question is answered.
			await withTimeout(recovering, 2_000, "blocked turn waited for unrelated salvage consent");
			expect(targets.map(target => target.credentialId)).toEqual([1]);
			expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });

			// A usage heartbeat must not start a sweep that asks about the same credit again.
			await session.fetchUsageReports();
			expect(consent).toHaveBeenCalledTimes(1);
			expect(targets.map(target => target.credentialId)).toEqual([1]);

			// Another session's blocked pass in the same process finds the credit already
			// claimed, so it neither asks twice nor waits for this open question.
			const peer = buildSession({
				accounts,
				streamErrorFirst: true,
				codexAutoRedeem5h: "unset",
				codexAutoRedeemWeekly: "yes",
				consent,
				coordinator,
			});
			laterTargets = peer.targets;
			later = peer.session
				.prompt("block again while the salvage question stays open")
				.then(() => peer.session.waitForIdle());
			await withTimeout(later, 2_000, "a later blocked pass waited for the pending salvage question");
			expect(consent).toHaveBeenCalledTimes(1);
			expect([...targets, ...laterTargets].map(target => target.credentialId)).toEqual([1]);

			answer.resolve("Yes");
			await coordinator.sweepPromise;
			expect([...targets, ...laterTargets].map(target => target.credentialId)).toEqual([1, 2]);
		} finally {
			answer.resolve("No");
			await recovering;
			await later;
			await coordinator.sweepPromise;
		}
	});

	it("recovers through approved active-account salvage while sibling consent stays open", async () => {
		const prompted = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<string | undefined>();
		const { session, coordinator, targets } = buildSession({
			accounts: [
				{
					accountId: "acct-a",
					credentialId: 1,
					weeklyUsed: 1,
					weeklyResetsInMs: 30 * MINUTE,
					limitReached: true,
					creditExpiresInMs: 2 * MINUTE,
				},
				{
					accountId: "acct-b",
					credentialId: 2,
					email: "sibling@example.com",
					fiveHourUsed: 0.8,
					weeklyUsed: 0.1,
					limitReached: false,
					creditExpiresInMs: 2 * HOUR,
				},
			],
			streamErrorFirst: true,
			blockRetryAfterMs: 30 * MINUTE,
			codexAutoRedeem5h: "unset",
			codexAutoRedeemWeekly: "yes",
			consent: () => {
				prompted.resolve();
				return answer.promise;
			},
		});
		mockSchedulerWaitWithClock();
		const recovering = session
			.prompt("recover through active salvage while the sibling awaits consent")
			.then(() => session.waitForIdle());

		try {
			await withTimeout(prompted.promise, 2_000, "no sibling salvage question was asked");
			// Restore is below the threshold, but the approved last-chance salvage
			// still resets the active credential without waiting for its sibling.
			await withTimeout(recovering, 2_000, "active salvage recovery waited for sibling consent");
			expect(targets).toEqual([
				{ provider: "openai-codex", credentialId: 1, accountId: "acct-a", email: EMAIL, creditId: "credit-1" },
			]);
			expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });

			answer.resolve("Yes");
			await coordinator.sweepPromise;
			expect(targets.map(target => target.credentialId)).toEqual([1, 2]);
		} finally {
			answer.resolve("No");
			await recovering;
			await coordinator.sweepPromise;
		}
	});

	it("keeps a blocked turn waiting for its own restore consent", async () => {
		const prompted = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<string | undefined>();
		const consent = vi.fn(() => {
			prompted.resolve();
			return answer.promise;
		});
		const { session, coordinator, targets } = buildSession({
			accounts: [
				{
					accountId: "acct-a",
					credentialId: 1,
					weeklyUsed: 1,
					limitReached: true,
					creditExpiresInMs: 6 * HOUR,
				},
			],
			streamErrorFirst: true,
			codexAutoRedeem5h: "no",
			codexAutoRedeemWeekly: "unset",
			consent,
		});
		mockSchedulerWaitWithClock();
		const recovering = session.prompt("wait for the restore decision").then(() => session.waitForIdle());
		try {
			await prompted.promise;
			// A full usage round trip still leaves the pass open: recovery is waiting for
			// this answer, so nothing is spent and no second question is asked.
			await session.fetchUsageReports();
			expect(coordinator.inFlightByAccount.size).toBe(1);
			expect(consent).toHaveBeenCalledTimes(1);
			expect(targets).toEqual([]);

			answer.resolve("Yes");
			await recovering;
			expect(targets.map(target => target.credentialId)).toEqual([1]);
			expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		} finally {
			answer.resolve("No");
			await recovering;
		}
	});

	it("waits for consent to salvage the blocked account's own expiring reset when its restore is too soon", async () => {
		// The weekly wall clears in half an hour — below the 60-minute restore
		// threshold — so the only planned spend is the account's last-chance
		// salvage. That salvage is what can recover the turn, so its question must
		// hold the turn: answering Yes spends the credit and the turn continues.
		const account: CodexAccount = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			weeklyResetsInMs: 30 * MINUTE,
			limitReached: true,
			creditExpiresInMs: 2 * MINUTE,
		};
		const { session, targets } = buildSession({
			accounts: [account],
			streamErrorFirst: true,
			codexAutoRedeem5h: "no",
			codexAutoRedeemWeekly: "unset",
			consent: async () => "Yes",
		});
		mockSchedulerWaitWithClock();

		await withTimeout(
			session.prompt("recover through the blocked account's own expiring reset").then(() => session.waitForIdle()),
			5_000,
			"the blocked turn never recovered",
		);

		expect(targets).toEqual([
			{ provider: "openai-codex", credentialId: 1, accountId: "acct-a", email: EMAIL, creditId: "credit-1" },
		]);
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "recovered after reset redemption" }],
		});
	});

	it("keeps a one-off imminent salvage from enabling both windows", async () => {
		const account = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			limitReached: true,
			creditExpiresInMs: 4 * MINUTE,
		};
		const { session, targets } = buildSession({
			accounts: [account],
			streamErrorFirst: true,
			consent: async () => "Yes",
		});
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		// The credit also restores 5h, but only the governing weekly key records the answer.
		expect(targets).toHaveLength(1);
		expect(cfgCodexResetsAutoRedeemWeekly.get(session.settings)).toBe("yes");
		expect(cfgCodexResetsAutoRedeem5h.get(session.settings)).toBe("unset");
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("does not ask again about an imminent credit the user declined", async () => {
		const consent = vi.fn(async () => "No");
		const { session, coordinator, targets } = buildSession({
			accounts: [
				{ accountId: "acct-a", credentialId: 1, weeklyUsed: 1, limitReached: true, creditExpiresInMs: 4 * MINUTE },
			],
			streamErrorFirst: true,
			consent,
		});
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();
		// No saves only the governing weekly key; 5h stays unset and would keep the credit askable.
		expect(cfgCodexResetsAutoRedeemWeekly.get(session.settings)).toBe("no");
		expect(cfgCodexResetsAutoRedeem5h.get(session.settings)).toBe("unset");

		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(consent).toHaveBeenCalledTimes(1);
		expect(targets).toEqual([]);
	});
});
