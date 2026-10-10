import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ResetCreditAccountStatus, ResetCreditTarget, UsageReport } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CodexAutoRedeemCoordinator,
	createCodexAutoRedeemCoordinator,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
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
	weeklyUsed: number;
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
				amount: { usedFraction: 0.1, unit: "percent" },
			},
			{
				id: "openai-codex:secondary",
				label: "Weekly",
				scope,
				window: { id: "7d", label: "Weekly", resetsAt: now + 3 * 24 * HOUR },
				amount: { usedFraction: account.weeklyUsed, unit: "percent" },
			},
		],
		metadata: { accountId: account.accountId, email: EMAIL, limitReached: account.limitReached },
	};
}

function liveCreditStatus(account: CodexAccount, active: boolean): ResetCreditAccountStatus {
	return {
		provider: "openai-codex",
		credentialId: account.credentialId,
		accountId: account.accountId,
		email: EMAIL,
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

	function buildSession(options: { accounts: CodexAccount[]; streamErrorFirst?: boolean }): {
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
		let calls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, streamOptions) => {
				calls++;
				if (options.streamErrorFirst && calls === 1) mock.push({ throw: CODEX_USAGE_LIMIT_ERROR });
				else mock.push({ content: ["recovered after reset redemption"], stopReason: "stop" });
				return mock.stream(requestedModel, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			"codexResets.autoRedeem": "unset",
			"claudeResets.autoRedeem": "no",
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory();
		managers.push(sessionManager);
		const coordinator = createCodexAutoRedeemCoordinator();
		coordinator.resetLockPath = `${tempDir.path()}/agent.db`;
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			codexResetCoordinator: coordinator,
		});
		sessions.push(session);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		return { session, coordinator, targets, notices };
	}

	it("restores a blocked turn with a reset expiring within five minutes and continues", async () => {
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

		expect(targets).toEqual([
			{ provider: "openai-codex", credentialId: 1, accountId: "acct-a", email: EMAIL, creditId: "credit-1" },
		]);
		expect(notices).toContainEqual(expect.stringContaining(`Spending a saved Codex reset for ${EMAIL}`));
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "recovered after reset redemption" }],
		});
	});

	it("still needs consent to restore a blocked turn with a reset that has more time left", async () => {
		const account = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 1,
			limitReached: true,
			creditExpiresInMs: 6 * HOUR,
		};
		const { session, targets, notices } = buildSession({ accounts: [account], streamErrorFirst: true });
		mockSchedulerWaitWithClock();

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		expect(targets).toEqual([]);
		expect(notices).toContainEqual(expect.stringContaining("auto-redeem is unset and no prompt UI is available"));
		expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
	});

	it("spends only the reset about to expire from a mixed salvage batch", async () => {
		const expiring = {
			accountId: "acct-a",
			credentialId: 1,
			weeklyUsed: 0.1,
			limitReached: false,
			creditExpiresInMs: 4 * MINUTE,
		};
		const salvageable = {
			accountId: "acct-b",
			credentialId: 2,
			weeklyUsed: 0.8,
			limitReached: false,
			creditExpiresInMs: 2 * HOUR,
		};
		const { session, coordinator, targets, notices } = buildSession({ accounts: [expiring, salvageable] });

		await session.fetchUsageReports();
		await coordinator.sweepPromise;

		expect(targets).toEqual([
			{ provider: "openai-codex", credentialId: 1, accountId: "acct-a", email: EMAIL, creditId: "credit-1" },
		]);
		expect(notices).toContainEqual(expect.stringContaining("auto-redeem is unset and no prompt UI is available"));
		expect([...coordinator.attemptedKeys]).toEqual([expect.stringContaining("openai-codex|-|1|")]);
	});
});
