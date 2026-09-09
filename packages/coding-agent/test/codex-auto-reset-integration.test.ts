/**
 * Integration regressions for the two codex saved-reset TRIGGERS — the wiring
 * the pure planner tests cannot cover:
 *
 * - A live 429 driven through the real retry pipeline (`AgentSession.prompt` →
 *   usage-limit classification → `markUsageLimitReached` (no sibling) →
 *   auto-redeem hook → `redeemResetCredit` → immediate retry). The usage
 *   report is deliberately a PRE-BLOCK snapshot (`limitReached: false`,
 *   healthy windows) — the original catch-22 that kept the feature from ever
 *   firing — so success proves the live 429's parsed unblock timestamp drives
 *   the decision.
 * - A stale-ZERO `/wham/usage` credit count corrected by the live
 *   `rate-limit-reset-credits` overlay (the usage provider never fixes a zero
 *   itself — it only consults the detail route on positive counts).
 * - The usage-fetch heartbeat (`AgentSession.fetchUsageReports`, what the
 *   status line polls) sweeping an expiring credit on a 5h-only exhausted
 *   account (the openai/codex#28525 shape), including once-per-episode
 *   idempotency across repeated heartbeats and headless `unset` consent.
 *
 * Provider IO is stubbed at the AuthStorage seam (`fetchUsageReports`,
 * `listResetCredits`, `redeemResetCredit`, `getOAuthAccountIdentity`);
 * everything in between — session hook, planner wiring, coordinator state,
 * sweep scheduling — is real. Each test injects its own coordinator, so the
 * process-wide default is never touched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
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

const ACCOUNT_ID = "acct-1";
const EMAIL = "user@example.com";
const HOUR = 3_600_000;

// 3 days — weekly-scale, parsed by the retry pipeline's retry-after parser.
const CODEX_USAGE_LIMIT_ERROR =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"usage_limit_reached"}} retry-after-ms=259200000';

interface CodexReportOpts {
	primaryUsed: number;
	weeklyUsed: number;
	limitReached: boolean;
	credits: number;
	creditExpiresInMs?: number;
}

/** A fresh openai-codex usage report for the stubbed account. */
function codexReport(opts: CodexReportOpts): UsageReport {
	const now = Date.now();
	return {
		provider: "openai-codex",
		fetchedAt: now,
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 Hour",
				scope: { provider: "openai-codex", accountId: ACCOUNT_ID },
				window: { id: "5h", label: "5 Hour", resetsAt: now + 2 * HOUR },
				amount: { usedFraction: opts.primaryUsed, unit: "percent" },
			},
			{
				id: "openai-codex:secondary",
				label: "Weekly",
				scope: { provider: "openai-codex", accountId: ACCOUNT_ID },
				window: { id: "7d", label: "Weekly", resetsAt: now + 3 * 24 * HOUR },
				amount: { usedFraction: opts.weeklyUsed, unit: "percent" },
			},
		],
		resetCredits: {
			availableCount: opts.credits,
			credits:
				opts.creditExpiresInMs === undefined
					? undefined
					: [{ status: "available", expiresAt: new Date(now + opts.creditExpiresInMs).toISOString() }],
		},
		metadata: { accountId: ACCOUNT_ID, email: EMAIL, limitReached: opts.limitReached },
	};
}

/** Live credits-route row for the stubbed account, as the overlay consumes it. */
function liveCreditStatus(availableCount: number, expiresInMs?: number): ResetCreditAccountStatus {
	return {
		credentialId: 1,
		accountId: ACCOUNT_ID,
		email: EMAIL,
		active: true,
		availableCount,
		credits:
			expiresInMs === undefined
				? []
				: [{ id: "credit-1", status: "available", expiresAt: new Date(Date.now() + expiresInMs).toISOString() }],
	};
}

describe("codex saved-reset trigger integration", () => {
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

	interface HarnessOpts {
		settings: Record<string, unknown>;
		report: UsageReport;
		liveCredits: ResetCreditAccountStatus[];
		streamErrorFirst?: boolean;
	}

	interface Harness {
		session: AgentSession;
		coordinator: CodexAutoRedeemCoordinator;
		redeemTargets: ResetCreditTarget[];
	}

	function buildSession(opts: HarnessOpts): Harness {
		const model = getBundledModel("openai-codex", "gpt-5.4");
		if (!model) throw new Error("Expected bundled openai-codex/gpt-5.4 to exist");
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		vi.spyOn(authStorage, "getOAuthAccountIdentity").mockReturnValue({ accountId: ACCOUNT_ID, email: EMAIL });
		vi.spyOn(authStorage, "fetchUsageReports").mockImplementation(async () => [opts.report]);
		vi.spyOn(authStorage, "listResetCredits").mockImplementation(async () => opts.liveCredits);
		const redeemTargets: ResetCreditTarget[] = [];
		vi.spyOn(authStorage, "redeemResetCredit").mockImplementation(async options => {
			redeemTargets.push(options.target);
			return { ok: true, code: "reset", accountId: ACCOUNT_ID, email: EMAIL, creditId: "credit-1" };
		});

		const mock = createMockModel();
		let calls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => {
				calls++;
				if (opts.streamErrorFirst && calls === 1) {
					mock.push({ throw: CODEX_USAGE_LIMIT_ERROR });
				} else {
					mock.push({ content: ["recovered after reset redemption"], stopReason: "stop" });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			...opts.settings,
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
		return { session, coordinator, redeemTargets };
	}

	it("spends a saved reset on a live 429 even when the report is a pre-block snapshot, then retries", async () => {
		// The report is the catch-22 snapshot: fetched pre-block, so the wire flag
		// and both windows still look healthy. Only the live 429 knows better.
		const { session, coordinator, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 0 },
			report: codexReport({ primaryUsed: 0.6, weeklyUsed: 0.5, limitReached: false, credits: 1 }),
			liveCredits: [liveCreditStatus(1)],
			streamErrorFirst: true,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		expect(redeemTargets).toEqual([{ accountId: ACCOUNT_ID, email: EMAIL }]);
		// The block episode is recorded in the injected coordinator so it cannot double-spend.
		expect([...coordinator.attemptedKeys].some(key => key.startsWith("block|"))).toBe(true);
		// The turn actually recovered on the retry after the redeem.
		const recovered = session.sessionManager
			.getEntries()
			.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some(
						block => block.type === "text" && block.text === "recovered after reset redemption",
					),
			);
		expect(recovered).toBe(true);
	});

	it("corrects a stale-zero usage count from the live credits route before deciding", async () => {
		// /wham/usage says 0 credits (stale — never corrected upstream on zero),
		// weekly exhausted and blocked; the dedicated credits route says 1.
		const { session, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 0 },
			report: codexReport({ primaryUsed: 0.6, weeklyUsed: 1.0, limitReached: true, credits: 0 }),
			liveCredits: [liveCreditStatus(1)],
			streamErrorFirst: true,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		expect(redeemTargets).toEqual([{ accountId: ACCOUNT_ID, email: EMAIL }]);
	});

	it("salvages an expiring credit on a 5h-only exhausted account from the usage heartbeat, exactly once", async () => {
		const { session, coordinator, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 12 },
			// openai/codex#28525 shape: 5h exhausted, weekly mostly free.
			report: codexReport({
				primaryUsed: 1.0,
				weeklyUsed: 0.2,
				limitReached: false,
				credits: 1,
				creditExpiresInMs: 2 * HOUR,
			}),
			liveCredits: [liveCreditStatus(1, 2 * HOUR)],
		});

		// The status line's heartbeat is exactly this call; the sweep handle lets
		// us await the fire-and-forget pass instead of polling wall-clock time.
		await session.fetchUsageReports();
		expect(coordinator.sweepPromise).toBeDefined();
		await coordinator.sweepPromise;
		expect(redeemTargets).toEqual([{ accountId: ACCOUNT_ID, email: EMAIL }]);

		// A later heartbeat re-plans over the same snapshot: the attempt key must
		// make it a no-op instead of a second spend.
		coordinator.lastSweepAt = 0;
		await session.fetchUsageReports();
		await coordinator.sweepPromise;
		expect(redeemTargets).toHaveLength(1);
	});

	it("asks before spending in unset mode and never spends headless", async () => {
		const { session, coordinator, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "unset", "codexResets.salvageHorizonHours": 12 },
			report: codexReport({
				primaryUsed: 1.0,
				weeklyUsed: 0.2,
				limitReached: false,
				credits: 1,
				creditExpiresInMs: 2 * HOUR,
			}),
			liveCredits: [liveCreditStatus(1, 2 * HOUR)],
		});

		await session.fetchUsageReports();
		expect(coordinator.sweepPromise).toBeDefined();
		await coordinator.sweepPromise;
		// No prompt UI in this harness: consent is required, so nothing is spent —
		// and the episode is NOT burned, so a UI session could still redeem it.
		expect(redeemTargets).toHaveLength(0);
		expect(coordinator.attemptedKeys.size).toBe(0);
	});
});
