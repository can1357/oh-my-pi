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
	accountId?: string;
	email?: string;
}

/** A fresh openai-codex usage report for a stubbed account. */
function codexReport(opts: CodexReportOpts): UsageReport {
	const now = Date.now();
	const accountId = opts.accountId ?? ACCOUNT_ID;
	const email = opts.email ?? EMAIL;
	return {
		provider: "openai-codex",
		fetchedAt: now,
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 Hour",
				scope: { provider: "openai-codex", accountId },
				window: { id: "5h", label: "5 Hour", resetsAt: now + 2 * HOUR },
				amount: { usedFraction: opts.primaryUsed, unit: "percent" },
			},
			{
				id: "openai-codex:secondary",
				label: "Weekly",
				scope: { provider: "openai-codex", accountId },
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
		metadata: { accountId, email, limitReached: opts.limitReached },
	};
}

/** Live credits-route row for a stubbed account, as the overlay consumes it. */
function liveCreditStatus(
	availableCount: number,
	expiresInMs?: number,
	accountId?: string,
	email?: string,
): ResetCreditAccountStatus {
	return {
		credentialId: 1,
		accountId: accountId ?? ACCOUNT_ID,
		email: email ?? EMAIL,
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
		reports?: UsageReport[];
		liveCredits: ResetCreditAccountStatus[];
		streamErrorFirst?: boolean;
		uiSelect?: (question: string) => string | undefined;
		redeemImpl?: (options: { target: ResetCreditTarget }) => Promise<{
			ok: boolean;
			code: "reset" | "final_consent_required";
			accountId?: string;
			email?: string;
			creditId?: string;
		}>;
	}

	interface Harness {
		session: AgentSession;
		coordinator: CodexAutoRedeemCoordinator;
		redeemTargets: ResetCreditTarget[];
		redeemOptions: { target: ResetCreditTarget }[];
		questions: string[];
	}

	function buildSession(opts: HarnessOpts): Harness {
		const model = getBundledModel("openai-codex", "gpt-5.4");
		if (!model) throw new Error("Expected bundled openai-codex/gpt-5.4 to exist");
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		vi.spyOn(authStorage, "getOAuthAccountIdentity").mockReturnValue({ accountId: ACCOUNT_ID, email: EMAIL });
		vi.spyOn(authStorage, "fetchUsageReports").mockImplementation(async () => opts.reports ?? [opts.report]);
		vi.spyOn(authStorage, "listResetCredits").mockImplementation(async () => opts.liveCredits);
		const redeemTargets: ResetCreditTarget[] = [];
		const redeemOptions: { target: ResetCreditTarget }[] = [];
		vi.spyOn(authStorage, "redeemResetCredit").mockImplementation(async options => {
			redeemTargets.push(options.target);
			redeemOptions.push(options);
			if (opts.redeemImpl) return opts.redeemImpl(options);
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
		const questions: string[] = [];
		const extensionRunner =
			opts.uiSelect === undefined
				? undefined
				: ({
						hasUI: () => true,
						emitBeforeAgentStart: async () => {},
						getUIContext: () => ({
							select: async (question: string) => {
								questions.push(question);
								return opts.uiSelect?.(question);
							},
						}),
					} as never);
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			codexResetCoordinator: coordinator,
			extensionRunner,
		});
		sessions.push(session);
		return { session, coordinator, redeemTargets, redeemOptions, questions };
	}

	it("spends a saved reset on a live 429 even when the report is a pre-block snapshot, then retries", async () => {
		// The report is the catch-22 snapshot: fetched pre-block, so the wire flag
		// and both windows still look healthy. Only the live 429 knows better.
		const { session, coordinator, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 0 },
			// Two credits: a non-final balance keeps the documented `yes` contract
			// (spend without prompting). The final-credit consent gate (issue
			// #11200) owns the one-credit case, covered below.
			report: codexReport({ primaryUsed: 0.6, weeklyUsed: 0.5, limitReached: false, credits: 2 }),
			liveCredits: [liveCreditStatus(2)],
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
		// weekly exhausted and blocked; the dedicated credits route says 2.
		const { session, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 0 },
			report: codexReport({ primaryUsed: 0.6, weeklyUsed: 1.0, limitReached: true, credits: 0 }),
			// The live route corrects the stale zero to a non-final balance, so
			// the `yes` contract spends without prompting (issue #11200 gates
			// only the final credit).
			liveCredits: [liveCreditStatus(2)],
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
			// openai/codex#28525 shape: 5h exhausted, weekly mostly free. Two credits:
			// a non-final balance keeps the `yes` silent-salvage contract (issue
			// #11200 gates only the final credit).
			report: codexReport({
				primaryUsed: 1.0,
				weeklyUsed: 0.2,
				limitReached: false,
				credits: 2,
				creditExpiresInMs: 2 * HOUR,
			}),
			liveCredits: [liveCreditStatus(2, 2 * HOUR)],
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
	it("requires explicit consent before spending the final saved reset in yes mode (issue #11200)", async () => {
		// The consent-violation repro: a `yes`-mode session blocked on a live 429
		// with exactly one credit left — e.g. after a background-job delivery
		// continued the turn — must NOT spend it without a prompt. Headless (no
		// prompt UI) means no spend, and the episode is NOT burned.
		const { session, coordinator, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 0 },
			report: codexReport({ primaryUsed: 0.6, weeklyUsed: 0.5, limitReached: false, credits: 1 }),
			liveCredits: [liveCreditStatus(1)],
			streamErrorFirst: true,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		expect(redeemTargets).toHaveLength(0);
		expect([...coordinator.attemptedKeys].some(key => key.startsWith("block|"))).toBe(false);
	});
	it("prompts once for a two-account sweep with a final credit and redeems exactly the listed actions", async () => {
		// The batch-consent repro: both usage snapshots claim two credits, but
		// the live credits route says the sibling is down to its last one. The
		// sweep must decide on live data (prompting in `yes` mode) and the
		// dialog must enumerate the whole batch — a single "Yes" spends both.
		const { session, coordinator, redeemTargets, questions } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 12 },
			report: codexReport({ primaryUsed: 1.0, weeklyUsed: 0.2, limitReached: false, credits: 2 }),
			reports: [
				codexReport({
					primaryUsed: 1.0,
					weeklyUsed: 0.2,
					limitReached: false,
					credits: 2,
					creditExpiresInMs: 2 * HOUR,
				}),
				codexReport({
					primaryUsed: 1.0,
					weeklyUsed: 0.3,
					limitReached: false,
					credits: 2,
					creditExpiresInMs: 3 * HOUR,
					accountId: "acct-2",
					email: "second@example.com",
				}),
			],
			liveCredits: [liveCreditStatus(2, 2 * HOUR), liveCreditStatus(1, 3 * HOUR, "acct-2", "second@example.com")],
			uiSelect: () => "Yes",
		});

		await session.fetchUsageReports();
		expect(coordinator.sweepPromise).toBeDefined();
		await coordinator.sweepPromise;

		expect(questions).toHaveLength(1);
		expect(questions[0]).toContain(EMAIL);
		expect(questions[0]).toContain("second@example.com");
		expect(redeemTargets).toEqual([
			{ accountId: ACCOUNT_ID, email: EMAIL },
			{ accountId: "acct-2", email: "second@example.com" },
		]);
	});
	it("waits for an in-flight salvage sweep before a blocked pass spends (issue #11470A)", async () => {
		// The double-spend repro: a sweep is already redeeming when a live 429
		// lands. The blocked pass must await the sweep so its plan observes
		// post-sweep credit counts instead of racing on a stale snapshot.
		const { session, coordinator, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 0 },
			report: codexReport({ primaryUsed: 0.6, weeklyUsed: 0.5, limitReached: false, credits: 2 }),
			liveCredits: [liveCreditStatus(2)],
			streamErrorFirst: true,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const sweepGate = Promise.withResolvers<void>();
		coordinator.sweepInFlight = true;
		coordinator.sweepPromise = sweepGate.promise;
		try {
			const promptPromise = session.prompt("trigger a codex usage limit");
			// Pump the event loop without guessing a duration: the mock stream
			// and retry pipeline need real macrotask turns (bare microtask
			// yields never fire their timers). An unserialized blocked pass
			// spends during this pump; a serialized one stays parked on the
			// sweep gate.
			for (let i = 0; i < 500 && redeemTargets.length === 0; i++) {
				await Bun.sleep(0);
			}
			expect(redeemTargets).toHaveLength(0);
			sweepGate.resolve();
			coordinator.sweepInFlight = false;
			await promptPromise;
			await session.waitForIdle();
			expect(redeemTargets).toEqual([{ accountId: ACCOUNT_ID, email: EMAIL }]);
		} finally {
			coordinator.sweepInFlight = false;
		}
	});

	it("defers a blocked pass when a planned sibling target is already claimed (issue #11470D)", async () => {
		// The cross-session race from review: another AgentSession sharing
		// this coordinator already holds acct-2 (its own blocked pass is
		// mid-flight). Our 429 plans acct-1 (restore) plus acct-2 (expiring
		// salvage, any trigger); without target claims both passes plan on one
		// live listing and can double-spend the final credit. The pass must
		// spend nothing — not just skip the held account.
		const { session, coordinator, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 12 },
			report: codexReport({ primaryUsed: 0.6, weeklyUsed: 0.5, limitReached: false, credits: 2 }),
			reports: [
				codexReport({ primaryUsed: 0.6, weeklyUsed: 0.5, limitReached: false, credits: 2 }),
				codexReport({
					primaryUsed: 1.0,
					weeklyUsed: 0.3,
					limitReached: false,
					credits: 2,
					creditExpiresInMs: 3 * HOUR,
					accountId: "acct-2",
					email: "second@example.com",
				}),
			],
			liveCredits: [liveCreditStatus(2), liveCreditStatus(2, 3 * HOUR, "acct-2", "second@example.com")],
			streamErrorFirst: true,
		});
		// Foreign pass holds the sibling target (and incidentally suppresses
		// the heartbeat sweep, which defers to any in-flight account).
		const foreignGate = Promise.withResolvers<void>();
		coordinator.inFlightByAccount.set(
			"acct-2",
			foreignGate.promise.then(() => false),
		);
		try {
			await session.prompt("trigger a codex usage limit");
			await session.waitForIdle();
			expect(redeemTargets).toHaveLength(0);
		} finally {
			coordinator.inFlightByAccount.delete("acct-2");
			foreignGate.resolve();
		}
		expect(coordinator.inFlightByAccount.size).toBe(0);
	});
	it("names the final-credit account in headless warnings when it is not first (issue #11470B)", async () => {
		// The misleading-guidance repro: the batch opens with a non-final
		// action and the final-credit action comes later. Headless users must
		// be told which account actually needs the explicit redemption.
		const { session, coordinator, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 12 },
			report: codexReport({ primaryUsed: 1.0, weeklyUsed: 0.2, limitReached: false, credits: 2 }),
			reports: [
				codexReport({
					primaryUsed: 1.0,
					weeklyUsed: 0.2,
					limitReached: false,
					credits: 2,
					creditExpiresInMs: 2 * HOUR,
				}),
				codexReport({
					primaryUsed: 1.0,
					weeklyUsed: 0.3,
					limitReached: false,
					credits: 2,
					creditExpiresInMs: 3 * HOUR,
					accountId: "acct-2",
					email: "second@example.com",
				}),
			],
			liveCredits: [liveCreditStatus(2, 2 * HOUR), liveCreditStatus(1, 3 * HOUR, "acct-2", "second@example.com")],
		});
		const warnings: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.level === "warning") warnings.push(event.message);
		});

		await session.fetchUsageReports();
		expect(coordinator.sweepPromise).toBeDefined();
		await coordinator.sweepPromise;

		expect(redeemTargets).toHaveLength(0);
		const finalWarning = warnings.find(message => message.includes("last saved Codex rate-limit reset"));
		expect(finalWarning).toBeDefined();
		expect(finalWarning).toContain("second@example.com");
	});
	it("re-prompts at redemption time when a planned non-final credit went final (issue #11470C sweep)", async () => {
		// The redemption-time race: planning saw two credits (no prompt in
		// `yes` mode), but another client spent one before execution. The
		// redeem seam reports `final_consent_required`; the sweep must prompt
		// and, on "Yes", retry the spend exactly once.
		const codes: string[] = [];
		const { session, coordinator, redeemTargets, redeemOptions, questions } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 12 },
			report: codexReport({
				primaryUsed: 1.0,
				weeklyUsed: 0.2,
				limitReached: false,
				credits: 2,
				creditExpiresInMs: 2 * HOUR,
			}),
			liveCredits: [liveCreditStatus(2, 2 * HOUR)],
			uiSelect: () => "Yes",
			redeemImpl: async () => {
				codes.push(codes.length === 0 ? "final_consent_required" : "reset");
				if (codes.length === 1) return { ok: false, code: "final_consent_required" as const };
				return { ok: true, code: "reset" as const, accountId: ACCOUNT_ID, email: EMAIL, creditId: "credit-1" };
			},
		});

		await session.fetchUsageReports();
		expect(coordinator.sweepPromise).toBeDefined();
		await coordinator.sweepPromise;

		expect(codes).toEqual(["final_consent_required", "reset"]);
		expect(redeemTargets).toHaveLength(2);
		expect(questions).toHaveLength(1);
		expect(questions[0]).toContain("last saved");
		expect(redeemOptions[0]).toHaveProperty("requireFinalCreditConsent", true);
		expect(redeemOptions[1]).not.toHaveProperty("requireFinalCreditConsent", true);
	});
	it("aborts a salvage sweep headless when redemption reports a newly-final credit (issue #11470C sweep)", async () => {
		// Same race through the sweep site with no prompt UI: the sweep must
		// warn once and spend nothing, without burning the episode.
		const { session, coordinator, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 12 },
			report: codexReport({
				primaryUsed: 1.0,
				weeklyUsed: 0.2,
				limitReached: false,
				credits: 2,
				creditExpiresInMs: 2 * HOUR,
			}),
			liveCredits: [liveCreditStatus(2, 2 * HOUR)],
			redeemImpl: async () => ({ ok: false, code: "final_consent_required" as const }),
		});
		const warnings: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.level === "warning") warnings.push(event.message);
		});

		await session.fetchUsageReports();
		expect(coordinator.sweepPromise).toBeDefined();
		await coordinator.sweepPromise;

		expect(redeemTargets).toHaveLength(1);
		expect(warnings.some(message => message.includes("last saved Codex rate-limit reset"))).toBe(true);
		expect([...coordinator.attemptedKeys].some(key => key.startsWith("salvage|"))).toBe(false);
	});
	it("aborts a blocked pass headless when redemption reports a newly-final credit (issue #11470C blocked)", async () => {
		// Same race through the blocked-pass site with no prompt UI: the
		// redeem is refused, the pass warns, and the episode is not burned.
		const { session, coordinator, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 0 },
			report: codexReport({ primaryUsed: 0.6, weeklyUsed: 0.5, limitReached: false, credits: 2 }),
			liveCredits: [liveCreditStatus(2)],
			streamErrorFirst: true,
			redeemImpl: async () => ({ ok: false, code: "final_consent_required" as const }),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const warnings: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.level === "warning") warnings.push(event.message);
		});

		await session.prompt("trigger a codex usage limit");
		await session.waitForIdle();

		expect(redeemTargets).toHaveLength(1);
		expect(warnings.some(message => message.includes("last saved Codex rate-limit reset"))).toBe(true);
		expect([...coordinator.attemptedKeys].some(key => key.startsWith("block|"))).toBe(false);
	});
	it("records one notified key per final action in headless warnings (issue #11470 P3)", async () => {
		// Two final-credit actions headless: the dedup set must hold a key per
		// final action, not just the first, so a later single-final pass for
		// the second account still warns instead of staying silent.
		const { session, coordinator, redeemTargets } = buildSession({
			settings: { "codexResets.autoRedeem": "yes", "codexResets.salvageHorizonHours": 12 },
			report: codexReport({ primaryUsed: 1.0, weeklyUsed: 0.2, limitReached: false, credits: 2 }),
			reports: [
				codexReport({
					primaryUsed: 1.0,
					weeklyUsed: 0.2,
					limitReached: false,
					credits: 1,
					creditExpiresInMs: 2 * HOUR,
				}),
				codexReport({
					primaryUsed: 1.0,
					weeklyUsed: 0.3,
					limitReached: false,
					credits: 1,
					creditExpiresInMs: 3 * HOUR,
					accountId: "acct-2",
					email: "second@example.com",
				}),
			],
			liveCredits: [liveCreditStatus(1, 2 * HOUR), liveCreditStatus(1, 3 * HOUR, "acct-2", "second@example.com")],
		});

		await session.fetchUsageReports();
		expect(coordinator.sweepPromise).toBeDefined();
		await coordinator.sweepPromise;

		expect(redeemTargets).toHaveLength(0);
		expect(coordinator.notifiedKeys.size).toBe(2);
	});
});
