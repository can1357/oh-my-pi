import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ResetCreditAccountStatus, ResetCreditTarget, UsageReport } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type CodexAutoRedeemCoordinator,
	createCodexAutoRedeemCoordinator,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	});

	beforeEach(() => {
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		sessions = [];
		managers = [];
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) {
			await session.dispose();
		}
		for (const manager of managers.splice(0).reverse()) {
			await manager.close();
		}
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	function buildSession(options: {
		report: UsageReport;
		status: ResetCreditAccountStatus;
		streamErrorFirst?: boolean;
		autoRedeem?: "unset" | "yes" | "no";
	}): { session: AgentSession; coordinator: CodexAutoRedeemCoordinator; targets: ResetCreditTarget[] } {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		authStorage.keys.setRuntime("anthropic", "test-key");
		vi.spyOn(authStorage.oauth, "identity").mockReturnValue({
			accountId: ACCOUNT_ID,
			email: EMAIL,
			orgId: ORG_ID,
		});
		vi.spyOn(authStorage.usage, "reports").mockImplementation(async () => [options.report]);
		vi.spyOn(authStorage.resets, "list").mockImplementation(async request =>
			request?.provider === "anthropic" ? [options.status] : [],
		);
		const targets: ResetCreditTarget[] = [];
		vi.spyOn(authStorage.resets, "redeem").mockImplementation(async request => {
			targets.push(request.target);
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
				if (options.streamErrorFirst && calls === 1) mock.push({ throw: CLAUDE_USAGE_LIMIT_ERROR });
				else mock.push({ content: ["recovered after Claude reset"], stopReason: "stop" });
				return mock.stream(requestedModel, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			"codexResets.autoRedeem": "no",
			"claudeResets.autoRedeem": options.autoRedeem ?? "yes",
			"claudeResets.salvageHorizonHours": 12,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory();
		managers.push(sessionManager);
		const coordinator = createCodexAutoRedeemCoordinator();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			codexResetCoordinator: coordinator,
		});
		sessions.push(session);
		return { session, coordinator, targets };
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
